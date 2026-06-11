"use client";

import { useLanguage } from "@/lib/i18n";
import Mermaid from "@/components/doc/Mermaid";
import { PageShell, H2, P, Code, Table, CodeBlock, Callout } from "@/components/doc/primitives";

export default function ArchitecturePage() {
  const { t } = useLanguage();

  return (
    <PageShell
      title={t("아키텍처", "Architecture")}
      subtitle={t(
        "가용성, 보안, 사용자 격리에 중점을 둔 8 스택 구성.",
        "8-stack composition focused on availability, security, and per-user isolation."
      )}
      tags={[
        { label: "8 stacks", color: "purple" },
        { label: "Multi-mode", color: "cyan" },
      ]}
    >
      <H2 id="stacks">{t("1. 인프라 스택 (8개)", "1. Infrastructure stacks (8)")}</H2>
      <Table
        columns={[
          { key: "n", label: "#" },
          { key: "stack", label: t("스택", "Stack") },
          { key: "what", label: t("주요 리소스", "Key resources") },
        ]}
        rows={[
          { n: "01", stack: "Network", what: "VPC (10.100.0.0/16) · NAT · VPC Endpoints · DNS Firewall · Route 53" },
          { n: "02", stack: "Security", what: "Cognito + custom attrs · ACM · KMS · Secrets Manager · IAM + Permission Boundary" },
          { n: "03", stack: "Usage Tracking", what: t("usage / cli_tokens / user_budgets / approval_requests / prompt_audit / mcp_catalog 테이블, tracker / budget-check / ec2-idle-stop / audit / gateway-manager Lambda", "usage / cli_tokens / user_budgets / approval_requests / prompt_audit / mcp_catalog tables, tracker / budget-check / ec2-idle-stop / audit / gateway-manager Lambdas") },
          { n: "04", stack: "ECS Dashboard infra", what: t("NLB internet-facing · Nginx Fargate (HA) · DynamoDB routing table + Lambda nginx-config-gen", "NLB internet-facing · Nginx Fargate (HA) · DynamoDB routing table + Lambda nginx-config-gen") },
          { n: "05", stack: "Dashboard", what: t("Next.js standalone ECS · 통합 CloudFront · Lambda@Edge (session-validator + origin-router)", "Next.js standalone ECS · Unified CloudFront · Lambda@Edge (session-validator + origin-router)") },
          { n: "06", stack: "WAF", what: t("CLOUDFRONT-scope WebACL (us-east-1)", "CLOUDFRONT-scope WebACL (us-east-1)") },
          { n: "07", stack: "EC2 DevEnv", what: t("Launch Template (ARM64 t4g.large) · DLP SG 3-tier (open/restricted/locked) · Hibernation", "Launch Template (ARM64 t4g.large) · DLP SG 3-tier · Hibernation") },
          { n: "08", stack: "Local Governance", what: t("STS Issuer + Function URL · cc-on-bedrock-limits · token-limit-enforcer · UserRoleProvisioner + EventBridge cognito-user-created + DLQ", "STS Issuer + Function URL · cc-on-bedrock-limits · token-limit-enforcer · UserRoleProvisioner + EventBridge cognito-user-created + DLQ") },
        ]}
      />

      <Callout type="info" title={t("배포 프로파일", "Deploy profiles")}>
        <ul className="space-y-1 list-disc pl-5">
          <li>
            <strong className="text-white">{t("기본", "Default")}:</strong>{" "}
            <Code>cdk deploy --all</Code> — {t("1~8 모두 배포 (EC2 + Local 공존)", "deploys 1–8 (EC2 + Local coexist)")}
          </li>
          <li>
            <strong className="text-white">Governance only:</strong>{" "}
            <Code>cdk deploy --all -c governanceOnly=true</Code> — {t("7번 스킵 (EC2 DevEnv 미배포)", "skips 7 (no EC2 DevEnv)")}
          </li>
        </ul>
      </Callout>

      <H2 id="ec2">{t("2. EC2-per-user DevEnv", "2. EC2-per-user DevEnv")}</H2>
      <P>
        {t(
          "각 사용자에게 전용 EC2 인스턴스 1대가 할당됩니다. ECS Task 모델은 폐기됨.",
          "Each user is allocated a single dedicated EC2 instance. The ECS Task model is deprecated."
        )}
      </P>
      <ul className="text-sm text-gray-400 space-y-1.5 list-disc pl-5 mb-5">
        <li>{t("1 EC2 instance — t4g.large ARM64 (Ubuntu 24.04 또는 AL2023)", "1 EC2 instance — t4g.large ARM64 (Ubuntu 24.04 or AL2023)")}</li>
        <li>{t("1 EBS root volume — 사용자별 데이터 영구 보관 (Stop 시 그대로 유지)", "1 EBS root volume — persists across stop")}</li>
        <li>{t("1 per-user IAM Instance Profile — Dashboard API가 RunInstances 직전 생성", "1 per-user IAM Instance Profile — Dashboard API creates it before RunInstances")}</li>
        <li>{t("1 Nginx 라우팅 entry — {subdomain}.dev.{domain} → DynamoDB routing table → 5초 hot-reload", "1 Nginx routing entry — DynamoDB routing table → 5s hot-reload")}</li>
        <li>{t("3 DevEnv 포트 — code-server :8080, Frontend :3000, API :8000", "3 ports — code-server :8080, Frontend :3000, API :8000")}</li>
        <li>{t("Hibernation 지원 — RAM → 암호화 EBS, ~5초 resume", "Hibernation — RAM → encrypted EBS, ~5s resume")}</li>
      </ul>

      <H2 id="local">{t("3. Local Governance Mode", "3. Local Governance Mode")}</H2>
      <P>
        {t(
          "EC2를 띄우지 않고 사용자가 본인 PC에서 claude를 직접 실행. Dashboard가 STS Issuer Lambda를 통해 1h chained-AssumeRole 자격증명을 발급.",
          "Run claude on your own PC without provisioning EC2. Dashboard issues 1h chained-AssumeRole credentials via the STS Issuer Lambda."
        )}
      </P>
      <Mermaid
        caption="Local Mode flow"
        chart={`flowchart LR
  User["User PC<br/>cc-bedrock-local"]
  Dashboard["Dashboard"]
  STS["STS Issuer Lambda<br/>(IAM Function URL)"]
  Role["per-user IAM Role<br/>cc-on-bedrock-local-user-*"]
  Limits[("cc-on-bedrock-limits")]
  Bedrock[("Bedrock Runtime")]

  User -->|"1. NextAuth login"| Dashboard
  Dashboard -->|"2. invoke (IAM)"| STS
  STS -->|"3. AssumeRole 1h"| Role
  STS -->|"4. read DENY#active"| Limits
  Dashboard -->|"5. STS creds + limit_status"| User
  User -->|"6. claude → Bedrock"| Bedrock

  classDef store fill:#151d30,stroke:#00d4ff,color:#e5e7eb
  classDef lambda fill:#1a2540,stroke:#a855f7,color:#e5e7eb
  class Limits store
  class STS lambda`}
      />

      <H2 id="ai">{t("4. Hybrid AI 아키텍처", "4. Hybrid AI architecture")}</H2>
      <Table
        columns={[
          { key: "channel", label: t("채널", "Channel") },
          { key: "path", label: t("경로", "Path") },
          { key: "perf", label: t("응답", "Response") },
        ]}
        rows={[
          {
            channel: t("대시보드 /ai", "Dashboard /ai"),
            path: "Browser → /api/ai → Bedrock Converse API",
            perf: t("SSE 1~5s · 5 tools", "SSE 1–5s · 5 tools"),
          },
          {
            channel: "Slack / external",
            path: "Slack Bot → /api/ai/runtime → AgentCore Runtime → MCP Gateway → Lambda",
            perf: t("10~20s · 8+ tools (per-dept MCP)", "10–20s · 8+ tools (per-dept MCP)"),
          },
        ]}
      />
      <P>
        {t(
          "모든 경로는 AgentCore Memory를 통해 사용자별 세션 격리 및 대화 기록 공유.",
          "All paths share session isolation and conversation history via AgentCore Memory."
        )}
      </P>

      <H2 id="sso">{t("5. 인증 / SSO", "5. Authentication / SSO")}</H2>
      <P>
        {t(
          "Dashboard 와 DevEnv 가 하나의 CloudFront 배포 + 단일 NextAuth JWE 쿠키로 SSO. Lambda@Edge session-validator 가 .{domain} 도메인 쿠키를 검증.",
          "Dashboard and DevEnv share a single CloudFront distribution + one NextAuth JWE cookie for SSO. The Lambda@Edge session-validator validates the cookie on the .{domain} apex."
        )}
      </P>
    </PageShell>
  );
}
