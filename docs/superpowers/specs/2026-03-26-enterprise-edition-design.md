# CC-on-Bedrock Enterprise Edition 설계

## Context
CC-on-Bedrock을 Enterprise 고객이 fork하여 4000명 규모로 운영하는 시나리오.
프록시 경유 제한적 인터넷, 1000명 동시 접속, 폐쇄망에서 Claude Code 운영.
기존 아키텍처 리뷰 결과(보안/비용/아키) 기반으로 Enterprise 갭을 해소하는 설계.

## 핵심 변경 영역 (10개)

### 1. 스토리지: EFS → EBS + S3 동기화
**현재**: EFS Bursting, 공유 루트, Access Point 없음
**변경**: 사용자별 EBS + S3 백업/동기화

```
[컨테이너 시작]
  ├── 같은 AZ에 기존 EBS 있음 → EBS attach → 마지막 S3 스냅샷 이후 delta sync
  ├── 다른 AZ로 이동됨 → 새 EBS 생성 → S3에서 전체 복원
  └── 첫 사용 or EBS 분실 → 새 EBS 생성 → S3에서 복원 (없으면 초기화)

[컨테이너 종료]
  └── EBS → S3 동기화 (incremental) → EBS 유지 (비용 절감 위해 snapshot 후 삭제 옵션)

[주기적]
  └── 5분마다 변경분 S3 sync (데이터 유실 최소화)
```

**장점**: EBS는 EFS 대비 3-5x 빠른 IOPS, AZ당 비용 ~$0.08/GB (gp3), S3는 $0.023/GB

#### S3 동기화 전략 상세

```
[S3 버킷 구조]
s3://cc-on-bedrock-user-data-{account-id}/
├── {user-id}/
│   ├── workspace/          # 코드, 프로젝트 파일
│   ├── config/             # code-server, claude 설정
│   ├── .metadata.json      # 마지막 sync 시간, AZ, EBS ID, snapshot ID
│   └── .sync-manifest.json # 파일 해시 목록 (incremental sync 용)
```

```
[동기화 메커니즘]
1. 초기 설정 (컨테이너 최초 시작):
   ├── 새 EBS gp3 20GB 생성 + attach
   ├── ext4 포맷 → /home/coder 마운트
   ├── S3에 빈 메타데이터 생성
   └── 기본 workspace 템플릿 복사

2. Incremental Sync (5분 주기 cron):
   ├── rsync --checksum로 변경 파일 감지
   ├── 변경된 파일만 aws s3 sync --size-only
   ├── .sync-manifest.json 업데이트 (파일 해시)
   ├── 대용량 파일 제외: node_modules/, .git/objects/, build/, dist/
   └── 예상 sync 크기: 평균 10-50MB per 5분 (코드 변경분만)

3. Warm Stop Sync (컨테이너 종료 시):
   ├── 마지막 incremental 이후 변경분 sync
   ├── .metadata.json 업데이트: {last_sync, az, ebs_id, snapshot_id}
   ├── aws s3 sync --delete (삭제된 파일 반영)
   └── 완료 확인 후 EBS snapshot 생성

4. Warm Resume (컨테이너 재시작 시):
   ├── Case A: 같은 AZ + EBS snapshot 존재
   │   ├── snapshot → EBS 복원 (~30초)
   │   ├── S3에서 snapshot 이후 변경분만 sync (delta)
   │   └── 체감 시간: 30-60초
   ├── Case B: 다른 AZ 또는 snapshot 없음
   │   ├── 새 EBS 생성 + 포맷
   │   ├── aws s3 sync → EBS 전체 복원
   │   ├── 크기에 따라 1-5분 (20GB 기준 ~2분)
   │   └── 체감 시간: 2-3분
   └── Case C: S3에도 없음 (첫 사용자)
       └── 기본 템플릿으로 초기화

5. 제외 패턴 (.s3ignore):
   ├── node_modules/       # Docker 이미지에 프리빌드
   ├── .git/objects/       # git은 shallow clone 권장
   ├── build/, dist/       # 빌드 결과물 (재생성 가능)
   ├── __pycache__/        # Python 캐시
   ├── .cache/             # 각종 캐시
   └── *.log              # 로그 파일
```

