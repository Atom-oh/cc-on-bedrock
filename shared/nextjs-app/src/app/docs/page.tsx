"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import {
  Layers,
  Rocket,
  User,
  Settings,
  Shield,
  HelpCircle,
  ArrowRight,
  Cloud,
  Terminal,
  BarChart3,
} from "lucide-react";

const sections = [
  {
    href: "/docs/architecture",
    icon: Layers,
    title: { ko: "아키텍처", en: "Architecture" },
    desc: {
      ko: "EC2-per-user 아키텍처, 7개 CDK 스택, 트래픽 흐름, 네트워크 구성을 상세히 설명합니다.",
      en: "EC2-per-user architecture, 7 CDK stacks, traffic flow, and network topology in detail.",
    },
    color: "from-blue-500 to-cyan-500",
  },
  {
    href: "/docs/getting-started",
    icon: Rocket,
    title: { ko: "시작하기", en: "Getting Started" },
    desc: {
      ko: "사전 요구사항부터 Docker 빌드, CDK/Terraform/CloudFormation 배포까지 단계별 가이드.",
      en: "Step-by-step from prerequisites, Docker build, to CDK/Terraform/CloudFormation deployment.",
    },
    color: "from-emerald-500 to-green-500",
  },
  {
    href: "/docs/user-guide",
    icon: User,
    title: { ko: "사용자 가이드", en: "User Guide" },
    desc: {
      ko: "로그인, 개발환경 시작/중지, code-server 사용, Claude Code/Kiro 활용법.",
      en: "Login, start/stop dev environment, code-server usage, Claude Code & Kiro workflow.",
    },
    color: "from-violet-500 to-purple-500",
  },
  {
    href: "/docs/admin-guide",
    icon: Settings,
    title: { ko: "관리자 가이드", en: "Admin Guide" },
    desc: {
      ko: "사용자 관리, 인스턴스 운영, 예산 설정, 승인 워크플로우, 모니터링.",
      en: "User management, instance ops, budget settings, approval workflows, monitoring.",
    },
    color: "from-orange-500 to-amber-500",
  },
  {
    href: "/docs/security",
    icon: Shield,
    title: { ko: "보안 아키텍처", en: "Security" },
    desc: {
      ko: "Cognito 인증, DLP 3-tier 정책, IAM Permission Boundary, Lambda@Edge, 네트워크 격리.",
      en: "Cognito auth, DLP 3-tier policies, IAM Permission Boundary, Lambda@Edge, network isolation.",
    },
    color: "from-rose-500 to-pink-500",
  },
  {
    href: "/docs/faq",
    icon: HelpCircle,
    title: { ko: "자주 묻는 질문", en: "FAQ" },
    desc: {
      ko: "스토리지, 프로비저닝, 비용, 아키텍처에 대한 일반적인 질문과 답변.",
      en: "Common questions about storage, provisioning, cost, and architecture.",
    },
    color: "from-teal-500 to-cyan-500",
  },
];

const highlights = [
  {
    icon: Cloud,
    value: "7",
    label: { ko: "CDK 스택", en: "CDK Stacks" },
  },
  {
    icon: Terminal,
    value: "4K+",
    label: { ko: "동시 사용자", en: "Concurrent Users" },
  },
  {
    icon: BarChart3,
    value: "3",
    label: { ko: "IaC 도구 지원", en: "IaC Tools Supported" },
  },
  {
    icon: Shield,
    value: "3-Tier",
    label: { ko: "DLP 보안 정책", en: "DLP Security" },
  },
];

export default function DocsPage() {
  const { locale } = useI18n();

  return (
    <div className="max-w-5xl mx-auto space-y-10">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-[#0d1117] to-[#161b22] border border-white/5 p-8 lg:p-12">
        <div className="absolute top-0 right-0 w-96 h-96 bg-primary-500/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
        <div className="relative">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary-500/10 border border-primary-500/20 text-primary-400 text-xs font-bold mb-4">
            <span className="w-1.5 h-1.5 rounded-full bg-primary-400 animate-pulse" />
            Enterprise v2
          </div>
          <h1 className="text-3xl lg:text-4xl font-black text-white tracking-tight mb-3">
            CC-on-Bedrock
          </h1>
          <p className="text-lg text-gray-400 max-w-2xl leading-relaxed">
            {locale === "ko"
              ? "AWS Bedrock 기반 멀티유저 Claude Code 개발환경 플랫폼. EC2-per-user 아키텍처로 4,000명 이상의 동시 사용자를 지원하며, 3가지 IaC 도구(CDK, Terraform, CloudFormation)로 배포할 수 있습니다."
              : "Multi-user Claude Code development environment platform on AWS Bedrock. EC2-per-user architecture supports 4,000+ concurrent users, deployable via CDK, Terraform, or CloudFormation."}
          </p>
        </div>

        {/* Highlights */}
        <div className="relative grid grid-cols-2 lg:grid-cols-4 gap-4 mt-8">
          {highlights.map((h) => {
            const Icon = h.icon;
            return (
              <div key={h.value} className="flex items-center gap-3 px-4 py-3 rounded-xl bg-white/5 border border-white/5">
                <Icon className="w-5 h-5 text-primary-400 shrink-0" />
                <div>
                  <div className="text-lg font-black text-white">{h.value}</div>
                  <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">
                    {h.label[locale]}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Section cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {sections.map((s) => {
          const Icon = s.icon;
          return (
            <Link key={s.href} href={s.href} className="group">
              <div className="h-full p-6 rounded-xl bg-[#0d1117] border border-white/5 hover:border-white/10 transition-all duration-300 hover:shadow-lg hover:shadow-primary-900/5">
                <div className="flex items-start gap-4">
                  <div className={`shrink-0 w-10 h-10 rounded-lg bg-gradient-to-br ${s.color} flex items-center justify-center shadow-lg`}>
                    <Icon className="w-5 h-5 text-white" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      <h3 className="text-base font-bold text-white group-hover:text-primary-400 transition-colors">
                        {s.title[locale]}
                      </h3>
                      <ArrowRight className="w-4 h-4 text-gray-600 group-hover:text-primary-400 group-hover:translate-x-1 transition-all" />
                    </div>
                    <p className="text-sm text-gray-500 leading-relaxed">
                      {s.desc[locale]}
                    </p>
                  </div>
                </div>
              </div>
            </Link>
          );
        })}
      </div>

      {/* Tech stack */}
      <div className="rounded-xl bg-[#0d1117] border border-white/5 p-6">
        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-4">
          {locale === "ko" ? "기술 스택" : "Tech Stack"}
        </h2>
        <div className="flex flex-wrap gap-2">
          {[
            "AWS CDK v2", "Terraform", "CloudFormation", "Next.js 14",
            "Tailwind CSS", "Amazon Cognito", "DynamoDB", "ECS (EC2)",
            "CloudFront", "Lambda@Edge", "Bedrock Opus 4.6", "Bedrock Sonnet 4.6",
            "code-server", "Claude Code", "Kiro", "EventBridge", "KMS",
            "Route 53", "ARM64 (Graviton)",
          ].map((tech) => (
            <span
              key={tech}
              className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/5 text-xs font-medium text-gray-400"
            >
              {tech}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
