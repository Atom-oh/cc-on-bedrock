/**
 * ADR-032 Task 2: the single idempotent, fail-safe shell routine that mounts (and, on
 * first encounter, migrates) the persistent /home/coder data volume. This SAME body is
 * used by:
 *   - the baked AMI systemd unit `cc-data-migrate.service` (Task 5) on every boot, and
 *   - the out-of-band SSM RunCommand for legacy root-only instances (Task 6).
 *
 * Safety properties (from the consensus plan gate, codex + agy):
 *  - Device resolution is by EBS volume-id (NVMe serial), never /dev/sdf or /dev/nvme1n1.
 *  - Bounded-wait for the volume to attach before giving up (attach race).
 *  - mkfs is guarded behind a filesystem check — never reformat a volume that holds data.
 *  - The original /home/coder is moved aside ONLY AFTER the rsync copy is verified.
 *  - fstab uses nofail,x-systemd.device-timeout so a missing volume never bricks boot.
 *  - No `systemctl restart` (the unit is ordered Before=code-server.service; restarting
 *    from inside would risk a boot dependency cycle).
 *  - Idempotent via the completion marker; fail-safe (preserve root /home/coder on any error).
 */

export const DATA_LABEL = "CCDATA";
export const DATA_MOUNT = "/home/coder";
export const MIGRATE_MARKER = "/home/coder/.cc-data-volume";
/** fstab options: nofail + bounded device timeout so a slow/absent volume never bricks boot. */
export const FSTAB_LINE = `LABEL=${DATA_LABEL} ${DATA_MOUNT} ext4 defaults,nofail,x-systemd.device-timeout=10s 0 2`;

/**
 * Render the migration/mount script for a specific expected data volume id.
 * @param expectedVolumeId e.g. "vol-0abc123" — its NVMe serial is the id without the dash.
 */
export function dataVolumeMigrateScript(expectedVolumeId: string): string {
  const serial = expectedVolumeId.replace(/-/g, "");
  // by-id symlink Nitro/Graviton exposes for an EBS volume (serial = volume-id sans dash).
  const byId = `/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${serial}`;
  return `#!/bin/bash
# ADR-032 cc-data-migrate — idempotent, fail-safe. Never bricks boot (exits 0 on trouble).
set -u
LABEL=${DATA_LABEL}
MOUNT=${DATA_MOUNT}
MARKER=${MIGRATE_MARKER}
TMP=/mnt/ccdata
EXPECT_VOL=${expectedVolumeId}

# Already on the data volume? (idempotent no-op)
if mountpoint -q "$MOUNT" && [ -f "$MARKER" ]; then
  echo "cc-data: $MOUNT already on data volume — nothing to do"
  exit 0
fi

# Resolve the block device by EBS volume-id (NVMe serial) — NOT by /dev/sdf or a guessed
# /dev/nvmeXn1, whose enumeration order is not stable on Nitro.
DEV=""
for i in $(seq 1 60); do
  if [ -e "${byId}" ]; then
    DEV=$(readlink -f "${byId}")
  else
    # Fallback: correlate NVMe serials to the expected volume id.
    for d in /dev/nvme*n1; do
      [ -b "$d" ] || continue
      s=$(nvme id-ctrl "$d" 2>/dev/null | sed -n 's/^sn[[:space:]]*:[[:space:]]*//p' | tr -d ' ')
      if [ "$s" = "${serial}" ] || [ "$s" = "${expectedVolumeId}" ]; then DEV="$d"; break; fi
    done
  fi
  [ -b "$DEV" ] && break
  sleep 2
done
if [ ! -b "$DEV" ]; then
  echo "cc-data: data volume $EXPECT_VOL not attached after wait — fail-safe, keeping root $MOUNT"
  exit 0
fi

# Format only if the volume has NO filesystem at all (guarded — never wipe existing data).
if ! blkid -L "$LABEL" >/dev/null 2>&1; then
  if blkid "$DEV" >/dev/null 2>&1; then
    echo "cc-data: $DEV already has an unexpected filesystem — fail-safe abort"
    exit 0
  fi
  mkfs.ext4 -L "$LABEL" "$DEV" || { echo "cc-data: mkfs failed — fail-safe"; exit 0; }
fi

# Stage on a temp mount and verify BEFORE touching the original /home/coder.
mkdir -p "$TMP"
mount "$DEV" "$TMP" 2>/dev/null || mount LABEL="$LABEL" "$TMP" 2>/dev/null || {
  echo "cc-data: temp mount failed — fail-safe, keeping root $MOUNT"; exit 0; }

if [ ! -f "$TMP/.cc-data-volume" ]; then
  # Fresh volume: migrate the existing root home into it, verify, then mark complete.
  if [ -d "$MOUNT" ]; then
    rsync -aXH --numeric-ids "$MOUNT"/ "$TMP"/ || {
      umount "$TMP"; echo "cc-data: rsync failed — fail-safe, keeping root $MOUNT"; exit 0; }
  fi
  touch "$TMP/.cc-data-volume"
  sync
  umount "$TMP"
  # Verified copy is on the data volume — only NOW move the original aside.
  if mountpoint -q "$MOUNT"; then umount "$MOUNT" 2>/dev/null || true; fi
  if [ -d "$MOUNT" ] && [ ! -L "$MOUNT" ] && [ ! -f "$MARKER" ]; then
    mv "$MOUNT" "${DATA_MOUNT}.old-root" 2>/dev/null || true
  fi
  mkdir -p "$MOUNT"
else
  umount "$TMP"
fi

# Persist mount via fstab (nofail so a future absent volume never blocks boot), then mount.
grep -q "LABEL=$LABEL" /etc/fstab 2>/dev/null || echo "${FSTAB_LINE}" >> /etc/fstab
mount "$MOUNT" 2>/dev/null || mount LABEL="$LABEL" "$MOUNT" || {
  echo "cc-data: final mount failed — fail-safe"; exit 0; }
chown coder:coder "$MOUNT" 2>/dev/null || true
echo "cc-data: $MOUNT is now on persistent data volume $EXPECT_VOL"
exit 0
`;
}
