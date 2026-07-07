---
status: Accepted
verification_required: false
date: 2026-07-06
consolidates: []
---

# 013: PR-Review Kiro `fs_read` — 잔여 유출 위험 (수용, 완화됨)

## Status

Accepted (2026-07-06)

## Context

PR 리뷰 CI 패널(lens×model 매트릭스, `scripts/pr-review/*`)이 Kiro의 diff 전달을
무효 tool 명(`--trust-tools=read,grep`)에서 실제 read-only tool 명 `--trust-tools=fs_read`로
전환했다. `fs_read`는 절대경로 read가 가능하고, 이는 **신뢰할 수 없는 PR diff**가
그대로 프롬프트로 들어가는 `pull_request_target` 잡(self-hosted 러너, 시크릿 스코프)에서
실행된다. diff 안의 prompt injection이 고정 크리덴셜 경로(예: `actions/checkout`이
기본값(`persist-credentials: true`)으로 남기는 `.git/config`의 `GITHUB_TOKEN`, EKS Pod
Identity 토큰 파일)를 read하도록 유도하면, 그 값은 Kiro의 응답에 나타나고 — Kiro는
**외부 서비스**이므로 scrub 이전에 이미 리전/계정 밖으로 나간 뒤다.

## 기존 완화

- Kiro 서브프로세스의 격리 `$HOME`/cwd(`KIRO_CWD`) — 실제 크리덴셜이 가짜 `$HOME` 아래
  없으므로 `~` 상대경로 유도 표면을 제거.
- `env -i` allowlist — `KIRO_API_KEY`와 최소 필요 변수만 전달, `AWS_*`/`GH_TOKEN`은
  환경변수로 전달하지 않음.
- `scrub_secrets()` — 셀 출력이 체어/공개 PR 코멘트에 닿기 전 정규식 기반 마지막
  방어선.

## 잔여 위험 (수용)

위 완화 중 어느 것도 **절대경로** `fs_read` 자체는 막지 못한다 — `fs_read`는 설계상
read-capable이고, 격리는 env 변수·`~` 상대경로 표면만 줄인다. 구체적 잔여 경로:
`actions/checkout`의 기본값(`persist-credentials: true`)이 `.git/config`에 남기는
`GITHUB_TOKEN` — 이를 read하도록 유도된 injection은 `scrub_secrets()`가 알려진 GitHub
토큰 패턴은 잡아내지만, 그 외 형태·부분 문자열의 시크릿은 첫 방어선을 통과할 수 있다.

## Decision

1. **`persist-credentials: false`**를 이 워크플로우의 `actions/checkout@v4` 스텝에
   추가 — 이 설계가 디스크에 남길 뻔한 유일한 구체적·알려진-형태 크리덴셜을 제거한다.
   문서화가 아니라 실제 코드 수정.
2. **잔여 위험으로 수용, 게이트 비대상**: "러너 OS 사용자가 read 가능한 것은 모두
   read 가능"이라는 일반적 위험은 `fs_read`를 완전히 제거(Kiro `chat`이 stdin을
   무시하므로 diff 전달 자체가 깨짐)하지 않는 한 완전한 완화가 없다. `scrub_secrets()`가
   실제로 read된 것에 대한 마지막 방어선으로 남는다. 이 trade-off는 이미 같은 lens×model
   설계를 먼저 도입한 sibling repo들(References)에서도 동일하게 수용된 것이며, 이 repo에
   새로 생긴 위험 종류가 아니다 — 대안(Kiro 패널 제외)은 한 벤더 전체의 교차확인을
   잃는다.
3. 범위: **CI pr-review only**. co-agent 자체의 Kiro fan-out(같은 tool 사용하나
   interactive/on-demand, `pull_request_target`처럼 신뢰 안 된 PR 콘텐츠에 대한 게이트가
   아님)에는 영향 없음.

## Consequences

- 구체적이고 알려진 형태였던 유일한 유출 경로(persisted `GITHUB_TOKEN`)가 닫힌다.
- 일반적인 절대경로 read 능력은 수용된 잔여 위험으로 남는다 — 향후 추가 하드닝(예: Kiro
  서브프로세스 전용 저권한 OS 사용자)은 이 ADR을 참조해 같은 trade-off를 재논의할 것.

## References

- `scripts/pr-review/run-panel.sh` (Kiro 셀: `kiro_env`, `KIRO_CWD`, `--trust-tools=fs_read`)
- `scripts/pr-review/lib.sh` (`scrub_secrets`)
- `.github/workflows/pr-review.yml` (`persist-credentials: false`)
- 같은 lens×model 설계를 포팅한 sibling repo들의 동등 ADR (예: ttobak ADR-019,
  aws-fsi-demo ADR-012)와 `plugins/co-agent/skills/co-agent/scripts/consensus_hooks.py`의
  `_sanitized_env`(동등 위협모델의 interactive-panel 버전).
