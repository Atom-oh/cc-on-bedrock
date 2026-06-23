---
status: Accepted
date: 2026-06-23
consolidates: [ADR-005, ADR-020, ADR-021, ADR-030, ADR-034, ADR-026]
---

# 007: IAM 접근통제 (DLP 3-tier · 셀프서비스 신청+admin 승인 · boundary X · runtime upsert)

## Status

Accepted (2026-06-23)

## Context

per-user EC2 DevEnv(ADR-004)와 Local Mode(ADR-014)에서 각 사용자는 독립 IAM 역할
(`cc-on-bedrock-task-{subdomain}` / `cc-on-bedrock-local-user-*`)을 갖는다. 4000-user
플랫폼에서 (a) 네트워크/데이터 유출(DLP) 차별화, (b) 기본 Bedrock 외 추가 AWS 권한 셀프서비스,
(c) 감사 추적 가능한 변경 통제, (d) "승인했는데 효력 0"(silent-deny) 제거, (e) 새 Claude 버전·
region prefix 출시에도 깨지지 않는 모델 권한이 동시에 필요하다.

Each per-user role must let a developer get real work done while a hard floor stops one user
from escalating into the account or other tenants. Architecture detail is owned by
`../architecture.md` (SSOT, pillar 7) — not re-derived here.

## Decision

네 갈래로 통제한다. Four interlocking mechanisms.

### 1. DLP 3-tier 보안 정책 (from ADR-005)

사용자별 보안 수준 **Open / Restricted / Locked** 3단계, Cognito `custom:security_policy`에 저장.
집행 레이어: Security Group(아웃바운드 범위) · code-server(file up/download·extension) · Extension 제어.
실행 중 인스턴스는 ENI SG swap(`changeSecurityPolicy()`, 재시작 불필요), 정지 인스턴스는 다음 Start 시 적용.

> **DNS Firewall 정정(ADR-005, 2026-06-11):** Route 53 Resolver DNS Firewall는 **VPC 단위로만**
> 연결되어 per-tier/per-instance 스코프가 불가능하다. 현 동작: AWS 관리형 위협 목록(BLOCK) +
> admin ALLOW/BLOCK 목록이 **VPC 전체 공통** 적용. admin UI의 tier 필드는 분류용 메타데이터일 뿐
> DNS 집행 스코프가 아니다.

The ADR-005 fixed **IAM Policy-Set Catalog** is **superseded by ADR-030** — only the DLP 3-tier
decision survives from ADR-005. IAM 확장 메커니즘의 현재 정본은 아래 §2–§3.

### 2. Tier 기반 셀프서비스 신청 + admin 승인 (request-time, from ADR-030; supersedes archived ADR-026)

모든 IAM 확장은 DynamoDB 기반 신청(`api/user/container-request` `type=iam_extension`) →
**admin 승인**(`api/admin/approval-requests`) → 역할에 inline policy 부착(감사 기록 포함).
신청은 고정 policy-set 선택이 아니라 **resource-specific 자유형**(구체 action + 구체 ARN)이며
`validateIamRequest`(`iam-request-validation.ts`)가 tier로 검증한다:

- **Tier-1 메타데이터**(`List*`/`Describe*`): 전 서비스, `Resource:*` 허용 (비-mutating).
- **Tier-2 데이터 읽기**(`Get*`/`Query*`/`Scan*`): 전 서비스, **concrete ARN 필수**(`Resource:*` 거부).
- **Tier-3 시크릿 읽기**: concrete secret ARN, path 와일드카드 금지.
- **Tier-4 쓰기**(`Put`/`Update`/`Delete`/`Create`): **write-allowlist 9개 서비스로 한정**.
- **dangerous 하드 거부**(`DEFAULT_DANGEROUS`): 권한위임·리소스정책 노출·공개화·교차계정 +
  whole-service deny 정합(`^(iam|organizations|account|sso|sso-directory|identitystore|ram):`,
  `^sts:(assumerole|getfederationtoken|getsessiontoken)`)으로 request-time에 거부.

부여는 **EC2 task + Local 역할 양쪽**에 적용한다(역할 부재는 skip, 기대 부착 실패는 fail-loud).
ADR-026의 per-service `GrantCeiling*` 천장 모델은 IAM 표현 한계(`*:Describe*` invalid)로 폐기됐다.
This is the **first-line control**: a human gates read/write scope and ARNs.

