# CDK IAM 권한 전수 리뷰

**Date**: 2026-04-01
**Scope**: `cdk/lib/` 전체 스택 (01~06)
**Reviewer**: Kiro AI

---

## 1. IAM Role 목록 및 권한 요약

### 1.1 ECS Infrastructure Role (`cc-on-bedrock-ecs-infrastructure`)

**Stack**: 02-security | **Principal**: `ecs.amazonaws.com`

| Type | Permission |
|------|-----------|
| Managed Policy | `AmazonECSInfrastructureRolePolicyForVolumes` |
| CDK Grant | `encryptionKey.grantEncryptDecrypt()` → kms:Encrypt, kms:Decrypt, kms:ReEncrypt*, kms:GenerateDataKey* |

### 1.2 ECS Task Role (`cc-on-bedrock-ecs-task`)

**Stack**: 04-ecs-devenv | **Principal**: `ecs-tasks.amazonaws.com`
**Permission Boundary**: `cc-on-bedrock-task-boundary` (optional, via props)

| Type | Actions | Resources |
|------|---------|-----------|
| Inline | bedrock:InvokeModel, InvokeModelWithResponseStream, Converse, ConverseStream | foundation-model/anthropic.claude-*, inference-profile/*anthropic.claude-* |
| Inline | ssmmessages:Create/OpenControlChannel, Create/OpenDataChannel | * |
| CDK Grant | `userDataBucket.grantRead()` | S3 user-data bucket |

### 1.3 ECS Task Execution Role (`cc-on-bedrock-ecs-task-execution`)

**Stack**: 04-ecs-devenv | **Principal**: `ecs-tasks.amazonaws.com`

| Type | Permission |
|------|-----------|
| Managed Policy | `AmazonECSTaskExecutionRolePolicy` |
| Managed Policy | `AmazonEC2ContainerRegistryReadOnly` |
| Inline | secretsmanager:GetSecretValue | `cc-on-bedrock/*` secrets |

### 1.4 Per-User Task Roles (`cc-on-bedrock-task-{subdomain}`)

**Created at runtime** by Dashboard (`aws-clients.ts` → `ensureUserTaskRole()`)
**Permission Boundary**: `cc-on-bedrock-task-boundary`

| Sid | Actions | Resources |
|-----|---------|-----------|
| BedrockClaude | bedrock:InvokeModel, InvokeModelWithResponseStream, Converse, ConverseStream | foundation-model/anthropic.claude-*, inference-profile/*anthropic.claude-* |
| S3UserData | s3:GetObject, s3:PutObject | user-data bucket (per-user path) |
| CloudWatchLogs | logs:CreateLogStream, logs:PutLogEvents | /cc-on-bedrock/* |
| EcrAuth | ecr:GetAuthorizationToken | * |
| EcrPull | ecr:BatchCheckLayerAvailability, GetDownloadUrlForLayer, BatchGetImage | cc-on-bedrock/* repos |
| SecretsRead | secretsmanager:GetSecretValue | cc-on-bedrock/codeserver/* |

### 1.5 Task Permission Boundary (`cc-on-bedrock-task-boundary`)

**Stack**: 02-security

| Sid | Actions | Resources |
|-----|---------|-----------|
| BedrockClaude | bedrock:Invoke*, Converse* | foundation-model + inference-profile |
| S3Access | s3:GetObject, PutObject, ListBucket | user-data + deploy buckets |
| KmsDecrypt | kms:Decrypt, DescribeKey, GenerateDataKey | encryptionKey |
| CloudWatchLogs | logs:CreateLogStream, PutLogEvents, CreateLogGroup | /cc-on-bedrock/* |
| EcrAuth | ecr:GetAuthorizationToken | * |
| EcrPull | ecr:BatchCheck*, GetDownloadUrl*, BatchGetImage | cc-on-bedrock/* repos |
| SsmMessages | ssmmessages:Create/Open* | * |
| SecretsRead | secretsmanager:GetSecretValue | cc-on-bedrock/* |

### 1.6 Dashboard EC2 Role (`cc-on-bedrock-dashboard-ec2`)

**Stack**: 02-security + 05-dashboard | **Principal**: `ec2.amazonaws.com`

| Sid / Type | Actions | Resources |
|------------|---------|-----------|
| Managed | AmazonSSMManagedInstanceCore | — |
| Bedrock | bedrock:Invoke*, Converse* | foundation-model + inference-profile |
| Cognito | AdminCreateUser, AdminDeleteUser, AdminGetUser, AdminUpdateUserAttributes, AdminDisableUser, AdminEnableUser, AdminAddUserToGroup, AdminSetUserPassword, ListUsers, DescribeUserPoolClient | UserPool ARN |
| ECS | RunTask, StopTask, DescribeTasks, ListTasks, TagResource | cluster, task, task-definition, container-instance |
| EfsAccess | elasticfilesystem:DescribeFileSystems | file-system/* |
| AlbManagement | elbv2:Create/DeleteTargetGroup, Register/DeregisterTargets, DescribeTargetGroups, Create/DeleteRule, DescribeRules | * (regional) |
| iam:PassRole | iam:PassRole | ecs-task, ecs-task-execution, task-*, ecs-infrastructure roles |
| IamTaskRoleManagement | iam:CreateRole, GetRole, PutRolePolicy, DeleteRolePolicy, TagRole, DeleteRole | cc-on-bedrock-task-* (with boundary condition) |
| IamTaskRoleRead | iam:GetRole | cc-on-bedrock-task-* |
| SecretsManagerCodeserver | secretsmanager:CreateSecret, PutSecretValue, UpdateSecret, GetSecretValue | cc-on-bedrock/codeserver/* |
| DynamoDBAccess | dynamodb:Scan, Query, GetItem, PutItem, UpdateItem, BatchGetItem | usage, department-budgets, approval-requests tables |
| RoutingTableAccess | dynamodb:PutItem, DeleteItem | cc-routing-table |
| CDK Grant | kms:Decrypt | encryptionKey |
| EfsAccessPointManagement | elasticfilesystem:CreateAccessPoint, DescribeAccessPoints, DeleteAccessPoint | file-system/* |
| EcsTaskDefRegistration | ecs:RegisterTaskDefinition, DescribeTaskDefinition, DescribeClusters | * |
| DeployBucketRead | s3:GetObject, ListBucket | deploy bucket |
| SsmParameterRead | ssm:GetParameter, GetParameters | /cc-on-bedrock/* |
| AgentCoreAccess | bedrock-agentcore:InvokeAgentRuntime, StopRuntimeSession, CreateEvent, ListEvents, GetAgentRuntime | * |
| CloudWatchAccess | cloudwatch:GetMetricData, ListMetrics, GetMetricStatistics | * |
| SecurityDashboard | cloudtrail:LookupEvents, route53resolver:List/GetFirewall*, ec2:DescribeSecurityGroups | * |
| BedrockAccess (05-stack) | bedrock:Invoke*, Converse* | regional foundation-model + inference-profile |

### 1.7 LiteLLM EC2 Role (`cc-on-bedrock-litellm-ec2`) — DEPRECATED

**Stack**: 02-security | Retained for stack dependency.

### 1.8 ECS Instance Role (unnamed, in 04-ecs-devenv)

**Stack**: 04-ecs-devenv | **Principal**: `ec2.amazonaws.com`

| Type | Permission |
|------|-----------|
| Managed | `AmazonEC2ContainerServiceforEC2Role` |
| Managed | `AmazonSSMManagedInstanceCore` |

### 1.9 Nginx Task Role (`cc-on-bedrock-nginx-task`)

**Stack**: 04-ecs-devenv | **Principal**: `ecs-tasks.amazonaws.com`

| Type | Actions | Resources |
|------|---------|-----------|
| Inline | s3:GetObject, ListBucket, HeadObject | user-data bucket |

### 1.10 Lambda Roles (auto-generated by CDK)

| Lambda | Key Permissions |
|--------|----------------|
| **usage-tracker** | DynamoDB RW (usage table), ecs:ListTasks/DescribeTasks |
| **budget-check** | DynamoDB R (usage), RW (dept-budgets, user-budgets), ecs:ListTasks/DescribeTasks/StopTask, cognito-idp:ListUsers/AdminUpdateUserAttributes, iam:PutRolePolicy/DeleteRolePolicy/GetRolePolicy, sns:Publish |
| **warm-stop** | DynamoDB RW (user-volumes), ecs:ListTasks/DescribeTasks/StopTask (*), cloudwatch:GetMetric* (*), lambda:InvokeFunction, sns:Publish |
| **idle-check** | ecs:ListTasks/DescribeTasks, cloudwatch:GetMetric* (*) |
| **ebs-lifecycle** | DynamoDB RW (user-volumes), ec2:CreateVolume/AttachVolume/DetachVolume/CreateSnapshot/DescribeVolumes/DescribeSnapshots/CreateTags (*), ec2:DeleteVolume/DeleteSnapshot (tag-conditioned) |
| **nginx-config-gen** | DynamoDB R (routing-table), S3 Write (user-data bucket) |
| **audit-logger** | DynamoDB Write (cc-prompt-audit) |
| **EnableBedrockLogging (CR)** | bedrock:Put/DeleteModelInvocationLoggingConfiguration, iam:PassRole |

---

## 2. 발견된 문제 (CRITICAL / IMPORTANT)

### 🔴 CRITICAL-1: ECS Infrastructure Role — `kms:CreateGrant` 누락

**File**: `02-security-stack.ts:167`
**Impact**: EBS 볼륨을 ECS Task에 attach할 때 실패

```typescript
// 현재 코드
this.encryptionKey.grantEncryptDecrypt(this.ecsInfrastructureRole);
```

`grantEncryptDecrypt()`는 `kms:Encrypt, kms:Decrypt, kms:ReEncrypt*, kms:GenerateDataKey*`만 부여합니다.
ECS가 EBS 볼륨을 attach할 때 내부적으로 `kms:CreateGrant`와 `kms:DescribeKey`가 필요합니다.

**Fix**:
```typescript
this.encryptionKey.grantEncryptDecrypt(this.ecsInfrastructureRole);
this.ecsInfrastructureRole.addToPolicy(new iam.PolicyStatement({
  sid: 'KmsGrantForEbs',
  actions: ['kms:CreateGrant', 'kms:DescribeKey'],
  resources: [this.encryptionKey.keyArn],
  conditions: {
    Bool: { 'kms:GrantIsForAWSResource': 'true' },
  },
}));
```

**Note**: `grantEncryptDecrypt()`는 `kms:DescribeKey`를 포함하지 않습니다. CDK의 `grant()` 메서드는 `kms:DescribeKey`를 자동 추가하지만, `grantEncryptDecrypt()`는 명시적으로 추가하지 않습니다. EBS attach에는 두 권한 모두 필요합니다.

---

### 🔴 CRITICAL-2: EBS Lifecycle Lambda — KMS 권한 누락

**File**: `04-ecs-devenv-stack.ts` (ebsLifecycleLambda)
**Impact**: KMS 암호화된 EBS 볼륨 생성/스냅샷 실패

Lambda가 `ec2:CreateVolume`, `ec2:CreateSnapshot`을 호출하지만, KMS 암호화 볼륨에 대한 `kms:CreateGrant`, `kms:Decrypt`, `kms:DescribeKey`, `kms:GenerateDataKeyWithoutPlaintext` 권한이 없습니다.

**Fix**:
```typescript
encryptionKey.grantEncryptDecrypt(ebsLifecycleLambda);
ebsLifecycleLambda.addToPolicy(new iam.PolicyStatement({
  actions: ['kms:CreateGrant', 'kms:DescribeKey'],
  resources: [encryptionKey.keyArn],
  conditions: {
    Bool: { 'kms:GrantIsForAWSResource': 'true' },
  },
}));
```

---

### 🟡 IMPORTANT-1: Dashboard EC2 Role — `ec2:ModifyVolume` 누락

**File**: `02-security-stack.ts` (dashboardEc2Role)
**Impact**: Admin EBS resize 기능 (`/api/admin/ebs-resize`) 실패 가능

Dashboard API route `admin/ebs-resize/route.ts`에서 Lambda를 invoke하여 EBS resize를 수행하지만, Dashboard 자체에서 직접 `ec2:ModifyVolume`을 호출하는 경로는 없으므로 현재는 Lambda 경유로 동작합니다. 그러나 Lambda invoke 권한이 Dashboard role에 없습니다.

**Fix**:
```typescript
dashboardEc2Role.addToPolicy(new iam.PolicyStatement({
  sid: 'LambdaInvoke',
  actions: ['lambda:InvokeFunction'],
  resources: [`arn:aws:lambda:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:function:cc-on-bedrock-*`],
}));
```

---

### 🟡 IMPORTANT-2: Dashboard EC2 Role — `dynamodb:GetItem` on `cc-user-volumes` 누락

**File**: `02-security-stack.ts` (dashboardEc2Role)
**Impact**: EBS 모드에서 컨테이너 시작 시 스냅샷 조회 실패

`aws-clients.ts`의 `startContainer()`에서 `cc-user-volumes` 테이블을 `GetItem`으로 조회하지만, Dashboard role의 DynamoDB 권한에 이 테이블이 포함되어 있지 않습니다.

**Fix**:
```typescript
// DynamoDBAccess statement에 추가
`arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/cc-user-volumes`,
```

---

### 🟡 IMPORTANT-3: Dashboard EC2 Role — `dynamodb:GetItem/Query/Scan` on `cc-user-budgets` 누락

**File**: `02-security-stack.ts` (dashboardEc2Role)
**Impact**: `/api/admin/budgets` API에서 per-user budget 조회 실패

`admin/budgets/route.ts`에서 `cc-user-budgets` 테이블을 Scan하지만, Dashboard role에 이 테이블 권한이 없습니다.

**Fix**:
```typescript
// DynamoDBAccess statement에 추가
`arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/cc-user-budgets`,
`arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/cc-user-budgets/*`,
```

---

### 🟡 IMPORTANT-4: Dashboard EC2 Role — `dynamodb:GetItem/UpdateItem` on `cc-routing-table` 누락

**File**: `02-security-stack.ts` (dashboardEc2Role)
**Impact**: 라우팅 테이블에 PutItem/DeleteItem만 있고, GetItem이 없음

`aws-clients.ts`에서 `registerContainerRoute()`는 PutItem, `deregisterContainerRoute()`는 DeleteItem을 사용하므로 현재 권한으로 충분합니다. 그러나 향후 GetItem 조회가 필요할 수 있습니다. **현재는 문제 없음**.

---

### 🟡 IMPORTANT-5: Per-User Task Role — `s3:ListBucket` 누락

**File**: `aws-clients.ts` → `ensureUserTaskRole()`
**Impact**: S3 user-data 버킷에서 ListBucket 불가

Permission Boundary에는 `s3:ListBucket`이 포함되어 있지만, 런타임에 생성되는 per-user role의 inline policy에는 `s3:GetObject`, `s3:PutObject`만 있고 `s3:ListBucket`이 없습니다.

**Fix** (aws-clients.ts):
```typescript
Action: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
```

---

### 🟡 IMPORTANT-6: Per-User Task Role — SSM Messages 권한 누락

**File**: `aws-clients.ts` → `ensureUserTaskRole()`
**Impact**: ECS Exec 실패 (per-user role로 override 시)

공유 ECS Task Role에는 `ssmmessages:*` 권한이 있지만, per-user role에는 없습니다. `RunTask`에서 `overrides.taskRoleArn`으로 per-user role을 지정하면 ECS Exec이 동작하지 않습니다.

**Fix** (aws-clients.ts):
```typescript
{
  Sid: "SsmMessages",
  Effect: "Allow",
  Action: [
    "ssmmessages:CreateControlChannel",
    "ssmmessages:CreateDataChannel",
    "ssmmessages:OpenControlChannel",
    "ssmmessages:OpenDataChannel",
  ],
  Resource: "*",
},
```

---

### 🟡 IMPORTANT-7: EBS Lifecycle Lambda — `ec2:ModifyVolume` 누락

**File**: `04-ecs-devenv-stack.ts` (ebsLifecycleLambda)
**Impact**: `modify_volume` action 실패

`ebs-lifecycle.py`에 `modify_volume` 핸들러가 있고 `ec2.modify_volume()`을 호출하지만, Lambda IAM policy에 `ec2:ModifyVolume`이 없습니다.

**Fix**:
```typescript
ebsLifecycleLambda.addToPolicy(new iam.PolicyStatement({
  actions: ['ec2:ModifyVolume'],
  resources: ['*'],
  conditions: {
    StringEquals: { 'aws:ResourceTag/managed_by': 'cc-on-bedrock' },
  },
}));
```

---

### 🟡 IMPORTANT-8: Dashboard EC2 Role — `ecs:ExecuteCommand` 누락

**File**: `02-security-stack.ts` (dashboardEc2Role)
**Impact**: `/api/containers` route에서 ECS Exec 호출 불가

`containers/route.ts`에서 `ExecuteCommandCommand`를 import하고 있으며, EFS per-user usage 조회에 사용될 수 있습니다.

**Fix**:
```typescript
// ECS statement에 추가
'ecs:ExecuteCommand',
```

---

### 🟡 IMPORTANT-9: Dashboard EC2 Role — Secrets Manager `DeleteSecret` 누락

**File**: `02-security-stack.ts` (dashboardEc2Role)
**Impact**: 사용자 삭제 시 code-server 비밀번호 secret 정리 불가

사용자를 삭제할 때 Cognito user는 삭제하지만, Secrets Manager의 `cc-on-bedrock/codeserver/{subdomain}` secret은 남게 됩니다.

**Fix** (선택적):
```typescript
// SecretsManagerCodeserver에 추가
'secretsmanager:DeleteSecret',
```

---

## 3. 서비스별 권한 매트릭스

### KMS

| Role | Encrypt | Decrypt | CreateGrant | DescribeKey | GenerateDataKey |
|------|---------|---------|-------------|-------------|-----------------|
| ECS Infrastructure | ✅ | ✅ | ❌ **MISSING** | ❌ **MISSING** | ✅ |
| Dashboard EC2 | — | ✅ | — | — | — |
| EBS Lifecycle Lambda | ❌ **MISSING** | ❌ **MISSING** | ❌ **MISSING** | ❌ **MISSING** | ❌ **MISSING** |
| Permission Boundary | — | ✅ | — | ✅ | ✅ |

### ECS

| Role | RunTask | StopTask | DescribeTasks | ListTasks | RegisterTaskDef | ExecuteCommand |
|------|---------|----------|---------------|-----------|-----------------|----------------|
| Dashboard EC2 | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ **MISSING** |
| Budget-check Lambda | — | ✅ | ✅ | ✅ | — | — |
| Warm-stop Lambda | — | ✅ | ✅ | ✅ | — | — |

### DynamoDB (Dashboard EC2 Role)

| Table | Scan | Query | GetItem | PutItem | UpdateItem | DeleteItem |
|-------|------|-------|---------|---------|------------|------------|
| cc-on-bedrock-usage | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| cc-department-budgets | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| cc-on-bedrock-approval-requests | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| cc-routing-table | — | — | — | ✅ | — | ✅ |
| cc-user-volumes | ❌ **MISSING** | ❌ | ❌ **MISSING** | ❌ | ❌ | ❌ |
| cc-user-budgets | ❌ **MISSING** | ❌ | ❌ **MISSING** | ❌ | ❌ | ❌ |

### S3

| Role | GetObject | PutObject | ListBucket |
|------|-----------|-----------|------------|
| ECS Task (shared) | ✅ (grant) | — | ✅ (grant) |
| Per-User Task (runtime) | ✅ | ✅ | ❌ **MISSING** |
| Nginx Task | ✅ | — | ✅ |
| Dashboard EC2 | ✅ (deploy) | — | ✅ (deploy) |

### Secrets Manager

| Role | GetSecretValue | CreateSecret | PutSecretValue | DeleteSecret |
|------|----------------|--------------|----------------|--------------|
| Dashboard EC2 | ✅ | ✅ | ✅ | ❌ (orphan risk) |
| ECS Task Execution | ✅ | — | — | — |
| Per-User Task | ✅ (codeserver/*) | — | — | — |

### Cognito

| Role | AdminCreate | AdminDelete | AdminGet | AdminUpdate | ListUsers | AdminSetPassword |
|------|-------------|-------------|----------|-------------|-----------|------------------|
| Dashboard EC2 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Budget-check Lambda | — | — | — | ✅ | ✅ | — |

---

## 4. 수정 우선순위

| Priority | Issue | Impact | Effort |
|----------|-------|--------|--------|
| 🔴 P0 | CRITICAL-1: ECS Infra Role kms:CreateGrant/DescribeKey | EBS attach 실패 | Low |
| 🔴 P0 | CRITICAL-2: EBS Lifecycle Lambda KMS 권한 | 암호화 볼륨 생성 실패 | Low |
| 🟡 P1 | IMPORTANT-1: Dashboard Lambda invoke 권한 | Admin EBS resize 실패 | Low |
| 🟡 P1 | IMPORTANT-2: Dashboard cc-user-volumes 테이블 | EBS 스냅샷 복원 실패 | Low |
| 🟡 P1 | IMPORTANT-3: Dashboard cc-user-budgets 테이블 | Budget 조회 실패 | Low |
| 🟡 P1 | IMPORTANT-6: Per-User Role SSM Messages | ECS Exec 실패 | Low |
| 🟡 P1 | IMPORTANT-7: EBS Lambda ec2:ModifyVolume | Volume resize 실패 | Low |
| 🟡 P2 | IMPORTANT-5: Per-User Role s3:ListBucket | S3 listing 불가 | Low |
| 🟡 P2 | IMPORTANT-8: Dashboard ecs:ExecuteCommand | ECS Exec 불가 | Low |
| 🟡 P3 | IMPORTANT-9: Dashboard secretsmanager:DeleteSecret | Secret orphan | Low |

---

## 5. 긍정적 사항

- Permission Boundary 패턴이 잘 적용되어 per-user role의 권한 상한이 제한됨
- IAM role 생성 시 boundary condition으로 권한 에스컬레이션 방지
- Lambda role은 CDK grant 패턴으로 최소 권한 원칙 준수
- EBS 삭제 작업에 tag condition 적용 (managed_by: cc-on-bedrock)
- iam:PassRole이 특정 role ARN 패턴으로 제한됨
- IMDS 차단 (ECS_AWSVPC_BLOCK_IMDS + IMDSv2) 으로 credential 탈취 방지
- ECS Instance Role에 Bedrock 권한 없음 (Task Role만 사용)
