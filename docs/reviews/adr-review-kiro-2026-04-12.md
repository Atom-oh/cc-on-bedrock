# AWS Well-Architected Framework 리뷰: ADR-007 / ADR-008

## 1. Security Pillar

### 🔴 CRITICAL: Gateway Manager Lambda의 IAM 권한 과다 (ADR-007)

cdk/lib/03-usage-tracking-stack.ts:280-290

typescript
actions: ['iam:CreateRole', 'iam:DeleteRole', 'iam:GetRole', 'iam:AttachRolePolicy',
  'iam:DetachRolePolicy', 'iam:PutRolePolicy', 'iam:DeleteRolePolicy',
  'iam:ListRolePolicies', 'iam:PassRole'],
iam:AttachRolePolicy와 iam:DetachRolePolicy가 포함되어 있지만, 실제 gateway-manager.py에서는 put_role_policy(인라인 정책)만 사용합니다. AttachRolePolicy는 AWS 관리형 정책을 부착할 수 있어 권한 상승(privilege escalation) 경로가 됩니다.

또한 iam:PassRole의 Resource가 cc-on-bedrock-agentcore-gateway-* 패턴이지만, 이 Lambda가 생성하는 Role의 trust policy(gateway-manager.py:30-36)에는 bedrock-agentcore.amazonaws.com만 허용되어 있어 PassRole condition key(iam:PassedToService)가 없습니다.

수정 제안:
- iam:AttachRolePolicy, iam:DetachRolePolicy 제거
- iam:PassRole에 condition 추가: "iam:PassedToService": "bedrock-agentcore.amazonaws.com"

### 🔴 CRITICAL: 동적 생성 Role에 Permission Boundary 미적용 (ADR-007)

cdk/lib/lambda/gateway-manager.py:72-82 — create_gateway_role()

python
resp = iam.create_role(
    RoleName=role_name,
    AssumeRolePolicyDocument=TRUST_POLICY,
    Description=f"AgentCore Gateway role for department: {department}",
    Tags=[...],
)
PermissionsBoundary 파라미터가 없습니다. ADR-007 문서에서는 "3-Layer IAM 격리"를 명시하고 있고, 02-security-stack.ts에 cc-on-bedrock-task-boundary가 정의되어 있지만, Gateway Role에는 적용되지 않습니다. Gateway Role이 Lambda invoke 권한만 가지고 있어 현재 위험은 제한적이지만, 향후 정책 추가 시 boundary 없이 권한이 확장될 수 있습니다.

수정 제안: create_role() 호출에 PermissionsBoundary 추가, 또는 Gateway 전용 boundary 정책 생성.

### 🟡 IMPORTANT: PreSignUp Lambda domain allowlist 우회 가능성 (ADR-008)

ADR-008 PreSignUp Lambda 코드:

javascript
const emailDomain = event.request.userAttributes.email?.split('@')[1];
if (!allowedDomains.includes(emailDomain)) {
  throw new Error(`Email domain ${emailDomain} is not allowed`);
}
두 가지 문제:
1. email이 undefined이면 emailDomain이 undefined가 되어 includes(undefined)는 false를 반환하므로 차단됩니다 — 이 부분은 안전합니다.
2. 그러나 SAML assertion에서 email을 제공하지 않는 IdP 설정 오류 시, email이 빈 문자열이면 split('@')[1]이 undefined가 되어 역시 차단됩니다.
3. 진짜 문제: ALLOWED_DOMAINS 환경변수가 빈 문자열이면 filter(Boolean) 결과가 빈 배열이 되어 allowlist 검증이 완전히 skip됩니다. 이것이 의도된 동작("전체 허용")이지만, 환경변수 미설정과 "전체 허용"이 동일한 동작이라 실수로 열릴 수 있습니다.

수정 제안: 명시적 ALLOW_ALL_DOMAINS=true 환경변수를 별도로 두거나, 빈 문자열일 때 기본 차단으로 변경.

