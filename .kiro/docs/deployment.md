# Deployment Entry Point

Follow the canonical [deployment guide](../../docs/deployment-guide.md) and
[decision baseline](../../docs/decisions/BASELINE.md). Terraform is the only IaC.

Configure `terraform/terraform.tfvars` with your region, existing VPC and subnet
IDs, shared Route 53 domain, deployment profile and immutable dashboard image
tag. Initialize the partial S3 backend before running any plan or apply.

1. Select `governance` (default) or `devenv`. Existing DevEnv deployments must
   explicitly retain `devenv`; an unset mode with existing DevEnv SGs fails planning.
2. Configure tfvars and initialize the existing S3 backend.
3. Bootstrap the Terraform-managed dashboard ECR repository, publish the image
   under a commit tag and use that same `dashboard_image_tag` in tfvars.
4. For `devenv`, prepare nginx/collector images as described in the canonical
   guide. Governance needs no DevEnv AMI.
5. Review and apply the full Terraform plan. For `devenv`, then build the AMI
   before the first user environment launch; the helper needs the deployed role
   and open SG and still uses legacy subnet-tag discovery.
6. Invite the first administrator and verify dashboard login, local credentials,
   invocation-log usage and limits.

Useful read-only local checks:

```bash
terraform -chdir=terraform fmt -check -recursive
terraform -chdir=terraform validate
bash tests/run-all.sh
```

`validate` requires initialized providers; the aggregate tests require Python
pytest and installed dashboard dependencies. Live integration checks require a
separate deployed environment.

For preservation and teardown constraints, read
[destroy/redeploy](../../docs/runbooks/full-teardown-redeploy.md). Shared network
resources, the backend and persistent user data are separate lifecycle concerns.
