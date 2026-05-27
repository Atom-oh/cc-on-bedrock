# 비용 관리 (Cost Management)

import CostCalculator from '@site/src/components/InteractiveDoc/CostCalculator';

CC-on-Bedrock은 대규모 사용자 환경에서도 효율적으로 예산을 관리할 수 있는 도구를
제공합니다.

<CostCalculator />

## 비용 구성 요소

### EC2-per-user DevEnv 모드 (Stack 07)

| 항목 | 단가 (ap-northeast-2) | 비고 |
|---|---|---|
| EC2 t4g.large (ARM64) | $0.0832 / hour (실행 중일 때만) | 8h/day 기준 ~$20/월 |
| EBS gp3 root | $0.08 / GB·월 | 40 GB 기본 → ~$3.2/월 |
| Hibernation EBS | 동일 (RAM 덤프 저장 공간 포함) | ADR-010 |
| **Bedrock API** | 모델/토큰별 종량제 | 아래 모델별 단가 참조 |

`ec2-idle-stop` Lambda가 유휴 인스턴스를 자동 stop하므로 실제 24h 풀가동
비용은 발생하지 않습니다.

### Local Governance 모드 (Stack 08)

| 항목 | 단가 | 비고 |
|---|---|---|
| EC2 / EBS | **0** (사용자 PC 사용) | |
| Lambda (STS Issuer, enforcer, reset) | ~$0.1/월 | invocation 횟수 매우 적음 |
| DynamoDB (`limits` table) | ~$0.01/월 | on-demand, ~수십 row |
| **Bedrock API** | 모델/토큰별 종량제 | EC2 모드와 동일 |

Local 모드에서는 **인프라 비용이 사실상 0**이며 Bedrock API 호출 비용만
발생합니다.

### Bedrock 모델 단가 (ap-northeast-2 inference profile 기준)

| 모델 | Input / 1M tokens | Output / 1M tokens |
|---|---|---|
| Claude Opus 4.7 | $15.00 | $75.00 |
| Claude Opus 4.6 | $15.00 | $75.00 |
| Claude Sonnet 4.6 | $3.00 | $15.00 |
| Claude Haiku 4.5 | $0.80 | $4.00 |

:::note inference profile 가중치
정확한 단가는 AWS Bedrock pricing 페이지를 확인하세요. 시스템은 ADR-015의
**normalized token** 모델로 다른 모델 간 가중치를 일관되게 적용해 한도를
관리합니다 (Haiku 1× / Sonnet ~3.5× / Opus ~15×).
:::

## 사용량 추적 흐름 (ADR-019)

```text
EC2 instance (Claude Code, Instance Profile credentials)
또는 사용자 PC (Local Mode, STS credentials)
  → Bedrock InvokeModel / Converse
  → Bedrock model invocation logging (CloudWatch Logs)
  → Subscription Filter (IAM role prefix 매칭)
  → bedrock-usage-tracker Lambda
  → cc-on-bedrock-usage DynamoDB (Streams)
  → token-limit-enforcer Lambda (Stream consumer)
  → 한도 초과 시 cc-on-bedrock-limits 테이블 DENY#active + IAM Deny attach
```

이전 버전이 사용하던 **CloudTrail + EventBridge** 방식 대비, Bedrock invocation
logging 방식은:
- 호출 횟수가 아닌 **실제 토큰 수**까지 정확히 추적
- `textDataDeliveryEnabled: false`로 페이로드 미저장 → CloudWatch Logs 비용 ~99% 절감
- 누락 / 지연 가능성이 낮음

## 예산 제어 (Budget Control)

이중 거버넌스 (ADR-015):

### 1. USD 예산 (`budget-check` Lambda, 5분 주기)

1. `cc-user-budgets` + 부서 budgets 테이블 + 누적 비용 합산
2. **80% 도달**: SNS 경고
3. **100% 도달**: 사용자 IAM role에 Deny Policy attach + (옵션) Cognito 플래그
4. **익일 자정 (KST)**: `limit-reset` Lambda가 Deny 자동 해제

### 2. Normalized 토큰 한도 (`token-limit-enforcer` Lambda, Stream 소비)

1. usage table Streams 이벤트마다 normalized_tokens 누적
2. 한도 초과 즉시 `DENY#active` 작성 + IAM Deny attach
3. KST 자정 (daily) / 일요일 (weekly) / 매월 1일 (monthly) reset

두 메커니즘은 독립적이며 어느 한쪽만이라도 트리거되면 사용자가 차단됩니다.

## 비용 절감 팁

- **Hibernation 활성화** (ADR-010): `HIBERNATE_ENABLED=true`로 ~5초 resume +
  cold start 시 OS init 시간 절감 → 사용자가 stop을 꺼리지 않게 됨
- **자동 EC2 stop**: `ec2-idle-stop` Lambda가 CPU/Network 메트릭 기반으로 idle
  판단해 자동 stop. EBS는 유지되므로 다음 start 때 모든 상태 복원
- **EBS 적정 크기**: 기본 40 GB부터 시작하고 사용량 80% 이상 시 user portal에서
  EBS 확장 신청 (AI Resource Review가 적정 크기 추천, ADR-005 승인 워크플로)
- **Local Mode 활용**: 본인 PC가 빠른 사용자는 Local 모드로 전환 → EC2 비용 0
- **모델 선택 가이드**: 단순 코드 변환은 Haiku, 복잡한 reasoning은 Opus.
  Claude Code `/model` 픽커에서 작업별 전환 권장
- **Bedrock invocation logging 비용 통제**: `textDataDeliveryEnabled: false`
  유지. 디버깅용으로 잠시 켜도 24h 이내 다시 끄기

## 모니터링 페이지

| 페이지 | 누가 보나 | 데이터 |
|---|---|---|
| `/admin/tokens` | Admin | 1d/7d/30d 토큰 / 비용 / 요청 수, top users, 부서별 분해 |
| `/admin/budgets` | Admin | 부서·사용자 USD 예산 + 80%/100% 트리거 이력 |
| `/admin/limits` | Admin | Normalized 토큰 한도 CRUD (ADR-014) |
| `/analytics` | Admin | 모델 비율, 비용 트렌드, 리더보드 |
| `/dept` | 부서 관리자 | 부서 멤버별 사용량 분포, 부서 예산 잔액 |
| `/user` | 본인 | 일일 토큰 사용량 카드 |
| `/local` | 본인 | Local 모드 자격증명 + normalized token 게이지 |
