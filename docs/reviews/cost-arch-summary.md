# 비용/아키텍처/EFS 종합 리뷰 요약

> 생성일: 2026-03-26 | 단계: continuous | 리뷰어: Claude Opus 4.6, Kiro 1.23.1
> Gemini: capacity 문제로 미완성

---

## 핵심 질문에 대한 답변

### EFS를 사용하는 것에 문제가 없을까?

**결론: EFS는 적합하지만, 현재 설정에는 2가지 심각한 문제가 있습니다.**

| 문제 | 심각도 | 현재 상태 | 권장 변경 |
|------|--------|----------|----------|
| Throughput 모드 | **높음** | Bursting (저장 용량에 비례) | **Elastic** (자동 확장) |
| 사용자 격리 | **높음** | 디렉토리 구분만 (Access Point 없음) | **EFS Access Points** 적용 |

#### 왜 EFS가 최선인가?

- **EBS**: ECS awsvpc 모드에서 컨테이너별 EBS 마운트 불가 (인스턴스 레벨만 가능)
- **FSx for Lustre**: 과잉 사양, 비용 5배 ($140/월 vs $30/월 per 100GB)
- **EFS**: ECS 네이티브 지원, 멀티AZ 자동 복제, 용량 자동 확장

#### Bursting 모드의 위험

```
저장 용량 10GB → 기본 처리량 50MiB/s
30명 동시 npm install → 필요 처리량 ~1.5GiB/s
= 30배 부족 → 극심한 throttling, 작업 10x 느려짐
```

**해결**: `throughputMode: ELASTIC` 변경 (추가 비용 $0.04/GiB 전송량)

#### Access Point 미사용의 위험

현재 모든 컨테이너가 EFS 루트(`/`)를 마운트합니다. 사용자 A가 터미널에서 `ls /home/coder/users/` 하면 모든 사용자의 파일에 접근 가능합니다.

**해결**: 사용자별 EFS Access Point 생성 → 커널 레벨에서 `/users/{subdomain}`만 접근 가능

---

## 비용 분석

### 월간 예상 비용 (ap-northeast-2 기준)

| 규모 | 인프라 비용 | Bedrock 비용 | 총 예상 비용 |
|------|-----------|-------------|-------------|
| 10명 | ~$900 | $500-2,000 | **$1,400-2,900** |
| 30명 | ~$1,900 | $1,500-6,000 | **$3,400-8,000** |
| 50명 | ~$3,000 | $2,500-10,000 | **$5,400-13,000** |

> Bedrock 비용이 총 비용의 50-75%를 차지. 사용량에 따라 크게 변동.

### 비용 절감 기회

| 항목 | 현재 | 권장 | 절감 |
|------|------|------|------|
| Dashboard EC2 | t4g.xlarge ($97/월) | t4g.small ($24/월) | **~$73/월** |
| EFS Lifecycle | 30일 후 IA 전환 | 14일 후 IA 전환 | **저장 비용 ~50% 절감** |
| ECS ASG | 24시간 대기 | 업무시간만 min=1 | **비업무시간 인스턴스 비용 $0** |
| VPC Endpoints | 7개 Interface ($141/월) | 필수만 유지 | 검토 필요 |

---

## 아키텍처 분석

### 잘 설계된 부분

| 항목 | 설명 |
|------|------|
| VPC Endpoints | Bedrock, ECR, S3 등 7개 → NAT 데이터 비용 최소화 |
| ECS EC2 모드 | Bin-packing으로 Fargate 대비 2-3배 비용 효율 |
| 3-tier 서브넷 | Public/Private/Isolated 적절한 분리 |
| KMS 암호화 | EBS, EFS, RDS 모두 KMS 암호화 |
| Container Insights | ECS 모니터링 활성화 |
| DLP 보안그룹 | open/restricted/locked 3단계 정책 |

### 개선 필요 사항

| 심각도 | 항목 | 설명 |
|--------|------|------|
| **높음** | 콜드스타트 | ASG min=0, desired=0 → 첫 사용자 3-5분 대기 |
| **높음** | EFS Bursting | 동시 사용자 증가 시 throughput 부족 |
| **높음** | EFS Access Point | 사용자 간 파일 접근 가능 |
| **중간** | 모니터링 갭 | ALB 5xx 알람, EFS burst credit, ECS 실패 알림 없음 |
| **중간** | Scale-in 보호 | `managedTerminationProtection: false` → 실행 중인 컨테이너가 있는 인스턴스 종료 가능 |
| **중간** | Dashboard SPOF | ASG min=1이면 롤링 업데이트 시 다운타임 |
| **중간** | EFS 메타데이터 병목 | ~35,000 ops/s 공유 → `node_modules`를 Docker 이미지에 미리 설치 권장 (Kiro) |
| **중간** | Fargate 병행 사용 | Fargate를 secondary capacity provider로 추가 → 콜드스타트 제거 (Kiro) |
| **중간** | DevEnv CloudFront 필요성 | WebSocket 위주로 캐싱 효과 없음, 지연시간만 추가 → 제거 검토 (Kiro) |
| **낮음** | DLP Restricted | HTTPS `0.0.0.0/0` 허용 → 실효성 낮음 |

---

## 우선 조치 사항 (Top 5)

1. **EFS → Elastic Throughput** 변경 - 동시 사용자 throttling 방지
2. **EFS Access Points** 적용 - 사용자 간 파일 격리 (보안 + 규정 준수)
3. **ECS ASG min=1** (운영 시간) - 콜드스타트 방지
4. **managedTerminationProtection: true** - 실행 중인 작업 보호
5. **모니터링 알람** 추가 - EFS/ALB/ECS 핵심 지표

---

## 상세 리뷰

- [Claude 비용/아키텍처/EFS 리뷰](cost-arch-claude.md) - 비용 추정, EFS 심층 분석, 아키텍처 평가
- [Kiro 비용/아키텍처/EFS 리뷰](cost-arch-kiro.md) - 15개 액션 아이템, 비용 추정, EFS 분석
- Gemini - capacity 문제로 미완성

---

## 이전 보안 리뷰 미해결 항목

초기 보안 리뷰에서 발견된 이슈 중 아직 수정되지 않은 항목:

| 이슈 | 파일 |
|------|------|
| Hardcoded Account ID `061525506239` | 6개+ 파일 |
| 기본 비밀번호 `CcOnBedrock2026!` | aws-clients.ts:340 |
| Wildcard IAM `Resource: *` | Instance/Dashboard Role |
| ALB `0.0.0.0/0:80` | CDK/TF/CFN 모두 |
| `unsafeUnwrap()` | dashboard-stack.ts:196 |

> 전체 보안 리뷰 결과: [docs/reviews/summary.md](summary.md)
