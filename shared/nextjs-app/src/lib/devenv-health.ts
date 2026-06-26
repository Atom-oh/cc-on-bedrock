/**
 * Derive the user-portal health status for a DevEnv instance. See ADR-012.
 *
 * We intentionally do NOT open a direct TCP probe from the dashboard to the
 * devenv's code-server (port 8080). The devenv security group restricts 8080
 * ingress to the shared nginx reverse proxy SG (network isolation — see
 * terraform/modules/ec2-devenv). The dashboard is not in that SG, so a direct
 * dashboard→devenv:8080 probe is dropped by the SG and times out, which
 * previously pinned the user portal on "code-server is starting up..." forever
 * even though code-server was healthy and actively serving the user via nginx.
 *
 * Instead we treat a running instance that has a private IP as HEALTHY. Like
 * the admin /api/containers route this keys off the running lifecycle state,
 * but it adds a non-blank privateIp guard (the admin route maps running ⇒
 * HEALTHY with no IP check) so we never surface a HEALTHY IDE link before the
 * ENI/IP is attached.
 *
 * Trade-off (accepted, ADR-012): healthStatus now means "instance running with
 * an IP", not "code-server reachable". Right after a cold start the instance
 * can report running for tens of seconds before code-server finishes booting,
 * so this can briefly show HEALTHY optimistically and the IDE link may 502 on a
 * page reload. This window exists on fresh creates too — the SSE provisioning
 * flow only watches the instance reaching running, not code-server readiness —
 * but it is preferable to the previous *permanent* false negative and self-
 * heals on reload within ~30-60s. Status is matched case-insensitively and a
 * whitespace-only IP is treated as absent so it does not register as healthy.
 */
export function deriveDevenvHealth(
  status: string | undefined,
  privateIp: string | undefined,
): "HEALTHY" | "UNKNOWN" {
  const isRunning = status?.trim().toLowerCase() === "running";
  const hasIp = !!privateIp && privateIp.trim() !== "";
  return isRunning && hasIp ? "HEALTHY" : "UNKNOWN";
}
