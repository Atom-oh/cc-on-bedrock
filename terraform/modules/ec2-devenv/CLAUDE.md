# Per-user EC2 infrastructure module

Inherit the repository baseline and `terraform/CLAUDE.md`. Root includes this
module for the optional `devenv` profile.

## Contract and ownership

- Inputs include project/VPC/KMS/boundary references, instance type, nginx SG
  and collector/endpoint SG lists.
- Outputs expose the launch template, baseline instance profile, open,
  restricted and locked DLP SGs, and instance-index table.
- Terraform owns shared infrastructure. Dashboard runtime owns individual
  user instance creation/start/stop and per-user IAM roles.
- `cc-user-instances` uses key `user_id`; the runtime value is the user's
  validated subdomain. Usage and limit-table identity keys use email separately.

## Change constraints

Admit application ports `1024..65535` only from nginx SG. Preserve the three
DLP egress policies, private collector access on `4318` and endpoint HTTPS
access. The legacy empty-nginx-SG fallback admits default ports from the VPC
CIDR; it is not the normal root-wired deployment.

Require IMDSv2. Both the current launch template and dashboard launch code retain
root EBS (`DeleteOnTermination = false`), while ADR-002 intends root deletion.
Record that discrepancy rather than silently changing lifecycle behavior.
Persistent `/home/coder` data-volume discovery and retention are governed by
dashboard runtime and the baseline, not just launch-template defaults.

## Validation

From the repository root:

```bash
terraform -chdir=terraform fmt -check modules/ec2-devenv
python3 -m pytest tests/unit/test_bedrock_iam_codex_parity.py -q
```

Source parity and formatting do not prove runtime storage lifecycle or deployed
permissions. Semantic Terraform validation requires the initialized root.
