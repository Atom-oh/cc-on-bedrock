"use client";

import { useI18n } from "@/lib/i18n";
import { HelpCircle, ChevronDown } from "lucide-react";
import { useState } from "react";

function FaqItem({ q, a, defaultOpen }: { q: string; a: string | React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? false);

  return (
    <div className="rounded-xl bg-[#0d1117] border border-white/5 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-white/[0.02] transition-colors"
      >
        <span className="w-6 h-6 rounded-md bg-teal-500/10 border border-teal-500/20 flex items-center justify-center shrink-0">
          <HelpCircle className="w-3.5 h-3.5 text-teal-400" />
        </span>
        <span className="text-sm font-bold text-white flex-1">{q}</span>
        <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="px-5 pb-4 pl-14">
          <div className="text-sm text-gray-400 leading-relaxed">{a}</div>
        </div>
      )}
    </div>
  );
}

function FaqSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-8">
      <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
        <span className="w-1 h-5 bg-teal-500 rounded-full" />
        {title}
      </h2>
      <div className="space-y-2">
        {children}
      </div>
    </div>
  );
}

export default function FaqPage() {
  const { locale } = useI18n();
  const ko = locale === "ko";

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-teal-500 to-cyan-500 flex items-center justify-center">
            <HelpCircle className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-black text-white">
              {ko ? "자주 묻는 질문" : "FAQ"}
            </h1>
            <p className="text-sm text-gray-500">
              {ko ? "일반적인 질문과 답변" : "Common questions and answers"}
            </p>
          </div>
        </div>
      </div>

      {/* Storage & Data */}
      <FaqSection title={ko ? "스토리지 & 데이터" : "Storage & Data"}>
        <FaqItem
          q={ko ? "인스턴스를 중지하면 데이터가 사라지나요?" : "Will I lose data when my instance stops?"}
          a={ko
            ? "아니요. EC2 인스턴스의 EBS Root Volume은 Stop 시 자동으로 보존됩니다. apt, npm -g, pip으로 설치한 패키지를 포함한 모든 시스템 상태가 완벽 보존됩니다. 재시작 시 30~75초 안에 이전 상태로 복원됩니다."
            : "No. The EC2 instance's EBS Root Volume is automatically preserved on Stop. All system state, including packages installed via apt, npm -g, and pip, is fully preserved. Restarts restore previous state within 30-75 seconds."}
          defaultOpen
        />
        <FaqItem
          q={ko ? "디스크 용량이 부족하면 어떻게 하나요?" : "What if I run out of disk space?"}
          a={ko
            ? "'내 환경 > 스토리지' 탭에서 EBS 확장을 신청할 수 있습니다. AI Resource Review가 사용량 패턴을 분석하여 적절한 크기를 추천하고, 관리자 승인 후 온라인으로 확장됩니다 (재시작 불필요)."
            : "Request EBS expansion from 'My Environment > Storage' tab. AI Resource Review analyzes usage patterns to recommend appropriate size. After admin approval, expansion happens online (no restart needed)."}
        />
        <FaqItem
          q={ko ? "AZ 장애 시 데이터는 어떻게 되나요?" : "What happens to data during AZ failure?"}
          a={ko
            ? "관리자가 장애 AZ의 EBS에서 Snapshot을 생성하고, 다른 AZ에서 새 인스턴스를 만든 후 Snapshot에서 복구합니다. 일반 사용자는 별도 조치가 필요 없습니다."
            : "Admin creates a Snapshot from the failed AZ's EBS, creates a new instance in another AZ, and restores from the Snapshot. Regular users don't need to take any action."}
        />
      </FaqSection>

      {/* Development Environment */}
      <FaqSection title={ko ? "개발 환경" : "Development Environment"}>
        <FaqItem
          q={ko ? "Claude Code API 키를 설정해야 하나요?" : "Do I need to set up a Claude Code API key?"}
          a={ko
            ? "아니요. CLAUDE_CODE_USE_BEDROCK=1이 사전 설정되어 있어 Claude Code가 EC2 Instance Profile을 통해 Bedrock에 자동 인증합니다. 별도 API 키 없이 즉시 사용 가능합니다."
            : "No. CLAUDE_CODE_USE_BEDROCK=1 is pre-configured, so Claude Code authenticates to Bedrock via EC2 Instance Profile. Ready to use immediately without any API key setup."}
        />
        <FaqItem
          q={ko ? "어떤 모델을 사용할 수 있나요?" : "What models are available?"}
          a={ko
            ? "Claude Opus 4.6 (최고 성능)과 Claude Sonnet 4.6 (빠른 응답)을 사용할 수 있습니다. 모델 선택은 Claude Code/Kiro 내에서 자유롭게 전환 가능합니다."
            : "Claude Opus 4.6 (highest performance) and Claude Sonnet 4.6 (fast response). You can freely switch between models within Claude Code/Kiro."}
        />
        <FaqItem
          q={ko ? "비밀번호는 어디서 확인하나요?" : "Where can I find my password?"}
          a={ko
            ? "'내 환경 > 설정' 탭에서 code-server 비밀번호를 확인할 수 있습니다. 비밀번호 변경도 같은 페이지에서 가능합니다."
            : "Check your code-server password in 'My Environment > Settings' tab. You can also change your password from the same page."}
        />
        <FaqItem
          q={ko ? "VS Code Extension을 설치할 수 있나요?" : "Can I install VS Code extensions?"}
          a={ko
            ? "보안 정책에 따라 다릅니다. Open: 자유 설치, Restricted: 사전 승인된 Extension만, Locked: 설치 불가. 현재 보안 정책은 '내 환경'에서 확인할 수 있습니다."
            : "Depends on your security policy. Open: free install, Restricted: pre-approved only, Locked: no install. Check your current policy in 'My Environment'."}
        />
        <FaqItem
          q={ko ? "인스턴스 타입을 변경할 수 있나요?" : "Can I change my instance type?"}
          a={ko
            ? "'내 환경'에서 리소스 등급 변경을 신청할 수 있습니다 (Light/Standard/Power). 관리자 승인 후 변경되며, 인스턴스 재시작이 필요합니다."
            : "Request a tier change (Light/Standard/Power) from 'My Environment'. Requires admin approval and instance restart."}
        />
      </FaqSection>

      {/* Architecture */}
      <FaqSection title={ko ? "아키텍처" : "Architecture"}>
        <FaqItem
          q={ko ? "왜 ECS가 아닌 EC2-per-user인가요?" : "Why EC2-per-user instead of ECS?"}
          a={ko
            ? "EC2 Stop/Start가 EBS volume을 자동 보존하기 때문입니다. ECS에서는 컨테이너 종료 시 Snapshot 생성/복원, S3 sync 등 복잡한 데이터 보존 로직이 필요했지만, EC2에서는 단순히 StopInstances만 호출하면 됩니다. 관련 Lambda 코드가 1,200줄에서 220줄로 줄었습니다. ADR-004 참조."
            : "Because EC2 Stop/Start automatically preserves EBS volumes. With ECS, container termination required complex data preservation (snapshots, S3 sync), but EC2 only needs StopInstances. Related Lambda code reduced from 1,200 to 220 lines. See ADR-004."}
        />
        <FaqItem
          q={ko ? "Nginx 동적 라우팅은 어떻게 작동하나요?" : "How does Nginx dynamic routing work?"}
          a={ko
            ? "DynamoDB cc-routing-table에 {subdomain → privateIp:port} 매핑을 저장합니다. 테이블 변경 시 DynamoDB Streams → Lambda가 nginx.conf를 재생성하여 S3에 업로드하고, Nginx 컨테이너가 30초마다 pull합니다. ALB의 100개 규칙 제한 없이 4,000+ 사용자를 지원합니다. ADR-002 참조."
            : "DynamoDB cc-routing-table stores {subdomain → privateIp:port} mappings. On changes, DynamoDB Streams → Lambda regenerates nginx.conf to S3, Nginx containers pull every 30s. Supports 4,000+ users without ALB's 100-rule limit. See ADR-002."}
        />
        <FaqItem
          q={ko ? "3가지 IaC 도구 중 어떤 것을 사용해야 하나요?" : "Which of the 3 IaC tools should I use?"}
          a={ko
            ? "CDK를 권장합니다. CDK는 TypeScript 타입 안전성, L2 Construct의 편의성, 스택 의존성 자동 관리를 제공합니다. Terraform은 멀티 클라우드 환경에서, CloudFormation은 AWS 네이티브 환경에서 선택하세요. 3가지 모두 동일한 아키텍처를 배포합니다."
            : "CDK is recommended. It provides TypeScript type safety, L2 Construct convenience, and automatic stack dependency management. Use Terraform for multi-cloud, CloudFormation for AWS-native environments. All three deploy the same architecture."}
        />
      </FaqSection>

      {/* Cost */}
      <FaqSection title={ko ? "비용" : "Cost"}>
        <FaqItem
          q={ko ? "월간 예상 비용은 얼마인가요?" : "What is the estimated monthly cost?"}
          a={ko
            ? "100명 사용자 기준 인프라 비용 약 $500-700/월 (VPC Endpoint $102, NAT Gateway $90, EC2 인스턴스, EBS). Bedrock API 비용은 사용량에 따라 별도. 유휴 자동 중지(45분)로 EC2 비용을 최적화합니다."
            : "~$500-700/month for 100 users (VPC Endpoints $102, NAT Gateway $90, EC2 instances, EBS). Bedrock API cost is usage-based. Idle auto-stop (45min) optimizes EC2 costs."}
        />
        <FaqItem
          q={ko ? "예산 초과 시 어떻게 되나요?" : "What happens when budget is exceeded?"}
          a={ko
            ? "80% 도달 시 부서 관리자+관리자에게 SNS 알림이 발송됩니다. 100% 도달 시 해당 부서 전체 사용자의 Bedrock 접근이 IAM Deny Policy로 자동 차단됩니다. 다음 달 또는 예산 증액 시 자동 복구됩니다."
            : "SNS alert to dept-manager + admin at 80%. Auto-block Bedrock access via IAM Deny Policy at 100% for all department users. Auto-restored next month or when budget is increased."}
        />
        <FaqItem
          q={ko ? "인스턴스가 중지되면 비용이 발생하나요?" : "Does a stopped instance incur costs?"}
          a={ko
            ? "중지된 EC2 인스턴스의 컴퓨팅 비용은 $0입니다. EBS 볼륨 비용만 발생합니다 (30GB gp3 = ~$2.4/월). 유휴 자동 중지와 야간 일괄 중지로 비용을 최소화합니다."
            : "Compute cost for stopped EC2 instances is $0. Only EBS volume cost applies (30GB gp3 ≈ $2.4/month). Idle auto-stop and EOD batch stop minimize costs."}
        />
      </FaqSection>

      {/* Security */}
      <FaqSection title={ko ? "보안" : "Security"}>
        <FaqItem
          q={ko ? "다른 사용자의 환경에 접근할 수 있나요?" : "Can I access another user's environment?"}
          a={ko
            ? "불가능합니다. 3중 인증으로 보호됩니다: (1) Lambda@Edge가 Cognito ID token의 subdomain claim을 확인, (2) Nginx가 X-Auth-User == 서브도메인을 검증, (3) code-server 비밀번호. alice의 쿠키로 bob.dev.atomai.click에 접근하면 403 Forbidden을 받습니다."
            : "No. Protected by 3-layer auth: (1) Lambda@Edge verifies subdomain claim in Cognito ID token, (2) Nginx verifies X-Auth-User == subdomain, (3) code-server password. Accessing bob.dev.atomai.click with alice's cookie returns 403 Forbidden."}
        />
        <FaqItem
          q={ko ? "SSH로 접속할 수 있나요?" : "Can I SSH into my instance?"}
          a={ko
            ? "SSH(포트 22)는 비활성화되어 있습니다. 관리자는 AWS SSM Session Manager를 통해 접근할 수 있습니다. 일반 사용자는 code-server 웹 터미널을 사용합니다."
            : "SSH (port 22) is disabled. Admins can access via AWS SSM Session Manager. Regular users use the code-server web terminal."}
        />
        <FaqItem
          q={ko ? "보안 정책을 변경할 수 있나요?" : "Can I change my security policy?"}
          a={ko
            ? "'내 환경'에서 보안 정책 변경을 신청할 수 있습니다 (Open/Restricted/Locked). 관리자 승인이 필요하며, 실행 중인 인스턴스에서도 Security Group이 즉시 교체됩니다."
            : "Request a policy change (Open/Restricted/Locked) from 'My Environment'. Requires admin approval. Security Group is swapped immediately on running instances."}
        />
      </FaqSection>
    </div>
  );
}
