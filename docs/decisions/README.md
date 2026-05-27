# Architecture Decision Records (ADR)

이 디렉토리는 본 프로젝트의 아키텍처 결정을 기록한다. 각 ADR은 별도 markdown 파일로 작성하며 자동 검증 파이프라인이 PR마다 ADR 명세와 코드의 일치를 확인한다.

## ADR 작성

새 ADR을 만들 때는 `/add-adr` 스킬을 사용하거나 `_TEMPLATE.md`를 복사한다. 모든 새 ADR은 다음을 만족해야 한다:

1. **YAML frontmatter** (status, date, verification_required) — `verification_required: true`가 기본.
2. **`## Verification` 섹션** — Tier 1(`files`)과 Tier 2(`semantic`) 청구 작성. 둘 다 없으면 PR이 막힌다.
3. **파일 이름**: `ADR-NNN-<slug>.md` (NNN은 3자리 증가하는 번호)

## 검증 파이프라인

각 PR push마다 `.github/workflows/adr-verify-pr.yml`이 실행되어:

- **Tier 1 (Static)**: `files[]` rules 검사. `must_contain` / `must_not_contain` / `must_exist`. FAIL 시 **merge 차단** (required check).
- **Tier 2 (Semantic)**: Claude on Bedrock이 `semantic[]` claim을 판정. FAIL 시 advisory PR comment (merge 허용).
- **Coverage**: `Coverage: N/24` sticky comment가 매 push마다 갱신.

자세한 설계: `docs/superpowers/specs/2026-05-26-adr-compliance-pipeline-design.md`

## Soft launch 규칙

| frontmatter | `## Verification` 섹션 | 동작 |
|------------|------------------------|------|
| 없음 (legacy) | 없음 | skip + warn |
| 없음 (legacy) | 있음 | 정상 검증 |
| `verification_required: false` | 없음/있음 | skip + warn |
| `verification_required: true` | **없음** | **PR check FAIL** |
| `verification_required: true` | 있음 | 정상 검증 |

## 우선순위 backfill (이미 적용됨 또는 적용 예정)

ADR-021, ADR-014, ADR-011, ADR-022, ADR-023, ADR-024 — 가장 활발히 코드가 진화 중이거나 비용/보안 영향이 큼.
