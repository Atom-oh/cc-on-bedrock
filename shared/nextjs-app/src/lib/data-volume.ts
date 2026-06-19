/**
 * ADR-032: per-user persistent data EBS (holds all of /home/coder), separate from
 * the ephemeral OS root. This module owns volume identity, AZ resolution, tagging,
 * and create/attach — keyed by subdomain but with DynamoDB `dataVolumeId` as the
 * authoritative reference (tag lookup is a fail-closed fallback only).
 *
 * Mount/migration logic lives in data-volume-userdata.ts; SSM out-of-band migration
 * of legacy root-only instances lives in data-volume-ssm.ts.
 */
import {
  EC2Client,
  DescribeVolumesCommand,
  DescribeSubnetsCommand,
  CreateVolumeCommand,
  AttachVolumeCommand,
  CreateTagsCommand,
} from "@aws-sdk/client-ec2";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const ec2 = new EC2Client({ region });
const VPC_SUBNET_IDS = (process.env.PRIVATE_SUBNET_IDS ?? "").split(",").filter(Boolean);

/** Filesystem label used for mounting — fstab mounts by LABEL, never device name. */
export const DATA_LABEL = "CCDATA";
/** Requested block-device name (advisory on Nitro/Graviton — actual device is NVMe). */
export const DATA_DEVICE = "/dev/sdf";
export const DEFAULT_DATA_SIZE_GB = 50;

export interface EbsTag {
  Key: string;
  Value: string;
}

export interface DataVolumeRef {
  volumeId: string;
  az: string;
  state?: string;
}

/** Minimal shape of the fields we read off DescribeVolumes/DescribeSubnets results. */
interface VolumeLike {
  VolumeId?: string;
  AvailabilityZone?: string;
  State?: string;
}
interface SubnetLike {
  SubnetId?: string;
  AvailabilityZone?: string;
}

/** Identity tags for the persistent data volume (cc:role=data distinguishes it from root). */
export function dataVolumeTags(subdomain: string, username: string, department: string): EbsTag[] {
  return [
    { Key: "Name", Value: `cc-data-${subdomain}` },
    { Key: "subdomain", Value: subdomain },
    { Key: "cc:subdomain", Value: subdomain },
    { Key: "cc:role", Value: "data" },
    { Key: "managed_by", Value: "cc-on-bedrock" },
    { Key: "cc:project", Value: "cc-on-bedrock" },
    { Key: "cc:user", Value: username },
    { Key: "cc:department", Value: department },
  ];
}

/**
 * Born-attached block-device mapping for RunInstances. Persistent
 * (DeleteOnTermination=false) and encrypted. Raw-device ext4 (no partition) — resize
 * uses resize2fs directly, never growpart.
 */
export function dataVolumeBlockDeviceMapping(sizeGb: number = DEFAULT_DATA_SIZE_GB) {
  return {
    DeviceName: DATA_DEVICE,
    Ebs: {
      VolumeSize: sizeGb,
      VolumeType: "gp3" as const,
      DeleteOnTermination: false,
      Encrypted: true,
    },
  };
}

/**
 * Pure selector over DescribeVolumes results. Returns the single matching data volume
 * or null. FAIL-CLOSED on >1 match — refusing to guess prevents attaching the wrong
 * user's data after subdomain reuse (ADR-032 rule 1; codex/agy CRITICAL).
 */
export function pickDataVolume(volumes: VolumeLike[] | undefined): DataVolumeRef | null {
  const candidates = (volumes ?? []).filter(
    (v) => v.State !== "deleting" && v.State !== "deleted" && v.VolumeId,
  );
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    throw new Error(
      `fail-closed: ${candidates.length} data volumes match this subdomain — refusing to guess. ` +
        `Resolve via DynamoDB dataVolumeId or clean up orphans first.`,
    );
  }
  const v = candidates[0];
  return { volumeId: v.VolumeId!, az: v.AvailabilityZone!, state: v.State };
}

/**
 * Pure selector mapping a volume's AZ to a usable SubnetId. FAIL-CLOSED when no subnet
 * exists in that AZ — launching elsewhere would InvalidVolume.ZoneMismatch-brick the env
 * (ADR-032 rule 2; codex/agy CRITICAL).
 */
export function pickSubnetForAz(subnets: SubnetLike[] | undefined, az: string): string {
  const match = (subnets ?? []).find((s) => s.AvailabilityZone === az && s.SubnetId);
  if (!match) {
    throw new Error(`no private subnet in AZ ${az} — cannot reattach data volume (would ZoneMismatch)`);
  }
  return match.SubnetId!;
}

/** Find the data volume for a subdomain by tag. Fail-closed on duplicates (pickDataVolume). */
export async function findDataVolume(subdomain: string): Promise<DataVolumeRef | null> {
  const res = await ec2.send(
    new DescribeVolumesCommand({
      Filters: [
        { Name: "tag:cc:subdomain", Values: [subdomain] },
        { Name: "tag:cc:role", Values: ["data"] },
        { Name: "tag:cc:project", Values: ["cc-on-bedrock"] },
      ],
    }),
  );
  return pickDataVolume(res.Volumes as VolumeLike[] | undefined);
}

/** Resolve a SubnetId in the given AZ from the configured private subnets. */
export async function resolveSubnetForAz(az: string): Promise<string> {
  const res = await ec2.send(new DescribeSubnetsCommand({ SubnetIds: VPC_SUBNET_IDS }));
  return pickSubnetForAz(res.Subnets as SubnetLike[] | undefined, az);
}

/**
 * Tag the data volume AFTER launch. RunInstances volume TagSpecification applies to ALL
 * created volumes (root included), so root/data cannot be tag-differentiated at launch
 * (codex CRITICAL). This re-tags only the data volume with cc:role=data.
 */
export async function tagDataVolumeAfterLaunch(
  volumeId: string,
  subdomain: string,
  username: string,
  department: string,
): Promise<void> {
  await ec2.send(
    new CreateTagsCommand({ Resources: [volumeId], Tags: dataVolumeTags(subdomain, username, department) }),
  );
}

/** Create a standalone persistent data volume in a specific AZ (reattach/legacy/SSM paths). */
export async function createDataVolume(
  az: string,
  subdomain: string,
  username: string,
  department: string,
  sizeGb: number = DEFAULT_DATA_SIZE_GB,
): Promise<string> {
  const res = await ec2.send(
    new CreateVolumeCommand({
      AvailabilityZone: az,
      Size: sizeGb,
      VolumeType: "gp3",
      Encrypted: true,
      TagSpecifications: [{ ResourceType: "volume", Tags: dataVolumeTags(subdomain, username, department) }],
    }),
  );
  if (!res.VolumeId) throw new Error("CreateVolume returned no VolumeId");
  return res.VolumeId;
}

/** Attach an existing data volume to an instance at the conventional device name. */
export async function attachDataVolume(instanceId: string, volumeId: string): Promise<void> {
  await ec2.send(new AttachVolumeCommand({ InstanceId: instanceId, VolumeId: volumeId, Device: DATA_DEVICE }));
}