### 3. boundary X = AllowInAccount + DenyEscalation, **authored in Terraform** (from ADR-030 + ADR-034)

per-user 역할의 permission boundary `cc-on-bedrock-task-boundary`는 **하드 플로어**다.
ADR-026 service-ceiling을 대체하는 2-statement 구조:

- `AllowInAccount` — `Action:"*"`, `Resource:"*"`, `Condition StringEquals aws:ResourceAccount = <account>`.
  계정 내 임의 액션 허용, **교차계정은 fail-closed**(조건 미지원 서비스는 deny).
- 운영 baseline — account-less foundation-model 등 `aws:ResourceAccount`로 덮이지 않는 필수 권한은 명시 Allow.
- `DenyEscalation` — 합법적 dev 용도가 없는 escalation/노출 액션을 열거 deny(Deny always wins;
  `iam:*`/`organizations:*`/`sso*`/`ram:*`/`sts:AssumeRole*`/KMS 파괴/리소스정책 노출/공개 SG 등 ~63개).
  admin이 무엇을 승인하든 절대 넘을 수 없다.

**IaC 소유(ADR-034가 ADR-030 §T3 "CDK-only"를 대체):** CDK 폐기(ADR-033/001) 후 boundary는
**Terraform `security` 모듈(`terraform/modules/security/main.tf`)에서 단일 정본으로 작성**되고,
root `terraform/main.tf`가 `task_permission_boundary_arn`(항상 non-empty)을 ec2-devenv·local-governance
모듈에 주입해 boundary 없는 역할이 생성되지 않게 한다.

> **검증기 ⇄ boundary 불변식:** boundary가 deny하는 액션이 *신청가능* 서비스에 있으면 검증기도
> request-time에 거부해야 한다(silent-deny 제거). ADR-030의 `scripts/check-policyset-boundary.py`
> CI 게이트가 CDK synth 기준으로 이를 강제했으나, CDK 폐기로 현재는 `--self-test`(coverage 로직)만
> 돈다 — **TF plan/show 기반 boundary↔allowlist 재검증은 후속 추적**(ADR-034 미완 항목).
>
> **`*embed*` deny-floor TF 포팅(미완):** ADR-030의 DenyEscalation 63-action floor가 TF boundary에
> 완전 포팅되었는지는 ADR-034가 후속으로 추적한다(그동안 boundary는 ADR-026 ceiling + AllowInAccount/
> 운영 baseline을 강제). The current truth and any porting gap live in `terraform/CLAUDE.md`.

### 4. Wildcard Claude-family Bedrock IAM (from ADR-021)

Bedrock InvokeModel resource는 per-model-ID가 아니라 **Claude family + embeddings 와일드카드**로 매치:

```
arn:aws:bedrock:*::foundation-model/*anthropic.claude-*
arn:aws:bedrock:*:{account}:inference-profile/*anthropic.claude-*
arn:aws:bedrock:*:{account}:application-inference-profile/*
arn:aws:bedrock:*::foundation-model/*embed*               # ADR-021 addendum 2026-06-13
arn:aws:bedrock:*:{account}:inference-profile/*embed*
```

`global.`/`us.`/`apac.`/`eu.` region prefix와 `[1m]` variant suffix, 미래 Claude 버전을 모두 흡수한다.
Per-model spend control은 IAM 사전 차단이 아니라 **런타임 enforcer**(token-limit-enforcer ADR-014,
budget-check ADR-015)가 한도 초과 시 Deny 정책을 동적 부착해 담당한다. **scope 정정:** 허용 범위는
Claude family + **embeddings(`*embed*` — `amazon.titan-embed` 등 non-Anthropic 임베딩 포함)**이며,
`application-inference-profile/*`는 벤더 무관 와일드카드라 **계정 내 생성된 profile만 호출 가능하다는
계정-신뢰 전제** 위에서 동작한다(임의 외부 profile 호출 아님). 임의 non-Anthropic **foundation-model
직접 호출**은 검증기 allowlist 밖이라 셀프서비스로 추가할 수 없다. (즉 "non-Anthropic 전면 미허용"이
아니라 embeddings 허용 + profile은 계정-신뢰 전제.)

