안녕하세요. cc-on-bedrock 프로젝트의 ADR 문서와 구현 코드에 대한 심층 리뷰를 시작하겠습니다.
전반적으로 체계적인 ADR 문서와 그에 기반한 견고한 구현이 인상적입니다. 아키텍처의 목표와 설계 원칙이 코드 레벨까지 일관되게 적용되고 있음을 확인했습니다.

리뷰는 요청하신 기준에 따라 다음 섹션으로 나누어 진행합니다.

---

### 최종 요약 (Executive Summary)

- **ADR 품질:** 매우 높음. 아키텍처 결정 과정이 체계적으로 문서화되어 있습니다.
- **일관성:** ADR-007과 ADR-008 간의 상호 의존성이 높으며, 함께 구현될 때 시너지를 낼 수 있도록 설계되었습니다. 단, 연동 지점에서의 데이터 흐름(Federated User -> Department Claim)을 명확히 하는 것이 중요합니다.
- **설계-구현 정합성:** ADR-007의 핵심 요구사항(2-Tier Gateway, DDB Stream 기반 자동화 등)이 코드에 충실하게 반영되었습니다.
- **주요 리스크:**
    - **CRITICAL:** API 라우트의 입력값 검증 부재는 심각한 보안 취약점으로 이어질 수 있습니다.
    - **HIGH:** ADR-008의 이메일 도메인 체크 로직은 가입 이후 이메일 변경 시 우회될 수 있습니다.
    - **HIGH:** Cognito Federated User의 `department` 속성 누락 시 처리 방안이 ADR에는 명시되었으나, 실제 Lambda 구현 시 예외 처리가 반드시 포함되어야 합니다.

아래에 각 항목별 상세 리뷰를 첨부합니다.

---

### 1. ADR 문서 품질

ADR 문서들은 구조적으로 잘 작성되었으며, 결정의 배경과 결과를 이해하기 쉽게 설명하고 있습니다.

- **[MEDIUM] ADR-007: `Consequences` 구체화 필요**
    - **위치:** `docs/decisions/ADR-007-dept-mcp-agentcore-gateway.md`
    - **내용:** "운영 복잡성 증가" 항목에서 DDB Catalog, Gateway Manager Lambda, 신규 IAM Policy 등 관리 포인트가 늘어나는 점을 언급했지만, 구체적인 운영 시나리오(예: 신규 부서 추가/삭제 절차, 장애 발생 시 추적 경로 등)를 명시하면 더 좋습니다. 이는 운영 문서를 위한 기반 자료가 될 수 있습니다.
    - **권고:** 운영 관점의 시나리오를 1~2개 추가하여 복잡성이 실제로 어떻게 발현되는지 보여주는 것을 고려해 보세요.

- **[LOW] ADR-008: Social Login의 한계 명시**
    - **위치:** `docs/decisions/ADR-008-enterprise-sso-federation.md`
    - **내용:** SAML/OIDC와 달리 Social IdP (Google, Apple 등)는 `department`와 같은 기업용 속성을 제공하지 않는 경우가 대부분입니다. 이로 인해 Social Login 사용자는 부서 할당을 위해 항상 수동 개입이 필요하다는 점을 'Risks' 또는 'Consequences' 섹션에 더 명확하게 기술할 필요가 있습니다.
    - **권고:** "Social IdP 사용 시 부서 정보 자동 매핑 불가, 관리자 수동 할당 필수"와 같은 내용을 명시하여 정책적 제한을 강조하는 것이 좋습니다.

---

### 2. ADR 간 일관성 이슈

ADR 간의 개념은 대체로 일관되지만, 구현 시 주의가 필요한 연동 지점들이 발견되었습니다.

- **[HIGH] ADR-007과 ADR-008의 핵심 연동 지점**
    - **위치:** ADR-007 및 ADR-008 전반
    - **내용:** ADR-007의 부서별 Gateway 접근 제어(`aws:PrincipalTag/department`)는 ADR-008에서 Cognito Identity Pool을 통해 주입되는 `department` 태그에 전적으로 의존합니다. ADR-008이 **제안(Proposed)** 상태이므로, ADR-007 구현이 올바르게 동작하려면 ADR-008의 `PreTokenGeneration` Lambda 구현이 필수적입니다.
    - **권고:** ADR-007의 'Dependencies' 또는 'Constraints' 섹션에 "ADR-008에 기술된 Cognito를 통한 `department` 클레임 주입이 성공적으로 구현되어야 함"을 명시해야 합니다. 두 ADR의 구현 순서와 의존성을 팀 내에 명확히 공유하는 것이 중요합니다.