### 🟡 IMPORTANT: PreTokenGeneration V2 응답 형식 오류 가능성 (ADR-008)

javascript
claimsToAddOrOverride: {
  'cognito:groups': JSON.stringify(groupNames),
},
Cognito PreTokenGeneration V2에서 cognito:groups를 override할 때, accessTokenGeneration에서는 claimsToAddOrOverride가 아닌 claimsToAddOrOverride + scopesToAdd/scopesToSuppress 구조입니다. 그러나 더 중요한 것은: Access Token의 cognito:groups는 V2에서도 groupOverrideDetails를 통해서만 수정 가능합니다. claimsToAddOrOverride로는 reserved claim인 cognito:groups를 override할 수 없을 수 있습니다.

수정 제안: groupOverrideDetails.groupsToOverride 사용을 검토하고, 실제 Cognito V2 응답 스펙을 테스트로 검증.

### 🟡 IMPORTANT: DynamoDB 테이블 암호화 불일치 (ADR-007)

cdk/lib/03-usage-tracking-stack.ts에서 cc-mcp-catalog와 cc-dept-mcp-config 테이블은 CUSTOMER_MANAGED KMS 암호화가 적용되어 있습니다 (line 253, 264). 그러나 cc-dlp-domain-lists 테이블(line 60)은 encryption 속성이 없어 AWS 기본 암호화(AWS owned key)를 사용합니다.

일관성 문제이며, DLP 도메인 리스트는 보안 관련 데이터이므로 CMK 암호화가 더 적절합니다.

### 🟢 GOOD: Catalog API의 입력 검증 및 필드 화이트리스트

shared/nextjs-app/src/app/api/admin/mcp/catalog/route.ts:73-76 — PUT 핸들러에서 ALLOWED_FIELDS 화이트리스트로 업데이트 가능한 필드를 제한하고 있습니다. Admin session 검증도 모든 핸들러에 적용되어 있습니다.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## 2. Reliability Pillar

### 🟡 IMPORTANT: DDB Streams 이벤트 처리 시 부분 실패 복구 불완전 (ADR-007)

cdk/lib/lambda/gateway-manager.py:233-240

python
for record in records:
    try:
        handle_stream_event(record)
    except Exception as e:
        logger.error(f"Stream event failed: {e}")
        event_id = record.get("eventID", "unknown")
        failed_ids.append({"itemIdentifier": event_id})
reportBatchItemFailures가 CDK에서 올바르게 설정되어 있고(line 299), Lambda 코드에서도 batchItemFailures를 반환합니다. 그러나:

1. create_gateway() 내부에서 time.sleep(10) (IAM propagation) + time.sleep(2) × 30 (gateway polling) = 최대 70초 대기. Lambda timeout이 5분이므로 batch 내 여러 CREATE 이벤트가 있으면 timeout 위험.
2. retryAttempts: 3 (CDK line 298) 설정이 있지만, AgentCore API가 idempotent하지 않으면 재시도 시 중복 Gateway 생성 가능.

수정 제안:
- batchSize를 10에서 1로 줄이거나, maxBatchingWindow를 늘려서 CREATE 이벤트가 배치에 여러 개 포함되지 않도록 조정
- create_gateway()에서 기존 Gateway 존재 여부를 먼저 확인하는 idempotency 체크 추가

### 🟡 IMPORTANT: Gateway DELETE 흐름의 상태 불일치 (ADR-007)

shared/nextjs-app/src/app/api/admin/mcp/gateways/route.ts:62-75 — DELETE 핸들러:

