# 비용 관리 (Cost Management)

import CostCalculator from '@site/src/components/InteractiveDoc/CostCalculator';
import Screenshot from '@site/src/components/Screenshot';

CC-on-Bedrock은 대규모 사용자 환경에서도 효율적으로 예산을 관리할 수 있는 도구를 제공합니다.

<CostCalculator />

## 실시간 비용 분석
대시보드 분석 탭을 통해 사용자별, 모델별 비용 사용 현황을 투명하게 파악할 수 있습니다.

<Screenshot 
  src="/img/Analytics02.png" 
  alt="Cost Analytics" 
  caption="비용 분석 대시보드: 사용자별 리더보드 및 실시간 지출 현황" 
/>

## 사용량 추적 흐름 (Budget Control Flow)

서버리스 아키텍처를 기반으로 사용자별 Bedrock 호출 비용을 실시간으로 추적합니다.

```text
ECS Task (Claude Code) → Bedrock API 호출
  → CloudTrail (자동 로그 기록)
  → EventBridge Rule (bedrock:InvokeModel 매칭)
  → Lambda: usage-tracker → DynamoDB (사용자별 비용 저장)
```

## 예산 제어 (Budget Control)

매 5분마다 실행되는 Lambda 함수를 통해 예산을 자동 제어합니다:

1. **DynamoDB 스캔**: 금일 사용자별 비용 합산
2. **80% 도달**: SNS를 통한 경고 알림 발송
3. **100% 도달**: 사용자 Task Role에 IAM Deny Policy 부여 + Cognito 플래그 설정 (접속 차단 가능)
4. **익일 초기화**: 매일 자정에 Deny Policy 자동 해제

## 비용 절감 팁

- **LiteLLM 배제**: LiteLLM 프록시 대신 서버리스 트래킹(CloudTrail + Lambda)을 사용하여 약 $370/월 절감 (~$5/월 수준 유지)
- **컨테이너 자원 조정**: 사용자 필요에 따라 3가지 태스크 정의(`light`, `standard`, `power`)를 선택하여 최적의 EC2 비용 지출
- **EFS 단일화**: 여러 사용자가 단일 EFS 내 디렉토리로 격리되어 사용하므로 고정 비용을 최소화
- **Cognito 사용자 비활성화**: 사용하지 않는 계정은 Cognito에서 즉각 정지하여 불필요한 리소스 할당 방지
