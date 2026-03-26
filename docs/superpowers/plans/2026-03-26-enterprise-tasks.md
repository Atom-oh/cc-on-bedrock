# CC-on-Bedrock Enterprise Edition - Task 목록

> 생성일: 2026-03-26 | 설계 문서: [enterprise-edition-design.md](../specs/2026-03-26-enterprise-edition-design.md)
> 마지막 업데이트: 2026-03-26 (최종)

## Phase 1: Foundation

- [x] **T1.1** EBS lifecycle Lambda ✅ `cdk/lib/lambda/ebs-lifecycle.py`
- [x] **T1.2** S3 sync 스크립트 ✅ `docker/devenv/scripts/s3-sync.sh` + entrypoint.sh
- [x] **T1.3** .s3ignore 패턴 ✅ s3-sync.sh EXCLUDE_PATTERNS
- [x] **T1.4** EBS+S3 메타데이터 ✅ .metadata.json
- [x] **T1.5** CDK S3 + DynamoDB + Lambda ✅ `04-ecs-devenv-stack.ts`
- [x] **T1.6** aws-clients.ts Lambda/S3 연동 ✅
- [ ] **T1.7** Cognito SAML/OIDC Federation - 고객 IdP 연동 필요
- [x] **T1.8** Cognito dept-manager 그룹 ✅ CDK/TF/CFN
- [ ] **T1.9** NextAuth.js SAML provider - IdP 연동 후
- [x] **T1.10** DynamoDB: department-budgets + user-volumes ✅ CDK/TF/CFN
- [ ] **T1.11** 예산 Lambda 부서/개인 한도 체크

## Phase 2: User Experience

- [x] **T2.1** User Portal ✅ `/user`
- [x] **T2.2** 셀프서비스 컨테이너 API ✅ `/api/user/container`
- [x] **T2.3** Dept Dashboard ✅ `/dept`
- [x] **T2.4** 승인 큐 API ✅ `/api/dept`
- [x] **T2.5** Admin 토큰 사용량 차트 ✅ `/admin/tokens`
- [x] **T2.6** 예산 설정 Admin UI ✅ `/admin/budgets`
- [x] **T2.7** 사용자 토큰 조회 API ✅ `/api/user/usage`
- [ ] **T2.8** EBS 증설 요청/승인 플로우
- [x] **T2.9** middleware 역할별 라우트 ✅

## Phase 3: Scale & Operations

- [ ] **T3.1** NLB 전환 - 별도 세션
- [ ] **T3.2** Nginx ECS Service - 별도 세션
- [ ] **T3.3** Nginx config Lambda - 별도 세션
- [ ] **T3.4** DynamoDB routing-table - 별도 세션
- [ ] **T3.5** Nginx S3 polling - 별도 세션
- [x] **T3.6** entrypoint SIGTERM trap ✅
- [x] **T3.7** Warm Stop Lambda ✅ `warm-stop.py`
- [x] **T3.8** Idle Check Lambda ✅ `idle-check.py`
- [x] **T3.9** Keep Alive API ✅ `/api/user/keep-alive`
- [x] **T3.10** EventBridge 스케줄 ✅ idle 5분 + EOD 18:00
- [ ] **T3.11** 사용자 티어 선택 UI
- [x] **T3.12** 프롬프트 감사 ✅ `audit-logger.py` + DynamoDB + EventBridge

## Phase 4: Hardening

- [x] **T4.1** 보안 리뷰 이슈 수정 ✅ commit `835befd`
- [x] **T4.2** 폐쇄망 프록시 설정 ✅ entrypoint.sh HTTP_PROXY
- [ ] **T4.3** CodeArtifact npm 미러
- [ ] **T4.4** DR: S3 Cross-Region Replication
- [ ] **T4.5** Locust 부하 테스트
- [ ] **T4.6** 비용 모니터링 대시보드

## TF/CFN 동기화

- [x] **TF1~3** S3 + DynamoDB + Cognito ✅
- [x] **CFN1~3** S3 + DynamoDB + Cognito ✅

---
**진행률**: 31/39 완료 (79%)
**미착수 8개**: NLB+Nginx (5), SAML (2), 예산Lambda (1) + EBS증설/티어UI/DR/부하테스트/비용대시보드
