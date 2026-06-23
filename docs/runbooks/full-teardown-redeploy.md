# Runbook: Full Teardown + Redeploy (complete wipe — option B)

> ⚠️ **DESTRUCTIVE & IRREVERSIBLE.** Wipes ALL platform state on the dev account
> (180294183052, ap-northeast-2): 35 Cognito users, all usage/limits/budget history,
> all S3 data, per-user secrets, per-user IAM roles. Use only for an intentional
> clean-slate redeploy. Created 2026-06-19 after a devenv EBS data-loss incident.

> **Resource IDs below** (account, Cognito pool `ap-northeast-2_*`, hosted zone `Z…`, golden AMI `ami-…`)
> are from the 2026-06-20 dev wipe. For another account/run derive them via `aws sts get-caller-identity`,
> `terraform output`, or the console — do not copy the literals.

## Scope decision: **B = complete initialization**
Destroy CFN stacks **and** manually delete all RETAIN orphans, then redeploy from scratch.

## PRESERVE (do NOT delete)
- **Golden AMI** `ami-007379804d9dfe4a7` (+ its snapshot) — devenv base, SSM points to it.
- **CDK bootstrap bucket** `cdk-hnb659fds-assets-180294183052-ap-northeast-2`.
- **Route53 hosted zone** `atomai.click` (Z01703432E9KT1G1FIRFM) — the zone itself; only per-user `{subdomain}` records get cleaned.

---

## Phase 0 — Prerequisites (non-destructive)
1. **Merge the EBS-persistence fix to main** so the redeploy doesn't reintroduce the
   data-loss bug:
   ```bash
   gh pr create --base main --head fix/devenv-ebs-delete-on-termination \
     --title "fix(devenv): preserve root EBS on Terminate (DeleteOnTermination=false)" \
     --fill
   # after review/merge:  git checkout main && git pull
   ```
2. Confirm you will redeploy from `main` (which now contains f751b60).

## Phase 1 — Pre-destroy cleanup
```bash
REGION=ap-northeast-2; R="--region $REGION"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
# Instances already terminated. Verify none running:
aws ec2 describe-instances $R --filters "Name=tag:managed_by,Values=cc-on-bedrock" \
  "Name=instance-state-name,Values=running,stopped" \
  --query 'Reservations[].Instances[].InstanceId' --output text
```

## Phase 2 — Destroy stacks
> This wipe predated ADR-033; the platform was still CDK-deployed, so teardown used `cdk destroy`.
> Post-migration the only IaC is Terraform — a future teardown uses `cd terraform && terraform destroy`.
```bash
cd cdk
npx cdk destroy --all          # (pre-ADR-033) EC2 mode + LocalGovernance → --all covers all 7
# RETAIN resources (DynamoDB, Cognito, S3, EC2 vol) will ORPHAN, not delete — handled in Phase 3.
```

## Phase 3 — Delete RETAIN orphans (manual)

### 3a. DynamoDB (13 tables — deletion protection already OFF)
```bash
for t in cc-department-budgets cc-dept-mcp-config cc-dlp-domain-lists cc-mcp-catalog \
  cc-on-bedrock-approval-requests cc-on-bedrock-cli-tokens cc-on-bedrock-limits \
  cc-on-bedrock-usage cc-prompt-audit cc-routing-table cc-user-budgets \
  cc-user-instances cc-user-volumes; do
  aws dynamodb delete-table $R --table-name "$t" && echo "deleted $t"
done
```

### 3b. Cognito user pool (35 users — DeletionProtection INACTIVE)
```bash
aws cognito-idp delete-user-pool $R --user-pool-id ap-northeast-2_fOsHIoJ6b
# Note: domain may need deleting first if a custom Cognito domain is attached.
```

### 3c. S3 buckets (empty, then delete)
```bash
for b in cc-on-bedrock-cost-reports-${ACCOUNT_ID} cc-on-bedrock-otel-metrics-raw-${ACCOUNT_ID} \
  cc-on-bedrock-user-data-${ACCOUNT_ID} cc-on-bedrock-deploy-${ACCOUNT_ID}; do
  aws s3 rm "s3://$b" --recursive
  aws s3api delete-bucket --bucket "$b" $R && echo "deleted $b"
done
# If versioned, delete all versions/markers first (script omitted — check bucket versioning).
```

