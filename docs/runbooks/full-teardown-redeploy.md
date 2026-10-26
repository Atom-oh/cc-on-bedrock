# Terraform Destroy and Redeploy

This procedure replaces the [historical CDK account wipe](../history/runbooks/2026-06-19-full-account-wipe.md).
Read [deployment](../deployment-guide.md), [ADR-002](../decisions/ADR-002-devenv-compute-storage.md)
and [ADR-015](../decisions/ADR-015-byo-vpc-internal-origins.md) before changing a
running deployment. These are operator steps, not commands executed by doc sync.

## Decide what must survive

Persistent DevEnv `/home/coder` data volumes are distinct from platform records
and artifacts. `DeleteOnTermination=false` protects a volume from EC2 termination;
it is not a backup, and does not retain Cognito accounts, DynamoDB records, S3
objects or a KMS key through every Terraform destroy plan.

Before teardown, record user email/subdomain, instance/data-volume IDs, volume
AZs and encryption-key dependencies. Snapshot required data, export/back up
required platform records, and verify that the recovery inputs are available.
Keep the S3 backend and its versioned state outside this platform teardown.
Stop user writes using the supported lifecycle flow before taking the final
backup. Retain the old configuration and pinned image/AMI identifiers.

The current runtime and launch template retain **both** root and data volumes.
ADR-002's intended ephemeral-root invariant differs from that implementation.
Identify data using `cc:role=data` and canonical subdomain/project tags; do not
classify every unattached root as user data or delete a volume by guessed age.

## Review the destroy plan and protection constraints

Use the existing initialized backend and the correct tfvars/profile:

```bash
terraform -chdir=terraform output -raw deployment_mode
terraform -chdir=terraform plan -destroy -out=destroy.tfplan
terraform -chdir=terraform show destroy.tfplan
```

The plan may stop at a protection constraint: the nginx ECR repository currently
has `prevent_destroy=true`. The dashboard ECR repository uses `force_delete=true`
and its images can be removed by destroy. Other resources may have service-side
protection, retained objects or key deletion windows. A complete destroy is not
an unconditional copy/paste workflow. Resolve retention/import/protection with
an explicit reviewed Terraform lifecycle change before applying the plan; do
not remove safeguards merely to get a green command.

Inspect Cognito/DynamoDB/S3/KMS deletion separately from EC2 volume preservation.
Never include shared VPC, subnets, NAT/IGW or public Route 53 zone in the wipe;
they are deployment inputs, not platform-owned resources. Inventory runtime-
created per-user IAM/instance resources and manual AgentCore resources outside
the state; a successful Terraform plan is not an account-wide inventory.

Apply a saved destroy plan only after its exact deletions, backups and retained
resources have been reviewed. This guide does not prescribe deletion of user
volumes or account-wide prefix cleanup. Keep saved plans/state out of Git.

## Redeploy and reconnect retained data

1. Follow the deployment guide with the same intended profile and initialized
   backend. Reconcile retained repository names with Terraform state/import
   before creating replacements; do not duplicate existing resources.
2. Publish the immutable dashboard image and use the same tag in tfvars. For
   `devenv`, restore router/collector prerequisites and record retained AMI inputs.
3. Review the full plan and apply it. Restore required platform records or
   recreate/invite users with the intended canonical email/subdomain. If custom
   AMIs need rebuilding, do so after the builder role/SG exist and before the
   first DevEnv launch, following the deployment guide.
4. Restore the authoritative `dataVolumeId` where retained records are available.
   Otherwise the dashboard can rediscover a unique tagged data volume and launch
   in its AZ. Duplicate tags or no usable subnet in that AZ fail closed.
5. Use the dashboard to launch/recover the DevEnv. Verify the expected volume is
   mounted at `/home/coder` and the user's files exist before reopening access.

## Verify recovery

Confirm dashboard login/RBAC, local credential renewal, Claude/Codex usage and
budget behavior. For DevEnv, also verify edge routes, filesystem identity,
mount/encryption, telemetry and stop/start behavior. See
[instance recovery](instance-recovery.md) for volume diagnostics.

When intentionally retiring a user's data, use a separately authorized,
user-specific deletion procedure after verifying ownership and retention policy.
This recovery procedure preserves data; the archived account-wipe commands are
not part of it.
