# ADR-015: Select an existing VPC through Terraform variables

Status: Accepted
Date: 2026-10-20

## Context

Demo workloads need to use an operator-selected shared VPC. The network module
previously created a dedicated VPC unconditionally. Changing its Name tag would
not move any workloads. Deployments must remain portable, preserve user data and
keep Terraform as the only application infrastructure definition.

## Decision

Accept `vpc_id`, `public_subnet_ids`, `private_subnet_ids` and
`isolated_subnet_ids` through tfvars. When `vpc_id` is omitted, preserve the
dedicated-network path. Explicit moved blocks preserve its existing state
addresses as managed resources gain conditional creation.

Read an existing VPC and its subnets through data sources. Require DNS support
and hostnames, distinct subnet groups, VPC membership, primary-CIDR containment
and at least two availability zones per group. Routing and service connectivity
remain deployment preflight checks; subnet IDs alone do not prove route intent.
Derive the application VPC CIDR and DevEnv OTLP egress subnet CIDRs from AWS.

Shared VPCs, NAT gateways, routes and endpoints remain owned by their original
infrastructure. Do not import or recreate them in this application's state.
Keep the application's public hosted zone and managed-threat DNS Firewall
rules. Their association moves to the selected VPC and applies VPC-wide;
check existing associations and priority conflicts before deployment.

## Consequences

The default path can upgrade without replacing its network. Switching paths on
an already deployed stack is a migration: the plan removes its old managed
network and replaces VPC-bound application resources. It cannot move
runtime-created DevEnv instances. Operators must preserve persistent EBS data,
maintain a recovery point and inspect the complete plan before cutover.

The initial existing-network contract uses the VPC's primary IPv4 CIDR, matching
the application's single-CIDR security rules. Subnets in secondary CIDRs are
rejected rather than silently receiving incomplete access rules.

The exact demo VPC ID belongs in environment-specific tfvars, not in source.
See the [migration runbook](../runbooks/vpc-migration.md).
