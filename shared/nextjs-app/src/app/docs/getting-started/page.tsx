"use client";

import { useI18n } from "@/lib/i18n";
import { Rocket, CheckCircle2, AlertTriangle, Terminal, Copy } from "lucide-react";
import { useState } from "react";

function SectionTitle({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <h2 id={id} className="text-xl font-bold text-white mt-10 mb-4 flex items-center gap-2 scroll-mt-8">
      <span className="w-1 h-6 bg-emerald-500 rounded-full" />
      {children}
    </h2>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-gray-400 leading-relaxed mb-3">{children}</p>;
}

function CopyableCode({ children, title }: { children: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-lg overflow-hidden border border-white/5 mb-4 group relative">
      {title && (
        <div className="px-4 py-2 bg-[#161b22] text-[10px] font-bold text-gray-500 uppercase tracking-wider border-b border-white/5">
          {title}
        </div>
      )}
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 p-1.5 rounded-md bg-white/5 hover:bg-white/10 text-gray-500 hover:text-gray-300 opacity-0 group-hover:opacity-100 transition-all"
        title="Copy"
      >
        {copied ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
      <pre className="p-4 bg-[#0d1117] text-xs text-gray-300 overflow-x-auto leading-relaxed">
        <code>{children}</code>
      </pre>
    </div>
  );
}

function StepCard({ num, title, children }: { num: number; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-[#0d1117] border border-white/5 p-5 mb-4">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-7 h-7 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-xs font-black text-emerald-400">
          {num}
        </div>
        <h3 className="text-sm font-bold text-white">{title}</h3>
      </div>
      <div className="pl-10">{children}</div>
    </div>
  );
}

function Alert({ type, children }: { type: "info" | "warning"; children: React.ReactNode }) {
  const styles = {
    info: "bg-blue-500/5 border-blue-500/20 text-blue-400",
    warning: "bg-amber-500/5 border-amber-500/20 text-amber-400",
  };
  return (
    <div className={`flex items-start gap-3 px-4 py-3 rounded-lg border text-sm ${styles[type]} mb-4`}>
      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
      <div className="text-xs leading-relaxed">{children}</div>
    </div>
  );
}

export default function GettingStartedPage() {
  const { locale } = useI18n();
  const ko = locale === "ko";

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-emerald-500 to-green-500 flex items-center justify-center">
            <Rocket className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-black text-white">
              {ko ? "시작하기" : "Getting Started"}
            </h1>
            <p className="text-sm text-gray-500">
              {ko ? "배포 가이드 (CDK / Terraform / CloudFormation)" : "Deployment Guide (CDK / Terraform / CloudFormation)"}
            </p>
          </div>
        </div>
      </div>

      {/* Prerequisites */}
      <SectionTitle id="prerequisites">{ko ? "1. 사전 준비" : "1. Prerequisites"}</SectionTitle>

      <div className="rounded-xl bg-[#0d1117] border border-white/5 p-5 mb-4">
        <h3 className="text-sm font-bold text-white mb-3">{ko ? "필수 도구" : "Required Tools"}</h3>
        <div className="grid grid-cols-2 gap-2">
          {[
            { tool: "AWS CLI v2", ver: "2.15+", cmd: "aws --version" },
            { tool: "Docker", ver: "24+", cmd: "docker --version" },
            { tool: "Node.js", ver: "20 LTS", cmd: "node --version" },
            { tool: "npm", ver: "10+", cmd: "npm --version" },
            { tool: "Git", ver: "2.40+", cmd: "git --version" },
            { tool: "jq", ver: "1.6+", cmd: "jq --version" },
          ].map((r) => (
            <div key={r.tool} className="flex items-center justify-between px-3 py-2 rounded-lg bg-white/5 text-xs">
              <div>
                <span className="font-bold text-white">{r.tool}</span>
                <span className="text-gray-500 ml-2">{r.ver}</span>
              </div>
              <code className="text-gray-500 font-mono text-[10px]">{r.cmd}</code>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl bg-[#0d1117] border border-white/5 p-5 mb-4">
        <h3 className="text-sm font-bold text-white mb-3">{ko ? "AWS 계정 요구사항" : "AWS Account Requirements"}</h3>
        <ul className="space-y-2 text-xs text-gray-400">
          <li className="flex items-start gap-2">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
            <span>{ko ? "AdministratorAccess 또는 동등한 IAM 권한" : "AdministratorAccess or equivalent IAM permissions"}</span>
          </li>
          <li className="flex items-start gap-2">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
            <span>{ko ? "Route 53에 호스팅된 도메인" : "Domain hosted in Route 53"}</span>
          </li>
          <li className="flex items-start gap-2">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
            <span>{ko ? "Bedrock 모델 접근 활성화 (Opus 4.6 + Sonnet 4.6, ap-northeast-2)" : "Bedrock model access enabled (Opus 4.6 + Sonnet 4.6, ap-northeast-2)"}</span>
          </li>
          <li className="flex items-start gap-2">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
            <span>{ko ? "EC2 인스턴스 한도 확인 (ARM64)" : "EC2 instance quota check (ARM64)"}</span>
          </li>
        </ul>
      </div>

      {/* Docker Build */}
      <SectionTitle id="docker">{ko ? "2. Docker 이미지 빌드" : "2. Docker Image Build"}</SectionTitle>
      <P>{ko ? "인프라 배포 전에 DevEnv Docker 이미지를 ECR에 빌드/푸시해야 합니다." : "Build and push DevEnv Docker images to ECR before deploying infrastructure."}</P>

      <StepCard num={1} title={ko ? "ECR 리포지토리 생성" : "Create ECR Repositories"}>
        <CopyableCode>bash scripts/create-ecr-repos.sh</CopyableCode>
      </StepCard>

      <StepCard num={2} title={ko ? "이미지 빌드 및 푸시" : "Build and Push Images"}>
        <CopyableCode>{`cd docker
bash build.sh all all        # All images
# Or individually:
bash build.sh all devenv-ubuntu   # Ubuntu only
bash build.sh all devenv-al2023   # AL2023 only`}</CopyableCode>
        <Alert type="info">{ko ? "ARM64(Graviton) 기반 이미지입니다. x86 머신에서는 Docker Buildx가 필요합니다." : "These are ARM64 (Graviton) images. Docker Buildx is required on x86 machines."}</Alert>
      </StepCard>

      {/* CDK Deployment */}
      <SectionTitle id="cdk">{ko ? "3. CDK 배포 (권장)" : "3. CDK Deployment (Recommended)"}</SectionTitle>

      <StepCard num={1} title={ko ? "의존성 설치 및 Bootstrap" : "Install Dependencies & Bootstrap"}>
        <CopyableCode>{`cd cdk
npm install
cdk bootstrap aws://<ACCOUNT_ID>/ap-northeast-2`}</CopyableCode>
      </StepCard>

      <StepCard num={2} title={ko ? "설정 및 배포" : "Configure and Deploy"}>
        <CopyableCode>{`# Option A: Context parameters
cdk deploy --all \\
  -c domainName=your-domain.com \\
  -c devSubdomain=dev

# Option B: Edit config/default.ts directly
# Then:
cdk deploy --all`}</CopyableCode>
        <P>{ko ? "스택 배포 순서는 CDK가 의존성 기반으로 자동 관리합니다." : "CDK automatically manages stack deployment order based on dependencies."}</P>
      </StepCard>

      <StepCard num={3} title={ko ? "개별 스택 배포 (문제 발생 시)" : "Individual Stack Deployment (if needed)"}>
        <CopyableCode>{`cdk deploy CcOnBedrock-Network
cdk deploy CcOnBedrock-Security
cdk deploy CcOnBedrock-UsageTracking
cdk deploy CcOnBedrock-WAF
cdk deploy CcOnBedrock-EcsDevenv
cdk deploy CcOnBedrock-Dashboard
cdk deploy CcOnBedrock-Ec2Devenv`}</CopyableCode>
      </StepCard>

      {/* Terraform */}
      <SectionTitle id="terraform">{ko ? "4. Terraform 배포 (대안)" : "4. Terraform Deployment (Alternative)"}</SectionTitle>
      <CopyableCode>{`cd terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars: domain_name = "your-domain.com"

terraform init
terraform plan
terraform apply`}</CopyableCode>

      {/* CloudFormation */}
      <SectionTitle id="cloudformation">{ko ? "5. CloudFormation 배포 (대안)" : "5. CloudFormation Deployment (Alternative)"}</SectionTitle>
      <CopyableCode>{`cd cloudformation
# Edit params/default.json
bash deploy.sh
# Or with domain override:
bash deploy.sh --domain your-domain.com`}</CopyableCode>

      {/* Post-deploy */}
      <SectionTitle id="post-deploy">{ko ? "6. 배포 후 설정" : "6. Post-Deployment Setup"}</SectionTitle>

      <StepCard num={1} title={ko ? "배포 검증" : "Verify Deployment"}>
        <CopyableCode>bash scripts/verify-deployment.sh your-domain.com</CopyableCode>
      </StepCard>

      <StepCard num={2} title={ko ? "DNS 전파 확인" : "DNS Propagation Check"}>
        <CopyableCode>{`dig dashboard.your-domain.com
dig test.dev.your-domain.com
aws acm list-certificates --region us-east-1`}</CopyableCode>
        <Alert type="warning">{ko ? "ACM 인증서 검증과 DNS 전파에 최대 30분이 소요될 수 있습니다." : "ACM certificate validation and DNS propagation may take up to 30 minutes."}</Alert>
      </StepCard>

      <StepCard num={3} title={ko ? "관리자 계정 생성" : "Create Admin Account"}>
        <CopyableCode>{`USER_POOL_ID=$(aws cognito-idp list-user-pools --max-results 10 \\
  --query "UserPools[?contains(Name, 'cc-on-bedrock')].Id" --output text)

aws cognito-idp admin-create-user \\
  --user-pool-id "$USER_POOL_ID" \\
  --username admin@your-company.com \\
  --user-attributes \\
    Name=email,Value=admin@your-company.com \\
    Name=email_verified,Value=true \\
    Name=custom:subdomain,Value=admin \\
    Name=custom:container_os,Value=ubuntu \\
    Name=custom:resource_tier,Value=standard \\
    Name=custom:security_policy,Value=open \\
  --temporary-password 'TempPass123!'

aws cognito-idp admin-add-user-to-group \\
  --user-pool-id "$USER_POOL_ID" \\
  --username admin@your-company.com \\
  --group-name admin`}</CopyableCode>
      </StepCard>

      <StepCard num={4} title={ko ? "대시보드 접속" : "Access Dashboard"}>
        <P>{ko
          ? "브라우저에서 https://dashboard.your-domain.com 접속 → Cognito 로그인 → 초기 비밀번호 변경 → 대시보드 메인 페이지"
          : "Open https://dashboard.your-domain.com → Cognito login → Change initial password → Dashboard main page"}</P>
      </StepCard>

      {/* Cleanup */}
      <SectionTitle id="cleanup">{ko ? "7. 리소스 삭제" : "7. Cleanup"}</SectionTitle>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="rounded-xl bg-[#0d1117] border border-white/5 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Terminal className="w-4 h-4 text-primary-400" />
            <span className="text-xs font-bold text-white">CDK</span>
          </div>
          <code className="text-[11px] text-gray-400">cdk destroy --all</code>
        </div>
        <div className="rounded-xl bg-[#0d1117] border border-white/5 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Terminal className="w-4 h-4 text-emerald-400" />
            <span className="text-xs font-bold text-white">Terraform</span>
          </div>
          <code className="text-[11px] text-gray-400">terraform destroy</code>
        </div>
        <div className="rounded-xl bg-[#0d1117] border border-white/5 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Terminal className="w-4 h-4 text-amber-400" />
            <span className="text-xs font-bold text-white">CloudFormation</span>
          </div>
          <code className="text-[11px] text-gray-400">bash destroy.sh</code>
        </div>
      </div>
    </div>
  );
}