typescript
await dynamodb.send(new PutItemCommand({
  TableName: DEPT_MCP_CONFIG_TABLE,
  Item: marshall({
    PK: `DEPT#${department}`,
    SK: "GATEWAY",
    status: "DELETING",
    ...
  }),
}));
PutItemCommand로 전체 아이템을 덮어쓰므로, 기존 gatewayId, gatewayUrl, roleArn 등의 속성이 삭제됩니다. 그런데 gateway-manager.py:119의 delete_gateway()는 DDB에서 gatewayId를 읽어서 삭제합니다. 즉, API가 PutItem으로 덮어쓴 후 DDB Streams가 트리거되면, Lambda가 gatewayId를 찾을 수 없어 삭제가 실패합니다.

또한 DDB Streams에서 GATEWAY record의 MODIFY 이벤트(status: DELETING)는 handle_stream_event()에서 처리되지 않습니다 — INSERT와 REMOVE만 처리합니다.

수정 제안:
- DELETE API에서 PutItemCommand 대신 UpdateItemCommand로 status만 변경
- handle_stream_event()에서 MODIFY + status=DELETING 케이스 추가

### 🟡 IMPORTANT: EC2 config sync (systemd oneshot) 실패 시 복구 없음 (ADR-007)

ADR-007에서 "EC2 부팅 시 systemd oneshot 서비스가 DDB에서 gateway URL 동기화"라고 명시하지만, 실제 구현 코드(ec2-clients.ts의 UserData)에는 MCP config sync 관련 systemd 서비스가 포함되어 있지 않습니다. 이는 아직 미구현이거나 별도 AMI에 포함된 것으로 보입니다.

구현 시 고려사항: DDB 조회 실패 시 이전 config를 유지하는 fallback, 또는 retry with backoff.

### 🟢 GOOD: SQS DLQ 설정

cdk/lib/03-usage-tracking-stack.ts:273-276 — DLQ가 14일 retention으로 설정되어 있어 실패한 이벤트를 수동 재처리할 수 있습니다. SNS 알림과 결합하면 운영 가시성이 확보됩니다.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## 3. Cost Optimization Pillar

### 🟡 IMPORTANT: DDB Streams 트리거 빈도와 Lambda 비용 (ADR-007)

Gateway Manager Lambda는 cc-dept-mcp-config 테이블의 모든 변경에 트리거됩니다. update_gateway_status() 함수가 Lambda 내부에서 같은 테이블을 업데이트하므로, 자기 자신의 업데이트가 다시 Stream 이벤트를 발생시킵니다.

gateway-manager.py:47에서 status 업데이트 → Stream 이벤트 → Lambda 재호출 → handle_stream_event()에서 MODIFY 이벤트는 GATEWAY SK에 대해 무시되므로 무한 루프는 아니지만, 불필요한 Lambda 호출이 발생합니다.

수정 제안: Stream 이벤트 필터링을 CDK에서 설정하거나, handle_stream_event() 초입에서 lastSyncAt 변경만인 경우 early return.

### 🟡 IMPORTANT: Per-department Gateway 비용 (ADR-007)

ADR-007에서 "부서 수는 보통 10~20개 수준"이라고 언급합니다. AgentCore Gateway는 현재 프리뷰/초기 단계이므로 과금 모델이 변경될 수 있습니다. 부서가 20개이면 Gateway 20개 + Common 1개 = 21개. 각 Gateway에 Lambda target이 등록되므로, 실제 비용은 Gateway 자체보다 Lambda 호출 빈도에 의존합니다.

현재 구조에서는 Common Gateway의 MCP(ECS/CloudWatch/DynamoDB)가 모든 부서에 중복 등록되지 않고 별도 Gateway로 분리되어 있어 비용 효율적입니다.

### 🟢 GOOD: Cognito Lambda trigger 비용 (ADR-008)

ADR-008에서 3개 Lambda trigger(PreSignUp, PostAuth, PreTokenGen)를 추가합니다. PreSignUp과 PostAuth는 첫 로그인 시에만 실질적 작업을 수행하고, PreTokenGen은 모든 로그인에서 실행되지만 AdminListGroupsForUser 1회 호출만 하므로 실행 시간이 짧습니다(~50ms). 사용자 수가 수백 명 수준이면 월 비용은 무시할 수 있습니다.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## 4. Performance Pillar

