# CC-on-Bedrock Enterprise Edition - Task 목록

> 생성일: 2026-03-26 | 마지막 업데이트: 2026-03-26 (최종)
> 진행률: **37/39 완료 (95%)**

## Phase 1: Foundation

- [x] **T1.1** EBS lifecycle Lambda ✅
- [x] **T1.2** S3 sync 스크립트 ✅
- [x] **T1.3** .s3ignore 패턴 ✅
- [x] **T1.4** EBS+S3 메타데이터 ✅
- [x] **T1.5** CDK S3 + DynamoDB + Lambda ✅
- [x] **T1.6** aws-clients.ts Lambda/S3 연동 ✅
- [ ] **T1.7** Cognito SAML/OIDC Federation - 고객 IdP 필요
- [x] **T1.8** Cognito dept-manager 그룹 ✅
- [ ] **T1.9** NextAuth.js SAML provider - IdP 연동 후
- [x] **T1.10** DynamoDB: department-budgets + user-volumes + user-budgets ✅
- [x] **T1.11** 예산 Lambda: 부서 월간 + 개인 일일 ✅

## Phase 2: User Experience

- [x] **T2.1** User Portal ✅
- [x] **T2.2** 셀프서비스 컨테이너 API ✅
- [x] **T2.3** Dept Dashboard ✅
- [x] **T2.4** 승인 큐 API ✅
- [x] **T2.5** Admin 토큰 차트 ✅
- [x] **T2.6** 예산 설정 Admin UI ✅
- [x] **T2.7** 사용자 토큰 조회 ✅
- [x] **T2.8** EBS 증설 요청/승인 ✅
- [x] **T2.9** middleware 역할별 라우트 ✅

## Phase 3: Scale & Operations

- [x] **T3.1** DynamoDB routing-table + Stream ✅
- [x] **T3.2** Nginx Dockerfile + config template ✅
- [x] **T3.3** Nginx config Lambda (DynamoDB Stream) ✅
- [x] **T3.4** Nginx S3 polling + reload ✅
- [x] **T3.5** CDK routing 리소스 ✅
- [x] **T3.6** entrypoint SIGTERM trap ✅
- [x] **T3.7** Warm Stop Lambda ✅
- [x] **T3.8** Idle Check Lambda ✅
- [x] **T3.9** Keep Alive API ✅
- [x] **T3.10** EventBridge 스케줄 ✅
- [x] **T3.11** 티어 선택 UI + 부서별 정책 ✅
- [x] **T3.12** 프롬프트 감사 ✅

## Phase 4: Hardening

- [x] **T4.1** 보안 리뷰 이슈 수정 ✅
- [x] **T4.2** 폐쇄망 프록시 설정 ✅
- [ ] T4.3 CodeArtifact npm 미러 - 배포 환경별 설정
- [ ] T4.4 DR: S3 Cross-Region Replication - 배포 후
- [ ] T4.5 Locust 부하 테스트 - 배포 후
- [ ] T4.6 비용 모니터링 대시보드 - 배포 후

## TF/CFN 동기화

- [x] TF/CFN: S3 + DynamoDB + Cognito ✅

---
**미착수 2개**: SAML/OIDC (고객 IdP 필요)
**배포 후 4개**: CodeArtifact, DR, 부하테스트, 비용대시보드
