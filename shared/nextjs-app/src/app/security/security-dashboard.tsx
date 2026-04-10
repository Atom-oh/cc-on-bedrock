"use client";

import { useState, useEffect, useCallback } from "react";
import { useI18n } from "@/lib/i18n";
import FilterBar from "@/components/filter-bar";
import type { ApiResponse } from "@/lib/types";

interface FirewallRule {
  name: string;
  priority: number;
  action: string;
  blockResponse?: string;
  domainListId?: string;
}

interface RuleGroup {
  name: string;
  status: string;
  priority: number;
  ruleGroupId: string;
  rules: FirewallRule[];
}

interface IngressRule {
  protocol: string;
  fromPort: number | null;
  toPort: number | null;
  sources: string[];
  description: string;
}

interface EgressRule {
  protocol: string;
  fromPort: number | null;
  toPort: number | null;
  destinations: string[];
}

interface SecurityGroup {
  id: string;
  name: string;
  description: string;
  policy: string;
  ingressRules: IngressRule[];
  egressRules: EgressRule[];
}

interface SecurityData {
  dnsFirewall: {
    associations: { name: string; status: string; priority: number; ruleGroupId: string }[];
    ruleGroups: RuleGroup[];
  };
  securityGroups: SecurityGroup[];
}

interface UserSecurity {
  username: string;
  email: string;
  enabled: boolean;
  status: string;
  subdomain: string;
  securityPolicy: string;
  containerOs: string;
  resourceTier: string;
  hasContainer: boolean;
  createdAt: string;
}

interface AuditEvent {
  time: string;
  source: string;
  event: string;
  user: string;
  sourceIp: string;
  errorCode: string;
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[11px] font-semibold text-gray-400 uppercase tracking-[0.15em] mb-3">{children}</h2>
  );
}

