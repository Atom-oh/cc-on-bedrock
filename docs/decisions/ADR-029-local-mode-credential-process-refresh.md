---
status: Accepted
date: 2026-06-12
verification_required: true
builds_on: ADR-014
---

# ADR-029: Local Mode 세션 중 자격증명 자동 갱신 — AWS SDK credential_process

**Status:** Accepted
**Date:** 2026-06-12
**Builds on:** [ADR-014 Local Governance Mode](ADR-014-local-governance-mode.md) · 관련 [ADR-022 EventBridge pre-provisioning](ADR-022-eventbridge-role-preprovisioning.md)

## 배경

Local Governance Mode의 STS 자격증명은 **1시간 하드캡**입니다. STS Issuer
Lambda(assumed role)가 사용자 role을 다시 AssumeRole하는 **role-chaining**
구조라서, role의 `MaxSessionDuration`과 무관하게 AWS가 세션을 1시간으로
제한합니다 (ADR-014의 8h 의도는 달성 불가).

기존 CLI(`cc-bedrock-local.sh`)의 갱신은 **런치 타임 전용**이었습니다: `cc`
실행 시점에 남은 TTL이 10분 미만이면 재발급. 일단 `claude`가 exec되면 정적
키가 `~/.aws/credentials`에 박힌 채로 돌아가므로, **1시간을 넘는 연속
세션은 도중에 `ExpiredToken`으로 죽습니다.** 실사용에서 세션이 수십 시간
지속되므로(사용자 요구사항: "업무 중 세션이 끊기면 안 됨") 이 갭은 치명적입니다.

실측(2026-06-12, psungbum role 직접 발급): 발급→만료 정확히 60.0분.

## 검토한 옵션

### 옵션 1: AWS SDK `credential_process` 훅 (채택)

`~/.aws/credentials`의 정적 키 대신 `~/.aws/config`에 등록:

```ini
[profile cc-bedrock]
credential_process = /path/to/cc-bedrock-local.sh credential-process
region = ap-northeast-2
```

AWS SDK는 자격증명이 필요할 때(그리고 반환된 `Expiration`이 임박할 때마다)
이 명령을 자동 재호출합니다. 훅은 캐시 TTL > 5분이면 캐시에서 즉시 응답하고,
아니면 Cognito refresh token → access token → Dashboard STS 교환을 무인으로
수행합니다.

- **장점**: SDK 표준 메커니즘 — 데몬/cron/백그라운드 프로세스 불필요.
  세션 길이 무제한(30일 Cognito refresh token이 한계). Claude Code 수정 불필요.
  훅 실패 시 SDK가 에러를 표면화해 사용자가 `login` 한 번으로 복구.
- **단점**: 훅은 절대 프롬프트 불가(헤드리스) — refresh token 만료 시(30일)
  세션 중간에 한 번 에러 후 재로그인 필요. SDK 호출마다 프로세스 spawn
  오버헤드(캐시 히트 시 ~수십 ms, 무시 가능).

### 옵션 2: 백그라운드 갱신 데몬 (CLI가 타이머로 credentials 파일 재작성)

- **장점**: credential_process 미지원 도구도 커버.
- **단점**: 데몬 수명 관리(로그아웃/슬립/재부팅), 플랫폼별 차이(macOS/Linux),
  파일 race. AWS SDK 사용처(Claude Code)에는 과잉 설계. 기각.

### 옵션 3: STS Issuer를 role-chaining 없이 재설계 (Lambda가 직접 user 자격증명 발급)

장수명 세션을 토큰 자체로 해결 (예: Cognito Identity Pool, 또는 사용자별
IAM User + 키 발급).

- **장점**: 1h 캡 자체가 사라짐.
- **단점**: ADR-014의 거버넌스 모델(per-user role + Deny policy 부착으로
  한도 차단) 전면 재설계. IAM User 키는 장기 자격증명이라 보안 후퇴.
  Deny 즉시 반영(1h 내 자연 만료)이라는 현재 장점도 상실. 기각.

## 결정

**옵션 1.** 짧은 토큰(1h)은 거버넌스 관점에서 오히려 장점(Deny policy가
최대 1시간 안에 모든 세션에 반영)이므로 유지하고, 연속성은 SDK 훅으로
해결합니다.

구현 (`tools/cc-bedrock-local.sh`):

