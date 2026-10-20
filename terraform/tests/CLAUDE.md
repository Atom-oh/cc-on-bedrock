# Terraform contract tests

Use Terraform >= 1.7 for mocked providers. Tests must use `command = plan` and
must not create AWS resources. Run from `terraform/` with
`terraform test`.

Cover network ownership, actual CIDR propagation and rejection of incompatible
VPC/subnet inputs. Keep deployed state, credentials and account-specific IDs out
of fixtures.

The DevEnv ingress tests cover Nginx-only access and the explicit fixed-port VPC
fallback across all three security tiers.