```
[장애 복구]
├── EBS 분실/손상: S3에서 전체 복원 (최대 5분 데이터 유실)
├── S3 sync 실패: CloudWatch 알람 → 재시도 3회 → SNS 알림
├── AZ 장애: 다른 AZ에서 S3 기반 복원 (자동)
└── 데이터 충돌: S3 versioning으로 이전 버전 복구 가능
```

**구현**: EBS lifecycle은 Lambda + Step Functions, S3 sync는 entrypoint.sh + cron + aws cli

#### EBS 크기 증설 및 승인 프로세스

```
[기본 할당]: 20GB gp3 (모든 사용자)

[증설 요청 플로우]
├── 사용자가 User Portal에서 증설 요청 (40GB / 60GB / 100GB)
├── 사유 입력 필수 (대형 프로젝트, ML 데이터 등)
├── Dept Manager 승인 큐에 추가
├── Dept Manager 승인 → 부서 예산에서 스토리지 크레딧 차감
├── 승인 완료 → Lambda가 EBS modify-volume 실행 (gp3는 온라인 리사이즈 가능)
├── 파일시스템 resize (resize2fs) → 컨테이너 재시작 불필요
└── 거부 시 사유와 함께 사용자에게 알림

[Admin 정책]
├── 부서별 최대 EBS 크기 설정 (예: 일반 40GB, AI팀 200GB)
├── 전체 EBS 총량 모니터링 (비용 제어)
└── 비활성 사용자 EBS 자동 축소 정책 (30일 미사용 → 기본 20GB로 축소, S3 백업 후)
```

### 2. 사용자 역할 분리 (Admin / Dept Manager / User)
**현재**: admin + user 2개 그룹
**변경**: 3-tier 역할 모델

| 역할 | 권한 |
|------|------|
| **Platform Admin** | 전체 설정, 사용자/부서 관리, 글로벌 예산, 모든 모니터링 |
| **Dept Manager** | 부서 내 사용자 승인/관리, 부서 예산 조회/조정, 부서 사용량 모니터링 |
| **User** | 셀프서비스 컨테이너 시작/중지, 본인 사용량 조회, 개발환경 설정 |

Cognito 그룹: `platform-admin`, `dept-manager:{dept-id}`, `user`

### 3. SSO/SAML + 승인 기반 프로비저닝
**현재**: Admin이 Cognito 사용자 직접 생성
**변경**:

```
[사용자] SSO 로그인 (SAML/OIDC)
  → Cognito User Pool Federation
  → 첫 로그인 시 자동 계정 생성 (IdP 그룹 매핑)
  → 부서 자동 할당 (IdP attribute: department)
  → 컨테이너 접근은 Dept Manager 승인 필요
  → 승인 후 셀프서비스 가능
```

### 4. 토큰/예산 제어 (2-tier)
**현재**: 글로벌 $50/day 단일 예산
**변경**:

| 레벨 | 제어 | Admin 수정 |
|------|------|-----------|
| **부서 월간 예산** | 부서별 월간 토큰/비용 한도 | Admin이 DynamoDB에서 직접 수정 |
| **개인 일일 한도** | 사용자별 일일 토큰 한도 | Admin이 사용자별 조정 가능 |

DynamoDB 테이블 구조:
- `department-budgets`: PK=dept_id, monthly_budget_usd, monthly_used_usd
- `user-budgets`: PK=user_id, daily_limit_tokens, daily_used_tokens, dept_id

### 5. Admin Dashboard 확장
**현재**: 관리자 전용 컨테이너 관리
**변경**: 3개 뷰 + 토큰 사용량

