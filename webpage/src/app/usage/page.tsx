"use client";

import Link from "next/link";
import { useLanguage } from "@/lib/i18n";
import { PageShell, H2, H3, P, Code, CodeBlock, Callout } from "@/components/doc/primitives";

export default function UsagePage() {
  const { t } = useLanguage();
  return (
    <PageShell
      title={t("사용법", "Usage")}
      subtitle={t("배포부터 두 가지 사용 모드까지 핵심 흐름 요약.", "From deployment to two usage modes, the essential flow.")}
    >
      <H2 id="deploy">{t("1. 인프라 배포", "1. Infrastructure deployment")}</H2>
      <H3>AWS CDK ({t("권장", "recommended")})</H3>
      <CodeBlock lang="bash">
{`cd cdk
npm install
npx cdk deploy --all                          # EC2 + Local 모두
npx cdk deploy --all -c governanceOnly=true   # Local 전용`}
      </CodeBlock>
      <H3>Terraform</H3>
      <CodeBlock lang="bash">
{`cd terraform
terraform init
terraform validate
terraform apply`}
      </CodeBlock>
      <H3>CloudFormation</H3>
      <CodeBlock lang="bash">
{`cd cloudformation
bash deploy.sh`}
      </CodeBlock>

      <H2 id="dashboard">{t("2. 대시보드 사용", "2. Using the dashboard")}</H2>
      <ul className="text-sm text-gray-400 space-y-1.5 list-disc pl-5 mb-4">
        <li><strong className="text-white">AI 비서 (/ai)</strong> — Bedrock Converse API + 5 tool</li>
        <li><strong className="text-white">분석 (/analytics)</strong> — {t("모델별/부서별/사용자별 토큰 + 비용 트렌드", "Per-model/dept/user tokens + cost trend")}</li>
        <li><strong className="text-white">모니터링 (/monitoring)</strong> — {t("EC2 메트릭 + Bedrock 사용량", "EC2 metrics + Bedrock usage")}</li>
        <li><strong className="text-white">보안 (/security)</strong> — {t("IAM, DLP, DNS Firewall", "IAM, DLP, DNS Firewall")}</li>
        <li><strong className="text-white">/admin/instances · tokens · budgets · limits · mcp · dlp</strong> — {t("관리자 운영 페이지", "Admin operational pages")}</li>
      </ul>
      <P>
        {t("Bedrock 모델은 ap-northeast-2 inference profile 사용:", "Bedrock models use ap-northeast-2 inference profiles:")}{" "}
        <strong className="text-white">Claude Opus 4.7 / 4.6 (1M context) / Sonnet 4.6 / Haiku 4.5</strong>.
      </P>

      <H2 id="modes">{t("3. 두 가지 개발환경 접속 모드", "3. Two dev-environment modes")}</H2>

      <H3 id="ec2">3-A. EC2-per-user DevEnv (ADR-004)</H3>
      <ol className="text-sm text-gray-400 space-y-1.5 list-decimal pl-5 mb-4">
        <li>{t("대시보드의 내 환경 페이지에서 EC2 인스턴스 Start", "Start your EC2 instance from My Environment")}</li>
        <li>{t("6 단계 SSE 프로비저닝 (Cold ~30s, Hibernation resume ~5s)", "6-step SSE provisioning (Cold ~30s, Hibernation resume ~5s)")}</li>
        <li>{t("할당된 서브도메인 ({subdomain}.dev.atomai.click) 접속", "Open your subdomain {subdomain}.dev.atomai.click")}</li>
        <li>{t("브라우저 VS Code (code-server) 실행", "Browser VS Code (code-server) runs")}</li>
        <li>{t("터미널에서 claude / kiro — Instance Profile 자격증명으로 Bedrock 직접 호출", "Terminal claude / kiro — Instance Profile credentials → Bedrock")}</li>
      </ol>

      <H3 id="local">3-B. Local Governance (ADR-014)</H3>
      <CodeBlock lang="bash">
{`# CLI 설치
curl -fsSL https://cconbedrock-dashboard.<domain>/tools/cc-bedrock-local.sh \\
  -o ~/.local/bin/cc-bedrock-local
chmod +x ~/.local/bin/cc-bedrock-local

# 로그인 + claude
cc-bedrock-local login
cc-bedrock-local claude`}
      </CodeBlock>
      <Callout type="tip" title={t("자세한 가이드", "Detailed guide")}>
        <Link href="/local-mode" className="text-accent-cyan hover:underline">
          /local-mode — {t("설치/설정/Admin 컨트롤 완전 가이드", "complete install / config / admin guide")}
        </Link>
      </Callout>
    </PageShell>
  );
}
