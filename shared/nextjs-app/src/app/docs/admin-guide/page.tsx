"use client";

import { useI18n } from "@/lib/i18n";
import { Settings, Users, Server, Wallet, ClipboardCheck, BarChart3, AlertTriangle } from "lucide-react";

function SectionTitle({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <h2 id={id} className="text-xl font-bold text-white mt-10 mb-4 flex items-center gap-2 scroll-mt-8">
      <span className="w-1 h-6 bg-orange-500 rounded-full" />
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

export default function AdminGuidePage() {
  const { locale } = useI18n();
  const ko = locale === "ko";

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-orange-500 to-amber-500 flex items-center justify-center">
            <Settings className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-black text-white">
              {ko ? "관리자 가이드" : "Admin Guide"}
            </h1>
            <p className="text-sm text-gray-500">
              {ko ? "사용자 관리, 인스턴스 운영, 예산 설정" : "User management, instance ops, budget settings"}
            </p>
          </div>
        </div>
      </div>

      {/* Dashboard Menu Overview */}
      <div className="rounded-xl bg-[#0d1117] border border-white/5 p-5 mb-6">
        <h3 className="text-sm font-bold text-white mb-3">{ko ? "관리자 메뉴 개요" : "Admin Menu Overview"}</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
          {[
            { icon: Users, label: ko ? "사용자 관리" : "User Management", path: "/admin", color: "text-blue-400" },
            { icon: Server, label: ko ? "인스턴스 관리" : "Instance Management", path: "/admin/containers", color: "text-cyan-400" },
            { icon: BarChart3, label: ko ? "토큰 사용량" : "Token Usage", path: "/admin/tokens", color: "text-emerald-400" },
            { icon: Wallet, label: ko ? "예산 설정" : "Budget Settings", path: "/admin/budgets", color: "text-amber-400" },
            { icon: ClipboardCheck, label: ko ? "승인 관리" : "Approvals", path: "/admin/approvals", color: "text-violet-400" },
            { icon: AlertTriangle, label: ko ? "모니터링" : "Monitoring", path: "/monitoring", color: "text-rose-400" },
          ].map((item) => {
            const Icon = item.icon;
            return (
              <div key={item.path} className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-white/5">
                <Icon className={`w-4 h-4 ${item.color} shrink-0`} />
                <div>
                  <div className="text-xs font-bold text-white">{item.label}</div>
                  <div className="text-[10px] text-gray-600 font-mono">{item.path}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* User Management */}
      <SectionTitle id="users">{ko ? "사용자 관리" : "User Management"}</SectionTitle>
      <P>
        {ko
          ? "Admin > 사용자 메뉴에서 Cognito 사용자를 생성/수정/삭제할 수 있습니다. 사용자 생성 시 Cognito 계정, 초기 비밀번호 (Secrets Manager), Subdomain이 자동 할당됩니다."
          : "Create/edit/delete Cognito users from Admin > Users. User creation auto-provisions Cognito account, initial password (Secrets Manager), and subdomain."}
      </P>

      <div className="rounded-xl bg-[#0d1117] border border-white/5 p-5 mb-4">
        <h3 className="text-sm font-bold text-white mb-3">{ko ? "사용자 생성 필드" : "User Creation Fields"}</h3>
        <div className="space-y-2">
          {[
            { field: ko ? "이메일" : "Email", desc: ko ? "Cognito 사용자 ID + 로그인 ID" : "Cognito user ID + login ID", required: true },
            { field: ko ? "서브도메인" : "Subdomain", desc: ko ? "이메일에서 자동 파생. 수동 오버라이드 가능." : "Auto-derived from email. Manual override possible.", required: true },
            { field: "OS", desc: "Ubuntu 24.04 / Amazon Linux 2023", required: true },
            { field: ko ? "리소스 등급" : "Resource Tier", desc: "Light (1vCPU/4GB) / Standard (2vCPU/8GB) / Power (4vCPU/12GB)", required: true },
            { field: ko ? "보안 정책" : "Security Policy", desc: "Open / Restricted / Locked", required: true },
            { field: ko ? "부서" : "Department", desc: ko ? "부서별 예산/사용량 추적용" : "For department budget/usage tracking", required: false },
          ].map((f) => (
            <div key={f.field} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-white/5 text-xs">
              <span className={`w-1.5 h-1.5 rounded-full ${f.required ? "bg-rose-400" : "bg-gray-600"} shrink-0`} />
              <span className="font-bold text-white w-24 shrink-0">{f.field}</span>
              <span className="text-gray-500">{f.desc}</span>
            </div>
          ))}
        </div>
      </div>

      <CodeBlock title={ko ? "CLI로 사용자 생성 (대안)" : "CLI User Creation (Alternative)"}>{`USER_POOL_ID=$(aws cognito-idp list-user-pools --max-results 10 \\
  --query "UserPools[?contains(Name, 'cc-on-bedrock')].Id" --output text)

aws cognito-idp admin-create-user \\
  --user-pool-id "$USER_POOL_ID" \\
  --username alice@company.com \\
  --user-attributes \\
    Name=email,Value=alice@company.com \\
    Name=email_verified,Value=true \\
    Name=custom:subdomain,Value=alice \\
    Name=custom:container_os,Value=ubuntu \\
    Name=custom:resource_tier,Value=standard \\
    Name=custom:security_policy,Value=restricted \\
    Name=custom:department,Value=engineering \\
  --temporary-password 'TempPass123!'`}</CodeBlock>

      {/* Instance Management */}
      <SectionTitle id="instances">{ko ? "인스턴스 관리" : "Instance Management"}</SectionTitle>
      <P>
        {ko
          ? "Admin > 인스턴스 메뉴에서 모든 사용자의 EC2 인스턴스 상태를 확인하고, 시작/중지/관리할 수 있습니다."
          : "View, start, stop, and manage all user EC2 instances from Admin > Instances."}
      </P>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <div className="rounded-xl bg-[#0d1117] border border-white/5 p-4">
          <h4 className="text-xs font-bold text-white mb-2">{ko ? "인스턴스 상태" : "Instance States"}</h4>
          <div className="space-y-1.5">
            {[
              { state: "Running", color: "bg-emerald-400", desc: ko ? "실행 중 (비용 발생)" : "Active (incurring cost)" },
              { state: "Stopped", color: "bg-gray-500", desc: ko ? "중지됨 (EBS만 비용)" : "Stopped (EBS cost only)" },
              { state: "Pending", color: "bg-amber-400", desc: ko ? "시작 중..." : "Starting..." },
              { state: "Not Created", color: "bg-gray-700", desc: ko ? "미생성 (첫 시작 대기)" : "Not yet created" },
            ].map((s) => (
              <div key={s.state} className="flex items-center gap-2 text-xs">
                <span className={`w-2 h-2 rounded-full ${s.color}`} />
                <span className="font-bold text-white w-24">{s.state}</span>
                <span className="text-gray-500">{s.desc}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-xl bg-[#0d1117] border border-white/5 p-4">
          <h4 className="text-xs font-bold text-white mb-2">{ko ? "관리 작업" : "Admin Actions"}</h4>
          <div className="space-y-1.5 text-xs text-gray-400">
            <div>{ko ? "개별/일괄 인스턴스 시작" : "Start instances (individual/batch)"}</div>
            <div>{ko ? "개별/일괄 인스턴스 중지" : "Stop instances (individual/batch)"}</div>
            <div>{ko ? "보안 정책 즉시 변경 (SG swap)" : "Change security policy instantly (SG swap)"}</div>
            <div>{ko ? "리소스 등급 변경 (재시작 필요)" : "Change resource tier (restart required)"}</div>
            <div>{ko ? "사용자 환경 초기화 (soft-delete)" : "Reset user environment (soft-delete)"}</div>
          </div>
        </div>
      </div>

      {/* Budget Management */}
      <SectionTitle id="budgets">{ko ? "예산 관리" : "Budget Management"}</SectionTitle>
      <P>
        {ko
          ? "부서별 월간 예산을 설정하고, 초과 시 자동으로 Bedrock 접근을 차단합니다. 80% 도달 시 SNS 경고, 100% 도달 시 IAM Deny Policy 자동 부착."
          : "Set monthly budgets per department. Auto-blocks Bedrock access on overrun. SNS alert at 80%, IAM Deny Policy at 100%."}
      </P>

      <CodeBlock title={ko ? "예산 집행 흐름" : "Budget Enforcement Flow"}>{`Lambda (budget-check, every 5 min)
 ├─▶ Scan DynamoDB cc-on-bedrock-usage (per dept, current month)
 ├─▶ Read DynamoDB cc-department-budgets (limits)
 ├─▶ Compare usage vs limit
 │    ├─ < 80%  → OK (no action)
 │    ├─ >= 80% → SNS alert to dept-manager + admin
 │    └─ >= 100% → IAM Deny Policy on all dept users' roles
 └─▶ Update DynamoDB status`}</CodeBlock>

      <div className="rounded-xl bg-[#0d1117] border border-amber-500/20 p-4 mb-4">
        <div className="flex items-center gap-2 mb-2">
          <AlertTriangle className="w-4 h-4 text-amber-400" />
          <span className="text-sm font-bold text-white">{ko ? "주의사항" : "Important Notes"}</span>
        </div>
        <ul className="space-y-1 text-xs text-gray-400">
          <li>{ko ? "예산 초과로 차단된 사용자는 다음 달 또는 예산 증액 시 자동 복구됩니다." : "Users blocked due to budget overrun are auto-restored next month or when budget is increased."}</li>
          <li>{ko ? "개별 사용자의 일일 한도도 별도 설정 가능합니다." : "Individual user daily limits can also be configured separately."}</li>
          <li>{ko ? "예산은 Bedrock API 비용만 추적합니다 (EC2 인프라 비용 제외)." : "Budget tracks Bedrock API cost only (excludes EC2 infra cost)."}</li>
        </ul>
      </div>

      {/* Approval Workflow */}
      <SectionTitle id="approvals">{ko ? "승인 워크플로우" : "Approval Workflow"}</SectionTitle>
      <P>
        {ko
          ? "사용자의 리소스 등급 변경, 보안 정책 변경, IAM 권한 확장 요청을 관리자가 승인/거부합니다."
          : "Admin approves or rejects user requests for tier changes, security policy changes, and IAM permission extensions."}
      </P>

      <div className="rounded-xl bg-[#0d1117] border border-white/5 p-5 mb-4">
        <h3 className="text-sm font-bold text-white mb-3">{ko ? "승인 가능 유형" : "Approval Request Types"}</h3>
        <div className="space-y-3">
          {[
            {
              type: "tier_change",
              label: ko ? "리소스 등급 변경" : "Resource Tier Change",
              action: ko ? "Cognito attribute + EC2 instance type 변경" : "Update Cognito attribute + EC2 instance type",
              color: "border-blue-500/20",
            },
            {
              type: "dlp_change",
              label: ko ? "보안 정책 변경" : "Security Policy Change",
              action: ko ? "Cognito attribute + Security Group 즉시 교체" : "Update Cognito attribute + immediate SG swap",
              color: "border-amber-500/20",
            },
            {
              type: "iam_extension",
              label: ko ? "IAM 권한 확장" : "IAM Permission Extension",
              action: ko ? "사전 정의 Policy Set → per-user role에 부착 (기간 선택)" : "Pre-defined Policy Set → attach to per-user role (with expiry)",
              color: "border-rose-500/20",
            },
          ].map((req) => (
            <div key={req.type} className={`rounded-lg border ${req.color} bg-white/[0.02] p-3`}>
              <div className="flex items-center gap-2 mb-1">
                <code className="text-[10px] text-gray-500 font-mono bg-white/5 px-1.5 py-0.5 rounded">{req.type}</code>
                <span className="text-xs font-bold text-white">{req.label}</span>
              </div>
              <div className="text-[11px] text-gray-500">{ko ? "승인 시: " : "On approve: "}{req.action}</div>
            </div>
          ))}
        </div>
      </div>

      <CodeBlock title={ko ? "승인 API" : "Approval API"}>{`# List pending requests
GET /api/admin/approval-requests?status=pending

# Approve a request
PUT /api/admin/approval-requests
{
  "requestId": "req_abc123",
  "action": "approve"
}

# Reject with reason
PUT /api/admin/approval-requests
{
  "requestId": "req_abc123",
  "action": "reject",
  "reason": "Budget constraint for this quarter"
}`}</CodeBlock>

      {/* Monitoring */}
      <SectionTitle id="monitoring">{ko ? "운영 모니터링" : "Operations Monitoring"}</SectionTitle>
      <P>
        {ko
          ? "모니터링 페이지에서 Bedrock API 상태, ECS 클러스터, 활성 세션, 리소스 사용률을 확인합니다."
          : "The monitoring page shows Bedrock API status, ECS cluster health, active sessions, and resource utilization."}
      </P>

      <div className="grid grid-cols-2 gap-3 mb-4">
        {[
          { label: ko ? "Bedrock API" : "Bedrock API", desc: ko ? "모델 가용성, 응답 시간" : "Model availability, response time" },
          { label: ko ? "사용량 추적" : "Usage Tracking", desc: ko ? "DynamoDB 상태, Lambda 실행" : "DynamoDB status, Lambda execution" },
          { label: ko ? "인스턴스 현황" : "Instance Status", desc: ko ? "Running/Stopped 분포, OS/Tier 통계" : "Running/Stopped distribution, OS/Tier stats" },
          { label: ko ? "활성 세션" : "Active Sessions", desc: ko ? "실시간 접속 사용자, CPU/메모리" : "Real-time connected users, CPU/Memory" },
        ].map((item) => (
          <div key={item.label} className="rounded-xl bg-[#0d1117] border border-white/5 p-3">
            <div className="text-xs font-bold text-white mb-1">{item.label}</div>
            <div className="text-[11px] text-gray-500">{item.desc}</div>
          </div>
        ))}
      </div>

      {/* Troubleshooting */}
      <SectionTitle id="troubleshooting">{ko ? "문제 해결" : "Troubleshooting"}</SectionTitle>
      <div className="space-y-3">
        {[
          {
            symptom: ko ? "인스턴스 시작 실패" : "Instance Start Failure",
            causes: ko
              ? ["AMI를 찾을 수 없음 → SSM Parameter /cc-on-bedrock/devenv/ami-id 확인", "EC2 한도 초과 → Service Quotas 확인", "IAM 권한 부족 → Task Role/Instance Profile 확인"]
              : ["AMI not found → Check SSM Parameter /cc-on-bedrock/devenv/ami-id", "EC2 quota exceeded → Check Service Quotas", "Insufficient IAM → Check Task Role/Instance Profile"],
          },
          {
            symptom: ko ? "code-server 접속 불가 (502/503)" : "Cannot Access code-server (502/503)",
            causes: ko
              ? ["code-server가 아직 부팅 중 → 30초 후 재시도", "Nginx 라우팅 미등록 → cc-routing-table 확인", "보안 그룹 차단 → DLP 정책/SG 확인"]
              : ["code-server still booting → retry in 30 seconds", "Nginx route not registered → check cc-routing-table", "Security group blocking → check DLP policy/SG"],
          },
          {
            symptom: ko ? "CloudFront 403 에러" : "CloudFront 403 Error",
            causes: ko
              ? ["X-Custom-Secret 불일치 → Secrets Manager 값 확인", "Cognito 인증 실패 → Lambda@Edge 로그 확인 (us-east-1)", "WAF 차단 → WAF WebACL 규칙 확인"]
              : ["X-Custom-Secret mismatch → check Secrets Manager", "Cognito auth failure → check Lambda@Edge logs (us-east-1)", "WAF blocked → check WAF WebACL rules"],
          },
        ].map((issue) => (
          <div key={issue.symptom} className="rounded-xl bg-[#0d1117] border border-white/5 p-4">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-4 h-4 text-amber-400" />
              <span className="text-sm font-bold text-white">{issue.symptom}</span>
            </div>
            <ul className="space-y-1 text-xs text-gray-400 pl-6">
              {issue.causes.map((c, i) => (
                <li key={i} className="list-disc">{c}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