| 뷰 | 대상 | 핵심 기능 |
|----|------|----------|
| **Admin Console** | Platform Admin | 부서/사용자 관리, 글로벌 모니터링, 예산 설정, 토큰 사용량 대시보드 |
| **Dept Dashboard** | Dept Manager | 부서 사용량, 멤버 관리, 승인 큐, 부서 토큰 현황 |
| **User Portal** | User | 셀프서비스 컨테이너, 본인 사용량/토큰, 환경 설정 |

### 6. ECS Cold Start / Warm Down 전략
**현재**: ASG min=0, 3-5분 콜드스타트
**변경**:

```
[Warm Pool 전략]
├── 업무시간 (09:00-18:00): min=예상 동시사용자의 30% / 인스턴스당 용량
├── 비업무시간: min=0, Fargate Spot으로 긴급 요청 처리
├── EventBridge 스케줄로 ASG min 조정
└── 예측 스케일링: 지난 2주 사용 패턴 기반

[Warm Stop 전략] ← 핵심: 사용자 경험을 해치지 않으면서 비용 절감
├── Level 0 (Active): 정상 작동 중. EBS 직접 I/O.
├── Level 1 (Idle 감지, 30분):
│   ├── [필수 조건] WebSocket 연결 없음 (code-server 브라우저 닫힘)
│   ├── [활성 프로세스 체크] 아래 중 하나라도 활성이면 idle 아님:
│   │   ├── CPU > 5% (빌드/컴파일 중)
│   │   ├── Disk I/O > 1MB/s (npm install, git clone 등)
│   │   ├── Network I/O > 100KB/s (패키지 다운로드, API 호출)
│   │   ├── PTY 세션 활성 (터미널 프로세스 실행 중)
│   │   ├── Bedrock 토큰 사용 중 (최근 5분 내 API 호출)
│   │   └── 빌드 프로세스 감지 (node, npm, cargo, go build, make, pytest 등)
│   ├── 모든 조건 충족 시 → SNS/이메일 알림: "15분 후 절전모드 전환"
│   ├── 알림에 "Keep Alive 1시간 연장" 링크 포함
│   └── EBS → S3 incremental sync 시작 (백그라운드, warm stop 대비)
├── Level 2 (Warm Stop, 45분):
│   ├── 컨테이너 SIGTERM → graceful shutdown
│   ├── EBS 최종 S3 sync 완료 확인
│   ├── EBS snapshot 생성 → EBS 삭제 (비용 절감: snapshot $0.05/GB vs EBS $0.08/GB)
│   ├── ECS Task 중지, ALB 타겟 해제
│   └── DynamoDB에 상태 기록: {user, az, snapshot_id, s3_path, last_sync}
├── Level 3 (Warm Resume, 즉시):
│   ├── 사용자가 포털에서 "시작" 클릭
│   ├── 같은 AZ 가용 시: snapshot → EBS 복원 (~30초) → attach → 컨테이너 시작
│   ├── 다른 AZ 배치 시: 새 EBS + S3 전체 복원 (~2-3분)
│   └── 사용자 체감: 30초~3분 (vs 현재 3-5분 콜드스타트)
└── Level 4 (Deep Archive, 7일 미사용):
    ├── Snapshot 삭제 → S3만 유지 (최저 비용)
    └── 재시작 시 S3에서 전체 복원 (~3-5분)

[업무시간 스케줄링]
├── 08:30: 예측 기반 ECS 인스턴스 pre-warm (지난 2주 패턴)
├── 09:00-18:00: ASG min = peak의 30%
├── 18:00: 모든 Level 1+ 컨테이너 batch warm stop
├── 22:00: 나머지 활성 컨테이너 강제 warm stop (데이터 보존)
└── Managed Termination Protection: true (실행 중 인스턴스 보호)

[비용 효과]
├── EBS 20GB × 1000명 = $1,600/월 (활성 시간만)
├── Snapshot 20GB × 3000명 = $3,000/월 (비활성)
├── S3 20GB × 4000명 = $1,840/월 (전체 백업)
└── vs EFS: $0.30/GB × 80TB = $24,000/월 → 73% 절감
```

