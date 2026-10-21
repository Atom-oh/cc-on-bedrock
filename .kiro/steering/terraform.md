# Terraform Module

## Role
Terraform HCL is the only IaC (ADR-001). The root `main.tf` wires 8 modules; details are in `terraform/CLAUDE.md`.

## Key Files
- `main.tf`, `variables.tf`, `outputs.tf`, `providers.tf` (S3 backend, `us-east-1` alias for CloudFront-scope resources)
- `modules/network/`, `modules/security/`, `modules/ecs-devenv/`, `modules/ec2-devenv/`, `modules/usage-tracking/`, `modules/dashboard/`, `modules/local-governance/`, `modules/waf/`
- `terraform.tfvars.example` - copy to `terraform.tfvars` and set at least `domain_name`

## Rules
- Run `terraform -chdir=terraform fmt -recursive` before committing (`tests/run-all.sh` checks it).
- Pass dependencies between modules as variables/outputs.
- No hardcoded account ID, domain or region; no `0.0.0.0/0` ingress; ingress only through CloudFront.
- `dashboard_image_tag` must be an immutable tag, not `latest`.