### 🟡 IMPORTANT: DynamoDB 테이블 설계 — Hot Partition 위험 (ADR-007)

cc-dept-mcp-config 테이블:
- PK: DEPT#{dept}, SK: GATEWAY 또는 MCP#{mcpId}

부서 수가 10~20개이므로 파티션 수가 매우 적습니다. PAY_PER_REQUEST 모드에서는 DynamoDB가 자동으로 파티션을 관리하지만, 모든 부서의 Gateway 상태를 동시에 업데이트하는 시나리오(예: 전체 sync)에서는 소수 파티션에 쓰기가 집중될 수 있습니다.

현재 규모(10~20 부서)에서는 문제가 되지 않지만, GSI가 없어 "모든 ACTIVE Gateway 조회" 같은 쿼리는 Scan이 필요합니다.

shared/nextjs-app/src/app/api/admin/mcp/gateways/route.ts:18 — 실제로 ScanCommand를 사용하고 있습니다. 부서 수가 적으므로 현재는 허용 가능하지만, 확장 시 GSI 추가를 고려해야 합니다.

### 🟡 IMPORTANT: Gateway Manager Lambda cold start (ADR-007)

gateway-manager.py는 boto3 클라이언트를 모듈 레벨에서 4개 생성합니다(dynamodb, iam, lambda_client, agentcore). bedrock-agentcore-control 클라이언트는 try/except로 감싸져 있어 실패 시에도 Lambda가 시작됩니다. Python 3.12 + boto3 4개 클라이언트의 cold start는 ~1-2초 수준으로, DDB Streams 트리거에서는 허용 가능합니다.

### 🟢 GOOD: Cognito trigger latency 인식 (ADR-008)

ADR-008에서 "+50-200ms" latency를 명시적으로 문서화하고, Provisioned Concurrency를 대안으로 제시한 점이 좋습니다.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## 5. Operational Excellence Pillar

### 🔴 CRITICAL: Gateway 생성/삭제 중 부분 실패 시 상태 관리 부재 (ADR-007)

gateway-manager.py:96-113 — create_gateway():

python
role_arn = create_gateway_role(department)  # Step 1: IAM Role 생성
resp = agentcore.create_gateway(...)        # Step 2: Gateway 생성
# ... targets 등록 ...                      # Step 3: Target 등록
Step 1 성공 → Step 2 실패 시, IAM Role이 orphan으로 남습니다. except 블록에서 status를 "ERROR"로 업데이트하지만, IAM Role 정리(rollback)는 수행하지 않습니다.

마찬가지로 delete_gateway():
python
agentcore.delete_gateway(gatewayId=gateway_id)  # Step 1
delete_gateway_role(department)                   # Step 2
dynamodb.delete_item(...)                         # Step 3
Step 1 성공 → Step 2 실패 시, Gateway는 삭제되었지만 IAM Role과 DDB 레코드가 남습니다.

수정 제안: 각 단계를 개별 try/except로 감싸고, 실패 시 이전 단계를 rollback하는 보상 트랜잭션(compensating transaction) 패턴 적용. 또는 최소한 ERROR 상태에 실패 단계를 기록하여 수동 복구를 용이하게.

### 🟡 IMPORTANT: CloudWatch 알람/메트릭 미정의 (ADR-007)

Gateway Manager Lambda에 대한 CloudWatch 알람이 CDK에 정의되어 있지 않습니다:
- Lambda Error rate 알람
- DLQ 메시지 수 알람
- Gateway 생성 실패율 메트릭

DLQ(cc-gateway-manager-dlq)가 있지만, DLQ에 메시지가 도착했을 때 SNS 알림을 보내는 CloudWatch 알람이 없습니다.

