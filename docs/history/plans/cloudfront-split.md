# 작업계획서: CloudFront 분리 (ADR-016)

> 작성: 2026-05-12 | 상태: 계획 중 | 관련 ADR: ADR-016 (supersedes ADR-013)

## 배경
ADR-013 통합 CloudFront 구조가 (a) ACM wildcard cert 깊이 제약, (b) Stack 04 ↔ 05 강결합 두 문제를 일으켰다. 도메인별 distribution으로 분리해 양 문제를 동시 해소한다.

## 목표
1. Dashboard CF는 Stack 05에 유지, alias = `cconbedrock-dashboard.atomai.click` 만
2. DevEnv CF를 Stack 04로 이관, alias = `*.dev.atomai.click`, cert = `*.dev.atomai.click` 전용
3. session-validator Lambda@Edge는 한 번만 정의해 양 distribution에서 참조
4. origin-router Lambda@Edge 제거
5. `governanceOnly=true`에서 Stack 04 instantiation 완전 skip 가능 (ADR-014 정합)
6. ADR-013 status를 Superseded로 갱신

## 작업 항목

### Phase A: CDK 코드 (Day 1)

- [ ] **A-1. 새 cert context 도입** (`bin/app.ts`)
  - `dashboardCertArn` (us-east-1 ACM, `*.atomai.click` 또는 dashboard 전용)
  - `devenvCertArn` (us-east-1 ACM, `*.dev.atomai.click` 전용 — 기존 `85c9ded8-...`)
  - `unifiedCertArn` context는 deprecation 경고 후 제거

- [ ] **A-2. Stack 05 슬림화** (`05-dashboard-stack.ts`)
  - `DashboardStackProps`에서 제거: `sgOpen`, `sgRestricted`, `sgLocked`, `nlbDnsName`, `dnsFirewallRuleGroupId` (Stack 04로 이동)
  - CloudFront `domainNames`에서 `*.dev.*` 제거. dashboard 도메인만 alias로 갖는다.
  - `OriginRouterConfigParam` SSM, `originRouterFn` EdgeFunction, 관련 IAM 정책 제거
  - `edgeLambdas`에서 ORIGIN_REQUEST 제거(VIEWER_REQUEST만 유지)
  - SessionValidator EdgeFunction의 currentVersion edgeArn을 SSM Parameter로 export: `/cc-on-bedrock/session-validator-version-arn`
  - 관련 ECS 컨테이너 env에서 `SG_DEVENV_*`, `ROUTING_TABLE`, `ECS_INFRASTRUCTURE_ROLE_ARN` 제거 또는 `governanceOnly` 시 빈 값 전달(컨테이너 코드는 LOCAL_MODE 가드로 회피)

- [ ] **A-3. Stack 04 확장** (`04-ecs-devenv-stack.ts`)
  - 신규 CloudFront distribution 추가: NLB origin (X-Custom-Secret 헤더 통과 유지), aliases = `*.dev.atomai.click`, cert = `devenvCertArn` context
  - SessionValidator는 SSM에서 ARN 읽어 `CfnDistribution.LambdaFunctionAssociation`으로 raw 참조 (CDK L2 EdgeFunction은 동일 인스턴스 cross-stack 공유 어려움)
  - Route 53 `*.dev.atomai.click` A/AAAA alias 레코드 추가 (Stack 04에서 직접)
  - WAF WebACL ARN cross-region reference로 attach (기존 패턴 재사용)
  - dnsFirewallRuleGroupId 참조는 Stack 04로 이관 (NLB 보안에 사용 중이라면)

- [ ] **A-4. `bin/app.ts` 정리**
  - `governanceOnly=true` 시 Stack 04 instantiation skip
  - Stack 05 props에서 Stack 04 의존 모두 제거
  - 새 context flag 입력 라인 추가
  - 콘솔 로그에 두 cert ARN 표기

- [ ] **A-5. 함수 자체 삭제는 마지막 단계로 분리**
  - originRouter Lambda 함수와 SSM 파라미터 삭제 commit은 cutover Step 4에서. Step 1-3 deploy까지는 함수 본문은 남겨둔 채 distribution 연결만 해제.

### Phase B: Network DnsFirewallRuleGroup 정상화 (Day 1)

같은 PR에 포함. ADR-016과는 별건이지만 stack 롤백을 풀어둬야 모든 deploy가 가능해진다.

- [x] **B-1. `01-network-stack.ts` 코드 확인**
  - 이미 commit `f308f9d` (2026-04-10)에서 ID-based로 수정됨 (`rslvr-fdl-1997a3cdd61a4f2a` 등 하드코딩)
  - 롤백을 일으킨 deploy는 2026-04-09(수정 직전)분이었음. **코드는 현재 정상**.
  - 2026-04-17 시도가 또 cancelled된 이유는 `EcsDevenv`가 사용 중인 subnet export를 못 지워서 (코드 문제가 아닌 export-in-use)

- [ ] **B-2. 정상 deploy로 forward-fix**
  - 위 사실로 인해 `continue-update-rollback`은 불필요. 다음 `cdk deploy CcOnBedrock-Network` (다른 cross-stack reference 변경 없음)이면 NO-OP 또는 정상 UPDATE_COMPLETE로 빠져나옴
  - 만약 4-17 시도가 무엇을 바꾸려 했는지 알면(예: subnet CIDR), 그 변경을 EcsDevenv와 동시에 처리해야 함

