"use client";

import { useI18n } from "@/lib/i18n";
import { Layers, ArrowRight, Server, Globe, Database, Shield, Cloud } from "lucide-react";

function SectionTitle({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <h2 id={id} className="text-xl font-bold text-white mt-10 mb-4 flex items-center gap-2 scroll-mt-8">
      <span className="w-1 h-6 bg-primary-500 rounded-full" />
      {children}
    </h2>
  );
}

function SubSection({ children }: { children: React.ReactNode }) {
  return <h3 className="text-base font-bold text-gray-200 mt-6 mb-3">{children}</h3>;
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-gray-400 leading-relaxed mb-3">{children}</p>;
}

function CodeBlock({ children, title }: { children: string; title?: string }) {
  return (
    <div className="rounded-lg overflow-hidden border border-white/5 mb-4">
      {title && (
        <div className="px-4 py-2 bg-[#161b22] text-[10px] font-bold text-gray-500 uppercase tracking-wider border-b border-white/5">
          {title}
        </div>
      )}
      <pre className="p-4 bg-[#0d1117] text-xs text-gray-300 overflow-x-auto leading-relaxed">
        <code>{children}</code>
      </pre>
    </div>
  );
}

function FlowDiagram() {
  const steps = [
    { icon: Globe, label: "Browser", sub: "HTTPS" },
    { icon: Cloud, label: "CloudFront", sub: "Lambda@Edge Auth" },
    { icon: Server, label: "NLB", sub: "TCP Pass-through" },
    { icon: Layers, label: "Nginx (ECS)", sub: "X-Auth-User Check" },
    { icon: Server, label: "EC2 Instance", sub: "code-server" },
    { icon: Cloud, label: "Bedrock", sub: "VPC Endpoint" },
  ];

  return (
    <div className="flex items-center gap-1 overflow-x-auto py-4 mb-4">
      {steps.map((step, i) => {
        const Icon = step.icon;
        return (
          <div key={i} className="flex items-center gap-1 shrink-0">
            <div className="flex flex-col items-center gap-1.5 px-3 py-3 rounded-lg bg-[#161b22] border border-white/5 min-w-[100px]">
              <Icon className="w-5 h-5 text-primary-400" />
              <span className="text-xs font-bold text-white">{step.label}</span>
              <span className="text-[10px] text-gray-500">{step.sub}</span>
            </div>
            {i < steps.length - 1 && <ArrowRight className="w-4 h-4 text-gray-600 shrink-0" />}
          </div>
        );
      })}
    </div>
  );
}

