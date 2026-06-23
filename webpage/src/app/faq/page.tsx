"use client";

import { useLanguage } from "@/lib/i18n";
import { PageShell, H2, H3, P, Code, CodeBlock, Callout, Table } from "@/components/doc/primitives";

export default function FaqPage() {
  const { t } = useLanguage();
  return (
    <PageShell
      title="FAQ"
      subtitle={t("자주 묻는 질문과 답변.", "Frequently asked questions.")}
    >
      <H2 id="storage">{t("스토리지", "Storage")}</H2>

      <H3>{t("스토리지는 무엇을 쓰나요?", "What storage is used?")}</H3>
      <Table
        columns={[
          { key: "item", label: t("항목", "Item") },
          { key: "ebs", label: "EBS" },
          { key: "note", label: t("비고", "Note") },
        ]}
        rows={[
          { item: t("성능", "Performance"), ebs: "gp3", note: t("필요 시 IOPS/throughput 조정", "Tune IOPS/throughput when needed") },
          { item: t("격리", "Isolation"), ebs: t("사용자별 볼륨", "Per-user volume"), note: t("Stop/Start 후 보존", "Preserved across Stop/Start") },
          { item: t("확장", "Expand"), ebs: t("관리자 승인 기반 확장", "Admin-approved expansion"), note: "40/60/100 GB" },
        ]}
      />

      <H3>{t("EC2 Stop/Start로 모든 데이터가 보존되나요?", "Does EC2 Stop/Start preserve data?")}</H3>
      <P>
        {t(
          "네. EBS root volume이 자동 보존됩니다 — /home/coder 파일, apt 패키지, npm/pip 패키지, 시스템 설정, code-server extensions 모두 유지.",
          "Yes. EBS root volume is preserved — /home/coder files, apt packages, npm/pip packages, system config, code-server extensions all retained."
        )}
      </P>

      <H2 id="auth">{t("인증 & 비밀번호", "Auth & passwords")}</H2>

      <H3>{t("Cognito 비밀번호와 code-server 비밀번호가 다른가요?", "Cognito vs code-server password?")}</H3>
      <P>
        {t(
          "초기에는 동일. Admin이 사용자 생성 시 동일한 임시 비밀번호가 Cognito + Secrets Manager에 저장. 이후 Settings 탭에서 변경하면 양쪽 동시 업데이트.",
          "Initially the same. Admin sets a shared temp password to both Cognito + Secrets Manager. Subsequent changes from the Settings tab update both."
        )}
      </P>

      <H3>{t("SAML / OIDC 연동 가능?", "SAML / OIDC support?")}</H3>
      <P>
        {t(
          "Cognito는 SAML 2.0 / OIDC IdP 연동을 기본 지원 — Okta, Azure AD, Google Workspace 등 통합 가능. Terraform security module에서 설정합니다.",
          "Cognito supports SAML 2.0 / OIDC IdPs out of the box — Okta, Azure AD, Google Workspace. Configure this in the Terraform security module."
        )}
      </P>

      <H3>{t("역할 관리 (admin/user/dept-manager)", "Role management")}</H3>
      <ul className="text-sm text-gray-400 space-y-1 list-disc pl-5 mb-4">
        <li><strong className="text-white">admin</strong> — {t("전체 대시보드 접근", "Full dashboard access")}</li>
        <li><strong className="text-white">dept-manager</strong> — {t("부서 관리 페이지", "Department management pages")}</li>
        <li><strong className="text-white">user</strong> — {t("기본 — My Environment, AI Assistant, Analytics", "Default — My Environment, AI Assistant, Analytics")}</li>
      </ul>

      <H2 id="usage">{t("사용량 추적", "Usage tracking")}</H2>
      <CodeBlock>
{`EC2 instance (Instance Profile)
또는 사용자 PC (Local Mode, STS)
  → Bedrock InvokeModel / Converse
  → Bedrock invocation logging (CloudWatch Logs, textData=false → 99% 절감)
  → Subscription Filter (cc-on-bedrock-task-* / cc-on-bedrock-local-user-* 매칭)
  → bedrock-usage-tracker Lambda
  → cc-on-bedrock-usage DynamoDB (Streams)
  → token-limit-enforcer Lambda (Stream consumer)
  → 한도 초과 시 cc-on-bedrock-limits DENY#active + IAM Deny attach`}
      </CodeBlock>
      <P>
        {t(
          "CloudTrail + EventBridge에서 Bedrock invocation logging으로 이동하면서 호출 횟수만이 아니라 실제 토큰 수까지 정확히 잡힘.",
          "Migrating from CloudTrail+EventBridge to Bedrock invocation logging captures exact token counts, not just call counts."
        )}
      </P>

      <H2 id="cost">{t("예상 운영 비용 (EC2 모드)", "Operating cost estimate (EC2 mode)")}</H2>
      <Table
        columns={[
          { key: "item", label: t("항목", "Item") },
          { key: "u10", label: "10 users" },
          { key: "u50", label: "50 users" },
          { key: "u100", label: "100 users" },
        ]}
        rows={[
          { item: t("EC2 t4g.large (8h/d ARM64)", "EC2 t4g.large (8h/d ARM64)"), u10: "~$200", u50: "~$1,000", u100: "~$2,000" },
          { item: "EBS gp3 root (40 GB)", u10: "~$32", u50: "~$160", u100: "~$320" },
          { item: "Bedrock API", u10: "~$200", u50: "~$1,000", u100: "~$2,000" },
          { item: "Nginx Fargate (HA 2)", u10: "~$18", u50: "~$18", u100: "~$18" },
          { item: "CloudFront + NLB + Dashboard ECS", u10: "~$50", u50: "~$80", u100: "~$120" },
          { item: "DynamoDB + Lambda + CloudWatch", u10: "~$10", u50: "~$20", u100: "~$40" },
          { item: <strong className="text-white">Total</strong>, u10: <strong className="text-white">~$510</strong>, u50: <strong className="text-white">~$2,278</strong>, u100: <strong className="text-white">~$4,498</strong> },
        ]}
      />
      <Callout type="tip">
        {t(
          "Local Governance 모드 100명 → EC2 비용 0 + Bedrock ~$2,000 + 거버넌스 인프라 ~$1.",
          "100 Local Governance users → zero EC2 + ~$2,000 Bedrock + ~$1 governance infra."
        )}
      </Callout>

      <H2 id="iam">{t("IAM 격리", "IAM isolation")}</H2>
      <ul className="text-sm text-gray-400 space-y-1.5 list-disc pl-5 mb-4">
        <li><strong className="text-white">EC2:</strong> <Code>cc-on-bedrock-task-{"{subdomain}"}</Code> Instance Profile</li>
        <li><strong className="text-white">Local:</strong> <Code>cc-on-bedrock-local-user-{"{sub_short}"}</Code> STS AssumeRole 대상</li>
        <li>{t("Bedrock: wildcard Claude family ARN — 신규 모델 출시 시 IAM 변경 없이 즉시 사용", "Bedrock: wildcard ARN — new models work without policy changes")}</li>
        <li>Permission Boundary <Code>cc-on-bedrock-task-boundary</Code> {t("강제", "enforced")}</li>
        <li>{t("Cognito 사용자 가입 → EventBridge가 사전 프로비저닝", "Cognito user creation → EventBridge pre-provisions")}</li>
        <li>{t("사용자 삭제 → EventBridge가 자동 정리", "User deletion → EventBridge auto-cleans")}</li>
      </ul>

      <H2 id="deploy">{t("배포 / 멀티 리전", "Deployment / multi-region")}</H2>
      <H3>{t("Terraform 배포 순서", "Terraform deploy order")}</H3>
      <CodeBlock lang="bash">
{`terraform -chdir=terraform init
terraform -chdir=terraform fmt -recursive
terraform -chdir=terraform validate
terraform -chdir=terraform plan
terraform -chdir=terraform apply`}
      </CodeBlock>
      <P>{t("모듈 의존성은 Terraform graph가 처리합니다.", "Terraform graph handles module dependency order.")}</P>

      <H3>{t("다른 리전에 배포 가능?", "Deploy to another region?")}</H3>
      <CodeBlock lang="bash">
{`terraform -chdir=terraform apply \\
  -var='aws_region=us-west-2' \\
  -var='vpc_cidr=10.200.0.0/16'`}
      </CodeBlock>
      <P>
        {t(
          "Claude Opus 4.7 / 4.6은 global. inference profile, Haiku 4.5는 us. profile. 가장 안정적인 region: us-east-1, us-west-2, ap-northeast-2.",
          "Claude Opus 4.7 / 4.6 use the global. inference profile; Haiku 4.5 uses us. The most stable regions are us-east-1, us-west-2, ap-northeast-2."
        )}
      </P>

      <H2 id="iac">{t("IaC 기준", "IaC source of truth")}</H2>
      <ul className="text-sm text-gray-400 space-y-1 list-disc pl-5 mb-4">
        <li><strong className="text-white">Terraform (HCL)</strong> — {t("유일한 배포 기준", "the only deployment source of truth")}</li>
        <li>{t("Lambda 소스는 repo root의 lambda/에서 패키징", "Lambda source is packaged from repo-root lambda/")}</li>
      </ul>
    </PageShell>
  );
}