1. **`credential-process` 서브커맨드** — stdout에 `{"Version":1, AccessKeyId,
   SecretAccessKey, SessionToken, Expiration}` JSON만 출력. 진단은 전부 stderr.
   캐시(TTL > 5분) → 즉시 응답; 아니면 silent refresh → STS 재발급 → state 갱신.
   프롬프트 절대 금지 — refresh token 사망 시 exit 1 + 재로그인 힌트.
2. **`setup_aws_profile`** — `~/.aws/config`에 credential_process 프로파일
   upsert + `~/.aws/credentials`의 레거시 정적 키 섹션 **제거** (credentials
   파일 엔트리가 config의 credential_process보다 우선하므로, 남겨두면 훅이
   영원히 무시됨). `login`/`refresh`/`claude`/`run` 모두에서 idempotent 호출
   → 구버전 사용자는 다음 실행 한 번으로 자동 마이그레이션.
3. STS Issuer 서버 계약은 무변경 (profileSnippet은 비-CLI 사용자용으로 유지).

갱신 체인과 수명:

```
STS 1h  ──(SDK가 Expiration 전 훅 재호출)──▶ 무한 연장
Cognito access 1h ──(refresh token으로 silent 재발급)──▶ 무한 연장
Cognito refresh 30d ──(만료 시)──▶ 'cc-bedrock-local login' 1회
```

## 영향

### 긍정적

- 수십 시간 연속 세션도 끊김 없음 — 재로그인은 30일에 1회.
- 정적 키가 디스크(`~/.aws/credentials`)에 더 이상 저장되지 않음 —
  state.json(600)에만 존재. 보안 소폭 개선.
- 1h 토큰 유지 → 한도 초과 Deny가 최대 1시간 내 모든 활성 세션에 반영되는
  거버넌스 특성 보존 (훅 재발급 시점에 Dashboard가 limitStatus를 재평가).

### 부정적 / 트레이드오프

- Cognito refresh token이 세션 도중 만료(30일)하면 그 시점 Bedrock 호출이
  실패하고 재로그인 필요 — 빈도상 허용 (월 1회 미만).
- 동시 SDK 클라이언트가 같은 순간 만료를 만나면 중복 재발급 가능 —
  idempotent하므로 무해, 락 미구현 (단순성 우선).
- credential_process 미지원 도구(순수 env var 주입 등)는 정적 snippet 경로
  (Dashboard /local 페이지) 사용 — 기존과 동일하게 1h 제한.

## 검증

테스트 (스텁 네트워크, 2026-06-12 통과):

1. 캐시 히트(TTL 30m) → JSON 즉시 출력, exit 0
2. 세션 없음 → exit 1 + 로그인 힌트 (stdout 오염 없음)
3. 만료 state + 유효 refresh token → silent 재발급 → 새 JSON
4. `refresh` → `~/.aws/config` 프로파일 설치 + `~/.aws/credentials`의
   `[cc-bedrock]` 정적 섹션 제거(타 프로파일 보존)

## Verification

```yaml
# Tier 1: Static
files:
  - path: tools/cc-bedrock-local.sh
    must_contain:
      - "credential-process"
      - "credential_process ="
      - "emit_credentials_json"
      - "setup_aws_profile"
  - path: lambda/sts-issuer.py
    must_contain:
      - "ADR-029"
    must_not_contain:
      - "no in-session background refresh"

# Tier 2: Semantic
semantic:
  - claim: "credential-process 서브커맨드는 stdout에 Version:1 자격증명 JSON만 출력하고, 캐시 TTL이 5분 이하일 때만 Cognito refresh token으로 무인 재발급하며, 어떤 경우에도 사용자에게 프롬프트하지 않는다"
    context_files:
      - tools/cc-bedrock-local.sh
  - claim: "setup_aws_profile은 ~/.aws/config에 credential_process 프로파일을 upsert하면서 ~/.aws/credentials의 동명 정적 키 섹션을 제거한다 (credentials 파일이 credential_process보다 우선하므로)"
    context_files:
      - tools/cc-bedrock-local.sh
  - claim: "login, refresh, claude, run 경로 모두에서 setup_aws_profile이 호출되어 구버전 정적 키 사용자가 자동 마이그레이션된다"
    context_files:
      - tools/cc-bedrock-local.sh
```

## 참고 자료

- AWS docs: [Sourcing credentials with an external process](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sourcing-external.html)
- AWS docs: [Roles terms and concepts — role chaining](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_terms-and-concepts.html) (1h cap)
- 실측: psungbum role 직접 발급 → 60.0분 수명 확인 (2026-06-12)
