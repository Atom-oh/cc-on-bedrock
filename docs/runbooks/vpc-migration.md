# Move a deployment to an existing VPC

This procedure changes application placement. VPC-independent resources such as
Cognito, DynamoDB, IAM, KMS, ECR and CloudFront remain in the same account and
region. This is not an account migration.

## Identify the destination

Confirm the AWS account, region and exact VPC ID. A Name tag such as `demo-vpc`
is not unique and is not accepted in place of the ID. Inventory the current
deployment before modifying its tfvars.

The destination must provide:

- DNS support and DNS hostnames.
- Public, private-with-egress and isolated subnet groups, each in at least two
  availability zones. All selected subnets must use the VPC's primary IPv4 CIDR.
- Public internet routing for the public load balancers and the required AWS
  service access from private subnets (NAT and/or the appropriate endpoints,
  endpoint policies, DNS and security rules).
- Private subnet AZs compatible with existing persistent EBS volumes. If an AZ
  is absent, prepare a snapshot-based volume copy into a selected AZ first.
- No conflict with the application's DNS Firewall association at priority 101.
  Its managed-threat rules will affect every workload in the target VPC.

The shared network's owning stack retains its routes, gateways and endpoints.
Do not import those resources into this application's state.

## Prepare and inspect

1. Save the Terraform state version and current tfvars securely. Record dashboard
   image tag, launch-template versions, CloudFront origins, routing records,
   user-instance records, security groups, instance IDs and all attached EBS IDs.
2. Establish a maintenance window. Preserve each DevEnv's persistent `/home/coder`
   volume and any additional non-deleting volumes. Take recovery snapshots before
   replacement; verify snapshot completion. Do not assume every attached volume
   is disposable or that every instance is Terraform-managed.
3. Set the destination in the environment's ignored `terraform.tfvars`:

   ```hcl
   vpc_id              = "vpc-0123456789abcdef0"
   public_subnet_ids   = ["subnet-00000000000000001", "subnet-00000000000000002"]
   private_subnet_ids  = ["subnet-00000000000000003", "subnet-00000000000000004"]
   isolated_subnet_ids = ["subnet-00000000000000005", "subnet-00000000000000006"]
   retain_managed_network = true
   ```

   Replace every example ID. Legacy `vpc_cidr` and `*_subnet_cidr_*` settings are
   ignored for placement and security rules in existing-VPC mode. Preserve the
   deployed immutable `dashboard_image_tag` unless a separate image rollout is
   intended.
4. Run `terraform init`, `terraform validate` and `terraform plan -out=...` in
   `terraform/`. Keep saved plans outside version control; they can contain
   sensitive values. Review all replacements and deletions, not only the network
   module. Verify Cognito, DynamoDB, IAM and KMS are retained.
5. Review replacement ordering and fixed resource names for load balancers,
   target groups and security groups. A VPC change can require a service outage.
   Review subnet/ENI dependencies before deleting any old subnet. Preserve the
   old runtime-created DevEnv instances until their recovery path is confirmed.

## Cut over

Use three stages, with a fresh inspected plan for each:

1. With `retain_managed_network = true`, create the temporary
   `module.network.aws_security_group.migration_hold` resource using a targeted
   plan/apply. This migration-specific target preserves the source VPC. Record
   existing DevEnv security-group associations, then associate stopped source
   instances with the hold group. Its rules are Terraform-owned, allow outbound
   HTTPS for SSM recovery, and allow no inbound traffic. Association changes on
   runtime-created instances do not require editing security-group rules.
2. Apply the complete destination change set. If refresh reveals unrelated
   pre-existing drift, record it and generate an explicitly targeted migration
   plan that includes all network-dependent changes and their dependencies.
   Do not roll unrelated application code or policies back as part of this move.
   VPC-derived load-balancer/target-group
   names allow old and new resources to coexist, and force actual cross-VPC
   replacement. Security groups use create-before-destroy. ECS waits for steady
   state; the dashboard ASG waits for a healthy load-balancer target. The old VPC,
   NAT gateways, subnets and endpoints remain available during this stage.
3. Move each runtime-created DevEnv and verify its data, runtime configuration
   and identity records. Once no application ENIs remain in the source VPC, set
   `retain_managed_network = false`, inspect the cleanup plan and apply it.
   The cleanup removes the hold group and the old Terraform-owned network.

Create recovery snapshots for every attached source volume before recreating a
DevEnv. A stopped source can be imaged to preserve its OS and additional disks;
attach its original persistent data volume to the replacement in the same AZ.
Update any persisted OTel endpoint to the destination output. Verify mounts and
data before enabling routing. Do not tag a cloned data disk as a second active
`cc:role=data` volume: the platform deliberately rejects ambiguous volume
identity. Preserve non-data source disks until their recovery copies are verified.

The dashboard ASG, Nginx ECS service, both OTel collectors, load balancers and
application security groups must all use the destination subnets/VPC. Terraform
updates the dashboard's `PRIVATE_SUBNET_IDS` and the DevEnv launch template for
new user instances. Existing user instances are outside Terraform state:
recreate them through the platform's supported lifecycle or an operator migration
that preserves the same instance-profile, data-volume and identity contracts.
Reattach their data volumes in the same AZ, and verify the user-instance and
routing records point to the replacement instance and IP.

Verify dashboard sign-in, DevEnv routing/code-server, Bedrock requests, SSM,
data-volume contents, usage collection and OTLP ingestion. Confirm every former
application ENI/instance has left the old VPC before removing its network.
CloudFront, DNS and global/account-level services do not reside in a VPC.

## Recovery

Before destructive cutover, restoring the previous tfvars and planning should
return to the previous topology. After VPC-bound resources have been replaced
or the old network deleted, rollback is a redeployment, not an instant variable
revert. Use retained data volumes/snapshots and recorded application state;
do not overwrite a newer Terraform state with the old backup.

## References

- [EC2 CreateImage](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_CreateImage.html):
  image creation includes attached EBS mappings; copying an image changes its
  encryption settings.
- [EC2 AttachVolume](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_AttachVolume.html):
  attachment supports running or stopped instances in the same availability zone.
