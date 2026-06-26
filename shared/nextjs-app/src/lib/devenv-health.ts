/**
 * Derive the user-portal health status for a DevEnv instance.
 *
 * We intentionally do NOT open a direct TCP probe from the dashboard to the
 * devenv's code-server (port 8080). The devenv security group only allows the
 * shared nginx reverse proxy to reach 8080 (DLP isolation — see
 * terraform/modules/ec2-devenv: ingress for 8080 is restricted to the nginx
 * SG). A direct dashboard→devenv:8080 probe is therefore dropped by the SG and
 * times out, which previously pinned the user portal on "code-server is
 * starting up..." forever even though code-server was healthy and actively
 * serving the user through nginx.
 *
 * Instead we treat a running instance that has a private IP as HEALTHY, which
 * is consistent with the admin /api/containers route (running ⇒ HEALTHY).
 *
 * Trade-off: right after a cold start the instance can report "running" a few
 * tens of seconds before code-server finishes booting, so this can briefly show
 * HEALTHY optimistically. That is preferable to the previous permanent false
 * negative, and the SSE provisioning flow already covers the fresh-create path.
 */
export function deriveDevenvHealth(
  status: string | undefined,
  privateIp: string | undefined,
): "HEALTHY" | "UNKNOWN" {
  return status === "running" && !!privateIp ? "HEALTHY" : "UNKNOWN";
}