export default function ArchitecturePage() {
  const { locale } = useI18n();
  const ko = locale === "ko";

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center">
            <Layers className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-black text-white">
              {ko ? "아키텍처" : "Architecture"}
            </h1>
            <p className="text-sm text-gray-500">
              {ko ? "CC-on-Bedrock 시스템 구조" : "CC-on-Bedrock System Structure"}
            </p>
          </div>
        </div>
      </div>

      {/* Traffic Flow */}
      <SectionTitle id="traffic-flow">{ko ? "트래픽 흐름" : "Traffic Flow"}</SectionTitle>
      <P>
        {ko
          ? "사용자의 브라우저에서 code-server까지의 전체 요청 경로입니다. CloudFront에서 Lambda@Edge가 Cognito 인증을 처리하고, Nginx가 서브도메인 기반으로 해당 EC2 인스턴스로 라우팅합니다."
          : "The complete request path from the user's browser to code-server. Lambda@Edge at CloudFront handles Cognito auth, and Nginx routes to the correct EC2 instance based on subdomain."}
      </P>
      <FlowDiagram />

      <CodeBlock title={ko ? "인증 흐름 상세" : "Auth Flow Detail"}>{`1. Browser → CloudFront (*.dev.atomai.click)
2. Lambda@Edge (Viewer Request)
   ├─ Cookie exists → HMAC verify → inject X-Auth-User header → pass
   ├─ /_auth/callback → exchange code → set signed cookie → redirect
   └─ No cookie → 302 redirect to Cognito Hosted UI
3. NLB → Nginx (ECS Fargate)
   └─ Validate: X-Auth-User == subdomain (defense-in-depth)
4. EC2 Instance → code-server (password auth)
5. Claude Code → Instance Profile → Bedrock VPC Endpoint`}</CodeBlock>

      {/* CDK Stacks */}
      <SectionTitle id="stacks">{ko ? "CDK 스택 구성" : "CDK Stack Architecture"}</SectionTitle>
      <P>
        {ko
          ? "7개의 CDK 스택으로 구성되며, 의존성 순서대로 배포됩니다. 각 스택은 독립적으로 업데이트 가능합니다."
          : "Composed of 7 CDK stacks, deployed in dependency order. Each stack can be updated independently."}
      </P>

      <div className="grid grid-cols-1 gap-3 mb-6">
        {[
          {
            num: "01",
            name: "Network",
            id: "CcOnBedrock-Network",
            items: ["VPC (10.x.0.0/16)", "Public/Private Subnets (2 AZ)", "NAT Gateway x2", "VPC Endpoints (SSM, ECR, Bedrock, CW, S3)", "Route 53 Hosted Zone", "DNS Firewall"],
            color: "border-blue-500/30",
          },
          {
            num: "02",
            name: "Security",
            id: "CcOnBedrock-Security",
            items: ["Cognito User Pool + Hosted UI", "DevEnv Auth Client (Lambda@Edge)", "ACM Certificates", "KMS Encryption Key", "Secrets Manager", "Per-user IAM Roles + Permission Boundary"],
            color: "border-amber-500/30",
          },
          {
            num: "03",
            name: "Usage Tracking",
            id: "CcOnBedrock-UsageTracking",
            items: ["DynamoDB (cc-on-bedrock-usage)", "Lambda (bedrock-usage-tracker)", "Lambda (budget-check, 5min)", "EventBridge Rules (CloudTrail → Lambda)"],
            color: "border-emerald-500/30",
          },
          {
            num: "04",
            name: "ECS DevEnv",
            id: "CcOnBedrock-EcsDevenv",
            items: ["ECS Cluster cc-on-bedrock-devenv", "Nginx Fargate Service (reverse proxy)", "ASG Capacity Provider (t4g.xlarge)", "NLB + CloudFront", "Lambda@Edge (Cognito auth)", "DynamoDB (cc-routing-table)", "Lambda (nginx-config-gen)"],
            color: "border-cyan-500/30",
          },
          {
            num: "05",
            name: "Dashboard",
            id: "CcOnBedrock-Dashboard",
            items: ["ECS Ec2Service (shared cluster)", "Dashboard Container (ECR, port 3000)", "ALB + CloudFront", "4096 CPU / 15360 MiB"],
            color: "border-violet-500/30",
          },
          {
            num: "06",
            name: "WAF",
            id: "CcOnBedrock-WAF",
            items: ["WAF WebACL (us-east-1)", "Rate Limiting Rules", "CloudFront Association"],
            color: "border-rose-500/30",
          },
          {
            num: "07",
            name: "EC2 DevEnv",
            id: "CcOnBedrock-Ec2Devenv",
            items: ["Launch Template (ARM64)", "Per-user Instance Profile", "Security Groups (open/restricted/locked)", "DynamoDB (cc-user-instances)", "Lambda (ec2-idle-stop)", "SSM Parameter (AMI ID)"],
            color: "border-orange-500/30",
          },
        ].map((stack) => (
          <div key={stack.num} className={`rounded-xl bg-[#0d1117] border ${stack.color} p-4`}>
            <div className="flex items-center gap-3 mb-3">
              <span className="text-xs font-black text-gray-500 bg-white/5 px-2 py-0.5 rounded-md">
                Stack {stack.num}
              </span>
              <span className="text-sm font-bold text-white">{stack.name}</span>
              <span className="text-[10px] text-gray-600 font-mono ml-auto">{stack.id}</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {stack.items.map((item) => (
                <span key={item} className="px-2 py-1 rounded-md bg-white/5 text-[11px] text-gray-400">
                  {item}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Stack Dependencies */}
      <SubSection>{ko ? "스택 의존성" : "Stack Dependencies"}</SubSection>
      <CodeBlock title="Dependency Graph">{`01 Network
 └─▶ 02 Security
      ├─▶ 03 Usage Tracking
      ├─▶ 06 WAF (us-east-1)
      ├─▶ 04 ECS DevEnv ◀─── 06 WAF
      │    └─▶ 05 Dashboard
      └─▶ 07 EC2 DevEnv`}</CodeBlock>

      {/* Network Layout */}
      <SectionTitle id="network">{ko ? "네트워크 구성" : "Network Layout"}</SectionTitle>
      <P>
        {ko
          ? "VPC 내 3-tier 서브넷 구조입니다. ALB/NLB는 Public 서브넷, 모든 컴퓨팅 리소스는 Private 서브넷에 배치됩니다."
          : "3-tier subnet structure within the VPC. ALB/NLB in public subnets, all compute resources in private subnets."}
      </P>

      <CodeBlock title={ko ? "서브넷 배치" : "Subnet Placement"}>{`VPC (configurable CIDR)
├── Public Subnets (AZ-a, AZ-c)
│   ├── NLB (DevEnv traffic)
│   ├── ALB (Dashboard traffic)
│   └── NAT Gateway x2
│
├── Private Subnets (AZ-a, AZ-c)
│   ├── ECS Cluster cc-on-bedrock-devenv
│   │   ├── Nginx (Fargate, 2 tasks)
│   │   └── Dashboard (EC2 launch type, 1 task)
│   ├── Per-user EC2 Instances (DevEnv)
│   └── VPC Endpoints
│
└── Isolated Subnets (AZ-a, AZ-c)
    └── (Reserved for future RDS/ElastiCache)`}</CodeBlock>

      {/* Bedrock Access */}
      <SectionTitle id="bedrock">{ko ? "Bedrock 접근 경로" : "Bedrock Access Path"}</SectionTitle>
      <P>
        {ko
          ? "Claude Code는 EC2 Instance Profile을 통해 Bedrock VPC Endpoint에 직접 접근합니다. CloudTrail이 모든 InvokeModel 호출을 기록하고, EventBridge → Lambda로 DynamoDB에 사용량을 저장합니다."
          : "Claude Code accesses Bedrock VPC Endpoint directly via EC2 Instance Profile. CloudTrail logs all InvokeModel calls, EventBridge → Lambda stores usage in DynamoDB."}
      </P>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
        <div className="rounded-xl bg-[#0d1117] border border-white/5 p-4">
          <div className="flex items-center gap-2 mb-3">
            <Server className="w-4 h-4 text-primary-400" />
            <span className="text-sm font-bold text-white">
              {ko ? "개발 환경 → Bedrock" : "DevEnv → Bedrock"}
            </span>
          </div>
          <div className="space-y-1.5 text-xs text-gray-400">
            <div>Claude Code / Kiro CLI</div>
            <div className="text-gray-600">↓ Instance Profile (IMDS v2)</div>
            <div>cc-on-bedrock-task-{"{subdomain}"}</div>
            <div className="text-gray-600">↓ VPC Endpoint</div>
            <div className="text-primary-400">Amazon Bedrock (ap-northeast-2)</div>
          </div>
        </div>
        <div className="rounded-xl bg-[#0d1117] border border-white/5 p-4">
          <div className="flex items-center gap-2 mb-3">
            <Database className="w-4 h-4 text-emerald-400" />
            <span className="text-sm font-bold text-white">
              {ko ? "사용량 추적" : "Usage Tracking"}
            </span>
          </div>
          <div className="space-y-1.5 text-xs text-gray-400">
            <div>InvokeModel API Call</div>
            <div className="text-gray-600">↓ CloudTrail</div>
            <div>EventBridge Rule</div>
            <div className="text-gray-600">↓ Lambda (usage-tracker)</div>
            <div className="text-emerald-400">DynamoDB (per-user + per-dept)</div>
          </div>
        </div>
      </div>

      {/* Nginx Routing */}
      <SectionTitle id="routing">{ko ? "Nginx 동적 라우팅" : "Nginx Dynamic Routing"}</SectionTitle>
      <P>
        {ko
          ? "DynamoDB cc-routing-table에 {subdomain → privateIp} 매핑을 저장합니다. 테이블 변경 시 DynamoDB Streams → Lambda가 nginx.conf를 재생성하여 S3에 업로드하고, Nginx 컨테이너가 주기적으로 pull합니다."
          : "DynamoDB cc-routing-table stores {subdomain → privateIp} mappings. On table changes, DynamoDB Streams → Lambda regenerates nginx.conf to S3, and Nginx containers periodically pull it."}
      </P>

      <CodeBlock title={ko ? "라우팅 파이프라인" : "Routing Pipeline"}>{`Dashboard API (Start Instance)
 └─▶ DynamoDB cc-routing-table
      PUT { subdomain: "alice", targetIp: "10.0.1.50", port: 8080, status: "active" }
      │
      ▼ DynamoDB Streams
      │
Lambda (nginx-config-gen)
 └─▶ S3 (nginx/nginx.conf)
      │
      ▼ Periodic pull (every 30s)
      │
Nginx Fargate Service
 └─▶ server { server_name alice.dev.atomai.click; proxy_pass http://10.0.1.50:8080; }`}</CodeBlock>

      {/* Models */}
      <SectionTitle id="models">{ko ? "지원 AI 모델" : "Supported AI Models"}</SectionTitle>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="rounded-xl bg-[#0d1117] border border-white/5 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Cloud className="w-4 h-4 text-amber-400" />
            <span className="text-sm font-bold text-white">Claude Opus 4.6</span>
          </div>
          <div className="text-xs text-gray-500 font-mono mb-1">global.anthropic.claude-opus-4-6-v1[1m]</div>
          <P>{ko ? "최고 성능 모델. 복잡한 코드 생성, 아키텍처 설계, 대규모 리팩토링에 적합." : "Highest performance model. Best for complex code generation, architecture design, large refactoring."}</P>
        </div>
        <div className="rounded-xl bg-[#0d1117] border border-white/5 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Cloud className="w-4 h-4 text-blue-400" />
            <span className="text-sm font-bold text-white">Claude Sonnet 4.6</span>
          </div>
          <div className="text-xs text-gray-500 font-mono mb-1">global.anthropic.claude-sonnet-4-6[1m]</div>
          <P>{ko ? "균형잡힌 모델. 빠른 응답 속도와 높은 코드 품질. 일반 개발 작업에 최적." : "Balanced model. Fast response with high code quality. Optimal for general development."}</P>
        </div>
      </div>
    </div>
  );
}