수정 제안: ApproximateNumberOfMessagesVisible > 0 알람 + SNS 연동 추가.

### 🟡 IMPORTANT: CDK RemovalPolicy 일관성

모든 DynamoDB 테이블이 RemovalPolicy.RETAIN으로 설정되어 있어 스택 삭제 시 데이터 보존됩니다. 이는 프로덕션에 적절합니다. 그러나 SQS DLQ(cc-gateway-manager-dlq)에는 removalPolicy가 설정되어 있지 않아 기본값(DESTROY)이 적용됩니다. 스택 삭제 시 미처리 실패 이벤트가 유실될 수 있습니다.

### 🟡 IMPORTANT: Lambda handler 이름 불일치 (ADR-007)

CDK에서 handler: 'gateway-manager.handler'로 설정되어 있지만, Python 코드의 실제 함수명은 lambda_handler입니다:

cdk/lib/03-usage-tracking-stack.ts:282: handler: 'gateway-manager.handler'
cdk/lib/lambda/gateway-manager.py:220: def lambda_handler(event, context):

이 불일치로 Lambda가 실행 시 handler 함수를 찾지 못해 런타임 에러가 발생합니다.

수정 제안: CDK에서 handler: 'gateway-manager.lambda_handler'로 변경하거나, Python에서 def handler(event, context):로 변경.

### 🟢 GOOD: ADR-008의 변경 영향 분석

ADR-008에서 "변경 불필요" 영역을 명시적으로 분석한 점이 우수합니다. middleware.ts, devenv-auth-edge/index.js, DynamoDB 테이블 등이 identity-agnostic하여 변경 불필요함을 확인한 것은 구현 리스크를 줄입니다.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## 발견사항 요약

| 심각도 | Pillar | 발견사항 | 파일 |
|--------|--------|----------|------|
| 🔴 CRITICAL | Security | Gateway Manager Lambda IAM 과다 권한 (AttachRolePolicy, PassRole 무조건) | 03-usage-tracking-stack.ts:280-290 |
| 🔴 CRITICAL | Security | 동적 생성 Gateway Role에 Permission Boundary 미적용 | gateway-manager.py:72-82 |
| 🔴 CRITICAL | Ops Excellence | Gateway 생성/삭제 부분 실패 시 rollback 없음 (orphan IAM Role) | gateway-manager.py:96-113, 119-150 |
| 🟡 IMPORTANT | Security | PreSignUp allowlist — 환경변수 미설정 시 전체 허용 | ADR-008 PreSignUp Lambda |
| 🟡 IMPORTANT | Security | PreTokenGen V2 groups claim override 방식 검증 필요 | ADR-008 PreTokenGen Lambda |
| 🟡 IMPORTANT | Security | DLP 테이블 암호화 불일치 | 03-usage-tracking-stack.ts:60 |
| 🟡 IMPORTANT | Reliability | DELETE API가 PutItem으로 gatewayId 덮어씀 → Lambda 삭제 실패 | gateways/route.ts:62-75 |
| 🟡 IMPORTANT | Reliability | DDB Streams MODIFY 이벤트 미처리 (DELETING status) | gateway-manager.py:195-210 |
| 🟡 IMPORTANT | Cost | Lambda 자기 참조 DDB 업데이트로 불필요한 Stream 이벤트 발생 | gateway-manager.py:47 |
| 🟡 IMPORTANT | Ops Excellence | Lambda handler 이름 불일치 (handler vs lambda_handler) | 03-usage-tracking-stack.ts:282, gateway-manager.py:220 |
| 🟡 IMPORTANT | Ops Excellence | DLQ CloudWatch 알람 미정의 | 03-usage-tracking-stack.ts |
| 🟡 IMPORTANT | Ops Excellence | SQS DLQ RemovalPolicy 미설정 | 03-usage-tracking-stack.ts:273 |

 ▸ Credits: 2.12 • Time: 2m 18s

[1G[?25h