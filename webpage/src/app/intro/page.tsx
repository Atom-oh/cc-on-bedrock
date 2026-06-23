"use client";

import { useLanguage } from "@/lib/i18n";
import { PageShell, H2, P, Code, Tag, Table, CodeBlock, Callout } from "@/components/doc/primitives";

export default function IntroPage() {
  const { t, locale } = useLanguage();

  return (
    <PageShell
      title={t("소개", "Introduction")}
      subtitle={t(
        "CC-on-Bedrock 은 AWS Bedrock 을 활용한 멀티유저 Claude Code 개발 플랫폼입니다. EC2-per-user DevEnv 와 Local Governance 두 모드를 모두 지원하며, 같은 클러스터에 공존할 수 있습니다.",
        "CC-on-Bedrock is a multi-user Claude Code development platform on AWS Bedrock. It supports both EC2-per-user DevEnv and Local Governance modes, which can coexist in the same cluster."
      )}
      tags={[
        { label: "v2", color: "cyan" },
        { label: "Multi-mode", color: "purple" },
        { label: "Zero infra option", color: "green" },
      ]}
    >
      <H2 id="modes">{t("1. 두 가지 배포 프로파일", "1. Two deployment profiles")}</H2>
      <Table
        columns={[
          { key: "mode", label: t("모드", "Mode") },
          { key: "how", label: t("사용 방식", "How users interact") },
          { key: "infra", label: t("인프라 비용", "Infra cost") },
          { key: "gov", label: t("거버넌스", "Governance") },
        ]}
        rows={[
          {
            mode: <strong className="text-white">EC2-per-user DevEnv</strong>,
            how: t(
              "사용자별 전용 EC2 (ARM64) + 브라우저 code-server",
              "Dedicated EC2 (ARM64) + browser code-server"
            ),
            infra: t("EC2 + EBS 시간당", "EC2 + EBS hourly"),
            gov: t("동일", "Same"),
          },
          {
            mode: <strong className="text-white">Local Governance</strong>,
            how: t(
              "사용자 PC에서 claude 직접 실행, /local 페이지에서 STS 자격증명 발급",
              "Run claude on your PC, issue STS credentials via /local"
            ),
            infra: t("0 (Bedrock 호출만 과금)", "0 (Bedrock invocations only)"),
            gov: t("동일", "Same"),
          },
        ]}
      />
      <P>
        {t(
          "두 모드는 같은 플랫폼에서 공존 가능. 인프라는 Terraform(HCL)을 기준으로 배포합니다.",
          "Both modes can coexist on the same platform. Infrastructure is deployed from Terraform (HCL)."
        )}
      </P>

      <H2 id="features">{t("2. 주요 특징", "2. Key features")}</H2>
      <ul className="space-y-2 text-sm text-gray-400 list-disc pl-5 mb-6">
        <li>
          <strong className="text-white">Bedrock Direct Mode:</strong>{" "}
          {t(
            "per-user IAM Role(EC2) 또는 STS 자격증명(Local)으로 Bedrock 직접 호출 — proxy 없음",
            "Direct Bedrock invocation via per-user IAM role (EC2) or STS (Local) — no proxy"
          )}
        </li>
        <li>
          <strong className="text-white">{t("사용자별 IAM 사전 프로비저닝", "Per-user IAM pre-provisioning")}:</strong>{" "}
          {t(
            "Cognito 사용자 가입 시 EventBridge로 IAM role + Cognito custom 속성 사전 생성, 첫 로그인 race condition 제거",
            "EventBridge pre-creates the IAM role and Cognito custom attrs on user creation — no first-login race"
          )}
        </li>
        <li>
          <strong className="text-white">{t("하이브리드 AI", "Hybrid AI")}:</strong>{" "}
          {t(
            "대시보드는 Converse API(빠른 스트리밍 + 5 tool), Slack/외부 채널은 AgentCore Runtime + per-department MCP Gateway",
            "Dashboard uses Converse API (streaming + 5 tools); Slack/external channels use AgentCore Runtime + per-department MCP Gateway"
          )}
        </li>
        <li>
          <strong className="text-white">{t("7계층 보안", "7-layer security")}:</strong> CloudFront →
          ALB/NLB → Cognito → Security Groups (DLP 3-tier) → VPC Endpoints → DNS Firewall → IAM Permission Boundary
        </li>
        <li>
          <strong className="text-white">{t("이중 거버넌스", "Dual governance")}:</strong>{" "}
          {t(
            "USD 예산(budget-check 5분 주기) + Normalized 토큰 한도(token-limit-enforcer, usage table Stream 소비)",
            "USD budget (budget-check 5-min cron) + Normalized token limit (token-limit-enforcer, usage table Stream consumer)"
          )}
        </li>
        <li>
          <strong className="text-white">{t("서버리스 사용량 추적", "Serverless usage tracking")}:</strong>{" "}
          Bedrock invocation logging → CloudWatch Logs → Subscription Filter →{" "}
          <Code>bedrock-usage-tracker</Code> Lambda → DynamoDB
        </li>
      </ul>

      <H2 id="models">{t("3. Bedrock 모델", "3. Bedrock models")}</H2>
      <P>
        {t(
          "기본 inference profile (ap-northeast-2):",
          "Default inference profiles (ap-northeast-2):"
        )}
      </P>
      <Table
        columns={[
          { key: "model", label: t("모델", "Model") },
          { key: "id", label: "Inference Profile ID", className: "font-mono text-xs" },
        ]}
        rows={[
          { model: <strong className="text-white">Claude Opus 4.7</strong>, id: "global.anthropic.claude-opus-4-7" },
          { model: <strong className="text-white">Claude Opus 4.6 (1M)</strong>, id: "global.anthropic.claude-opus-4-6-v1[1m]" },
          { model: <strong className="text-white">Claude Sonnet 4.6</strong>, id: "global.anthropic.claude-sonnet-4-6" },
          { model: <strong className="text-white">Claude Haiku 4.5</strong>, id: "us.anthropic.claude-haiku-4-5-20251001-v1:0" },
        ]}
      />
      <Callout type="info" title={t("Wildcard IAM", "Wildcard IAM")}>
        {t(
          "IAM은 wildcard Claude family ARN으로 부여돼 신규 Claude 모델이 추가되면 IAM 변경 없이 즉시 사용 가능합니다.",
          "IAM grants use the wildcard Claude family ARN, so newly released Claude models are usable without policy changes."
        )}
      </Callout>

      <H2 id="stacks">{t("4. 8 스택 구조", "4. The 8 stacks")}</H2>
      <Table
        columns={[
          { key: "n", label: "#" },
          { key: "stack", label: t("스택", "Stack") },
          { key: "what", label: t("주요 리소스", "Key resources") },
        ]}
        rows={[
          { n: "01", stack: <strong className="text-white">Network</strong>, what: "VPC · Subnets · NAT · VPC Endpoints · DNS Firewall · Route 53" },
          { n: "02", stack: <strong className="text-white">Security</strong>, what: "Cognito · ACM · KMS · Secrets Manager · IAM Roles + Permission Boundary" },
          { n: "03", stack: <strong className="text-white">Usage Tracking</strong>, what: "Bedrock invocation logging + tracker / budget-check / ec2-idle-stop / audit / gateway-manager Lambdas" },
          { n: "04", stack: <strong className="text-white">ECS Dashboard infra</strong>, what: "NLB + Nginx Fargate + DynamoDB routing table" },
          { n: "05", stack: <strong className="text-white">Dashboard</strong>, what: "Next.js standalone + Unified CloudFront + Lambda@Edge (session-validator + origin-router)" },
          { n: "06", stack: <strong className="text-white">WAF</strong>, what: "CLOUDFRONT-scope WebACL (us-east-1)" },
          { n: "07", stack: <strong className="text-white">EC2 DevEnv</strong>, what: "Launch Template (ARM64) · DLP SGs (open/restricted/locked) · Hibernation" },
          { n: "08", stack: <strong className="text-white">Local Governance</strong>, what: "STS Issuer Lambda · cc-on-bedrock-limits · token-limit-enforcer · UserRoleProvisioner" },
        ]}
      />
      <CodeBlock title={t("배포 명령", "Deploy command")} lang="bash">
{`terraform -chdir=terraform init
terraform -chdir=terraform validate
terraform -chdir=terraform plan
terraform -chdir=terraform apply`}
      </CodeBlock>
    </PageShell>
  );
}
