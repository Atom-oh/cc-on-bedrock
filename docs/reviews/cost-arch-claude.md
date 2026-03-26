# Claude Code: Cost, Architecture & EFS Review

> Generated: 2026-03-26 | Model: Claude Opus 4.6

---

## 1. Cost Analysis

### Infrastructure Cost Estimate (ap-northeast-2, monthly)

| Component | Spec | 10 Users | 30 Users | 50 Users |
|-----------|------|----------|----------|----------|
| **NAT Gateway** (x2) | 2 AZ, $0.059/hr + data | $85 + data | $85 + data | $85 + data |
| **VPC Endpoints** (x7 interface) | $0.014/hr/AZ x 7 x 2 | $141 | $141 | $141 |
| **ECS Host** (m7g.4xlarge) | $0.6528/hr, 16vCPU/64GB | $470 (1대) | $1,410 (3대) | $2,350 (5대) |
| **EFS** | Bursting, Standard class | $3 (10GB) | $15 (50GB) | $45 (150GB) |
| **ALB** (DevEnv) | $0.0225/hr + LCU | $25 | $40 | $60 |
| **ALB** (Dashboard) | $0.0225/hr + LCU | $25 | $25 | $30 |
| **CloudFront** (x2) | WebSocket + HTTP | $10 | $30 | $50 |
| **Dashboard EC2** (t4g.xlarge) | $0.1344/hr | $97 | $97 | $97 |
| **DynamoDB** | On-demand | $5 | $15 | $25 |
| **KMS** | 1 key + API calls | $3 | $5 | $8 |
| **Route 53** | 1 hosted zone + queries | $2 | $2 | $2 |
| **CloudWatch** | Logs + Container Insights | $15 | $40 | $65 |
| **Bedrock** (Opus 4.6) | ~$15/1M input, $75/1M output | $500-2,000 | $1,500-6,000 | $2,500-10,000 |
| **총 예상 비용** | | **$1,400-2,900** | **$3,400-8,000** | **$5,400-13,000** |

### Cost Optimization Recommendations

#### [High] NAT Gateway 비용 - $85/월 고정 + 데이터 비용
- 2개 NAT Gateway ($85/월 기본)는 적절하나, Bedrock VPC Endpoint가 이미 있으므로 AI 트래픽은 NAT를 타지 않음
- ECR/S3도 Gateway Endpoint 사용 → NAT 데이터 비용 절감됨
- **평가**: 잘 설계됨. VPC Endpoints (7개)로 NAT 데이터 비용 최소화

#### [High] ECS EC2 vs Fargate 분석
현재: **EC2 모드 (m7g.4xlarge)** - 올바른 선택

| 항목 | EC2 Mode | Fargate |
|------|----------|---------|
| vCPU 단가 | ~$0.04/hr (m7g) | $0.04048/hr |
| 메모리 단가 | ~$0.005/hr | $0.004445/hr |
| EFS 지원 | O | O |
| GPU | O | X |
| Bin-packing | O (여러 컨테이너/호스트) | X (1:1) |
| 관리 오버헤드 | 높음 (ASG, AMI) | 낮음 |

**결론**: EC2가 맞음. m7g.4xlarge (16vCPU/64GB)에 light(1CPU/4GB) 컨테이너 10-15개 bin-packing 가능. Fargate는 1:1 매핑이라 비용 2-3x 증가.

#### [Medium] EFS Bursting vs Elastic Throughput
현재: `throughputMode: BURSTING`
- Bursting: 50MiB/s 기본 + 버스트 크레딧 (저장 용량 비례)
- 10GB 저장 시 burst 크레딧 매우 적음 → **30명 동시 npm install 시 throttling 발생 가능**
- **권장**: `ELASTIC` 모드로 변경 ($0.04/GiB transferred 추가). 자동 확장되어 burst 크레딧 고갈 문제 없음

#### [Low] Dashboard EC2 - t4g.xlarge 과대
Next.js 대시보드 하나에 t4g.xlarge (4vCPU/16GB)는 과잉. t4g.small (2vCPU/2GB)로도 충분.
- 절감: $97 → $24/월 (~$73 절감)

---

## 2. Architecture Analysis

### [Critical] ECS ASG minCapacity: 0 + desiredCapacity: 0
```typescript
minCapacity: 0, maxCapacity: 15, desiredCapacity: 0
```
- 첫 사용자 접속 시 EC2 인스턴스 프로비저닝부터 시작 → **3-5분 콜드스타트**
- ECS Managed Scaling이 `targetCapacityPercent: 80`으로 설정되어 있지만, 0→1 스케일업은 느림
- **권장**: 운영 시간에는 `minCapacity: 1` 설정. EventBridge 스케줄로 업무시간만 유지.

### [High] 단일 장애점 분석

| Component | 다중화 | 위험 |
|-----------|--------|------|
| NAT Gateway | 2 AZ | OK |
| ALB | Multi-AZ | OK |
| EFS | Multi-AZ 자동 | OK |
| Dashboard EC2 | ASG (1대) | **SPOF** - min 1이면 롤링 업데이트 시 다운타임 |
| ECS Host | ASG (0-15) | OK |
| Route 53 | Managed | OK |