### 3d. ECR repos (OPTIONAL — rebuildable artifacts, not user state)
```bash
# Skip to save a rebuild, OR for true clean slate:
for r in cc-on-bedrock/dashboard cc-on-bedrock/devenv cc-on-bedrock/nginx cc-on-bedrock/otel-collector; do
  aws ecr delete-repository $R --repository-name "$r" --force && echo "deleted $r"
done
```

### 3e. Secrets (force-delete — else 7-30d recovery window blocks same-name recreate)
```bash
for s in $(aws secretsmanager list-secrets $R --query 'SecretList[?contains(Name,`cc-on-bedrock`)].Name' --output text); do
  aws secretsmanager delete-secret $R --secret-id "$s" --force-delete-without-recovery && echo "deleted $s"
done
```

### 3f. Per-user IAM roles + instance profiles (~22 task + 35 local-user + ~37 profiles)
```bash
# Instance profiles: remove role then delete profile
for p in $(aws iam list-instance-profiles --query 'InstanceProfiles[?starts_with(InstanceProfileName,`cc-on-bedrock`)].InstanceProfileName' --output text); do
  for r in $(aws iam get-instance-profile --instance-profile-name "$p" --query 'InstanceProfile.Roles[].RoleName' --output text); do
    aws iam remove-role-from-instance-profile --instance-profile-name "$p" --role-name "$r"
  done
  aws iam delete-instance-profile --instance-profile-name "$p" && echo "profile $p"
done
# Roles: detach managed, delete inline, then delete role
for role in $(aws iam list-roles --query 'Roles[?starts_with(RoleName,`cc-on-bedrock-task-`)||starts_with(RoleName,`cc-on-bedrock-local-user-`)].RoleName' --output text); do
  for pa in $(aws iam list-attached-role-policies --role-name "$role" --query 'AttachedPolicies[].PolicyArn' --output text); do
    aws iam detach-role-policy --role-name "$role" --policy-arn "$pa"
  done
  for ip in $(aws iam list-role-policies --role-name "$role" --query 'PolicyNames[]' --output text); do
    aws iam delete-role-policy --role-name "$role" --policy-name "$ip"
  done
  aws iam delete-role --role-name "$role" && echo "role $role"
done
# Boundary policy + any shared managed policies are CDK-managed (deleted in Phase 2 if not RETAIN; check cc-on-bedrock-task-boundary).
```

### 3g. EC2 RETAIN orphans
```bash
aws ec2 delete-volume $R --volume-id vol-022aa1e54320b7598   # CcOnBedrock-Ec2Devenv/DevenvLaunchTemplate orphan
aws ec2 delete-launch-template $R --launch-template-name cc-on-bedrock-devenv
```

### 3h. Route53 per-user records (keep the zone)
```bash
# Review first — delete only {subdomain}.atomai.click A/CNAME records for gone users,
# NOT platform records (ALB, CloudFront, ACM _validation, NS/SOA).
aws route53 list-resource-record-sets --hosted-zone-id Z01703432E9KT1G1FIRFM \
  --query 'ResourceRecordSets[?Type==`A`].Name' --output text
# Then targeted change-batch DELETE per record (manual / scripted).
```

## Phase 4 — Redeploy (from main, includes EBS fix)
```bash
# 1. Re-push Docker images (if ECR deleted in 3d)
bash scripts/create-ecr-repos.sh
cd docker && bash build.sh all all && cd ..
# 2. Deploy all infra — Terraform is the only IaC surface (ADR-033)
cd terraform && terraform init && terraform apply && cd ..
# 3. Re-upload dashboard standalone tar to the (recreated) deploy bucket
#    s3://cc-on-bedrock-deploy-${ACCOUNT_ID}/dashboard-deploy.tar.gz
# 4. Re-create Cognito users (admin first, then team) — pool is NEW (new pool id);
#    SSM /cc-on-bedrock/cognito/* updated automatically by the deploy.
```

## Phase 5 — Verify
```bash
bash scripts/verify-deployment.sh atomai.click
# Confirm new instances get DeleteOnTermination=false (the fix):
#   after a user provisions, check:
#   aws ec2 describe-instances --instance-ids <id> \
#     --query 'Reservations[].Instances[].BlockDeviceMappings[].Ebs.DeleteOnTermination'
#   → must be false
```

## Post-redeploy
- Update memory `[[devenv-ebs-data-loss-2026-06-19]]` → fix deployed, platform reset.
- Consider the latent backup gap (ADR-004 root-EBS-only) — DLM snapshot schedule / S3 sync.