### 7. NLB + Nginx 라우팅 (ALB 100 규칙 한계 해소)
**현재**: 사용자별 ALB Listener Rule (max 100)
**변경**: NLB → Nginx (ECS Service) → 사용자 컨테이너

```
[아키텍처]
Client → CloudFront → NLB (TCP 443 passthrough)
  → Nginx ECS Service (2-3 Task, AutoScaling)
    → 사용자 컨테이너 (port 8080)

[Nginx가 하는 일]
├── TLS 종료 (ACM 인증서)
├── Host 헤더 기반 라우팅: user1.dev.example.com → user1 컨테이너 IP:8080
├── WebSocket 프록시 (code-server, Claude Code 터미널)
├── Health check (upstream 컨테이너)
└── 접근 로그 → CloudWatch

[Nginx Config 동적 배포]
사용자 생성/삭제 시 Nginx config 자동 업데이트 필요:

1. 사용자 컨테이너 시작 시:
   ├── Dashboard API → DynamoDB에 {user, subdomain, container_ip, port} 등록
   ├── Lambda (DynamoDB Stream trigger) → Nginx config 생성
   │   upstream user1 { server 10.100.16.x:8080; }
   │   server { server_name user1.dev.example.com; proxy_pass http://user1; }
   ├── S3에 nginx.conf 업로드
   ├── Nginx ECS Task에 SSM SendCommand로 config reload
   │   또는 Nginx Task가 30초 주기로 S3 polling + nginx -s reload
   └── Route 53 와일드카드 *.dev.example.com → NLB (이미 설정됨)

2. 사용자 컨테이너 종료 시:
   ├── DynamoDB에서 라우팅 정보 삭제
   ├── Lambda → Nginx config에서 upstream 제거
   ├── S3 업로드 → Nginx reload
   └── 종료된 사용자 접속 시 "컨테이너 중지됨. 시작하시겠습니까?" 페이지 표시

3. Nginx Config 관리:
   ├── S3: s3://cc-on-bedrock-config/nginx/nginx.conf (마스터)
   ├── DynamoDB: routing-table (PK=subdomain, container_ip, port, status)
   ├── Config 생성: Lambda가 DynamoDB scan → nginx.conf 템플릿 렌더링
   └── 무중단 배포: nginx -t (문법 검증) → nginx -s reload
```

**NLB 선택 이유** (vs ALB):
- TCP passthrough로 WebSocket 안정적 지원
- 규칙 수 제한 없음 (Nginx가 라우팅 담당)
- 고정 IP 가능 (폐쇄망 방화벽 설정에 유리)
- ALB 대비 비용 저렴 (LCU 과금 없음)

### 8. 폐쇄망 Claude Code 운영
**현재**: 인터넷 경유 Claude Code 1P
**변경**: VPC 내부에서 Bedrock 직접 접근

```
[Claude Code CLI]
  → ANTHROPIC_API_KEY 대신 AWS_PROFILE 사용
  → Bedrock VPC Endpoint 경유
  → 프록시 설정: HTTP_PROXY, HTTPS_PROXY 환경변수
  → npm registry: 사내 Artifactory/CodeArtifact 미러
  → Docker registry: ECR 프라이빗
```

컨테이너 entrypoint에서 프록시 자동 설정.

### 9. 프롬프트 감사 로깅
**현재**: CloudWatch 로그만
**변경**:

```
[Bedrock API 호출]
  → CloudTrail Data Event 활성화 (Bedrock InvokeModel)
  → EventBridge → Lambda → DynamoDB audit 테이블
  → 저장: user_id, timestamp, model_id, input_tokens, output_tokens, prompt_hash
  → Admin Dashboard에서 사용 패턴 시각화
  → 프롬프트 본문은 저장하지 않음 (hash만) - 개인정보 보호
```