### [Medium] 모니터링 갭
- Container Insights 활성화됨 (`containerInsights: true`) - 좋음
- CloudWatch Log Group 1개월 보존 - 적절
- **누락**: ALB 5xx 알람, EFS burst credit 모니터링, ECS task failure 알림, Bedrock throttling 알람

### [Low] 오토스케일링 전략
현재 ECS Managed Scaling (80% target capacity)은 적절하나:
- **scale-in 보호 없음** (`newInstancesProtectedFromScaleIn: false`) - 실행 중인 컨테이너가 있는 인스턴스가 종료될 수 있음
- **권장**: `enableManagedTerminationProtection: true`로 변경

---

## 3. EFS 심층 분석

### EFS는 이 프로젝트에 적합한가?

**결론: 적합하지만 조건부** - Bursting 모드 + Access Point 미사용이 주요 위험.

#### EFS vs EBS vs FSx 비교

| 항목 | EFS (현재) | EBS (per-user) | FSx for Lustre |
|------|-----------|---------------|----------------|
| 멀티유저 공유 | O | X (단일 인스턴스) | O |
| 멀티AZ | 자동 | X (AZ 종속) | 단일 AZ |
| 비용 (100GB) | $30/월 | $8/월 (gp3) | $140/월 |
| 처리량 | 버스트/탄력적 | 125-1000 MiB/s (gp3) | 200+ MiB/s |
| IOPS | ~8K (General Purpose) | 3K-16K (gp3) | 높음 |
| 지연시간 | 1-5ms | 0.5-1ms | <1ms |
| ECS 통합 | 네이티브 | 복잡 (awsvpc 모드 어려움) | 제한적 |
| 사용자 격리 | Access Point | 자연 격리 | 디렉토리 |

**EFS가 최선인 이유:**
1. ECS awsvpc 모드에서 EBS 마운트는 매우 복잡 (인스턴스-레벨이라 컨테이너별 불가)
2. 멀티AZ 자동 복제로 가용성 높음
3. 용량 자동 확장 (관리 불필요)
4. ECS Task Definition에서 네이티브 지원

**EFS의 위험:**
1. **Bursting 모드 성능 한계** - 10GB 저장 시 50MiB/s burst, 크레딧 빠르게 소진
2. **Access Point 미사용** - 사용자 간 파일 접근 가능 (이전 리뷰에서도 지적)
3. **동시 I/O** - 30명 동시 `npm install` 시 IOPS 포화 가능

#### 30명 동시 npm install 시나리오

```
npm install 평균 I/O: ~50-100 MiB/s read + ~20-50 MiB/s write (per user)
30명 동시: ~1.5-3 GiB/s read 필요
EFS Bursting (10GB): 50 MiB/s baseline → 극심한 throttling
EFS Elastic: 자동 확장 → $0.04/GiB × ~50GiB = $2 추가 비용으로 해결
```

#### 권장 EFS 설정 변경

```typescript
// Before (현재)
const fileSystem = new efs.FileSystem(this, 'DevenvEfs', {
  throughputMode: efs.ThroughputMode.BURSTING,  // 위험
  performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
  lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
});

// After (권장)
const fileSystem = new efs.FileSystem(this, 'DevenvEfs', {
  throughputMode: efs.ThroughputMode.ELASTIC,   // 자동 확장
  performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,  // OK
  lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS,    // IA 전환 빠르게
});
```

#### Access Point 필수 적용

```typescript
// Per-user Access Point 생성 (Lambda 또는 Dashboard에서 동적 생성)
const accessPoint = new efs.AccessPoint(this, 'UserAccessPoint', {
  fileSystem,
  path: '/users/{subdomain}',
  posixUser: { uid: '1000', gid: '1000' },
  createAcl: { ownerUid: '1000', ownerGid: '1000', permissions: '750' },
});
```

---

## 4. 이전 보안 리뷰 미해결 항목 (확인)

| 이슈 | 상태 | 비고 |
|------|------|------|
| Hardcoded Account ID | 미해결 | 6개+ 파일 |
| Default Password `CcOnBedrock2026!` | 미해결 | aws-clients.ts |
| EFS Access Point 미사용 | 미해결 | 위 EFS 섹션 참조 |
| Wildcard IAM `Resource: *` | 부분 해결 | ECS Task Role은 scoped, Instance/Dashboard Role은 미해결 |
| ALB `0.0.0.0/0:80` | 미해결 | 3개 IaC 모두 |
| `unsafeUnwrap()` | 미해결 | dashboard-stack.ts |

---

## Summary

| 영역 | 핵심 권장사항 |
|------|-------------|
| **비용** | EFS → Elastic 모드, Dashboard → t4g.small, 업무시간 외 ECS min=0 |
| **아키텍처** | ECS min=1 (콜드스타트 방지), managed termination protection 활성화 |
| **EFS** | Elastic throughput + Access Points 필수, IA lifecycle 14일 |
| **모니터링** | ALB 5xx, EFS burst credit, ECS task failure 알람 추가 |
