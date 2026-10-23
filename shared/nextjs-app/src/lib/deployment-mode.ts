import { NextResponse } from "next/server";

// Deployment profile, set by Terraform `deployment_mode` through the DEPLOYMENT_MODE env.
// "governance" (default): admin dashboard + local installer, no EC2 DevEnv.
// "devenv": also per-user EC2 DevEnvs.
export type DeploymentMode = "governance" | "devenv";

// Read at request time (server only); a missing or unknown value means "governance".
export function getDeploymentMode(): DeploymentMode {
  return process.env.DEPLOYMENT_MODE === "devenv" ? "devenv" : "governance";
}

// Guard for DevEnv-only API routes: returns a 404 response in governance mode, else null.
export function devenvDisabledResponse(): NextResponse | null {
  if (getDeploymentMode() === "devenv") return null;
  return NextResponse.json(
    { success: false, error: "DevEnv is disabled in this deployment (deployment_mode = governance)" },
    { status: 404 },
  );
}