### 10. 리소스 티어 관리
**현재**: admin이 수동으로 리소스 티어 지정
**변경**: 사용자 선택 + Admin 정책 제어 (자동 티어링 제거)

개발 워크로드는 대부분 idle이다가 빌드 시 폭발적 CPU 사용 → CPU 기반 자동 티어링 부적합.

```
[티어 할당 방식]
├── 사용자가 컨테이너 시작 시 티어 선택 (light/standard/power)
├── 부서별 허용 티어 Admin이 설정 (예: 일반부서는 light/standard만, AI팀은 power 허용)
├── 부서 예산 내에서만 상위 티어 선택 가능
└── Admin이 특정 사용자의 기본 티어를 오버라이드 가능

[비용 가중치]
├── light (1CPU/4GB): 1x 크레딧 소모
├── standard (2CPU/8GB): 2x 크레딧 소모
└── power (4CPU/12GB): 4x 크레딧 소모
→ 부서 예산에서 크레딧 기반으로 차감하여 상위 티어 남용 방지
```

---

## 스케일링 추정 (1000명 동시)

| 컴포넌트 | 사양 | 수량 |
|----------|------|------|
| ECS Instances | m7g.4xlarge (16vCPU/64GB) | ~80-120대 (light 기준) |
| EBS Volumes | gp3 20GB per user | 4000개 (활성 1000 + 비활성 3000) |
| S3 저장소 | ~20GB × 4000 = 80TB | 1개 버킷 |
| ALB | 1개 + Host 기반 라우팅 | 1-2개 |
| NAT Gateway | 2 AZ | 2개 |
| DynamoDB | On-demand | 3 테이블 |

**월간 비용 추정 (Bedrock 제외)**:
- ECS: ~$60,000 (100대 × $600)
- EBS: ~$6,400 (4000 × 20GB × $0.08)
- S3: ~$1,840 (80TB × $0.023)
- NAT + VPC Endpoints: ~$230
- ALB: ~$200
- Total: **~$70,000/월** (Bedrock 비용 별도, 사용량에 따라 $50K-200K 추가)

---

## 구현 우선순위

### Phase 1: Foundation (4주)
1. EBS + S3 스토리지 전환
2. SSO/SAML 연동
3. 3-tier 역할 모델 (Cognito 그룹)
4. 부서/사용자 예산 DynamoDB 스키마

### Phase 2: User Experience (4주)
5. User Portal (셀프서비스 컨테이너)
6. Dept Dashboard (부서 관리)
7. Admin Dashboard 확장 (토큰 사용량, 부서별 한도)
8. 승인 기반 프로비저닝 플로우

### Phase 3: Scale & Operations (4주)
9. ALB 라우팅 개선 (Host 기반)
10. ECS Warm Pool + Warm Down 전략
11. 자동 스케일 티어
12. 프롬프트 감사 로깅

### Phase 4: Hardening (2주)
13. 이전 보안 리뷰 미해결 이슈 전부 수정
14. 폐쇄망 프록시/미러 설정
15. DR/백업 전략
16. 부하 테스트 (1000명 동시)

## Validation 계획

### Phase 1 검증: Foundation

| 검증 항목 | 방법 | 성공 기준 |
|----------|------|----------|
| EBS + S3 동기화 | 컨테이너 시작→파일 생성→종료→재시작 | 파일이 S3에 백업되고 재시작 후 복원됨 |
| AZ 이동 복원 | AZ-a에서 종료 → AZ-c에서 시작 | S3에서 새 EBS로 전체 복원, 데이터 무손실 |
| EBS 분실 복구 | EBS 수동 삭제 후 컨테이너 시작 | S3에서 자동 복원 |
| SSO/SAML 로그인 | IdP 연동 후 첫 로그인 | 자동 계정 생성 + 부서 할당 |
| 3-tier 역할 | admin/dept-manager/user 각각 로그인 | 권한별 화면/API 접근 제한 |
| 예산 스키마 | DynamoDB 테이블 생성 + CRUD | 부서/개인 예산 읽기/쓰기 |

