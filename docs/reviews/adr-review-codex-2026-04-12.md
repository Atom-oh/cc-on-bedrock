# ADR 구현 코드 리뷰 — 코드 정확성 + 보안 (Claude Opus 4.6, Codex 대체)

> Codex CLI (gpt-5.4)가 ChatGPT 계정 모델 제한으로 최종 리뷰를 생성하지 못해,
> Claude Opus 4.6이 Codex 역할(코드 정확성/보안 집중)을 대체하여 수행합니다.
> 모든 대상 파일을 직접 읽고 분석했습니다.

---

## 1. gateway-manager.py Lambda

### 🔴 CRITICAL — Lambda handler 이름 불일치 (confidence: 99)
- **CDK**: `03-usage-tracking-stack.ts:440` → `handler: 'gateway-manager.handler'`
- **Python**: `gateway-manager.py:371` → `def lambda_handler(event, context):`
- **영향**: Lambda 호출 시 `Runtime.HandlerNotFound` 에러 발생. Gateway 생성/삭제가 전혀 동작하지 않음.
- **수정**: CDK에서 `handler: 'gateway-manager.lambda_handler'`로 변경, 또는 Python에서 `def handler(event, context):`로 변경.

### 🔴 CRITICAL — Permission Boundary 미적용 (confidence: 95)
- **위치**: `gateway-manager.py:93-102` — `create_gateway_role()`
- **내용**: `iam.create_role()` 호출에 `PermissionsBoundary` 파라미터가 없음. `02-security-stack.ts`에 `cc-on-bedrock-task-boundary`가 정의되어 있으나 동적 생성 Role에 적용 안 됨.
- **위험**: 향후 이 Role에 추가 정책을 부착하면 Permission Boundary 없이 권한 상승 가능.
- **수정**: `PermissionsBoundary=f"arn:aws:iam::{account_id}:policy/cc-on-bedrock-task-boundary"` 추가.

### 🟡 HIGH — IAM 권한 과다: AttachRolePolicy/DetachRolePolicy 불필요 (confidence: 92)
- **위치**: `03-usage-tracking-stack.ts:481`
- **내용**: `iam:AttachRolePolicy`, `iam:DetachRolePolicy`가 허용되어 있으나, `gateway-manager.py`는 `put_role_policy`(인라인 정책)만 사용. `AttachRolePolicy`로 AWS 관리형 정책(`AdministratorAccess` 등) 부착 가능 → privilege escalation 경로.
- **수정**: `iam:AttachRolePolicy`, `iam:DetachRolePolicy` 제거.

### 🟡 HIGH — iam:PassRole에 Condition 미설정 (confidence: 90)
- **위치**: `03-usage-tracking-stack.ts:481`
- **내용**: `iam:PassRole`에 `iam:PassedToService` condition이 없음. Gateway Role의 trust policy는 `bedrock-agentcore.amazonaws.com`만 허용하지만, PassRole 자체에 서비스 제한이 없어 다른 서비스에도 role 전달 가능.
- **수정**: condition 추가: `"iam:PassedToService": "bedrock-agentcore.amazonaws.com"`.

### 🟡 HIGH — CREATE/DELETE 부분 실패 시 rollback 부재 (confidence: 88)
- **위치**: `gateway-manager.py:151-210` (create_gateway), `gateway-manager.py:213-256` (delete_gateway)
- **내용**:
  - CREATE: IAM Role 생성 성공 → Gateway 생성 실패 시, orphan IAM Role이 남음.
  - DELETE: Gateway 삭제 성공 → IAM Role 삭제 실패 시, orphan Role이 남음.
- **수정**: except 블록에서 보상 트랜잭션(compensating transaction) 패턴 적용. 또는 ERROR 상태에 실패 단계를 기록하여 수동 복구 용이하게.

### 🟡 MEDIUM — DDB Streams 자기 참조 루프 (confidence: 85)
- **위치**: `gateway-manager.py:57-78` (`update_gateway_status`)
- **내용**: Lambda가 `cc-dept-mcp-config` 테이블을 업데이트 → DDB Streams가 다시 Lambda 트리거. `handle_stream_event()`에서 GATEWAY의 MODIFY 이벤트를 무시하므로 무한 루프는 아니지만, 불필요한 Lambda 호출 발생.
- **수정**: DDB Streams EventSourceMapping에 필터 패턴 추가 (`eventName: [INSERT, REMOVE]`만 처리).

