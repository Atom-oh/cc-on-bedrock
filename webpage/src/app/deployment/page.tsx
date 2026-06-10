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
      tags={[{ label: "8 stacks", color: "cyan" }, { label: "CDK / TF / CFN", color: "green" }]}
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
          { item: "Node.js", req: "v20+ (CDK + Next.js)" },
          { item: "AWS CDK CLI", req: <Code>npm install -g aws-cdk</Code> },
          { item: "Docker", req: t("ARM64 build host 권장", "ARM64 build host recommended") },
          { item: t("Domain (옵션)", "Domain (optional)"), req: t("Route 53 hosted zone + ACM 인증서", "Route 53 hosted zone + ACM certificate") },
        ]}
      />

      <H2 id="profile">{t("배포 프로파일", "Deploy profiles")}</H2>
      <Table
        columns={[
          { key: "p", label: t("프로파일", "Profile") },
          { key: "cmd", label: t("명령", "Command") },
          { key: "incl", label: t("포함 스택", "Stacks included") },
        ]}
        rows={[
          { p: t("EC2 + Local 공존 (기본)", "EC2 + Local coexist (default)"), cmd: <Code>cdk deploy --all</Code>, incl: "1–8" },
          { p: "Local Governance only", cmd: <Code>cdk deploy --all -c governanceOnly=true</Code>, incl: t("1–6, 8 (7 스킵)", "1–6, 8 (skip 7)") },
        ]}
      />

      <H2 id="steps">{t("배포 단계 상세", "Deployment steps")}</H2>

      <H3 id="s1">Step 1 — Network (01)</H3>
      <ul className="text-sm text-gray-400 space-y-1 list-disc pl-5 mb-4">
        <li>VPC <Code>10.100.0.0/16</Code> · 2 AZ · Public + Private + Isolated subnet</li>
        <li>NAT Gateway / VPC Endpoints (S3, DynamoDB, Bedrock Runtime, KMS, Secrets Manager)</li>
        <li>DNS Firewall · Route 53 hosted zone</li>
      </ul>

      <H3 id="s2">Step 2 — Security (02)</H3>
      <ul className="text-sm text-gray-400 space-y-1 list-disc pl-5 mb-4">
        <li>Cognito User Pool + App Client (USER_PASSWORD_AUTH) + custom 속성</li>
        <li>ACM wildcard 인증서 + us-east-1 별도 발급 (WAF용)</li>
        <li>KMS customer-managed CMK · Secrets Manager</li>
        <li>IAM Permission Boundary <Code>cc-on-bedrock-task-boundary</Code></li>
      </ul>

      <H3 id="s3">Step 3 — Usage Tracking (03) · ADR-019</H3>
      <ul className="text-sm text-gray-400 space-y-1 list-disc pl-5 mb-4">
        <li>{t("Bedrock invocation logging → CloudWatch Logs (textDataDeliveryEnabled: false, 비용 ~99% 절감)", "Bedrock invocation logging → CloudWatch Logs (text/image/embedding off, ~99% cost cut)")}</li>
        <li>{t("Subscription Filter → bedrock-usage-tracker Lambda (IAM role prefix 매칭)", "Subscription Filter → bedrock-usage-tracker Lambda (IAM role prefix match)")}</li>
        <li>{t("DynamoDB usage (Streams) + user_budgets + cli_tokens + approval_requests + prompt_audit + mcp_catalog + dept_mcp_config", "DynamoDB usage (Streams) + user_budgets + cli_tokens + approval_requests + prompt_audit + mcp_catalog + dept_mcp_config")}</li>
        <li>budget-check · ec2-idle-stop · audit-logger · gateway-manager Lambdas</li>
      </ul>

      <H3 id="s4">Step 4 — ECS Dashboard infra (04)</H3>
      <ul className="text-sm text-gray-400 space-y-1 list-disc pl-5 mb-4">
        <li>NLB internet-facing (CloudFront prefix list only on port 80)</li>
        <li>Nginx Fargate 2-task HA + 5초 hot-reload pipeline</li>
        <li>Lambda <Code>nginx-config-gen</Code> + S3 sync</li>
      </ul>

      <H3 id="s5">Step 5 — Dashboard (05) · ADR-013/016/017</H3>
      <ul className="text-sm text-gray-400 space-y-1 list-disc pl-5 mb-4">
        <li>Next.js Standalone ECS Task (rolling deployment + circuit breaker)</li>
        <li>{t("통합 CloudFront — Dashboard + DevEnv 라우팅", "Unified CloudFront — routes Dashboard + DevEnv")}</li>
        <li>Lambda@Edge: <Code>session-validator</Code> (NextAuth JWE) + <Code>origin-router</Code></li>
      </ul>

      <H3 id="s6">Step 6 — WAF (06)</H3>
      <P>{t("CloudFront-scope WebACL (us-east-1) — AWS Managed Common Rule Set + 사용자 정의 rate limit.", "CloudFront-scope WebACL (us-east-1) — AWS Managed Common Rule Set + custom rate limit.")}</P>

      <H3 id="s7">Step 7 — EC2 DevEnv (07)</H3>
      <P>
        <span className="text-accent-orange">[{t("governanceOnly=true 시 스킵", "skipped if governanceOnly=true")}]</span>
      </P>
      <ul className="text-sm text-gray-400 space-y-1 list-disc pl-5 mb-4">
        <li>Launch Template (ARM64 t4g.large, Ubuntu 24.04 또는 AL2023)</li>
        <li>{t("부팅 시 SSM Parameter Store에서 Cognito Client ID/Secret 로드", "Boot loads Cognito Client ID/Secret from SSM Parameter Store")}</li>
        <li>cloud-init이 code-server + Claude Code + Kiro CLI 설치/실행</li>
        <li>DLP Security Groups (ADR-005) — open / restricted / locked</li>
        <li>Hibernation (ADR-010, 60-day rotation 한도)</li>
      </ul>

      <H3 id="s8">Step 8 — Local Governance (08) · ADR-014</H3>
      <ul className="text-sm text-gray-400 space-y-1 list-disc pl-5 mb-4">
        <li>STS Issuer Lambda + Function URL (IAM auth)</li>
        <li>cc-on-bedrock-limits DynamoDB</li>
        <li>token-limit-enforcer Lambda (usage table Stream consumer)</li>
        <li>limit-reset Lambda + 3 EventBridge crons (daily/weekly/monthly KST)</li>
        <li>UserRoleProvisioner Lambda + EventBridge <Code>cognito-user-created</Code> rule + DLQ (ADR-022)</li>
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

      <Callout type="warn" title={t("Terraform parity 주의", "Terraform parity note")}>
        {t(
          "현재 Terraform 모듈은 root main.tf에 network + security + ecs-devenv + dashboard 4개만 wired. usage-tracking / local-governance / ec2-devenv / waf 모듈은 존재하지만 root 통합은 follow-up. CDK / CloudFormation은 모두 사용 가능.",
          "Terraform root currently wires only network + security + ecs-devenv + dashboard. The usage-tracking / local-governance / ec2-devenv / waf modules exist but root integration is follow-up work. CDK / CloudFormation are fully usable."
        )}
      </Callout>
    </PageShell>
  );
}
