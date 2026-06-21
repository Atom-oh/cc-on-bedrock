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
  DetachVolumeCommand,
  DeleteVolumeCommand,
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

/**
 * Idempotent attach: attach the volume, but tolerate the "already attached to THIS instance"
 * case (re-run / reused volume). Any other failure (e.g. attached elsewhere, AZ mismatch) is
 * fatal — we must never proceed believing the data volume is attached when it is not.
 */
export async function ensureDataVolumeAttached(instanceId: string, volumeId: string): Promise<void> {
  try {
    await attachDataVolume(instanceId, volumeId);
  } catch (err) {
    const res = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
    const attached = (res.Volumes?.[0] as { Attachments?: { InstanceId?: string }[] } | undefined)?.Attachments?.some(
      (a) => a.InstanceId === instanceId,
    );
    if (attached) return; // already attached to this instance — idempotent no-op
    throw err;
  }
}

export interface LaunchPlan {
  /** born-attached = new volume via RunInstances BDM; reattach = existing volume, attach post-launch. */
  mode: "born-attached" | "reattach";
  blockDeviceMappings: ReturnType<typeof dataVolumeBlockDeviceMapping>[];
  /** reattach → the volume's AZ to pin the launch subnet to; born-attached → null (any subnet). */
  pinAz: string | null;
  /** reattach → the volume id to attach + wait for; born-attached → null (resolved post-launch). */
  expectedVolumeId: string | null;
}

/**
 * Pure decision for how to provision the data volume at launch. New user → born-attached
 * (fresh BDM volume); returning user with an existing volume → reattach, pinned to the
 * volume's AZ (rule 2). No AWS calls — the caller resolves the subnet/attaches.
 */
export function planDataVolumeLaunch(
  dataVol: DataVolumeRef | null,
  sizeGb: number = DEFAULT_DATA_SIZE_GB,
): LaunchPlan {
  if (!dataVol) {
    return {
      mode: "born-attached",
      blockDeviceMappings: [dataVolumeBlockDeviceMapping(sizeGb)],
      pinAz: null,
      expectedVolumeId: null,
    };
  }
  return { mode: "reattach", blockDeviceMappings: [], pinAz: dataVol.az, expectedVolumeId: dataVol.volumeId };
}

/** Extract the data volume id from a launched instance's block-device mappings (post-born-attached). */
export function dataVolumeIdFromInstance(
  blockDeviceMappings: { DeviceName?: string; Ebs?: { VolumeId?: string } }[] | undefined,
  deviceName: string = DATA_DEVICE,
): string | null {
  const m = (blockDeviceMappings ?? []).find((b) => b.DeviceName === deviceName);
  return m?.Ebs?.VolumeId ?? null;
}

/**
 * Pure resolution of the EBS-resize target (ADR-032 rule 7): the persistent DATA volume ONLY,
 * never the OS root. Returns null for a not-yet-migrated instance (no data volume) — the caller
 * then defers the resize (and should migrate first) rather than silently growing the root disk.
 */
export function resizeTargetVolumeId(dataVolumeId: string | null | undefined): string | null {
  return dataVolumeId ?? null;
}

/** Pure: a volume is safe to act on (attach/delete) only once it reports `available`. */
export function volumeIsAvailable(state: string | undefined): boolean {
  return state === "available";
}

/** Poll until a volume reaches `available` (after detach/terminate) — avoids attach-on-detaching races. */
export async function waitForVolumeAvailable(
  volumeId: string,
  attempts: number = 60,
  delayMs: number = 5000,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
      if (volumeIsAvailable(res.Volumes?.[0]?.State)) return true;
    } catch {
      /* transient — keep polling */
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

export interface VolumeWaitOpts {
  attempts?: number;
  delayMs?: number;
}

/**
 * Orphan cleanup for admin "complete delete" (ADR-024/032 rule 9): detach → wait available →
 * DeleteVolume. Returns false (NO delete) if the volume never reaches `available`, so a
 * still-attached volume is never force-deleted (an optional final snapshot is the caller's job).
 */
export async function deleteDataVolume(
  volumeId: string,
  instanceId?: string,
  opts: VolumeWaitOpts = {},
): Promise<boolean> {
  if (instanceId) {
    try {
      await ec2.send(new DetachVolumeCommand({ VolumeId: volumeId, InstanceId: instanceId }));
    } catch {
      /* may already be detached */
    }
  }
  const available = await waitForVolumeAvailable(volumeId, opts.attempts ?? 60, opts.delayMs ?? 5000);
  if (!available) return false;
  await ec2.send(new DeleteVolumeCommand({ VolumeId: volumeId }));
  return true;
}
