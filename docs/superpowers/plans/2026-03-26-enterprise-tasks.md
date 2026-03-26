# CC-on-Bedrock Enterprise Edition - Task 목록

> 생성일: 2026-03-26 | 설계 문서: [enterprise-edition-design.md](../specs/2026-03-26-enterprise-edition-design.md)
> 마지막 업데이트: 2026-03-26

## Phase 1: Foundation (4주)

- [x] **T1.1** EBS lifecycle Lambda 구현 (생성/attach/detach/snapshot/삭제) ✅ `cdk/lib/lambda/ebs-lifecycle.py`
- [x] **T1.2** S3 sync 스크립트 구현 (entrypoint.sh + cron) ✅ `docker/devenv/scripts/s3-sync.sh`
- [x] **T1.3** .s3ignore 패턴 적용 (node_modules, .git/objects, build 제외) ✅ s3-sync.sh 내 EXCLUDE_PATTERNS
- [x] **T1.4** EBS+S3 메타데이터 스키마 설계 (.metadata.json) ✅ s3-sync.sh 내 metadata 업데이트
- [x] **T1.5** CDK EcsDevenvStack에 S3 버킷 + DynamoDB + EBS Lambda 추가 ✅ `04-ecs-devenv-stack.ts`
- [x] **T1.6** aws-clients.ts에 Lambda client + S3_SYNC_BUCKET 환경변수 추가 ✅
- [ ] **T1.7** Cognito SAML/OIDC Federation 설정 (CDK) - Enterprise IdP 연동 필요
- [x] **T1.8** Cognito 그룹 확장: dept-manager 추가 ✅ `02-security-stack.ts`
- [ ] **T1.9** NextAuth.js에 SAML provider + 역할 매핑 추가
- [x] **T1.10** DynamoDB 테이블 생성: department-budgets ✅ `03-usage-tracking-stack.ts`, user-volumes ✅ `04-ecs-devenv-stack.ts`
- [ ] **T1.11** 예산 Lambda 확장: 부서 월간 + 개인 일일 한도 체크

## Phase 2: User Experience (4주)

- [ ] **T2.1** User Portal 페이지 구현 (/user) 🔄 진행 중 (에이전트 실행)
- [ ] **T2.2** 사용자 셀프서비스 컨테이너 시작/중지 API 🔄
- [ ] **T2.3** Dept Manager Dashboard 페이지 (/dept) 🔄
- [ ] **T2.4** 승인 큐 UI + API (컨테이너 접근 승인) 🔄
- [ ] **T2.5** Admin Dashboard 토큰 사용량 차트 (Recharts)
- [ ] **T2.6** 부서별/사용자별 예산 설정 Admin UI
- [ ] **T2.7** 사용자 본인 토큰 사용량 조회 API + UI
- [ ] **T2.8** EBS 증설 요청/승인 플로우 (UI + Lambda)
- [ ] **T2.9** middleware.ts 역할별 라우트 분리 확장 🔄

## Phase 3: Scale & Operations (4주)

- [ ] **T3.1** NLB 전환 (CDK: ALB → NLB)
- [ ] **T3.2** Nginx ECS Service 구현 (Task Definition + Service)
- [ ] **T3.3** Nginx config 동적 생성 Lambda (DynamoDB Stream trigger)
- [ ] **T3.4** DynamoDB routing-table 테이블 + Stream 설정
- [ ] **T3.5** Nginx S3 polling + reload 메커니즘
- [x] **T3.6** idle-monitor.sh - 기존 유지 (entrypoint에 SIGTERM trap 추가 완료) ✅
- [ ] **T3.7** Warm Stop Lambda (Level 1→2 전환, EBS snapshot, S3 sync) 🔄 진행 중
- [ ] **T3.8** Warm Resume Lambda (snapshot/S3 복원) 🔄
- [ ] **T3.9** Keep Alive API endpoint + SNS 알림 연동
- [ ] **T3.10** EventBridge 업무시간 스케줄 (ASG min 조정) 🔄
- [ ] **T3.11** 사용자 티어 선택 UI + 부서별 허용 티어 정책
- [ ] **T3.12** 프롬프트 감사: CloudTrail Data Event + DynamoDB audit 테이블

## Phase 4: Hardening (2주)

- [x] **T4.1** 보안 리뷰 주요 이슈 수정 ✅ commit `835befd` (hardcoded ID, password, IAM, ALB, EFS, cognito)
- [ ] **T4.2** 폐쇄망 프록시 설정 (entrypoint.sh HTTP_PROXY 자동 설정)
- [ ] **T4.3** CodeArtifact npm 미러 + ECR 프라이빗 레지스트리 설정
- [ ] **T4.4** DR 전략: S3 Cross-Region Replication 설정
- [ ] **T4.5** Locust 부하 테스트 스크립트 작성 (1000명 동시)
- [ ] **T4.6** 비용 모니터링 대시보드 (Cost Explorer API 연동)

## Terraform/CloudFormation 동기화

- [ ] **TF1** S3 버킷 + DynamoDB user-volumes 테이블 🔄 진행 중
- [ ] **TF2** dept-manager Cognito 그룹 🔄
- [ ] **TF3** department-budgets DynamoDB 테이블 🔄
- [ ] **CFN1** S3 버킷 + DynamoDB user-volumes 테이블 🔄
- [ ] **CFN2** dept-manager Cognito 그룹 🔄
- [ ] **CFN3** department-budgets DynamoDB 테이블 🔄

---
**범례**: ✅ 완료 | 🔄 진행 중 | 빈칸 = 미착수