- **[MEDIUM] DynamoDB PK 형식의 암묵적 의존성**
    - **위치:** `cdk/lib/lambda/gateway-manager.py:38`
    - **내용:** Lambda 코드 `item_type, item_id = key.split('#', 1)` 부분은 DDB의 PK가 항상 `TYPE#ID` 형식임을 가정합니다. 현재 `DEPT#{dept}` 형식이므로 문제없지만, 이 형식 규칙이 다른 ADR이나 미래의 기능에서 변경될 경우 파급효과가 큽니다.
    - **권고:** DDB 스키마 규칙(특히 PK 작명 규칙)을 별도의 문서(`docs/architecture.md` 등)에 명시하고, 여러 컴포넌트(Lambda, API 등)가 이 문서를 참조하도록 가이드하는 것을 추천합니다. 코드 주석에라도 "PK format must be 'TYPE#ID'"라고 명시하면 좋습니다.

- **[LOW] IAM Role 작명 규칙의 일관성**
    - **내용:** ADR-005(`DevEnv-User-{username}`), ADR-006(부서 예산), ADR-007(MCP Gateway)에서 각각 다른 목적의 IAM 역할과 정책이 생성됩니다. 현재 충돌은 없지만, 전체 IAM 전략이 복잡해지고 있습니다.
    - **권고:** `iam-strategy.md`와 같은 문서를 통해 역할/정책의 작명 규칙, 책임 범위, 상호작용을 중앙에서 관리하면 장기적으로 혼란을 줄일 수 있습니다. 예를 들어, `PROJECT-COMPONENT-TARGET-PERMISSION` (예: `CC-MCP-DEPTA-Read`) 같은 규칙을 정의할 수 있습니다.

---

### 3. 설계-구현 정합성 Gap (ADR-007)**

ADR-007의 설계는 대부분 정확하게 구현되었으나, 몇 가지 미세한 차이점과 개선점이 있습니다.

- **[MEDIUM] 3-Layer IAM Isolation 구현 방식의 미세한 차이**
    - **위치:** `cdk/lib/lambda/gateway-manager.py`
    - **내용:** ADR-007은 "Department Gateway가 IAM 역할을 가질 것"이라고 서술했지만, 실제 구현(`gateway-manager.py`)에서는 VPC Endpoint에 **리소스 기반 정책(Resource-based policy)**을 연결하여 접근 제어를 수행합니다. 이는 IAM 역할을 사용하는 것과 기능적으로는 동일한 목표를 달성하지만, 엄밀히 말해 구현 방식에 차이가 있습니다.
    - **권고:** 혼란을 피하기 위해 ADR-007의 문구를 "Department Gateway(VPC Endpoint)에 리소스 기반 정책을 적용하여..."로 수정하거나, 코드 주석에 "IAM Role 대신 VPC Endpoint Policy를 사용하여 ADR의 목표를 달성함"이라고 명시하는 것이 좋습니다.

- **[LOW] DDB Streams 처리 시작점**
    - **위치:** `cdk/lib/03-usage-tracking-stack.ts`
    - **내용:** `new DynamoDBEventSource(..., { startingPosition: StartingPosition.LATEST })`로 설정되어 있습니다. 이는 CDK 스택 배포 이후 발생하는 변경사항만 처리함을 의미합니다. 만약 배포 중단 기간 동안 DDB에 변경이 있었다면 해당 이벤트는 유실됩니다.
    - **권고:** 현재 설정은 일반적인 시나리오에서 문제가 없습니다. 하지만 만약 이벤트 유실이 절대 없어야 하는 중요한 시스템이라면 `TRIM_HORIZON`을 고려하고, Lambda 내에서 중복 처리를 방지하는 로직을 추가해야 합니다. 현재 아키텍처에서는 `LATEST`가 합리적인 선택으로 보입니다.

---

### 4. 보안 이슈

- **[CRITICAL] API 라우트의 입력값 검증 부재**
    - **위치:** `shared/nextjs-app/src/app/api/admin/mcp/gateways/route.ts`
    - **내용:** `const { departmentId, region, action } = await req.json();` 코드는 클라이언트로부터 받은 입력을 아무런 검증 없이 그대로 사용합니다. 악의적인 사용자가 예상치 못한 형식의 `departmentId`(예: 빈 문자열, 특수문자 포함 등)를 보낼 경우, `DEPT#${departmentId}`와 같이 구성되어 DynamoDB와 상호작용하는 과정에서 에러를 유발하거나 의도치 않은 동작을 일으킬 수 있습니다.
    - **권고:** `zod`, `joi` 같은 스키마 검증 라이브러리를 사용하여 API 요청 본문의 `departmentId`, `region`, `action` 값이 예상된 형식과 값(예: `action`은 'create' 또는 'delete'만 허용)을 갖는지 **반드시** 검증해야 합니다.

