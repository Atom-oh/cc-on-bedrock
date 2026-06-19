/**
 * ADR-032 Task 6: out-of-band migration of legacy root-only instances onto a persistent
 * data volume — WITHOUT recreating the instance (no data loss). Legacy instances boot the
 * OLD AMI (no baked cc-data-migrate unit) and UserData only runs on first boot, so the
 * dashboard cannot trigger migration via startInstance. Instead we create an AZ-matched
 * data volume, attach it, and run the SAME idempotent/fail-safe migrate routine via SSM
 * RunCommand on the running instance (the proven in-place pattern used for the GRUB fix).
 */
import { EC2Client, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { SSMClient, SendCommandCommand } from "@aws-sdk/client-ssm";
import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { createDataVolume, ensureDataVolumeAttached, findDataVolume, waitForVolumeAvailable } from "@/lib/data-volume";
import { dataVolumeMigrateScript } from "@/lib/data-volume-userdata";

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const ec2 = new EC2Client({ region });
const ssm = new SSMClient({ region });
const ddb = new DynamoDBClient({ region });
const INSTANCE_TABLE = process.env.INSTANCE_TABLE ?? "cc-user-instances";

interface ReservationLike {
  Instances?: { Placement?: { AvailabilityZone?: string } }[];
}

/** Pure: the running instance's AZ — the data volume MUST be created/attached in this AZ. */
export function azFromInstanceDescribe(reservations: ReservationLike[] | undefined): string | null {
  return reservations?.[0]?.Instances?.[0]?.Placement?.AvailabilityZone ?? null;
}

/**
 * Pure: the SSM command lines for a legacy migration. Writes the expected-volume hint (so a
 * later baked unit also targets the right volume) and runs the idempotent migrate routine
 * for this specific volume id.
 */
export function buildLegacyMigrateCommand(volumeId: string): string[] {
  return [
    `echo "${volumeId}" > /etc/cc-data-expected-volume`,
    dataVolumeMigrateScript(volumeId),
  ];
}

export interface LegacyMigrateResult {
  volumeId: string;
  az: string;
  commandId: string | null;
  reused: boolean;
}

/**
 * Migrate a legacy root-only instance. Idempotent: if a data volume already exists for the
 * subdomain it is reused (the migrate routine itself is a no-op once the marker is set).
 */
export async function migrateLegacyInstance(
  subdomain: string,
  username: string,
  department: string,
  instanceId: string,
): Promise<LegacyMigrateResult> {
  const desc = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  const az = azFromInstanceDescribe(desc.Reservations as ReservationLike[] | undefined);
  if (!az) throw new Error(`could not determine AZ for instance ${instanceId}`);

  // Idempotent at the volume level: reuse an existing data volume (fail-closed on duplicates).
  const existing = await findDataVolume(subdomain);
  let volumeId: string;
  let reused = false;
  if (existing) {
    volumeId = existing.volumeId;
    reused = true;
    if (existing.az !== az) {
      throw new Error(
        `data volume ${volumeId} is in ${existing.az} but instance ${instanceId} is in ${az} — ` +
          `cannot attach across AZ (fail-closed)`,
      );
    }
  } else {
    volumeId = await createDataVolume(az, subdomain, username, department);
    // A freshly created volume must reach `available` before it can be attached.
    const ready = await waitForVolumeAvailable(volumeId, 30, 2000);
    if (!ready) throw new Error(`created data volume ${volumeId} did not reach 'available'`);
  }

  // FATAL on failure (idempotent for already-attached-to-this-instance): we must not record
  // the volume in DynamoDB or run the migrate command unless the volume is truly attached.
  await ensureDataVolumeAttached(instanceId, volumeId);

  await ddb.send(
    new UpdateItemCommand({
      TableName: INSTANCE_TABLE,
      Key: marshall({ user_id: subdomain }),
      UpdateExpression: "SET dataVolumeId = :v, dataVolumeAz = :a, updatedAt = :now",
      ExpressionAttributeValues: marshall({ ":v": volumeId, ":a": az, ":now": new Date().toISOString() }),
    }),
  );

  const cmd = await ssm.send(
    new SendCommandCommand({
      InstanceIds: [instanceId],
      DocumentName: "AWS-RunShellScript",
      Parameters: { commands: buildLegacyMigrateCommand(volumeId) },
      TimeoutSeconds: 600,
    }),
  );

  return { volumeId, az, commandId: cmd.Command?.CommandId ?? null, reused };
}