function StatusBadge({ status, size = "sm" }: { status: string; size?: "sm" | "xs" }) {
  const isOk = ["COMPLETE", "READY", "ACTIVE", "ALLOW"].includes(status);
  const isBlock = status === "BLOCK";
  const color = isOk ? "bg-green-900/30 text-green-400" : isBlock ? "bg-red-900/30 text-red-400" : "bg-yellow-900/30 text-yellow-400";
  const dotColor = isOk ? "bg-green-400" : isBlock ? "bg-red-400" : "bg-yellow-400";
  const textSize = size === "xs" ? "text-[9px]" : "text-[10px]";
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full ${color} ${textSize} font-medium`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
      {status}
    </span>
  );
}

const DLP_DESCRIPTIONS: Record<string, { title: string; titleEn: string; desc: string; descEn: string; color: string; icon: string }> = {
  open: {
    title: "Open", titleEn: "Open",
    desc: "모든 아웃바운드 트래픽 허용. 개발/테스트 환경용.",
    descEn: "All outbound traffic allowed. For dev/test environments.",
    color: "border-green-500/30 bg-green-500/5", icon: "🟢",
  },
  restricted: {
    title: "Restricted", titleEn: "Restricted",
    desc: "화이트리스트 도메인만 허용. AWS, GitHub, npm, PyPI 등 개발 필수 도메인.",
    descEn: "Whitelisted domains only. AWS, GitHub, npm, PyPI and essential dev domains.",
    color: "border-yellow-500/30 bg-yellow-500/5", icon: "🟡",
  },
  locked: {
    title: "Locked", titleEn: "Locked",
    desc: "VPC 내부 통신만 허용. 최고 보안 환경.",
    descEn: "VPC internal only. Maximum security environment.",
    color: "border-red-500/30 bg-red-500/5", icon: "🔴",
  },
};

export default function SecurityDashboard() {
  const { t, locale } = useI18n();
  const [data, setData] = useState<SecurityData | null>(null);
  const [users, setUsers] = useState<UserSecurity[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [filterPolicy, setFilterPolicy] = useState("all");
  const [filterLogSource, setFilterLogSource] = useState("all");
  const [searchText, setSearchText] = useState("");

  const fetchData = useCallback(async () => {
    try {
      const [overviewRes, usersRes, logsRes] = await Promise.all([
        fetch("/api/security?action=overview"),
        fetch("/api/security?action=user_security"),
        fetch("/api/security?action=audit_logs&hours=24"),
      ]);
      if (overviewRes.ok) {
        const json = (await overviewRes.json()) as ApiResponse<SecurityData>;
        setData(json.data ?? null);
      }
      if (usersRes.ok) {
        const json = (await usersRes.json()) as ApiResponse<UserSecurity[]>;
        setUsers(json.data ?? []);
      }
      if (logsRes.ok) {
        const json = (await logsRes.json()) as ApiResponse<AuditEvent[]>;
        setAuditLogs(json.data ?? []);
      }
      setLastUpdated(new Date());
    } catch (err) {
      console.error("Security fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const isKo = locale === "ko";

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-sm text-gray-500">Loading security data...</div>
      </div>
    );
  }

  const activeAssociations = data?.dnsFirewall.associations.filter((a) => a.status === "COMPLETE") ?? [];
  const totalSGRules = data?.securityGroups.reduce((s, sg) => s + sg.ingressRules.length + sg.egressRules.length, 0) ?? 0;
  const totalFWRules = data?.dnsFirewall.ruleGroups.reduce((s, rg) => s + rg.rules.length, 0) ?? 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-red-500/10">
            <svg className="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">{isKo ? "보안 관리" : "Security Management"}</h1>
            <p className="text-[10px] text-gray-500">
              {isKo ? "DLP 정책, DNS Firewall, Security Groups" : "DLP Policies, DNS Firewall, Security Groups"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {lastUpdated && <span className="text-[10px] text-gray-600">Updated {lastUpdated.toLocaleTimeString()}</span>}
          <button onClick={() => void fetchData()} className="px-3 py-1.5 text-xs font-medium text-gray-300 bg-gray-800 border border-gray-700 rounded-lg hover:bg-gray-700 transition-colors">
            ↻ {isKo ? "새로고침" : "Refresh"}
          </button>
        </div>
      </div>

      {/* Overview Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-[#111827] rounded-xl border border-gray-800/50 p-5">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider">{isKo ? "DLP 정책" : "DLP Policies"}</p>
          <p className="text-2xl font-bold text-white mt-1">3</p>
          <p className="text-[10px] text-gray-600 mt-0.5">Open · Restricted · Locked</p>
        </div>
        <div className="bg-[#111827] rounded-xl border border-gray-800/50 p-5">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider">DNS Firewall</p>
          <p className="text-2xl font-bold text-green-400 mt-1">{activeAssociations.length}</p>
          <p className="text-[10px] text-gray-600 mt-0.5">{isKo ? "VPC에 적용된 규칙 그룹" : "Rule groups applied to VPC"}</p>
        </div>
        <div className="bg-[#111827] rounded-xl border border-gray-800/50 p-5">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider">{isKo ? "방화벽 규칙" : "Firewall Rules"}</p>
          <p className="text-2xl font-bold text-cyan-400 mt-1">{totalFWRules}</p>
          <p className="text-[10px] text-gray-600 mt-0.5">ALLOW + BLOCK</p>
        </div>
        <div className="bg-[#111827] rounded-xl border border-gray-800/50 p-5">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider">Security Groups</p>
          <p className="text-2xl font-bold text-purple-400 mt-1">{data?.securityGroups.length ?? 0}</p>
          <p className="text-[10px] text-gray-600 mt-0.5">{totalSGRules} {isKo ? "개 규칙" : "rules"}</p>
        </div>
      </div>

      {/* Filters */}
      <FilterBar
        searchPlaceholder={isKo ? "사용자, 이벤트 검색..." : "Search users, events..."}
        searchValue={searchText}
        onSearchChange={setSearchText}
        filters={[
          {
            key: "policy",
            label: isKo ? "보안 정책" : "Policy",
            value: filterPolicy,
            onChange: setFilterPolicy,
            options: [
              { value: "all", label: isKo ? "전체" : "All", count: users.length },
              { value: "open", label: "🟢 Open", count: users.filter((u) => u.securityPolicy === "open").length },
              { value: "restricted", label: "🟡 Restricted", count: users.filter((u) => u.securityPolicy === "restricted").length },
              { value: "locked", label: "🔴 Locked", count: users.filter((u) => u.securityPolicy === "locked").length },
            ],
          },
          {
            key: "logSource",
            label: isKo ? "로그 서비스" : "Log Source",
            value: filterLogSource,
            onChange: setFilterLogSource,
            options: [
              { value: "all", label: isKo ? "전체" : "All", count: auditLogs.length },
              { value: "Bedrock", label: "Bedrock", count: auditLogs.filter((l) => l.source === "Bedrock").length },
              { value: "Cognito", label: "Cognito", count: auditLogs.filter((l) => l.source === "Cognito").length },
              { value: "EC2", label: "EC2", count: auditLogs.filter((l) => l.source === "EC2").length },
            ],
          },
        ]}
      />

      {/* DLP Policies Overview */}
      <div>
        <SectionHeader>{isKo ? "DLP (DATA LOSS PREVENTION) 정책" : "DLP (DATA LOSS PREVENTION) POLICIES"}</SectionHeader>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {Object.entries(DLP_DESCRIPTIONS).map(([key, dlp]) => (
            <div key={key} className={`rounded-xl border ${dlp.color} p-5`}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-lg">{dlp.icon}</span>
                <h3 className="text-sm font-bold text-gray-100">{dlp.title}</h3>
              </div>
              <p className="text-xs text-gray-400 leading-relaxed">{isKo ? dlp.desc : dlp.descEn}</p>
              <div className="mt-3 pt-3 border-t border-gray-800/50">
                <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1.5">{isKo ? "적용 범위" : "Scope"}</p>
                <div className="flex flex-wrap gap-1">
                  <span className="px-1.5 py-0.5 text-[9px] bg-gray-800 text-gray-400 rounded">Security Group</span>
                  <span className="px-1.5 py-0.5 text-[9px] bg-gray-800 text-gray-400 rounded">DNS Firewall</span>
                  <span className="px-1.5 py-0.5 text-[9px] bg-gray-800 text-gray-400 rounded">code-server flags</span>
                  {key !== "open" && <span className="px-1.5 py-0.5 text-[9px] bg-gray-800 text-gray-400 rounded">Extension control</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 4-Layer DLP Architecture */}
      <div>
        <SectionHeader>{isKo ? "4-LAYER DLP 아키텍처" : "4-LAYER DLP ARCHITECTURE"}</SectionHeader>
        <div className="bg-[#111827] rounded-xl border border-gray-800/50 p-5">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            {[
              { layer: "Layer 1", name: "code-server Flags", desc: isKo ? "확장 마켓플레이스 비활성화, 터미널 제한" : "Extension marketplace disabled, terminal restrictions", status: "ACTIVE", color: "text-blue-400" },
              { layer: "Layer 2", name: "Security Groups", desc: isKo ? "네트워크 레벨 아웃바운드 제어" : "Network-level outbound control", status: "ACTIVE", color: "text-green-400" },
              { layer: "Layer 3", name: "DNS Firewall", desc: isKo ? "도메인 레벨 화이트리스트/블랙리스트" : "Domain-level whitelist/blacklist", status: "ACTIVE", color: "text-cyan-400" },
              { layer: "Layer 4", name: "Extension Control", desc: isKo ? "VS Code 확장 설치 제한" : "VS Code extension installation restrictions", status: "PARTIAL", color: "text-yellow-400" },
            ].map((layer) => (
              <div key={layer.layer} className="bg-[#0a0f1a] rounded-lg p-4 border border-gray-800/30">
                <p className="text-[9px] text-gray-600 uppercase">{layer.layer}</p>
                <p className={`text-sm font-semibold ${layer.color} mt-1`}>{layer.name}</p>
                <p className="text-[10px] text-gray-500 mt-1 leading-relaxed">{layer.desc}</p>
                <div className="mt-2">
                  <StatusBadge status={layer.status} size="xs" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* DNS Firewall Rules */}
      {data?.dnsFirewall.ruleGroups && data.dnsFirewall.ruleGroups.length > 0 && (
        <div>
          <SectionHeader>DNS FIREWALL {isKo ? "규칙" : "RULES"}</SectionHeader>
          {data.dnsFirewall.ruleGroups.map((rg) => (
            <div key={rg.ruleGroupId} className="bg-[#111827] rounded-xl border border-gray-800/50 overflow-hidden mb-4">
              <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <svg className="w-4 h-4 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                  <span className="text-sm font-medium text-gray-200">{rg.name}</span>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={rg.status} />
                  <span className="text-[10px] text-gray-600">Priority: {rg.priority}</span>
                </div>
              </div>
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-800 bg-[#0a0f1a]">
                    <th className="px-5 py-2 text-left text-[10px] font-medium text-gray-500 uppercase">Priority</th>
                    <th className="px-5 py-2 text-left text-[10px] font-medium text-gray-500 uppercase">{isKo ? "규칙 이름" : "Rule Name"}</th>
                    <th className="px-5 py-2 text-left text-[10px] font-medium text-gray-500 uppercase">Action</th>
                    <th className="px-5 py-2 text-left text-[10px] font-medium text-gray-500 uppercase">{isKo ? "설명" : "Description"}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/50">
                  {rg.rules.sort((a, b) => a.priority - b.priority).map((rule) => (
                    <tr key={rule.name} className="hover:bg-gray-800/20 transition-colors">
                      <td className="px-5 py-2.5 text-sm text-gray-400">{rule.priority}</td>
                      <td className="px-5 py-2.5 text-sm text-gray-200 font-medium">{rule.name}</td>
                      <td className="px-5 py-2.5">
                        <StatusBadge status={rule.action} size="xs" />
                      </td>
                      <td className="px-5 py-2.5 text-[10px] text-gray-500">
                        {rule.action === "ALLOW"
                          ? (isKo ? "허용된 도메인 목록" : "Allowed domain list")
                          : rule.blockResponse === "NXDOMAIN"
                          ? "NXDOMAIN (DNS 응답 차단)"
                          : rule.blockResponse ?? ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {/* Security Groups */}
      {data?.securityGroups && data.securityGroups.length > 0 && (
        <div>
          <SectionHeader>SECURITY GROUPS (DLP)</SectionHeader>
          <div className="space-y-4">
            {data.securityGroups.map((sg) => {
              const dlp = DLP_DESCRIPTIONS[sg.policy];
              return (
                <div key={sg.id} className={`bg-[#111827] rounded-xl border ${dlp?.color ?? "border-gray-800/50"} overflow-hidden`}>
                  <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-sm">{dlp?.icon ?? "🔒"}</span>
                      <div>
                        <span className="text-sm font-semibold text-gray-200">{sg.policy.toUpperCase()}</span>
                        <span className="text-[10px] text-gray-500 ml-2">{sg.id}</span>
                      </div>
                    </div>
                    <span className="text-[10px] text-gray-600">{sg.description}</span>
                  </div>
                  <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-gray-800">
                    {/* Inbound */}
                    <div className="p-4">
                      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">
                        Inbound ({sg.ingressRules.length} {isKo ? "규칙" : "rules"})
                      </p>
                      {sg.ingressRules.length === 0 ? (
                        <p className="text-[10px] text-gray-600">{isKo ? "인바운드 규칙 없음" : "No inbound rules"}</p>
                      ) : (
                        <div className="space-y-1.5">
                          {sg.ingressRules.map((r, i) => (
                            <div key={i} className="flex items-center gap-2 text-[10px]">
                              <span className="text-green-400 font-medium w-6">✓</span>
                              <span className="text-gray-400 w-12">{r.protocol === "-1" ? "ALL" : `TCP/${r.fromPort}`}</span>
                              <span className="text-gray-300 flex-1 truncate">{r.sources.join(", ") || "None"}</span>
                              {r.description && <span className="text-gray-600 truncate max-w-[150px]">{r.description}</span>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    {/* Outbound */}
                    <div className="p-4">
                      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">
                        Outbound ({sg.egressRules.length} {isKo ? "규칙" : "rules"})
                      </p>
                      <div className="space-y-1.5">
                        {sg.egressRules.map((r, i) => (
                          <div key={i} className="flex items-center gap-2 text-[10px]">
                            <span className={`font-medium w-6 ${r.destinations.includes("0.0.0.0/0") ? "text-yellow-400" : "text-cyan-400"}`}>
                              {r.destinations.includes("0.0.0.0/0") ? "⚠" : "→"}
                            </span>
                            <span className="text-gray-400 w-12">{r.protocol === "-1" ? "ALL" : `TCP/${r.fromPort}`}</span>
                            <span className="text-gray-300 flex-1 truncate">{r.destinations.join(", ")}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Security Checklist */}
      <div>
        <SectionHeader>{isKo ? "보안 체크리스트" : "SECURITY CHECKLIST"}</SectionHeader>
        <div className="bg-[#111827] rounded-xl border border-gray-800/50 p-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {[
              { item: isKo ? "Cognito 사용자 인증" : "Cognito User Authentication", status: true, detail: "OAuth2 + OIDC" },
              { item: isKo ? "CloudFront HTTPS" : "CloudFront HTTPS", status: true, detail: "ACM *.whchoi.net" },
              { item: isKo ? "VPC Endpoints (Private Link)" : "VPC Endpoints (Private Link)", status: true, detail: "8 endpoints" },
              { item: isKo ? "KMS 암호화" : "KMS Encryption", status: true, detail: "EBS, Secrets Manager" },
              { item: isKo ? "Secrets Manager" : "Secrets Manager", status: true, detail: "NextAuth, CloudFront" },
              { item: "DNS Firewall", status: true, detail: isKo ? "Restricted 규칙 적용" : "Restricted rules applied" },
              { item: isKo ? "Security Groups (3-tier DLP)" : "Security Groups (3-tier DLP)", status: true, detail: "Open/Restricted/Locked" },
              { item: "SSM Session Manager", status: true, detail: isKo ? "SSH 비활성, SSM만 허용" : "SSH disabled, SSM only" },
              { item: isKo ? "EBS 볼륨 암호화" : "EBS Volume Encryption", status: true, detail: "KMS encrypted" },
              { item: isKo ? "IMDSv2 강제" : "IMDSv2 Enforced", status: true, detail: "AL2023 default" },
              { item: isKo ? "IAM 기반 사용량 제어" : "IAM-based Usage Control", status: true, detail: isKo ? "사용자별 Task Role" : "Per-user Task Role" },
              { item: isKo ? "DynamoDB 사용량 추적" : "DynamoDB Usage Tracking", status: true, detail: "CloudTrail → Lambda → DDB" },
            ].map((check) => (
              <div key={check.item} className="flex items-center gap-3 py-1.5">
                <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${check.status ? "bg-green-900/30 text-green-400" : "bg-red-900/30 text-red-400"}`}>
                  {check.status ? "✓" : "✗"}
                </span>
                <div className="flex-1 min-w-0">
                  <span className="text-xs text-gray-300">{check.item}</span>
                  <span className="text-[10px] text-gray-600 ml-2">{check.detail}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      {/* User Security Status */}
      {users.length > 0 && (
        <div>
          <SectionHeader>{isKo ? "사용자별 보안 정책 현황" : "USER SECURITY POLICY STATUS"}</SectionHeader>
          <div className="bg-[#111827] rounded-xl border border-gray-800/50 overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-800 bg-[#0a0f1a]">
                  <th className="px-4 py-2.5 text-left text-[10px] font-medium text-gray-500 uppercase">{isKo ? "사용자" : "User"}</th>
                  <th className="px-4 py-2.5 text-left text-[10px] font-medium text-gray-500 uppercase">Subdomain</th>
                  <th className="px-4 py-2.5 text-center text-[10px] font-medium text-gray-500 uppercase">{isKo ? "보안 정책" : "DLP Policy"}</th>
                  <th className="px-4 py-2.5 text-center text-[10px] font-medium text-gray-500 uppercase">{isKo ? "계정 상태" : "Account"}</th>
                  <th className="px-4 py-2.5 text-center text-[10px] font-medium text-gray-500 uppercase">API Key</th>
                  <th className="px-4 py-2.5 text-center text-[10px] font-medium text-gray-500 uppercase">OS / Tier</th>
                  <th className="px-4 py-2.5 text-center text-[10px] font-medium text-gray-500 uppercase">{isKo ? "보안 등급" : "Risk Level"}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {users.filter((u) => {
                if (filterPolicy !== "all" && u.securityPolicy !== filterPolicy) return false;
                if (searchText && !u.email.toLowerCase().includes(searchText.toLowerCase()) && !u.subdomain.toLowerCase().includes(searchText.toLowerCase())) return false;
                return true;
              }).map((u) => {
                  const policyColor = u.securityPolicy === "locked" ? "bg-red-900/30 text-red-400" : u.securityPolicy === "restricted" ? "bg-yellow-900/30 text-yellow-400" : "bg-green-900/30 text-green-400";
                  const policyIcon = u.securityPolicy === "locked" ? "🔴" : u.securityPolicy === "restricted" ? "🟡" : "🟢";
                  const riskLevel = u.securityPolicy === "open" && u.hasContainer ? "MEDIUM" : u.securityPolicy === "locked" ? "LOW" : u.securityPolicy === "restricted" ? "LOW" : "MEDIUM";
                  const riskColor = riskLevel === "LOW" ? "text-green-400" : riskLevel === "MEDIUM" ? "text-yellow-400" : "text-red-400";
                  return (
                    <tr key={u.username} className="hover:bg-gray-800/20 transition-colors">
                      <td className="px-4 py-2.5">
                        <p className="text-sm text-gray-200">{u.email}</p>
                      </td>
                      <td className="px-4 py-2.5 text-sm text-gray-400">{u.subdomain}</td>
                      <td className="px-4 py-2.5 text-center">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${policyColor}`}>
                          {policyIcon} {u.securityPolicy}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${u.enabled ? "bg-green-900/30 text-green-400" : "bg-gray-800 text-gray-500"}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${u.enabled ? "bg-green-400" : "bg-gray-600"}`} />
                          {u.enabled ? (u.status === "CONFIRMED" ? "Active" : u.status) : "Disabled"}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <span className={`text-[10px] ${u.hasContainer ? "text-cyan-400" : "text-gray-600"}`}>
                          {u.hasContainer ? "✓ Issued" : "✗ None"}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <span className="text-[10px] text-gray-400">
                          {u.containerOs === "al2023" ? "AL2023" : "Ubuntu"} / {u.resourceTier}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <span className={`text-[10px] font-bold ${riskColor}`}>{riskLevel}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* Policy distribution summary */}
          <div className="mt-3 flex gap-4">
            {["open", "restricted", "locked"].map((policy) => {
              const count = users.filter((u) => u.securityPolicy === policy).length;
              const color = policy === "locked" ? "text-red-400" : policy === "restricted" ? "text-yellow-400" : "text-green-400";
              return (
                <div key={policy} className="flex items-center gap-2">
                  <span className={`text-lg font-bold ${color}`}>{count}</span>
                  <span className="text-[10px] text-gray-500 capitalize">{policy}</span>
                </div>
              );
            })}
            <span className="text-gray-700 mx-1">|</span>
            <span className="text-[10px] text-gray-500">{users.filter((u) => u.enabled).length}/{users.length} {isKo ? "활성" : "active"}</span>
          </div>
        </div>
      )}

      {/* Audit Logs */}
      {auditLogs.length > 0 && (
        <div>
          <SectionHeader>{isKo ? "보안 감사 로그 (최근 24시간)" : "SECURITY AUDIT LOGS (LAST 24H)"}</SectionHeader>
          <div className="bg-[#111827] rounded-xl border border-gray-800/50 overflow-hidden">
            {/* Log summary */}
            <div className="px-5 py-3 border-b border-gray-800 flex items-center gap-6">
              {["Bedrock", "Cognito", "EC2"].map((source) => {
                const count = auditLogs.filter((l) => l.source === source).length;
                const errors = auditLogs.filter((l) => l.source === source && l.errorCode).length;
                return (
                  <div key={source} className="flex items-center gap-2">
                    <span className="text-xs text-gray-300 font-medium">{source}</span>
                    <span className="text-[10px] text-gray-500">{count} events</span>
                    {errors > 0 && <span className="text-[10px] text-red-400">{errors} errors</span>}
                  </div>
                );
              })}
            </div>
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full">
                <thead className="sticky top-0">
                  <tr className="border-b border-gray-800 bg-[#0a0f1a]">
                    <th className="px-4 py-2 text-left text-[10px] font-medium text-gray-500 uppercase">{isKo ? "시간" : "Time"}</th>
                    <th className="px-4 py-2 text-left text-[10px] font-medium text-gray-500 uppercase">{isKo ? "서비스" : "Service"}</th>
                    <th className="px-4 py-2 text-left text-[10px] font-medium text-gray-500 uppercase">{isKo ? "이벤트" : "Event"}</th>
                    <th className="px-4 py-2 text-left text-[10px] font-medium text-gray-500 uppercase">{isKo ? "주체" : "Principal"}</th>
                    <th className="px-4 py-2 text-left text-[10px] font-medium text-gray-500 uppercase">IP</th>
                    <th className="px-4 py-2 text-left text-[10px] font-medium text-gray-500 uppercase">{isKo ? "상태" : "Status"}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/30">
                  {auditLogs.filter((l) => {
                    if (filterLogSource !== "all" && l.source !== filterLogSource) return false;
                    if (searchText && !l.event.toLowerCase().includes(searchText.toLowerCase()) && !l.user.toLowerCase().includes(searchText.toLowerCase())) return false;
                    return true;
                  }).map((log, i) => {
                    const sourceColor = log.source === "Bedrock" ? "text-cyan-400 bg-cyan-900/20" : log.source === "Cognito" ? "text-purple-400 bg-purple-900/20" : "text-amber-400 bg-amber-900/20";
                    const hasError = !!log.errorCode;
                    return (
                      <tr key={i} className={`hover:bg-gray-800/20 transition-colors ${hasError ? "bg-red-900/5" : ""}`}>
                        <td className="px-4 py-2 text-[10px] text-gray-500 whitespace-nowrap">
                          {log.time ? new Date(log.time).toLocaleString(isKo ? "ko-KR" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "-"}
                        </td>
                        <td className="px-4 py-2">
                          <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${sourceColor}`}>{log.source}</span>
                        </td>
                        <td className="px-4 py-2 text-xs text-gray-300 font-mono">{log.event}</td>
                        <td className="px-4 py-2 text-[10px] text-gray-400 max-w-[200px] truncate" title={log.user}>{log.user || "-"}</td>
                        <td className="px-4 py-2 text-[10px] text-gray-500 font-mono">{log.sourceIp || "-"}</td>
                        <td className="px-4 py-2">
                          {hasError ? (
                            <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-red-900/30 text-red-400">{log.errorCode}</span>
                          ) : (
                            <span className="text-[10px] text-green-400">✓</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
