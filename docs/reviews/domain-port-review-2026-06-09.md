# 도메인 관리 & 프론트엔드 포트 노출 리뷰 (2026-06-09)

> 멀티 AI 협업(co-agent). 패널: **Kiro CLI · Codex · Gemini** (3개 전부 응답).
> **Claude 가 chair** — 패널 의견을 실제 코드와 대조 검증 후 작성. 다수결이 아니라 코드 확인 기반.
> 범위 A: Route53 / DNS Firewall(DLP 도메인 차단·허용) / CloudFront split. 범위 B: 보안그룹 포트 노출 / Nginx per-user 라우팅 / X-Custom-Secret 게이트.

## 판정: **REVIEW 필요** (Critical 0 · High 5 · Medium 9 · Low 6)

두 서브시스템 모두 동작은 하나, **fail-open(시크릿 부재 시 통과)**, **테넌트 격리 갭(VPC CIDR ingress)**,
**DLP 상태 불일치(Route53↔DDB)**, **시크릿 평문 노출(CFN 템플릿)** 이 핵심. 모두 수정 가능.

---

## A. 도메인 관리

### HIGH
**A-H1. DNS Firewall rule-group 자동탐색이 엉뚱한 그룹을 고르고 영구 캐시** — `api/admin/dlp/domains/route.ts:34-46`
`VPC_ID` 비어있으면 계정/리전 association 전체에서 name 매칭 또는 **첫 번째**를 선택 후 `cachedRuleGroupId` 에 영구 핀.
잘못된 rule group 에 도메인 차단룰을 쓰거나, 그룹 교체(재배포) 시 stale → `ResourceNotFound` 로 보안제어 다운.
→ `DNS_FIREWALL_RULE_GROUP_ID` 필수화 + VPC/name 검증, first-association fallback 제거, `ResourceNotFound` 시 재탐색.
*[Codex HIGH + Gemini HIGH 합의, chair 코드 확인]*

**A-H2. DLP 변경이 Route53 먼저 커밋 후 DDB → 실패 시 상태 불일치 / 삭제 시 resolver 정리 실패를 묵살** — `route.ts` (POST ~166, DELETE ~336)
Route53 룰/리스트 생성 후 DDB 기록 실패하거나, 삭제 때 resolver 정리 실패를 삼키면 **고아 firewall 룰/리스트**가 남고 UI 와 desync → AWS 쿼터 소진.
→ `PENDING`/`DELETING` 상태머신, 실패 시 보상 삭제 또는 fail-closed.
*[Codex HIGH×2 + Gemini MEDIUM×2]*

### MEDIUM
- **A-M1. 우선순위 할당 race + 비페이지네이션 + 관리형 BLOCK이 ALLOW보다 먼저** — 관리형 위협리스트 priority 100–400, 관리자 ALLOW는 500 → **ALLOW가 관리형 BLOCK을 override 못 함**. 동시 생성 시 priority 충돌(ConflictException) 미처리, `ListFirewallRules` 미페이지네이션. → DDB 조건부 allocator + 페이지네이션, 의도된 allow는 더 낮은 priority. *[Codex MED + Kiro HIGH + Gemini MED]*
- **A-M2. PUT 입력검증 부재 / 비멱등 / BatchWrite UnprocessedItems 무시** — `action`·도메인 형식 미검증으로 Route53까지 도달, `Date.now()` 기반 ID라 재시도 시 중복 리스트/룰 생성, BatchWrite 미처리 항목 누락을 성공으로 보고. → POST 검증 재사용, client token/결정적 ID, UnprocessedItems 재시도. *[Codex MED×3]*
- **A-M3. 와일드카드 Route53 레코드를 cert/hostedZone 보장 없이 생성** — `04-ecs-devenv-stack.ts:463` (+ hostedZone 미설정 시 silent skip). → cert/zone 없으면 synth 실패하도록 가드. *[Codex MED + Kiro MED]*
- **A-M4. Dashboard CloudFront에는 origin 시크릿 헤더 게이트 없음** — prefix-list SG에만 의존. → ALB origin에도 X-Custom-Secret 추가 검토. *[Kiro MED]*

