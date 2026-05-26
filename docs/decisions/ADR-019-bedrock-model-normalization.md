# ADR-019: Bedrock Model ID Normalization for Usage Tracking

## Status
Accepted (retrospective documentation 2026-05-12)

## Context
`bedrock-usage-tracker.py`는 Bedrock Invocation Logging과 CloudTrail 양쪽에서 model ID를 추출해 DynamoDB(`cc-on-bedrock-usage`)에 키로 저장하고 가격 계산에 사용한다. 그러나 Bedrock 호출자는 동일 모델을 **여러 표기**로 부른다:

| 호출 표기 | 출처 |
|---|---|
| `arn:aws:bedrock:us-east-1:123:inference-profile/global.anthropic.claude-sonnet-4-6-v1` | Application Inference Profile 호출 |
| `arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6-20251015-v2:0` | 직접 foundation model 호출 |
| `global.anthropic.claude-opus-4-6-v1[1m]` | Inference profile ID + 1M context suffix |
| `claude-haiku-4-5-20251001` | 직접 model 이름 |
| `anthropic.claude-sonnet-4-5-v1:0` | 버전 + 콜론 suffix |

정규화 없이 키로 쓰면:
- DynamoDB에 같은 모델의 여러 변형 row가 생겨 dashboard 차트가 split
- 가격 lookup table miss → "default" 가격(Sonnet) fallback으로 잘못된 비용 추정
- 일자별 집계 SK(`{date}#{model}`)가 무한 fragmentation

게다가 Haiku 4.5처럼 date suffix(`-20251001`)가 붙어 출시되는 모델은 새 SKU 출시 때마다 가격 mapping을 깨뜨린다.

## Decision

`normalize_model(model_id)` 함수를 도입해 **모든 호출 경로의 model ID를 단일 short form으로 환원**한다.

### Normalization Rules (적용 순서)

1. 빈 값/`unknown` → `unknown`
2. `/` 포함 시 마지막 segment만 유지 — ARN의 `inference-profile/...` 또는 `foundation-model/...` 부분 추출
3. 여전히 `arn:`로 시작하면 `:`로 split해 마지막 segment 사용
4. region/vendor prefix 제거: `global.anthropic.`, `apac.anthropic.`, `us.anthropic.`, `eu.anthropic.`, `anthropic.`
5. 콜론 suffix(`:0` 등) 제거
6. `[1m]` context-length suffix 제거
7. version suffix(`-v1`, `-v2`) 제거
8. **8자리 date suffix** (`-20251001`) 정규식으로 제거 — `re.sub(r"-\d{8}$", "", model_id)`

### 결과

| 입력 | 출력 |
|---|---|
| `arn:aws:bedrock:us-east-1:123:inference-profile/global.anthropic.claude-sonnet-4-6-v1` | `claude-sonnet-4-6` |
| `arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6-20251015-v2:0` | `claude-sonnet-4-6` |
| `global.anthropic.claude-opus-4-6-v1[1m]` | `claude-opus-4-6` |
| `claude-haiku-4-5-20251001` | `claude-haiku-4-5` |
| `anthropic.claude-sonnet-4-5-v1:0` | `claude-sonnet-4-5` |

### Pricing Mapping

정규화된 short form을 기준으로 `PRICING` dict에 hardcoded:
```python
PRICING = {
    "claude-sonnet-4-6": {"input": 3.0, "output": 15.0},
    "claude-opus-4-6":   {"input": 15.0, "output": 75.0},
    "claude-haiku-4-5":  {"input": 0.80, "output": 4.0},
    ...
}
```

`get_model_pricing()`은 short form에 partial-match를 허용해, 새 SKU가 출시되어도 4-자리 패밀리(예: `claude-sonnet-4-6`)만 유지되면 자동 매핑.

### Normalized-Token Weight 연동 (ADR-014)

ADR-014 `token-limit-enforcer.py`의 `_model_family()`도 같은 short form을 입력으로 받아 `opus|sonnet|haiku` 패밀리를 판정한다. 모든 가격/한도 결정의 단일 진실 원천이 `normalize_model()` 출력이 되도록 통일.

## Rationale

| 차원 | Raw model ID 유지 | 정규화 |
|---|---|---|
| DDB row 수 | 표기별로 분기, 사용자별 1일에 5-10 row 가능 | 1일 1 row per family |
| 가격 매핑 | 호출 경로별 mapping 필요 (난해) | 단일 mapping table |
| 새 SKU date suffix | 매번 PRICING dict 수동 추가 | 자동 매핑 (family 기준) |
| 정확도 | 잘못된 cost mapping 시 무차별 fallback | 명시적 family-level mapping |
| 코드 위치 | 호출 처마다 분기 | tracker 진입점 1곳 |

핵심 판단: 정규화 함수가 ~30줄로 콤팩트하면서 잘못된 비용 추정이라는 큰 위험을 막는다. 모델 family는 한 번 정해지면 잘 안 바뀌므로 short form이 안정적인 키 역할.

## Changes

- `cdk/lib/lambda/bedrock-usage-tracker.py`
  - `normalize_model(model_id: str) -> str` 함수 신설 (line 190-)
  - `process_invocation_log()`, `process_cloudtrail_event()` 모두 DynamoDB write 전에 호출
  - `get_model_pricing()`은 정규화된 short form 기준 partial-match
- `cdk/lib/lambda/token-limit-enforcer.py` (ADR-014)
  - `_model_family()`가 normalize된 model 문자열을 입력으로 가정

## Consequences

### Positive
- DynamoDB row 폭증 방지 — usage table 크기/스캔 비용 안정
- 새 date-suffix 모델 출시 시 코드 변경 없이 자동 분류
- Dashboard 차트가 family 단위로 깔끔히 그룹화
- ADR-014 normalized-token 가중치도 같은 family 키 공유

### Negative
- 정규화 함수가 silent — 매핑 누락 시 `unknown` 또는 잘못된 family로 떨어질 수 있음. 새 family(예: `claude-opus-5`) 출시 시 family-detection rule 갱신 필요
- Bedrock이 새로운 vendor prefix(예: `eu.anthropic.`)를 도입하면 prefix 리스트에 추가 필요
- 정규화는 lossy — 정확한 SKU/version은 raw `modelId` 로그에 보존 (DDB에는 short만)

### Validation
- 매 deploy 후 CloudWatch Logs에서 `Tracked: ` 라인이 예상 short form을 포함하는지 spot check
- DynamoDB scan: `SELECT DISTINCT model FROM cc-on-bedrock-usage` 결과가 합리적인 family 셋 (`claude-sonnet-4-6`, `claude-opus-4-6`, `claude-haiku-4-5`)으로만 구성되는지 주기 점검

## Out of Scope
- Anthropic 외 vendor(Cohere, Mistral 등)의 model ID 정규화 — 호출이 발생하지 않음
- Bedrock의 새로운 model family/버전 출시 시 PRICING 자동 갱신 — 수동 PR 유지

## References
- `cdk/lib/lambda/bedrock-usage-tracker.py:190-226` (normalize_model)
- ADR-011: Bedrock IAM Cost Allocation (정규화된 model이 IAM tag와 함께 cost attribute 기여)
- ADR-014: Local Governance Mode (model family 기반 normalized token 가중치)