- **[HIGH] ADR-008: 이메일 도메인 Allowlist 우회 가능성**
    - **위치:** `docs/decisions/ADR-008-enterprise-sso-federation.md`
    - **내용:** `PreSignUp` 트리거에서 이메일 도메인을 검사하는 것은 좋은 접근입니다. 하지만 사용자가 일단 가입한 후, Cognito 콘솔이나 앱 기능을 통해 자신의 이메일 주소를 허용되지 않은 도메인의 이메일로 변경할 경우 이 보안 정책이 우회될 수 있습니다.
    - **권고:**
        1.  Cognito에서 사용자의 이메일 주소 변경 기능을 비활성화하거나,
        2.  `Custom-Attribute-Update` Lambda 트리거를 구현하여 이메일 주소 변경 시에도 도메인 검사를 다시 수행하도록 해야 합니다.

- **[MEDIUM] 환경 변수 강제 언래핑(Unwrapping)**
    - **위치:** `shared/nextjs-app/src/app/api/admin/mcp/catalog/route.ts` 등 다수
    - **내용:** `process.env.MCP_CATALOG_TABLE_NAME!`와 같이 `!` 연산자를 사용하여 환경 변수가 항상 존재한다고 가정하고 있습니다. 만약 환경 변수가 설정되지 않으면 런타임에 서버가 다운됩니다.
    - **권고:** 서버 시작 시점에 필수 환경 변수들이 모두 설정되었는지 확인하는 로직을 추가하여, 변수가 누락된 경우 즉시 프로세스를 종료하고 명확한 에러 메시지를 출력하도록 개선하는 것이 안정성 측면에서 좋습니다.

---

### 5. AWS Best Practices

- **[HIGH] ADR-008: Federated User의 `department` 속성 누락 시 처리**
    - **위치:** `docs/decisions/ADR-008-enterprise-sso-federation.md`
    - **내용:** ADR은 `department` 속성이 IdP로부터 오지 않을 경우 수동 할당을 언급했지만, `PreTokenGeneration` Lambda 구현 시 이 예외 케이스를 반드시 처리해야 합니다. 만약 Lambda가 `department` 그룹이 없는 사용자에 대해 이 속성을 찾으려고 시도하다가 에러를 내뿜으면, 해당 사용자는 **로그인 자체가 실패**하게 됩니다.
    - **권고:** `PreTokenGeneration` Lambda 코드 내에서 사용자의 Cognito 그룹 목록을 조회한 후, `department` 관련 그룹이 없는 경우 `custom:department` 클레임을 추가하지 않거나 기본값(예: 'default' 또는 'unassigned')을 할당하는 등, 에러 없이 정상적으로 통과시키는 방어 로직을 반드시 구현해야 합니다.

- **[MEDIUM] Lambda 코드 내 하드코딩된 리전/계정 ID**
    - **위치:** `cdk/lib/lambda/gateway-manager.py` (잠재적)
    - **내용:** 현재 코드에는 없지만, 향후 정책 ARN 등을 생성할 때 `f"arn:aws:iam::{account_id}:policy/..."`와 같이 계정 ID나 리전이 필요할 수 있습니다. Lambda 실행 환경에서 자동으로 제공되는 `AWS_REGION`, `AWS_ACCOUNT_ID` 등의 환경 변수를 사용하는 것이 좋습니다. 코드 리뷰 시점에는 문제가 없었으나 향후 확장 시 고려해야 할 부분입니다.

---

### 6. 개선 권고사항

1.  **(즉시 조치)** `gateways` API 라우트에 `zod`를 이용한 입력값 검증을 최우선으로 추가하여 보안 취약점을 해결하십시오.
2.  **(설계 보완)** ADR-008 구현 시, 이메일 변경 우회 가능성에 대한 방어 로직과 `department` 속성 누락 시의 예외 처리 로직을 Lambda 코드에 반드시 포함시키십시오.
3.  **(문서화)** ADR-007과 ADR-008 간의 의존성을 문서에 명시하고, DDB PK 규칙과 같은 핵심 설계 제약을 중앙 아키텍처 문서에 정리하여 팀 전체의 이해도를 높이십시오.
4.  **(코드 품질)** 환경 변수 사용 시 런타임 안정성을 위해 시작 시점에 유효성을 검사하는 헬퍼 함수를 도입하는 것을 고려해 보십시오.

전체적으로 매우 훌륭한 프로젝트입니다. 위의 제안들이 시스템을 더욱 견고하고 안전하게 만드는 데 도움이 되기를 바랍니다. 추가 질문이 있으시면 언제든지 문의해 주세요.