### 🟡 MEDIUM — `time.sleep(10)` IAM propagation 대기 (confidence: 80)
- **위치**: `gateway-manager.py:119`
- **내용**: IAM Role 생성 후 10초 고정 대기. AWS IAM eventually consistent 특성상 10초가 불충분할 수 있고, 불필요하게 길 수도 있음. batch에 CREATE 이벤트가 여러 개 있으면 누적 대기 시간이 Lambda timeout(5분)에 근접.
- **수정**: exponential backoff + retry 패턴으로 변경. 또는 `batchSize: 1`로 설정.

---

## 2. API Routes (catalog, gateways)

### 🔴 CRITICAL — DELETE API가 PutItem으로 기존 데이터 덮어쓰기 (confidence: 97)
- **위치**: `gateways/route.ts:105-116`
- **내용**: DELETE handler가 `PutItemCommand`로 전체 아이템을 `{ PK, SK, status: "DELETING", deletedAt, deletedBy }`로 덮어씀. 기존 `gatewayId`, `gatewayUrl`, `roleArn` 속성이 삭제됨.
- **문제**: `gateway-manager.py:219-224`의 `delete_gateway()`는 DDB에서 `gatewayId`를 읽어 삭제하는데, PutItem으로 덮어쓴 후엔 `gatewayId`가 없어 삭제 실패.
- **추가 문제**: DDB Streams에서 `MODIFY` 이벤트가 발생하지만, `handle_stream_event()`는 GATEWAY SK에 대해 INSERT/REMOVE만 처리 → DELETING 상태 변경이 무시됨.
- **수정**: 
  1. `PutItemCommand` → `UpdateItemCommand`로 status만 변경
  2. `handle_stream_event()`에 MODIFY + status=DELETING 케이스 추가

### 🟡 HIGH — POST API에서 department 값 미검증 (confidence: 88)
- **위치**: `gateways/route.ts:59-64`
- **내용**: `department`가 빈 문자열인지만 체크. 특수문자, 슬래시, 공백 등이 포함되면 `DEPT#../../admin` 같은 PK가 생성되어 의도치 않은 DDB 레코드 접근 가능.
- **수정**: `department` 값에 대해 영숫자+하이픈만 허용하는 정규식 검증 추가.

### 🟡 MEDIUM — GET에서 ScanCommand 사용 (confidence: 78)
- **위치**: `gateways/route.ts:24-29`
- **내용**: 전체 테이블 Scan 후 `SK = GATEWAY` 필터링. 부서 수가 적으므로(10-20개) 현재는 허용 가능하지만, MCP 할당 레코드가 많아지면 비효율적.
- **향후**: GSI (`SK`에 GSI 추가) 또는 PK prefix scan 패턴으로 전환 고려.

---

## 3. CDK Stack 변경

### 🟡 MEDIUM — AgentCore Gateway 권한 Resource: * (confidence: 82)
- **위치**: `03-usage-tracking-stack.ts:462-476`
- **내용**: `bedrock-agentcore-control:*` 권한이 `resources: ['*']`로 설정. AgentCore Gateway ARN 패턴이 아직 안정화되지 않았을 수 있지만, 가능하면 리소스를 제한해야 함.
- **향후**: AgentCore API가 ARN 기반 접근 제어를 지원하면 ARN 패턴으로 scope down.

### 🟡 MEDIUM — SQS DLQ RemovalPolicy 미설정 (confidence: 80)
- **위치**: `03-usage-tracking-stack.ts:431-434`
- **내용**: DLQ에 `removalPolicy`가 없어 기본값(`DESTROY`) 적용. 스택 삭제 시 미처리 실패 이벤트 유실.
- **수정**: `removalPolicy: cdk.RemovalPolicy.RETAIN` 추가.

