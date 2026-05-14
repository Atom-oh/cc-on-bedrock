# Post-ADR-021 Follow-up Plan

PR #13 (ADR-021 wildcard Claude IAM)의 AI review 코멘트 중 코드 단위 small fix는 같은 PR에서 즉시 적용됐고(#2 docs, #5 retry, #6 try/finally, #9 docs, #4 perf, TF outputs CI), 설계 영향이 큰 7개 item을 본 문서에 정리한다. 각 항목은 별도 PR/branch 로 분리해 처리한다.

## Status: Open (2026-05-14)

| # | Issue | Severity | Effort | Owner |
|---|---|---|---|---|
| 1 | Region wildcard backup (SCP) | Critical | M | TBD |
| 3 | Cost allocation tag migration (`cc:*` → `username`/`department`) | Critical | L (breaking) | TBD |
| 7 | CloudFront Lambda@Edge cross-stack share | High | M | TBD |
| 8 | CloudFront secret rotation + CFN access restriction | High | M | TBD |
| 10 | Terraform Local Governance module parity | Medium | L | TBD |
| 11 | `cc-on-bedrock-limits` GSI to replace Scan | Medium | M | TBD |
| 12 | Origin-router archival migration-order validation | Medium | S | TBD |

---

## 1. Region Wildcard Backup (SCP) — Critical

### Context
ADR-021은 `arn:aws:bedrock:*::foundation-model/*anthropic.claude-*` 와일드카드 region을 의도적으로 채택했다 — cross-region inference profile(`global.anthropic.*`)이 caller region과 다른 region의 model을 invoke할 때 IAM resource ARN의 region 필드가 caller region과 일치하지 않을 수 있기 때문. Bedrock Application Inference Profile도 같은 이유로 region wildcard가 안전한 선택.

그러나 review의 지적: IAM 정책이 region wildcard이면 runtime enforcer(`token-limit-enforcer`, `budget-check`)가 모든 차단을 책임진다. 둘 다 Lambda → DynamoDB → IAM `PutRolePolicy` 체인에 의존하므로 단일 지점 실패 시 wide-open. backup 통제로 SCP 또는 별도 boundary 필요.

### Plan
**옵션 A (권장): Organizations SCP**
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "DenyBedrockOutsidePrimaryRegions",
    "Effect": "Deny",
    "Action": "bedrock:*",
    "Resource": "*",
    "Condition": {
      "StringNotEqualsIfExists": {
        "aws:RequestedRegion": ["ap-northeast-2", "us-east-1", "us-west-2", "eu-west-1", "apac-northeast-1"]
      },
      "ArnNotLike": {
        "aws:PrincipalARN": "arn:aws:iam::*:role/OrganizationAccountAccessRole"
      }
    }
  }]
}
```
ap-northeast-2 + cross-region inference profile이 라우팅하는 region들만 화이트리스트. 계정-수준 통제이므로 어떤 role이나 policy 실수도 흡수.

**옵션 B (대안): IAM PermissionBoundary에 `aws:RequestedRegion` 조건 추가**
SCP가 없는 단일 계정 환경 대비.
```typescript
new iam.PolicyStatement({
  sid: 'BedrockClaude',
  actions: [...],
  resources: [...wildcard 3종...],
  conditions: {
    StringEquals: {
      'aws:RequestedRegion': ['ap-northeast-2', 'us-east-1', 'us-west-2', 'eu-west-1', 'apac-northeast-1'],
    },
  },
}),
```
주의: cross-region inference profile은 caller region이 ap-northeast-2여도 internally 다른 region을 호출. AWS는 caller's RequestedRegion만 평가하므로 ap-northeast-2 화이트리스트면 충분. 확인 필요.

### Effort
- SCP: Organizations admin 작업 + 테스트 ~1d
- IAM condition: CDK 변경 + region 매트릭스 검증 ~0.5d

### Risk
조건이 너무 좁으면 합법 호출 거부 위험. 우선 ap-northeast-2 + us-east-1 + us-west-2 화이트리스트로 시작하고 운영 중 region 추가.

---

## 3. Cost Allocation Tag Migration — Critical (Breaking)

### Context
`shared/nextjs-app/src/lib/ec2-clients.ts:1213-1217`가 EC2/EBS 리소스에 부착하는 tag schema를 `cc:user` → `username`, `cc:department` → `department`로 변경. Cost Explorer/CUR 활성 tag는 변경된 이름으로 다시 등록 필요. 기존 `cc:*` tag 기반 dashboard 쿼리/필터가 즉시 작동 정지.

ADR-011은 `cc:*` prefix 컨벤션을 명시했으므로 ADR-011 자체 갱신 또는 신규 ADR로 결정 기록 필요.

### Plan
**Phase 0 (즉시)**: 새 ADR (ADR-022 cost-tag-schema-unification) 작성. 두 schema 의도 정리, runtime tracker가 양쪽 tag 모두 읽도록 일시 dual-write.

**Phase 1 (1주 내)**: 모든 신규 리소스에 새 schema (`username`, `department`) 적용. EC2 RunInstances, EBS Volume create, IAM Role tag 등.

**Phase 2 (1-2주)**: 기존 리소스에 backfill — Lambda one-shot 또는 console:
```python
for instance in describe_instances():
    tags = instance['Tags']
    new_tags = []
    for t in tags:
        if t['Key'] == 'cc:user':
            new_tags.append({'Key': 'username', 'Value': t['Value']})
        elif t['Key'] == 'cc:department':
            new_tags.append({'Key': 'department', 'Value': t['Value']})
    if new_tags:
        ec2.create_tags(Resources=[instance['InstanceId']], Tags=new_tags)