### Phase C: 문서 (Day 1)

- [ ] **C-1. `docs/decisions/ADR-013-unified-cloudfront-auth.md`** status 줄을 "Superseded by ADR-016" 으로 갱신, 상단에 짧은 supersession note
- [ ] **C-2. `docs/architecture.md` CloudFront 다이어그램 갱신 (2개 distribution)
- [ ] **C-3. `cdk/CLAUDE.md` Stack 04/05 책임 문구 재기술
- [ ] **C-4. `docs/deployment-guide.md` cert 발급 절차에서 unifiedCert 단락 제거, devenvCertArn 안내 추가
- [ ] **C-5. README 업데이트 (Deployment Profiles 표에 단일 CF 표현 제거)

### Phase D: Cutover (Day 2)

각 단계 사이 5-15분 대기.

- [ ] **D-1. Step 1 — Stack 04에 DevEnv CF 추가 deploy**
  - `cdk deploy CcOnBedrock-EcsDevenv -c devenvCertArn=arn:aws:acm:us-east-1:...:certificate/85c9ded8-...`
  - DNS는 아직 통합 CF를 가리킴. 신규 CF는 idle 상태로 Deployed.

- [ ] **D-2. Step 2 — Route 53 전환**
  - Stack 04 두 번째 deploy 또는 manual change: `*.dev.atomai.click` alias를 신규 CF로 변경
  - TTL 60s 기준 ~2분 후 트래픽 이동
  - CloudWatch Logs로 신규 CF에 트래픽 도달 확인

- [ ] **D-3. Step 3 — Stack 05에서 DevEnv 동작 제거 deploy**
  - `cdk deploy CcOnBedrock-Dashboard`
  - distribution aliases에서 `*.dev` 제거, originRouter edge 연결 해제
  - Lambda@Edge dissociation 후 함수 삭제 시도는 propagation 완료(~15분) 후

- [ ] **D-4. Step 4 — Lambda 함수/SSM 정리**
  - originRouter Lambda function 삭제 (replication 잔류 IAM/log group은 그대로 두거나 별도 cleanup)
  - `/cc-on-bedrock/devenv-origin-config` SSM 파라미터 삭제
  - 통합 CF 시절의 ACM cert 가운데 사용 안 하는 것 정리(선택)

### Phase E: ADR-014 재배포 (별 PR — 후속)

- [ ] **E-1. ADR-014 branch를 main(=ADR-016 머지 후) 기준으로 rebase
- [ ] **E-2. `bin/app.ts`의 `governanceOnly=true` 시 Stack 04 skip이 실제로 동작하는지 재확인 (이제 Dashboard가 04에 의존 없음)
- [ ] **E-3. LocalGovernance stack deploy + 03 (usage table Stream 활성화) 동시 deploy
- [ ] **E-4. Dashboard 환경변수 추가: `STS_ISSUER_FUNCTION_NAME`, `LIMITS_TABLE`, `NEXT_PUBLIC_LOCAL_MODE_ENABLED=true`
- [ ] **E-5. E2E 테스트 (`tests/integration/test-local-governance.sh`)

## 검증 기준

1. `cdk synth` 양 모드(`governanceOnly` true/false) 모두 성공
2. `cdk list -c governanceOnly=true`에서 Stack 04, 07 모두 빠지고 `LocalGovernance` 포함
3. 분리 후 두 도메인 모두 정상 접속:
   - `https://cconbedrock-dashboard.atomai.click` (Dashboard)
   - `https://test-user.dev.atomai.click` (DevEnv, 임의 활성 사용자)
4. NextAuth 세션 쿠키가 두 도메인 사이 정상 전달 (Dashboard 로그인 후 DevEnv 접속 시 자동 인증)
5. Lambda@Edge logs에 originRouter 호출 0 (제거 확인)
6. CloudFormation에 `CcOnBedrock-Network`, `CcOnBedrock-Dashboard` 모두 `UPDATE_COMPLETE` 상태

## 위험 / 롤백 시나리오

- **Step 2 DNS 전환 후 새 CF에서 인증 실패**: Route 53 record를 통합 CF로 되돌리기 (~2분). session-validator가 동일 함수이므로 인증 자체는 항상 작동해야 함. 의심 원인 1순위 = cert mismatch.
- **Step 3 deploy 중 dashboard 접근 실패**: edge replication propagation 중 일시 5xx 가능. 야간 배포로 영향 최소화.
- **AWS Managed Rule list ID region**: ap-northeast-2 외 region 배포 시 ID 다름. ID 조회 로직을 CDK가 갖도록 정정.

## Out of Scope
- Lambda@Edge 함수 자체 통폐합/리팩토링은 별도
- CloudFront cache 정책 / WAF rule 조정
- ADR-013에서 도입한 다른 보안 헤더(X-Custom-Secret, prefix list) 유지
- 사용자 가시 도메인 변경 없음

## 의존 / 영향
- 본 ADR이 머지된 후 ADR-014 PR을 rebase해야 깔끔히 동작
- Network rollback 정리는 다음 deploy의 선결 조건
