> Dated operational evidence; status and identifiers describe the recorded event,
> not the current deployment. Follow `docs/deployment-guide.md` and the active runbooks
> for present-day operations.

# Demo VPC migration status

Recorded: 2026-10-20 10:10 UTC. **Migration incomplete; AWS mutations are on hold
pending coordination with a separate cleanup operation.**

## Target and implementation

- Destination: `fsi-demo-vpc`, `vpc-04e77172c67f19814`, Seoul.
- Implementation checkout: `/tmp/cc-demo-vpc-20261020`.
- Origin branch: `feat/existing-vpc-tfvars`; latest commit `3e9394f`.
- Terraform accepts an existing VPC and public/private/isolated subnet IDs through
  tfvars. It validates ownership, primary CIDR, DNS support and AZ coverage.
- Temporary `retain_managed_network=true` keeps the source network until
  application migration and recovery are complete.
- Terraform formatting, validation and all 11 mocked plan tests pass.
- The original workspace checkout and its pre-existing edits were preserved.
  Do not apply Terraform from that stale checkout.

## Applied and observed

- Nginx ECS: 2/2 tasks running in the destination private subnets; one deployment.
- Legacy OTel ECS: 1/1 running in the destination; one deployment.
- Rollup OTel ECS: 2/2 running in the destination; one deployment.
- Four replacement load balancers are active in the destination.
- Both CloudFront distributions point to the replacement load balancers.
- DNS Firewall association and three DevEnv security groups use the destination.
- Dashboard ASG remains in the source VPC. Its replacement ALB currently has no
  migrated dashboard target; public `/api/health` returned **503**.
- The source VPC and one old OTel load balancer remain pending cleanup.

## Concurrent changes that interrupted migration

These actions were not issued by this migration workflow. CloudTrail attributes
them to the same management-host role and AWS CLI:

- 09:59:03 UTC: source DevEnv `i-014fd1b763a21d142` terminated.
- 09:59:44 UTC: original persistent 50 GB EBS volume
  `vol-07e1de493274854a9` deleted.
- 09:59:56 UTC: per-user instance profile `cc-on-bedrock-task-atomoh` deleted;
  the corresponding IAM role is also absent.
- 10:02:01 UTC: remote Terraform state advanced from serial 110 to 111 and lost
  the hosted-zone and two ECR resource bindings. The actual AWS resources still
  exist. A saved migration plan was correctly rejected as stale.

Missing state bindings:

| Terraform address | Existing resource |
|---|---|
| `module.network.aws_route53_zone.this` | `Z01703432E9KT1G1FIRFM` |
| `module.security.aws_ecr_repository.dashboard` | `cc-on-bedrock/dashboard` |
| `module.ecs_devenv[0].aws_ecr_repository.nginx` | `cc-on-bedrock/nginx` |

Do not apply the saved retry plan that proposes recreating these resources.
Reconcile the intended ownership first.

## Recovery material verified

Encrypted recovery AMI `ami-05a478b8f7650b6f7` is available. All its snapshots are
completed and encrypted:

| Device contents | Snapshot |
|---|---|
| Actual 8 GB root | `snap-0494b43a90810c182` |
| Legacy additional 30 GB disk | `snap-05b133a7f6b6dbe54` |
| Persistent 50 GB user data | `snap-05be5837fa0fd534b` |

The source was stopped when the image was created. Restore from this image;
the deleted original data-volume ID cannot be reused. Preserve the recovery
image and snapshots until restored files and runtime behavior have been checked.
The replacement launch was rejected because the instance profile had been
deleted; no replacement instance was created by that attempt.

## Resume sequence

1. Confirm other cleanup/state writers have stopped and reconcile shared-resource
   ownership. Restore missing Terraform bindings only if this state should still
   own those resources.
2. Re-plan from current state. Never apply an old plan or restore an old whole
   state file over the partially migrated deployment.
3. Finish dashboard launch-template/ASG migration and verify public health.
4. Repair the confirmed user's IAM/profile through the platform's supported
   provisioning path. Launch the encrypted recovery image in destination AZ 2a.
5. Verify disk mounts, user files, code-server and telemetry endpoints. Update
   the user-instance mapping with the new instance, private IP and data-volume
   IDs. Restore the user's original stopped lifecycle state.
6. Remove source resources only after successful recovery and service checks.
   Then set `retain_managed_network=false`, inspect a fresh cleanup plan and apply.
7. Record and leave unrelated pre-existing OTel IAM/Lambda/S3 encryption drift
   outside this migration unless separately approved.

Detailed evidence and sensitive plans/state backups are under
`/tmp/cc-demo-vpc-evidence-20261020/migration` (restricted directory). Do not commit
that directory or the ignored deployment tfvars.
