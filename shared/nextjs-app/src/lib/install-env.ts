import { codexModelId } from "@/lib/codex-model";

// Values baked into the Local CLI installers (/api/install for bash,
// /api/install/windows for PowerShell). Read at request time: the standalone
// build can otherwise capture empty strings at module init.
export interface InstallerEnv {
  dashboardUrl: string;
  cognitoRegion: string;
  cognitoUserPoolId: string;
  cognitoCliClientId: string;
  localOtelEndpoint: string;
  codexModelId: string;
}

export function installerEnv(): InstallerEnv {
  return {
    dashboardUrl:
      process.env.NEXTAUTH_URL ??
      process.env.DASHBOARD_URL ??
      "https://cconbedrock-dashboard.atomai.click",
    cognitoRegion:
      process.env.COGNITO_REGION ?? process.env.AWS_REGION ?? "ap-northeast-2",
    cognitoUserPoolId: process.env.COGNITO_USER_POOL_ID ?? "",
    cognitoCliClientId: process.env.COGNITO_CLI_CLIENT_ID ?? "",
    localOtelEndpoint: process.env.LOCAL_OTEL_EXPORTER_OTLP_ENDPOINT ?? "",
    codexModelId: codexModelId(process.env.CODEX_MODEL_ID),
  };
}