### 🟢 GOOD — DDB Streams EventSourceMapping
- **위치**: `03-usage-tracking-stack.ts:496-503`
- `reportBatchItemFailures: true`, `retryAttempts: 3`, `batchSize: 10`, `maxBatchingWindow: 5s` 모두 적절.
- `onFailure: SqsDlq` + 14일 retention으로 실패 이벤트 보존.
- `startingPosition: TRIM_HORIZON` — 배포 중단 시 이벤트 유실 방지 (Kiro 리뷰와 차이: CDK 코드에서는 `TRIM_HORIZON`으로 확인됨).

### 🟡 LOW — IAM ARN 패턴에 콜론 누락 (confidence: 75)
- **위치**: `03-usage-tracking-stack.ts:483`
- **내용**: `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/...` — `iam:` 뒤에 콜론이 두 개(`::`)로 리전 필드가 비어있음. IAM은 글로벌 서비스이므로 이것이 올바른 형식이지만, 일견 오타처럼 보이므로 주석이 있으면 좋음.

---

## 4. ADR-008 Lambda Trigger 코드

### 🟡 HIGH — PreTokenGeneration V2: cognito:groups override 방식 오류 가능성 (confidence: 85)
- **위치**: ADR-008 line 506
- **내용**: `claimsToAddOrOverride: { 'cognito:groups': JSON.stringify(groupNames) }` — `cognito:groups`는 reserved claim으로, Access Token에서는 `groupOverrideDetails`를 통해서만 수정 가능할 수 있음.
- **추가**: `JSON.stringify(groupNames)`는 `'["admin","dev"]'` 문자열을 생성. `middleware.ts:127`의 `payload["cognito:groups"]`가 배열을 기대하므로 파싱 불일치.
- **수정**: `groupOverrideDetails.groupsToOverride` 사용 검토 + 실제 Cognito V2 API 스펙 테스트.

### 🟡 HIGH — ALLOWED_DOMAINS 환경변수 미설정 시 전체 허용 (confidence: 90)
- **위치**: ADR-008 line 407-408
- **내용**: `(process.env.ALLOWED_DOMAINS || '').split(',').filter(Boolean)` — 환경변수가 빈 문자열이면 빈 배열 → `includes` 체크가 항상 false → 검증 skip(=전체 허용).
- **위험**: 환경변수 설정 실수로 domain allowlist가 무력화.
- **수정**: 빈 배열일 때 기본 차단, 또는 별도 `ALLOW_ALL_DOMAINS=true` 플래그.

### 🟡 MEDIUM — unsafeUnwrap() Apple 비밀키 노출 (confidence: 88)
- **위치**: ADR-008 line 363
- **내용**: `cdk.SecretValue.secretsManager('cc-on-bedrock/apple-signin-key').unsafeUnwrap()` — CFN 템플릿에 비밀키가 평문으로 노출.
- **수정**: `SecretValue.secretsManager()` 직접 전달 (Cognito construct가 `SecretValue` 타입을 받는지 확인 필요).

### 🟢 GOOD — PostAuthentication first-login 감지
- **위치**: ADR-008 line 435
- `event.triggerSource !== 'PostAuthentication_Authentication'` early return으로 불필요한 처리 방지.
- `AdminListGroupsForUser`로 그룹 확인 후, 그룹이 없으면 기본 그룹 추가 — first-login 감지 로직 정확.

---

## 5. ec2-clients.ts 변경

### 🟢 GOOD — PK 형식 일관성
- `COMMON` → `DEPT#COMMON` 변경이 ADR-007 DDB 스키마(`DEPT#{dept}` PK 패턴)와 일치.
- `gateway-manager.py:329-335`의 `pk.startswith("DEPT#")` 체크와도 정합.

---

## 발견사항 요약

| 심각도 | 건수 | 핵심 발견 |
|--------|------|-----------|
| CRITICAL | 3 | handler 이름 불일치, Permission Boundary 미적용, DELETE PutItem 덮어쓰기 |
| HIGH | 5 | IAM 과다권한, PassRole condition 없음, 부분실패 rollback, PreTokenGen 방식, ALLOWED_DOMAINS |
| MEDIUM | 5 | 자기참조 루프, time.sleep, ScanCommand, AgentCore Resource:*, SQS DLQ |
| LOW | 1 | IAM ARN 콜론 형식 |
| **합계** | **14** | |