> **boundary X와의 관계(자주 제기되는 오해):** `AllowInAccount`(`Action:*`)는 §4의 Anthropic-only
> Bedrock ceiling을 **완화하지 않는다**. boundary는 cap일 뿐 grant가 아니다 —
> 유효 권한 = identity policy ∩ boundary. Bedrock grant는 identity policy에서 위 와일드카드로 한정된다.

### 5. Runtime policy/tag upsert (from ADR-020)

per-user 역할의 policy/tag는 일회성 마이그레이션 스크립트가 아니라 **인스턴스 시작 시점마다 항상 upsert**
한다(`ensureUserInstanceProfile()`: `PutRolePolicy`/`TagRole`를 try/catch **밖**에서 무조건 실행).
IAM API의 idempotency에 의존해 drift가 다음 start에 self-heal되고, 새 권한 정책은 코드 PR 단위로 점진 배포된다.
`migrate-role-tags.sh`는 제거됐다. 같은 upsert 패턴이 Local STS issuer(`sts-issuer.py:_ensure_role()`)에도 쓰여
§4 wildcard 마이그레이션이 다음 호출 시 자동 적용된다.

## Consequences

긍정 / Positive
- 모든 IAM 변경이 신청/승인으로 감사 추적됨; 4-layer DLP로 단일 레이어 우회 불가.
- boundary가 신청가능 서비스 추가마다 깨지지 않음 — read는 전 서비스, write는 admin 게이트, escalation은 하드 플로어.
- request-time 검증기와 runtime boundary가 신청가능 서비스에서 **일관**(silent-deny 제거).
- 새 Claude 버전/region prefix 출시 시 코드 변경 없이 토큰 추적·호출 유지(§4).
- drift가 다음 instance start에 self-heal(§5).

부정·위험 / Negative & risk
- boundary가 "in-account 거의 전부 허용"으로 넓어 통제가 **admin 승인 품질**에 더 의존 —
  완화: 검증기 dangerous 거부 + DenyEscalation 하드 플로어 + 컴퓨팅 confused-deputy 잔여위험 문서화.
- deny-floor는 비-신청가능 서비스의 모든 리소스정책 액션을 망라하지 못함(IAM 표현 벽); out-of-band 수동 부여가 잔여 벡터 — admin 운영 규율로 완화.
- **CI 불변식 약화(ADR-034):** `check-policyset-boundary.py`가 CDK synth 의존이라 CDK 폐기 후
  `--self-test`만 동작; **TF 기반 boundary↔allowlist 재검증 + deny-floor TF 포팅은 후속**(`terraform/CLAUDE.md`).
- **커플링:** request-time 검증기 변경은 boundary X 없이 단독 배포 금지(allowlist 밖 서비스가 검증 통과 후 silent-deny). 한 묶음으로 머지/배포.
- DLP 3단계로 못 덮는 중간 요구(예: HTTPS + 특정 IP만) 존재; per-tier DNS 화이트리스트는 별도 ADR 필요.

보안 / Security
- 최소권한은 boundary ARN 스코프가 아니라 **신청 검증(`Resource:*` 금지) + admin 승인**에서 주로 달성. **as-built 단서:** DenyEscalation 63-action floor의 TF 완전 포팅은 미완(follow-up, ADR-034)이라, 현행 boundary 강제는 **AllowInAccount + ADR-026 ceiling**이다(DenyEscalation 완비 후 강화).
- 0.0.0.0/0 · Principal:"*" · 평문 시크릿 도입 없음. boundary 정책은 Terraform 정본.

## Consolidates

- **ADR-005** (DLP 3-tier만 유효; IAM Policy-Set Catalog는 ADR-030이 대체)
- **ADR-020** (runtime IAM policy/tag upsert)
- **ADR-021** (wildcard Claude-family + embeddings Bedrock IAM)
- **ADR-030** (tiered IAM 신청 + boundary X; archived ADR-026 service-ceiling을 supersede)
- **ADR-034** (boundary를 Terraform에서 작성 — ADR-030 §T3 "CDK-only" 대체)
- **ADR-026** (archived; service-ceiling boundary, ADR-030으로 superseded)

레거시 ADR 본문은 트리에서 제거되었고 git tag `adr-legacy-2026-06-23` + `../history/ADR-MAPPING.md`에 보존된다. 번호 재사용 금지.
Legacy bodies live in git tag `adr-legacy-2026-06-23` and `../history/ADR-MAPPING.md`.