```

**Phase 3**: Cost Explorer / CUR 활성 tag 변경. CUR 쿼리/dashboard 갱신.

**Phase 4 (확인 후)**: 옛 `cc:*` tag 제거.

### Effort
- ADR + dual-write: 0.5d
- Backfill Lambda: 0.5d
- CUR/dashboard 마이그레이션: 1d
- 전체: 2-3d (스테이징 검증 포함)

### Risk
backfill 실패 시 cost attribution 부정확. dual-read 기간을 충분히 두는 게 핵심.

---

## 7. CloudFront Lambda@Edge Cross-Stack Share — High

### Context
`cdk/lib/04-ecs-devenv-stack.ts:408-436` 주석은 session-validator EdgeFunction을 Stack 04(DevEnv CF)와 Stack 05(Dashboard CF) 양쪽이 공유한다고 명시하나, 실제 코드는 Stack 04에서만 EdgeFunction을 생성. Stack 05의 참조 경로(SSM export → import 또는 cross-region reference)가 diff에서 보이지 않음. 첫 배포 시 Stack 05 build 실패 가능.

### Plan
**옵션 A (권장): SSM Parameter Store 매개**
- Stack 04 (us-east-1): EdgeFunction version ARN을 `/cc-on-bedrock/edge-functions/session-validator-version-arn` SSM에 PUT
- Stack 05 (us-east-1): SSM `StringParameter.fromStringParameterName`으로 read, `cloudfront.Function.fromFunctionArn`으로 wrap

**옵션 B: CDK `crossRegionReferences`**
- Stack 04 ↔ 05가 같은 region(us-east-1)이라 cross-region이 아니라 plain cross-stack export 가능
- 그러나 Edge Function은 us-east-1 hard requirement + Dashboard Stack 05도 us-east-1 CF 부분 분리되어 있어 복잡
- 보류

**옵션 C: Custom Resource → DescribeFunction**
- Stack 05에서 Custom Resource로 EdgeFunction을 lookup
- Lambda 실행 비용 + cold start, 권장 안 함

### Effort
SSM 경로: 0.5d (Stack 04 PUT + Stack 05 read + 첫 배포 검증)

### Risk
재배포 순서 의존성 (Stack 04 → Stack 05). 명시적 `addDependency` 필요.

---

## 8. CloudFront Secret Rotation + CFN Stack Access — High

### Context
`cdk/lib/04-ecs-devenv-stack.ts:436` — `cloudfrontSecret.secretValue.unsafeUnwrap()`이 CloudFormation 템플릿에 평문으로 박힘. CloudFront origin custom header는 Secrets Manager dynamic reference를 지원하지 않으므로 unavoidable trade-off지만 secret 노출면 최소화 필요:

1. **Rotation 부재**: 현재 한 번 생성된 secret을 무기한 사용. 누출 시 만료 메커니즘 없음
2. **CFN stack 접근 제한 부재**: 누구든 `cloudformation:GetTemplate`/`DescribeStackResource`로 평문 secret 추출 가능

### Plan
1. **Secret rotation**: Secrets Manager `RotateSecret` + Lambda rotator. 매 90일. rotation 시 1) 새 secret 발행 → 2) ALB listener rule에 새 header 값 추가(grace period 1h) → 3) CloudFront origin header 새 값으로 교체 → 4) ALB old 값 제거. grace로 무중단.
2. **CFN access 제한**: CloudFormation stack resource policy 또는 dedicated `cloudformation:GetTemplate` deny IAM policy를 non-admin role에 부착.
3. **Alt origin protection**: VPC origin (CloudFront → ALB private link) 도입 시 secret-based pinning 자체가 불필요해짐. Phase 2 candidate.

### Effort
- Rotation Lambda + 운영 테스트: 1d
- CFN access policy: 0.5d
- 합계: 1.5d

### Risk
Rotation grace period 동안 ALB rule 2개 공존 — config drift 가능. 단일 rotation Lambda가 양쪽 변경을 atomic하게 처리해야 함.

---

## 10. Terraform Local Governance Parity — Medium

### Context
ADR-014 Local Governance 전체(STS Issuer Lambda, token-limit-enforcer, limit-reset, `cc-on-bedrock-limits` table) 가 Terraform에 없음. ADR-016 CloudFront split도 TF에 없음. README는 "CDK/Terraform/CloudFormation 3가지로 동일 인프라" 라고 명시하므로 parity drift.

### Plan
**옵션 A (권장): TF module 추가**
- `terraform/modules/local-governance/main.tf` 작성 — CDK Stack 08과 동등 리소스 set
- root `main.tf`에 module call 추가, `governance_only = true` variable
- Lambda 코드는 동일 (`cdk/lib/lambda/*` 경로 ZIP) — DRY 유지

**옵션 B: README/CLAUDE.md에 "Local Governance는 CDK only" 명시**
- TF parity 포기, 사용자가 CDK 선택하도록 가이드
- 빠르지만 future drift 가능

### Effort
옵션 A: 1.5d (lambda packaging, IAM, DDB stream → enforcer 구성, EventBridge rules 4개, SNS topic)
옵션 B: 0.5h

### Risk
TF 모듈에서 Lambda 함수 코드 path를 CDK와 공유하는 것은 DRY지만 빌드 환경 의존성 다름. zip 패키징을 빌드 스크립트로 통일 권장.

---

## 11. `cc-on-bedrock-limits` Table GSI — Medium

### Context
`cdk/lib/lambda/budget-check.py:28` `MAX_SCAN_PAGES=100`. limits 테이블이 커지면 5분 cycle에서 Scan timeout. budget-check는 모든 LIMIT/COUNTER/DENY 행을 훑어 한도 위반자를 찾는데 row 수가 사용자 × period × dept × counter buckets로 증가.

### Plan
**Phase 1**: limits 테이블에 GSI 추가
```typescript
this.limitsTable.addGlobalSecondaryIndex({
  indexName: 'sk-pk-index',
  partitionKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.ALL,
});
```
SK가 `LIMIT#daily`, `COUNTER#daily#{bucket}`, `DENY#active` 등 type-discriminator이므로 SK partition으로 type별 query 가능.

**Phase 2**: budget-check.py가 Scan 대신 Query 사용
```python
resp = dynamodb_client.query(
    TableName=LIMITS_TABLE,
    IndexName='sk-pk-index',
    KeyConditionExpression='SK = :sk',
    ExpressionAttributeValues={':sk': {'S': 'DENY#active'}},
)
```

**Phase 3**: token-limit-enforcer의 `_prefetch_limits()`도 GSI 활용 가능하면 적용 (현재는 BatchGetItem으로 이미 N+1 해결).

### Effort
1d (GSI 추가 + budget-check 마이그레이션 + 운영 검증)

### Risk
GSI throughput 비용 증가. Pay-per-request라 idle 비용은 없으나 hot path에서 GSI write 비용 발생. 측정 후 결정.

---

## 12. Origin-Router Archival Migration Order — Medium

### Context
`cdk/lib/lambda/_archived/devenv-origin-router/` — ADR-016 CloudFront split 후 더 이상 사용되지 않는 Lambda@Edge. CDK stack에서 함수 정의를 제거하면 첫 cdk deploy에서 즉시 삭제 시도. 기존 CloudFront distribution이 여전히 이 함수를 viewer-request로 참조 중이면 IAM `cloudfront:UpdateDistribution` 또는 `DELETE_FAILED`.

ADR-016 마이그레이션 plan Step 3 (`docs/plans/cloudfront-split.md`)는 "Lambda@Edge 연결 해제 ~15분"이라 했으나 CDK에서 함수 자체 제거와 distribution 참조 해제의 순서를 명확히 정의해야.

### Plan
1. **Step 1**: CloudFront distribution config에서 Lambda@Edge association 제거 (CDK는 distribution behavior에서 ARN 빼기). distribution 갱신 후 ~15-30분 propagation.
2. **Step 2**: Lambda 함수 자체 제거 (CDK에서 함수 정의 삭제). distribution 참조가 없으므로 즉시 삭제 가능.
3. **Step 3**: `_archived/` 디렉토리 git에서 제거.

순서 위반 시 발생하는 에러:
- "The function … is currently being used by a CloudFront distribution"

CDK가 이 순서를 자동으로 보장하지 않으므로 두 번의 deploy로 분리 필요. ADR-016 마이그레이션 plan에 명시 추가.

### Effort
0.5d (plan 갱신 + 운영 step 검증)

### Risk
Lambda@Edge replica는 전 region에 복제되므로 전체 정리에 추가 24-48h 소요. PR로 함수 정의 제거 후 한참 뒤에 actual 삭제 가능.

---

## Tracking

각 항목 처리 PR이 이 plan의 line item을 close하면서 status update.
- [ ] #1 SCP/region condition
- [ ] #3 Cost tag migration (ADR-022 + dual-write + backfill)
- [ ] #7 CF Lambda@Edge SSM share
- [ ] #8 CF secret rotation
- [ ] #10 Terraform LocalGov parity (or "CDK-only" 명시)
- [ ] #11 limits GSI
- [ ] #12 origin-router archival order

## References
- ADR-011: Bedrock IAM Cost Allocation (tag schema 진실 원천)
- ADR-014: Local Governance Mode
- ADR-015: Dollar Budget × Normalized Token Limit
- ADR-016: CloudFront Distribution Split
- ADR-020: Runtime IAM Policy Upsert
- ADR-021: Wildcard Claude-Family IAM (this PR)
- PR #13: AI review (github-actions bot comment 2026-05-14T04:05Z)
