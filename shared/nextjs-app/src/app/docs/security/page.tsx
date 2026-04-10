"use client";

import { useI18n } from "@/lib/i18n";
import { Shield, Lock, Globe, Key, Layers, AlertTriangle } from "lucide-react";

function SectionTitle({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <h2 id={id} className="text-xl font-bold text-white mt-10 mb-4 flex items-center gap-2 scroll-mt-8">
      <span className="w-1 h-6 bg-rose-500 rounded-full" />
      {children}
    </h2>
  );
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

export default function SecurityPage() {
  const { locale } = useI18n();
  const ko = locale === "ko";

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-rose-500 to-pink-500 flex items-center justify-center">
            <Shield className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-black text-white">
              {ko ? "보안 아키텍처" : "Security Architecture"}
            </h1>
            <p className="text-sm text-gray-500">
              {ko ? "인증, DLP, IAM, 네트워크 격리" : "Authentication, DLP, IAM, Network Isolation"}
            </p>
          </div>
        </div>
      </div>

      {/* Security Overview */}
      <div className="rounded-xl bg-[#0d1117] border border-rose-500/20 p-5 mb-6">
        <h3 className="text-sm font-bold text-white mb-3">{ko ? "보안 레이어 요약" : "Security Layer Summary"}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {[
            { layer: ko ? "엣지 인증" : "Edge Auth", desc: "CloudFront + Lambda@Edge + Cognito OAuth", icon: Globe, color: "text-blue-400" },
            { layer: ko ? "프록시 검증" : "Proxy Validation", desc: "Nginx X-Auth-User == subdomain", icon: Layers, color: "text-cyan-400" },
            { layer: ko ? "네트워크 격리" : "Network Isolation", desc: ko ? "DLP 3-tier SG + DNS Firewall" : "DLP 3-tier SG + DNS Firewall", icon: Lock, color: "text-amber-400" },
            { layer: ko ? "IAM 최소 권한" : "IAM Least Privilege", desc: "Per-user Role + Permission Boundary", icon: Key, color: "text-rose-400" },
          ].map((l) => {
            const Icon = l.icon;
            return (
              <div key={l.layer} className="flex items-start gap-3 px-4 py-3 rounded-lg bg-white/5">
                <Icon className={`w-5 h-5 ${l.color} shrink-0 mt-0.5`} />
                <div>
                  <div className="text-xs font-bold text-white">{l.layer}</div>
                  <div className="text-[11px] text-gray-500">{l.desc}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Authentication Flow */}
      <SectionTitle id="auth">{ko ? "인증 흐름 (Cognito + Lambda@Edge)" : "Authentication Flow (Cognito + Lambda@Edge)"}</SectionTitle>
      <P>
        {ko
          ? "*.dev.atomai.click 도메인 접근 시 CloudFront의 Lambda@Edge가 Cognito OAuth 인증을 처리합니다. 인증 후 X-Auth-User 헤더를 주입하여 Nginx에서 이중 검증합니다."
          : "Lambda@Edge at CloudFront handles Cognito OAuth for *.dev.atomai.click. After auth, it injects X-Auth-User header for Nginx double-verification."}
      </P>

      <CodeBlock title={ko ? "3단계 인증 흐름" : "3-Layer Auth Flow"}>{`[1] Lambda@Edge (CloudFront Viewer Request)
    ├─ No cookie → 302 redirect to Cognito Hosted UI
    ├─ /_auth/callback → exchange code for tokens
    │   ├─ Verify ID token (JWKS)
    │   ├─ Extract custom:subdomain claim
    │   ├─ Sign cookie with HMAC-SHA256
    │   └─ Set _devenv_auth cookie (.dev.atomai.click, 8h TTL)
    └─ Valid cookie → verify HMAC → inject X-Auth-User header

[2] Nginx (ECS Fargate)
    ├─ Verify X-Custom-Secret (CloudFront → Origin)
    ├─ Verify X-Auth-User == server_name subdomain
    │   (alice.dev.* must have X-Auth-User: alice)
    └─ Strip X-Auth-User before proxy_pass (don't leak to code-server)

[3] code-server (EC2 Instance)
    └─ Password authentication (per-user, Secrets Manager)`}</CodeBlock>

      <div className="rounded-xl bg-[#0d1117] border border-blue-500/20 p-4 mb-4">
        <div className="flex items-center gap-2 mb-2">
          <Key className="w-4 h-4 text-blue-400" />
          <span className="text-sm font-bold text-white">{ko ? "쿠키 구조" : "Cookie Structure"}</span>
        </div>
        <CodeBlock>{`Cookie: _devenv_auth=<base64(payload)>.<hmac-sha256>

Payload:
{
  "sub": "alice",           // subdomain claim from ID token
  "email": "alice@co.com",  // email from ID token
  "exp": 1712678400,        // 8-hour expiry (UTC epoch)
  "iat": 1712649600         // issued at
}

Domain: .dev.atomai.click (shared across all subdomains)
Flags: Secure; HttpOnly; SameSite=Lax; Path=/`}</CodeBlock>
      </div>

      {/* DLP Policies */}
      <SectionTitle id="dlp">{ko ? "DLP 보안 정책 (Open / Restricted / Locked)" : "DLP Security Policies"}</SectionTitle>
      <P>
        {ko
          ? "사용자별 보안 수준을 3단계로 분류하고, 4개 레이어에서 동시에 집행합니다. 보안 정책은 Cognito custom:security_policy 속성에 저장되며, 실행 중 인스턴스에서도 즉시 변경 가능합니다."
          : "User security is classified in 3 tiers, enforced across 4 layers simultaneously. Policy is stored in Cognito custom:security_policy and can be changed on running instances."}
      </P>

      <div className="rounded-xl bg-[#0d1117] border border-white/5 overflow-hidden mb-4">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-white/5 bg-[#161b22]">
              <th className="text-left px-4 py-3 font-bold text-gray-400">{ko ? "레이어" : "Layer"}</th>
              <th className="text-left px-4 py-3 font-bold text-emerald-400">Open</th>
              <th className="text-left px-4 py-3 font-bold text-amber-400">Restricted</th>
              <th className="text-left px-4 py-3 font-bold text-rose-400">Locked</th>
            </tr>
          </thead>
          <tbody>
            {[
              {
                layer: "Security Group",
                open: ko ? "전체 아웃바운드 허용" : "All outbound",
                restricted: "HTTPS + DNS only",
                locked: "VPC CIDR HTTPS only",
              },
              {
                layer: "code-server",
                open: ko ? "기본 설정" : "Default",
                restricted: ko ? "파일 업/다운로드 차단" : "File upload/download blocked",
                locked: ko ? "+ Extension 읽기 전용" : "+ Extensions read-only",
              },
              {
                layer: "DNS Firewall",
                open: ko ? "허용" : "Allow all",
                restricted: ko ? "위협 도메인 차단" : "Threat domains blocked",
                locked: ko ? "화이트리스트만" : "Whitelist only",
              },
              {
                layer: "Extensions",
                open: ko ? "자유 설치" : "Free install",
                restricted: ko ? "승인된 것만" : "Pre-approved only",
                locked: ko ? "설치 불가" : "No install",
              },
            ].map((row) => (
              <tr key={row.layer} className="border-b border-white/5 last:border-0">
                <td className="px-4 py-3 font-bold text-white">{row.layer}</td>
                <td className="px-4 py-3 text-gray-400">{row.open}</td>
                <td className="px-4 py-3 text-gray-400">{row.restricted}</td>
                <td className="px-4 py-3 text-gray-400">{row.locked}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* IAM Architecture */}
      <SectionTitle id="iam">{ko ? "IAM 아키텍처" : "IAM Architecture"}</SectionTitle>
      <P>
        {ko
          ? "각 사용자에게 독립된 IAM Role이 부여됩니다. Permission Boundary가 최대 권한 범위를 제한하고, 사전 정의된 Policy Set으로 추가 권한을 요청/승인 방식으로 확장합니다."
          : "Each user gets an independent IAM Role. Permission Boundary limits maximum scope, and pre-defined Policy Sets enable additional permissions via request/approval workflow."}
      </P>

      <CodeBlock title={ko ? "Per-user IAM 구조" : "Per-user IAM Structure"}>{`Role: cc-on-bedrock-task-{subdomain}
├── Permission Boundary: cc-on-bedrock-task-boundary
│   └── Maximum allowed: Bedrock, S3 (user-prefix), CloudWatch, SSM
├── Base Policies (always attached):
│   ├── Bedrock InvokeModel (Opus 4.6, Sonnet 4.6)
│   ├── CloudWatch PutMetricData + Logs
│   └── SSM GetParameter (read-only)
└── Extended Policies (via approval workflow):
    ├── dynamodb-readwrite → specific tables
    ├── s3-readwrite → specific buckets/prefixes
    ├── eks-access → specific clusters
    └── ... (auto-expire via EventBridge)`}</CodeBlock>

      <div className="rounded-xl bg-[#0d1117] border border-white/5 p-5 mb-4">
        <h3 className="text-sm font-bold text-white mb-3">{ko ? "IAM Policy Set Catalog" : "IAM Policy Set Catalog"}</h3>
        <div className="grid grid-cols-2 gap-2">
          {[
            { set: "dynamodb-readwrite", service: "DynamoDB", scope: ko ? "테이블 CRUD" : "Table CRUD" },
            { set: "dynamodb-readonly", service: "DynamoDB", scope: ko ? "테이블 읽기" : "Table read" },
            { set: "s3-readwrite", service: "S3", scope: ko ? "버킷/prefix R/W" : "Bucket/prefix R/W" },
            { set: "s3-readonly", service: "S3", scope: ko ? "버킷 읽기" : "Bucket read" },
            { set: "eks-access", service: "EKS", scope: "Describe + API" },
            { set: "sqs-readwrite", service: "SQS", scope: "Send/Receive" },
            { set: "sns-publish", service: "SNS", scope: "Publish" },
            { set: "secretsmanager-read", service: "Secrets", scope: "GetSecretValue" },
          ].map((p) => (
            <div key={p.set} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 text-xs">
              <code className="text-[10px] text-gray-600 font-mono">{p.set}</code>
              <span className="text-gray-400 ml-auto">{p.scope}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Network Security */}
      <SectionTitle id="network">{ko ? "네트워크 보안" : "Network Security"}</SectionTitle>
      <P>
        {ko
          ? "모든 EC2 인스턴스는 Private 서브넷에 배치되며, 인터넷 접근은 NAT Gateway를 통합니다. VPC Endpoint를 통해 AWS 서비스에 Private 연결합니다."
          : "All EC2 instances run in private subnets, accessing internet via NAT Gateway. AWS services are accessed privately through VPC Endpoints."}
      </P>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <div className="rounded-xl bg-[#0d1117] border border-white/5 p-4">
          <h4 className="text-xs font-bold text-white mb-2">{ko ? "VPC Endpoint (Private)" : "VPC Endpoints"}</h4>
          <div className="flex flex-wrap gap-1.5">
            {["SSM", "SSM Messages", "ECR (api + dkr)", "Bedrock", "Bedrock Runtime", "CloudWatch Logs", "S3 (Gateway)"].map((ep) => (
              <span key={ep} className="px-2 py-1 rounded-md bg-white/5 text-[10px] text-gray-400">{ep}</span>
            ))}
          </div>
        </div>
        <div className="rounded-xl bg-[#0d1117] border border-white/5 p-4">
          <h4 className="text-xs font-bold text-white mb-2">DNS Firewall</h4>
          <div className="space-y-1.5 text-xs text-gray-400">
            <div>{ko ? "AWS 관리형 위협 도메인 목록" : "AWS managed threat domain lists"}</div>
            <div>{ko ? "커스텀 화이트리스트/블랙리스트" : "Custom whitelist/blacklist"}</div>
            <div>{ko ? "Locked 정책: 화이트리스트만 허용" : "Locked policy: whitelist-only"}</div>
          </div>
        </div>
      </div>

      {/* WAF */}
      <SectionTitle id="waf">{ko ? "WAF (Web Application Firewall)" : "WAF"}</SectionTitle>
      <P>
        {ko
          ? "CloudFront 앞단에 WAF WebACL을 배치하여 악성 트래픽을 필터링합니다. WAF는 us-east-1에 배포됩니다."
          : "WAF WebACL is placed in front of CloudFront to filter malicious traffic. WAF is deployed in us-east-1."}
      </P>

      <div className="rounded-xl bg-[#0d1117] border border-white/5 p-4 mb-4">
        <h4 className="text-xs font-bold text-white mb-2">{ko ? "WAF 규칙" : "WAF Rules"}</h4>
        <div className="space-y-1.5 text-xs text-gray-400">
          <div>{ko ? "Rate Limiting (분당 요청 제한)" : "Rate Limiting (requests per minute)"}</div>
          <div>{ko ? "AWS Managed Rules (Core Rule Set)" : "AWS Managed Rules (Core Rule Set)"}</div>
          <div>{ko ? "IP Reputation 차단" : "IP Reputation blocking"}</div>
          <div>{ko ? "SQL Injection / XSS 방어" : "SQL Injection / XSS protection"}</div>
        </div>
      </div>

      {/* Secrets Management */}
      <SectionTitle id="secrets">{ko ? "시크릿 관리" : "Secrets Management"}</SectionTitle>
      <div className="rounded-xl bg-[#0d1117] border border-white/5 overflow-hidden mb-4">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-white/5 bg-[#161b22]">
              <th className="text-left px-4 py-3 font-bold text-gray-400">{ko ? "시크릿" : "Secret"}</th>
              <th className="text-left px-4 py-3 font-bold text-gray-400">{ko ? "저장 위치" : "Store"}</th>
              <th className="text-left px-4 py-3 font-bold text-gray-400">{ko ? "용도" : "Purpose"}</th>
            </tr>
          </thead>
          <tbody>
            {[
              { name: "CloudFront Secret", store: "Secrets Manager", desc: "X-Custom-Secret header" },
              { name: "NextAuth Secret", store: "Secrets Manager", desc: ko ? "세션 암호화" : "Session encryption" },
              { name: "Cookie HMAC Secret", store: "Secrets Manager", desc: ko ? "Lambda@Edge 쿠키 서명" : "Lambda@Edge cookie signing" },
              { name: "Cognito Client Secret", store: "SSM Parameter", desc: ko ? "DevEnv OAuth 클라이언트" : "DevEnv OAuth client" },
              { name: "code-server Password", store: "Secrets Manager", desc: ko ? "사용자별 비밀번호" : "Per-user password" },
              { name: "KMS Key", store: "KMS", desc: ko ? "전체 암호화 키" : "Master encryption key" },
            ].map((s) => (
              <tr key={s.name} className="border-b border-white/5 last:border-0">
                <td className="px-4 py-3 font-mono text-[11px] text-white">{s.name}</td>
                <td className="px-4 py-3 text-gray-400">{s.store}</td>
                <td className="px-4 py-3 text-gray-500">{s.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Compliance */}
      <SectionTitle id="audit">{ko ? "감사 및 컴플라이언스" : "Audit & Compliance"}</SectionTitle>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="rounded-xl bg-[#0d1117] border border-white/5 p-4">
          <h4 className="text-xs font-bold text-white mb-2">{ko ? "감사 추적" : "Audit Trail"}</h4>
          <div className="space-y-1.5 text-xs text-gray-400">
            <div>{ko ? "CloudTrail: 모든 Bedrock API 호출" : "CloudTrail: All Bedrock API calls"}</div>
            <div>{ko ? "DynamoDB: 승인 워크플로우 기록" : "DynamoDB: Approval workflow records"}</div>
            <div>{ko ? "CloudWatch: Lambda@Edge 인증 로그" : "CloudWatch: Lambda@Edge auth logs"}</div>
            <div>{ko ? "Cognito: 로그인/로그아웃 이벤트" : "Cognito: Login/logout events"}</div>
          </div>
        </div>
        <div className="rounded-xl bg-[#0d1117] border border-white/5 p-4">
          <h4 className="text-xs font-bold text-white mb-2">{ko ? "암호화" : "Encryption"}</h4>
          <div className="space-y-1.5 text-xs text-gray-400">
            <div>{ko ? "KMS: EBS, DynamoDB, S3, Secrets Manager" : "KMS: EBS, DynamoDB, S3, Secrets Manager"}</div>
            <div>{ko ? "TLS: CloudFront → NLB/ALB (ACM 인증서)" : "TLS: CloudFront → NLB/ALB (ACM certs)"}</div>
            <div>{ko ? "HMAC-SHA256: Lambda@Edge 쿠키 서명" : "HMAC-SHA256: Lambda@Edge cookie signing"}</div>
            <div>{ko ? "HTTPS only: HSTS 헤더" : "HTTPS only: HSTS headers"}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
