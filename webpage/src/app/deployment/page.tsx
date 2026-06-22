"use client";

import { useLanguage } from "@/lib/i18n";
import { PageShell, H2, H3, P, Code, Table, CodeBlock, Callout } from "@/components/doc/primitives";

export default function DeploymentPage() {
  const { t } = useLanguage();

  return (
    <PageShell
      title={t("배포 가이드", "Deployment Guide")}
      subtitle={t(
        "CC-on-Bedrock을 AWS 계정에 배포하기 위한 전체 과정과 아키텍처 원리를 설명합니다.",
        "Step-by-step deployment to your AWS account, with architectural context."
      )}
      tags={[{ label: "Terraform", color: "cyan" }, { label: "EC2 + Local", color: "green" }]}
    >
      <H2 id="prereq">{t("Prerequisites", "Prerequisites")}</H2>
      <Table
        columns={[
          { key: "item", label: t("항목", "Item") },
          { key: "req", label: t("요구사항", "Requirement") },
        ]}
        rows={[
          { item: t("AWS 계정", "AWS account"), req: "AdministratorAccess IAM" },
          { item: "Region", req: t("ap-northeast-2 (Seoul) — 다른 리전 시 inference profile 변경 필요", "ap-northeast-2 (Seoul) — change inference profile if using other regions") },
          { item: "Terraform", req: "v1.6+" },
          { item: "Node.js", req: "v20+ (Next.js)" },
          { item: "Docker", req: t("ARM64 build host 권장", "ARM64 build host recommended") },
          { item: t("Domain (옵션)", "Domain (optional)"), req: t("Route 53 hosted zone + ACM 인증서", "Route 53 hosted zone + ACM certificate") },
        ]}
      />

      <H2 id="profile">{t("배포 프로파일", "Deploy profiles")}</H2>
      <Table
        columns={[
          { key: "p", label: t("프로파일", "Profile") },
          { key: "cmd", label: t("명령", "Command") },
          { key: "incl", label: t("포함 범위", "Scope") },
        ]}
        rows={[
          { p: t("EC2 + Local 공존 (기본)", "EC2 + Local coexist (default)"), cmd: <Code>terraform -chdir=terraform apply</Code>, incl: t("전체 모듈", "all modules") },
          { p: "Local Governance", cmd: <Code>curl -fsSL https://dashboard.example.com/api/install | bash</Code>, incl: t("Terraform 배포 후 사용자 PC에서 사용", "user-local flow after Terraform deploy") },
        ]}
      />

      <H2 id="steps">{t("배포 단계 상세", "Deployment steps")}</H2>

      <H3 id="s1">Step 1 — Network</H3>
      <ul className="text-sm text-gray-400 space-y-1 list-disc pl-5 mb-4">
        <li>VPC <Code>10.100.0.0/16</Code> · 2 AZ · Public + Private + Isolated subnet</li>
        <li>NAT Gateway / VPC Endpoints (S3, DynamoDB, Bedrock Runtime, KMS, Secrets Manager)</li>
        <li>DNS Firewall · Route 53 hosted zone</li>
      </ul>

      <H3 id="s2">Step 2 — Security</H3>
      <ul className="text-sm text-gray-400 space-y-1 list-disc pl-5 mb-4">
        <li>Cognito User Pool + App Client (USER_PASSWORD_AUTH) + custom 속성</li>
        <li>ACM wildcard 인증서 + us-east-1 별도 발급 (WAF용)</li>
        <li>KMS customer-managed CMK · Secrets Manager</li>
        <li>IAM Permission Boundary <Code>cc-on-bedrock-task-boundary</Code></li>
      </ul>

      <H3 id="s3">Step 3 — Usage Tracking</H3>
      <ul className="text-sm text-gray-400 space-y-1 list-disc pl-5 mb-4">
        <li>{t("Bedrock invocation logging → CloudWatch Logs (textDataDeliveryEnabled: false, 비용 ~99% 절감)", "Bedrock invocation logging → CloudWatch Logs (text/image/embedding off, ~99% cost cut)")}</li>
        <li>{t("Subscription Filter → bedrock-usage-tracker Lambda (IAM role prefix 매칭)", "Subscription Filter → bedrock-usage-tracker Lambda (IAM role prefix match)")}</li>
        <li>{t("DynamoDB usage (Streams) + user_budgets + cli_tokens + approval_requests + prompt_audit + mcp_catalog + dept_mcp_config", "DynamoDB usage (Streams) + user_budgets + cli_tokens + approval_requests + prompt_audit + mcp_catalog + dept_mcp_config")}</li>
        <li>budget-check · ec2-idle-stop · audit-logger · gateway-manager Lambdas</li>
      </ul>

      <H3 id="s4">Step 4 — Shared Nginx Router</H3>
      <ul className="text-sm text-gray-400 space-y-1 list-disc pl-5 mb-4">
        <li>NLB internet-facing (CloudFront prefix list only on port 80)</li>
        <li>Nginx Fargate 2-task HA + 5초 hot-reload pipeline</li>
        <li>Lambda <Code>nginx-config-gen</Code> + S3 sync</li>
      </ul>

      <H3 id="s5">Step 5 — Dashboard</H3>
      <ul className="text-sm text-gray-400 space-y-1 list-disc pl-5 mb-4">
        <li>Next.js dashboard on EC2 ASG behind ALB</li>
        <li>{t("통합 CloudFront — Dashboard + DevEnv 라우팅", "Unified CloudFront — routes Dashboard + DevEnv")}</li>
        <li>Lambda@Edge: <Code>session-validator</Code> (NextAuth JWE) + <Code>origin-router</Code></li>
      </ul>

      <H3 id="s6">Step 6 — WAF</H3>
      <P>{t("CloudFront-scope WebACL (us-east-1) — AWS Managed Common Rule Set + 사용자 정의 rate limit.", "CloudFront-scope WebACL (us-east-1) — AWS Managed Common Rule Set + custom rate limit.")}</P>

      <H3 id="s7">Step 7 — EC2 DevEnv</H3>
      <P>
        <span className="text-accent-orange">[{t("EC2 모드가 필요한 사용자에게 할당", "assigned only to users who need EC2 mode")}]</span>
      </P>
      <ul className="text-sm text-gray-400 space-y-1 list-disc pl-5 mb-4">
        <li>Launch Template (ARM64 t4g.large, Ubuntu 24.04 또는 AL2023)</li>
        <li>{t("부팅 시 SSM Parameter Store에서 Cognito Client ID/Secret 로드", "Boot loads Cognito Client ID/Secret from SSM Parameter Store")}</li>
        <li>cloud-init이 code-server + Claude Code + Kiro CLI 설치/실행</li>
        <li>DLP Security Groups — open / restricted / locked</li>
        <li>Hibernation (60-day rotation 한도)</li>
      </ul>

      <H3 id="s8">Step 8 — Local Governance</H3>
      <ul className="text-sm text-gray-400 space-y-1 list-disc pl-5 mb-4">
        <li>STS Issuer Lambda + Function URL (IAM auth)</li>
        <li>cc-on-bedrock-limits DynamoDB</li>
        <li>token-limit-enforcer Lambda (usage table Stream consumer)</li>
        <li>limit-reset Lambda + 3 EventBridge crons (daily/weekly/monthly KST)</li>
        <li>UserRoleProvisioner Lambda + EventBridge <Code>cognito-user-created</Code> rule + DLQ</li>
        <li>SNS alert topic</li>
      </ul>

      <H2 id="verify">{t("배포 후 검증", "Post-deploy verification")}</H2>
      <CodeBlock lang="bash">
{`# 도메인 기반 검증
bash scripts/verify-deployment.sh {your-domain}

# 컨테이너 통합 테스트
bash tests/docker/test-devenv.sh

# E2E
bash tests/integration/test-e2e.sh`}
      </CodeBlock>

      <Callout type="tip" title={t("Terraform 기준", "Terraform canonical path")}>
        {t(
          "현재 배포 기준은 Terraform root입니다. 변경 전 terraform fmt, validate, plan을 실행하세요.",
          "The deployment source of truth is the Terraform root. Run terraform fmt, validate, and plan before applying changes."
        )}
      </Callout>
    </PageShell>
  );
}
