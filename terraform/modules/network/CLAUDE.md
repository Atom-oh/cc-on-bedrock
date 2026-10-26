# Network module

Inherit the repository baseline and `terraform/CLAUDE.md`. This module attaches
platform services to an existing VPC and shared public DNS zone.

## Contract and ownership

- Inputs: `name_prefix`, `vpc_id`, subnet ID lists, `interface_endpoint_services`
  and `domain_name`.
- Outputs include the existing VPC ID/CIDR, subnet IDs/private CIDRs, public zone
  ID/name, DNS Firewall rule group and endpoint security group IDs.
- Own only requested interface endpoints, their security group, DNS Firewall
  resources and association. VPCs, subnets, NAT gateways, internet gateways and
  route tables remain externally managed.
- Private subnets must span at least two availability zones. Avoid requesting
  an endpoint service whose private DNS is already enabled in the VPC.
- The removed `aws_route53_zone.this` state block has `destroy = false`; preserve
  the shared zone during migration and teardown.

## Change constraints

Pass references through module outputs and root wiring. The endpoint security
group's VPC-CIDR ingress is a documented shared-network exception; compute
security groups require their respective source security groups.

DNS Firewall managed-domain-list IDs currently target `ap-northeast-2`; changes
to deployment region require checking those IDs.

## Validation

From the repository root:

```bash
terraform -chdir=terraform fmt -check modules/network
```

Formatting does not validate semantics. Run `terraform -chdir=terraform validate`
against an initialized root configuration; child modules are not independent
deployments.
