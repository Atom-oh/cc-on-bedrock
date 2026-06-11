"use client";

import { useLanguage } from "@/lib/i18n";
import { PageShell, H2, H3, P, Table, Callout, Code } from "@/components/doc/primitives";

export default function SecurityPage() {
  const { t } = useLanguage();
  return (
    <PageShell
      title={t("보안", "Security")}
      subtitle={t("기업 환경에서도 안전하게 사용할 수 있도록 설계된 7계층 보안 모델.", "A 7-layer security model designed for enterprise use.")}
      tags={[{ label: "DLP 3-tier", color: "red" }, { label: "Permission Boundary", color: "purple" }, { label: "Per-user IAM", color: "purple" }]}
    >
      <H2 id="layers">{t("1. 7계층 보안 모델", "1. 7-layer security model")}</H2>
      <Table
        columns={[
          { key: "l", label: t("계층", "Layer") },
          { key: "comp", label: t("구성 요소", "Component") },
          { key: "func", label: t("주요 보호 기능", "Protection") },
        ]}
        rows={[
          { l: "L1", comp: "CloudFront", func: "TLS 1.2+ · AWS Shield" },
          { l: "L2", comp: "ALB / NLB", func: t("CloudFront Prefix List + X-Custom-Secret 헤더 강제", "CloudFront prefix list + X-Custom-Secret header") },
          { l: "L3", comp: "Cognito", func: t("이메일/비밀번호 + 그룹 기반 (admin/user/dept-manager)", "Email/password + group-based (admin/user/dept-manager)") },
          { l: "L4", comp: "Security Groups", func: t("DLP 3단계: Open / Restricted / Locked", "DLP 3 tiers: Open / Restricted / Locked") },
          { l: "L5", comp: "VPC Endpoints", func: t("인터넷을 거치지 않는 내부 전송", "Private intra-AWS transit") },
          { l: "L6", comp: "DNS Firewall", func: t("AWS 위협 5개 리스트 + 사용자 정의 차단", "5 AWS Managed lists + custom blocks") },
          { l: "L7", comp: "IAM + DLP", func: t("Permission Boundary + Deny on overspend + 모델별 ACL", "Permission Boundary + Deny on overspend + per-model ACL") },
        ]}
      />

      <H2 id="dlp">{t("2. DLP 정책 (L4)", "2. DLP policies (L4)")}</H2>
      <Table
        columns={[
          { key: "p", label: t("정책", "Policy") },
          { key: "out", label: t("아웃바운드", "Outbound") },
          { key: "use", label: t("적합", "Use case") },
        ]}
        rows={[
          { p: "Open", out: t("전체 허용 (기본값)", "All (default)"), use: t("일반 개발자", "General developers") },
          { p: "Restricted", out: t("VPC 내부 + HTTPS(443)만", "VPC + HTTPS (443) only"), use: t("보안 민감 프로젝트", "Security-sensitive projects") },
          { p: "Locked", out: t("VPC 내부만 (인터넷 차단)", "VPC only (no internet)"), use: t("규제 환경, 금융", "Regulated / financial") },
        ]}
      />
      <P>
        {t(
          "추가로 code-server에서 --disable-file-downloads --disable-file-uploads 플래그로 파일 유출 방지 (Restricted/Locked).",
          "code-server is also launched with --disable-file-downloads --disable-file-uploads for Restricted/Locked."
        )}
      </P>

      <H2 id="iam">{t("3. IAM 격리 (L7)", "3. IAM isolation (L7)")}</H2>
      <Table
        columns={[
          { key: "mode", label: t("모드", "Mode") },
          { key: "role", label: t("Role", "Role") },
          { key: "via", label: t("발급 경로", "Issued via") },
        ]}
        rows={[
          { mode: "EC2 DevEnv", role: <Code>cc-on-bedrock-task-{"{subdomain}"}</Code>, via: t("Instance Profile (Dashboard가 RunInstances 직전 생성)", "Instance Profile (created before RunInstances)") },
          { mode: "Local Governance", role: <Code>cc-on-bedrock-local-user-{"{sub_short}"}</Code>, via: t("STS AssumeRole (STS Issuer Lambda)", "STS AssumeRole via STS Issuer Lambda") },
        ]}
      />
      <P>{t("두 role 모두:", "Both roles share:")}</P>
      <ul className="text-sm text-gray-400 space-y-1 list-disc pl-5 mb-4">
        <li>{t("Bedrock: wildcard Claude family ARN (신규 모델 즉시 사용)", "Bedrock: wildcard Claude family ARN (new models work immediately)")}</li>
        <li>{t("S3 / DynamoDB: 본인 데이터 경로만", "S3 / DynamoDB: own data paths only")}</li>
        <li>{t("CloudWatch: 로그 쓰기만", "CloudWatch: write-only")}</li>
        <li>Permission Boundary: <Code>cc-on-bedrock-task-boundary</Code> {t("강제 → 권한 확장 방지", "enforces — no privilege escalation")}</li>
      </ul>

      <Callout type="info" title={t("IAM 사전 프로비저닝", "IAM pre-provisioning")}>
        {t(
          "Cognito 사용자 가입 시 EventBridge 가 UserRoleProvisioner Lambda 를 트리거해 per-user role + Cognito custom attrs 사전 생성. 첫 로그인 시 IAM eventual consistency race 제거.",
          "EventBridge fires UserRoleProvisioner Lambda on Cognito user creation, pre-provisioning per-user role + custom attrs. Eliminates first-login IAM eventual-consistency race."
        )}
      </Callout>

      <Callout type="warn" title={t("Cognito 삭제 → 자동 cleanup", "Cognito deletion → auto cleanup")}>
        {t(
          "사용자 삭제 시 EventBridge 가 자동으로 IAM role + DDB entries + EC2 instance + Secrets 정리. Dashboard 는 IdP-safe degraded mode 로 유실 사용자 그래프를 보여줍니다.",
          "On user delete, EventBridge automatically cleans up IAM role + DDB entries + EC2 instance + Secrets. Dashboard renders an IdP-safe degraded view for orphaned data."
        )}
      </Callout>

      <H2 id="audit">{t("4. 감사 및 추적", "4. Audit & traceability")}</H2>
      <P>
        {t(
          "CloudTrail 로 모든 Bedrock 호출 및 인프라 변경 이력 저장. 대시보드의 /security 페이지에서 실시간 차단 내역 + 보안 체크리스트 확인.",
          "CloudTrail records every Bedrock call and infra change. Dashboard /security shows real-time block list + security checklist."
        )}
      </P>
    </PageShell>
  );
}