### Phase 2 검증: User Experience

| 검증 항목 | 방법 | 성공 기준 |
|----------|------|----------|
| User Portal | 사용자 로그인 → 컨테이너 시작/중지 | 셀프서비스 동작, code-server 접속 |
| 승인 플로우 | 신규 사용자 → 신청 → Dept Manager 승인 | 승인 후 컨테이너 접근 가능 |
| 토큰 대시보드 | 사용자/부서/admin 각각 조회 | 실시간 토큰 사용량 표시 |
| 예산 초과 차단 | 일일 한도 초과 시 | Bedrock API 호출 차단 + 알림 |
| EBS 증설 | 사용자 요청 → 승인 → 리사이즈 | 온라인 증설 완료, 재시작 없음 |

### Phase 3 검증: Scale & Operations

| 검증 항목 | 방법 | 성공 기준 |
|----------|------|----------|
| NLB + Nginx 라우팅 | 200명 동시 접속 | Host 기반 라우팅 정상, WebSocket 안정 |
| Nginx config 동적 배포 | 컨테이너 시작/종료 10회 반복 | 30초 내 config reload, 무중단 |
| Warm Stop 전략 | 45분 idle 시뮬레이션 | SNS 알림 → S3 sync → EBS snapshot → Task 중지 |
| Warm Resume | Warm Stop 후 재시작 | 같은 AZ: <60초, 다른 AZ: <3분 |
| Idle 감지 정확도 | 빌드 실행 중 브라우저 닫기 | CPU/Disk I/O 감지로 idle 판정 안 됨 |
| Keep Alive | 알림 링크에서 연장 클릭 | 1시간 idle 타이머 리셋 |
| ECS 스케일링 | 100→200명 급증 시나리오 | ASG 5분 내 인스턴스 추가 |

### Phase 4 검증: Hardening

| 검증 항목 | 방법 | 성공 기준 |
|----------|------|----------|
| 부하 테스트 | Locust 1000명 동시 접속 | 응답 시간 p99 < 5초, 에러율 < 1% |
| 보안 리뷰 | 이전 27개 이슈 재검토 | 전부 해결 확인 |
| 프롬프트 감사 | Bedrock 호출 100건 후 감사 로그 확인 | CloudTrail + DynamoDB에 전건 기록 |
| 폐쇄망 테스트 | 프록시만 허용된 환경 시뮬레이션 | Bedrock VPC Endpoint + npm 미러로 정상 동작 |
| DR 테스트 | AZ 장애 시뮬레이션 (AZ-a 비활성) | AZ-c에서 전체 서비스 복구, 사용자 데이터 S3에서 복원 |
| 비용 검증 | 2주 운영 후 AWS Cost Explorer | 실제 비용이 추정 대비 ±20% 이내 |

---

## 출력 문서 목록

| 문서 | 경로 | 내용 |
|------|------|------|
| **설계 문서** | `docs/superpowers/specs/2026-03-26-enterprise-edition-design.md` | 이 plan의 전체 설계 내용 |
| **Task 목록** | `docs/superpowers/plans/2026-03-26-enterprise-tasks.md` | Phase별 구현 태스크 + 담당/기한 |
| **Validation 체크리스트** | `docs/superpowers/plans/2026-03-26-enterprise-validation.md` | 위 검증 항목 체크리스트 |
| **ADR** | `docs/decisions/ADR-001-ebs-s3-storage-strategy.md` | EFS→EBS+S3 전환 결정 근거 |
| **ADR** | `docs/decisions/ADR-002-nlb-nginx-routing.md` | ALB→NLB+Nginx 전환 결정 근거 |
