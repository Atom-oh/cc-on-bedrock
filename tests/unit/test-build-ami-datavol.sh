#!/usr/bin/env bash
# ADR-032 Task 5: assert build-ami.sh bakes a correct, safe cc-data-migrate unit.
# Pure static checks (bash -n + grep) — the live AMI behavior is verified in Phase B.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AMI="${ROOT}/scripts/build-ami.sh"
fail=0
chk() { if grep -q -- "$1" "$AMI"; then echo "  ok: $2"; else echo "  FAIL: $2 (missing: $1)"; fail=1; fi; }
nochk() { if grep -q -- "$1" "$AMI"; then echo "  FAIL: $2 (must NOT contain: $1)"; fail=1; else echo "  ok: $2"; fi; }

echo "== build-ami.sh syntax =="
bash -n "$AMI" && echo "  ok: bash -n clean" || { echo "  FAIL: syntax"; fail=1; }

echo "== cc-data-migrate unit + ordering =="
chk "cc-data-migrate.service" "installs cc-data-migrate.service"
chk "DefaultDependencies=no" "unit has DefaultDependencies=no"
chk "Before=code-server.service" "unit ordered Before=code-server.service (no user processes mid-rsync)"
chk "systemctl enable cc-data-migrate.service" "unit enabled at boot"

echo "== mount safety =="
chk "LABEL=CCDATA /home/coder ext4 defaults,nofail,x-systemd.device-timeout=10s" "fstab nofail + device-timeout (never bricks boot)"
chk "nvme-Amazon_Elastic_Block_Store_" "device resolved by EBS volume-id (NVMe serial)"
nochk "/dev/nvme1n1" "no hardcoded NVMe device name"
chk "blkid" "mkfs guarded by a blkid filesystem check"
chk "/home/coder/.cc-data-volume" "idempotency completion marker"
chk "home/coder.old-root" "original moved aside (after verified copy)"

echo "== resize: raw-device ext4, no growpart =="
chk "resize2fs" "online grow via resize2fs"
nochk "growpart" "no growpart (raw-device ext4 has no partition)"

echo "== fail-safe / no boot deadlock =="
chk "fail-safe" "fail-safe messaging on every failure path"
# Scope the deadlock check to the baked migrate routine (the file elsewhere has an
# unrelated hibernate-resume unit that legitimately restarts agents).
MIGBODY="$(sed -n "/^DATA_VOL_SCRIPT='#!/,/^exit 0'$/p" "$AMI")"
if printf '%s' "$MIGBODY" | grep -q "systemctl restart"; then
  echo "  FAIL: cc-data-migrate routine must not 'systemctl restart' (deadlock guard)"; fail=1
else
  echo "  ok: no systemctl restart inside the cc-data-migrate routine"
fi

[ "${fail}" -eq 0 ] && echo "ALL build-ami data-volume TESTS PASSED" || echo "build-ami data-volume TESTS FAILED"
exit "${fail}"