### LOW
- **A-L1. 관리형 DNS Firewall 리스트 ID 하드코딩(리전 종속)** — `01-network-stack.ts:97-107` `rslvr-fdl-...` ap-northeast-2 고정. **프로젝트 "하드코딩 금지" 규칙 위반** + 타 리전 배포 시 무효 ID로 fail-open. → 런타임 `listFirewallDomainLists` 조회 or 리전 맵. *[3 AI 전부 합의]*
- **A-L2. 관리자 mutating API에 CSRF/Origin 검증 없음** — `route.ts:89` 등. → CSRF 토큰 또는 Origin/Referer 검사. *[Codex LOW]*

---

## B. 프론트엔드 / 포트 노출

### HIGH
**B-H1. Nginx 설정에 subdomain 주입 가능 (검증 부재 2중 갭)** — `nginx-config-gen.py:304,321,329` + `aws-clients.ts:276 registerContainerRoute`
routing-table 의 `subdomain`/`container_ip` 를 검증 없이 `.format()` 으로 nginx 지시문에 직접 보간. `validation.ts:3` 에 subdomain 정규식이 **있지만** DDB 기록(`registerContainerRoute`)과 config-gen 양쪽에서 미적용. subdomain은 Cognito `custom:subdomain` 출처 → **(이전 보안리뷰 H1 미배포 상태에서는 사용자가 자가 설정 가능)** → `user1; location /evil {...}` 류 config injection 체인.
→ config-gen에서 `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` 검증·미매칭 행 skip, write-path에도 동일 검증. (※ 직전 보안리뷰 H1 배포가 이 체인을 함께 차단함)
*[Kiro CRITICAL + Codex HIGH, chair 검증]*

**B-H2. CLOUDFRONT_SECRET 미설정 시 fail-open** — `nginx-config-gen.py:35` `os.environ.get("CLOUDFRONT_SECRET", "")`
빈 문자열이면 `$http_x_custom_secret != $cf_secret` 에서 **헤더 없는 요청("")이 빈 시크릿과 일치 → 게이트 통과**. cold-start 시 템플릿의 리터럴 `{{CLOUDFRONT_SECRET}}` fallback 도 동일 위험.
→ 시크릿 비었으면 config 생성 중단/deny-all, 템플릿 기본값을 추측불가 값 또는 무조건 503.
*[Codex HIGH + Kiro HIGH, chair 확인]*

**B-H3. DevEnv 보안그룹 ingress가 Nginx SG가 아닌 전체 VPC CIDR** — `07-ec2-devenv-stack.ts:58,67,80`
8080/3000/8000을 `ec2.Peer.ipv4(config.vpcCidr)` 로 개방 → VPC 내 임의 워크로드(타 사용자 DevEnv 포함)가 **다른 사용자의 frontend(3000)/API(8000)에 Nginx·X-Custom-Secret 게이트 우회하여 직접 접근**. (code-server 8080은 자체 비밀번호가 있어 부분 완화, frontend/api는 무인증.)
→ ingress source를 Nginx 서비스 SG(또는 전용 routing SG)로 제한.
*[3 AI 전부 합의, chair 코드 확인]*

### MEDIUM
- **B-M1. CloudFront 시크릿이 CFN 템플릿에 평문(unsafeUnwrap)** — `04-ecs-devenv-stack.ts:281`(Lambda env), `:437`(CF customHeaders), 그리고 생성된 nginx.conf(S3)에도 리터럴 포함. `cloudformation:GetTemplate`/`lambda:GetFunctionConfiguration`/S3 read로 추출 → 게이트 우회. (:281은 런타임 GetSecretValue로 수정 가능; :437은 CF 정적헤더 제약 → 회전+템플릿 접근제한으로 완화.) *[Kiro CRIT + Gemini CRIT + Codex, chair 확인 — 다층 노출이라 운영영향 HIGH지만 직접 익스플로잇은 IAM 선행 필요 → MEDIUM]*
- **B-M2. CloudFront→NLB HTTP_ONLY (시크릿·페이로드 평문)** — `04-ecs-devenv-stack.ts:435`. CloudFront-origin 구간이 공인망 평문 → 소스코드·인증헤더 노출. → HTTPS origin 또는 private(VPC) origin. *[Codex MED + Gemini MED]*
- **B-M3. container_ip/privateIp 형식검증 없이 기록·보간** — `aws-clients.ts:287`, `nginx-config-gen.py:322`. DescribeInstances(AWS) 출처라 공격자 통제 낮으나 버그 시 SSRF/오프록시. → RFC1918 + VPC CIDR 검증. *[Kiro CRIT/Codex HIGH → chair MED]*
- **B-M4. /nginx-status 무인증 노출** — `nginx-config-gen.py:98`, 기본 server 블록이 X-Custom-Secret 검사 없이 stub_status 공개. NLB 직결(게이트 우회) 시 정찰 가능. → 시크릿 게이트 적용 또는 localhost 바인딩. *[Kiro HIGH/Codex MED → MED]*
- **B-M5. 기본 server 블록이 X-Auth-User 신뢰** — per-user 블록은 `X-Auth-User ""` 로 클리어하나 기본 블록은 클라이언트 값 신뢰(시크릿 게이트가 선행이라 defense-in-depth). → 기본 블록에서도 X-Auth-User 클리어. *[Codex MED + Kiro MED]*
- **B-M6. restricted egress가 임의 443 + 공용 DNS 허용 → DNS Firewall 우회** — `07-ec2-devenv-stack.ts:70-72`. DoH/외부DNS/직접 IP로 DNS Firewall 의도 우회 가능. → DNS를 Resolver로 강제, egress proxy 통제. *[Codex MED]*

### LOW
- **B-L1. `/api`(슬래시 없음)→frontend, `?folder=` 빈값→code-server 미라우팅** — `nginx-config-gen.py:216,233`. → `location = /api` 추가, 빈 folder는 raw query 매칭. *[Codex LOW]*
- **B-L2. session-validator subdomain 문자검증 취약** — `devenv-session-validator/index.js`. `.` 포함만 확인, `^[a-z0-9-]+$` 미강제. (소유권 검사가 악용은 차단) *[Kiro MED → LOW]*
- **B-L3. reload.sh cold-start 윈도우 / UserData `|| true`·`2>/dev/null` 로 setup 실패 묵살** — 깨진 인스턴스가 "running"으로 보임. → 핵심 블록 `set -e` + 영속 로그. *[Kiro LOW + Gemini LOW]*

---

## 잘 되어 있는 점 (검증됨)
- 외부 노출 포트는 **정확히 8080/3000/8000 3개만** ingress (Codex/Claude 확인). `0.0.0.0/0` ingress·하드코딩 `atomai.click` 없음(리뷰 파일 기준).
- Nginx 우선순위 라우팅(code-server 내부경로 → ?folder= → /api → /) 설계 명확(ADR-009).
- per-user server 블록의 `X-Auth-User == subdomain` defense-in-depth 검사 존재.
- CloudFront split(ADR-016)로 Dashboard/DevEnv 배포 분리.

## 권장 우선순위
1. **B-H2 fail-open** + **B-H3 VPC CIDR ingress** — 가장 직접적인 격리/게이트 약점.
2. **A-H1 rule-group 오탐** + **A-H2 DLP 상태 불일치** — 보안제어 신뢰성.
3. **B-H1 subdomain 주입** — 직전 보안리뷰 **H1 배포**가 핵심 완화책이므로 함께 진행.
4. B-M1/M2 시크릿 평문·평문전송, A-M1 priority override.
