"use client";

import Link from "next/link";
import { useLanguage } from "@/lib/i18n";
import {
  Layers,
  Cloud,
  Terminal,
  ShieldCheck,
  DollarSign,
  HelpCircle,
  ArrowRight,
  Cpu,
  Sparkles,
} from "lucide-react";

const cards = [
  {
    href: "/intro",
    icon: Sparkles,
    ko: { title: "소개", desc: "두 가지 배포 모드(EC2 / Local), 주요 특징, 모델 라인업, 8 스택 구조." },
    en: { title: "Introduction", desc: "Two modes (EC2 / Local), key features, Bedrock model lineup, 8-stack layout." },
    color: "from-accent-cyan/30 to-accent-cyan/5",
  },
  {
    href: "/architecture",
    icon: Layers,
    ko: { title: "아키텍처", desc: "8 CDK 스택 매핑(ADR 별), EC2-per-user 아키텍처, Local Mode 흐름, Hybrid AI." },
    en: { title: "Architecture", desc: "8-stack ADR mapping, EC2-per-user architecture, Local Mode flow, Hybrid AI." },
    color: "from-accent-purple/30 to-accent-purple/5",
  },
  {
    href: "/deployment",
    icon: Cloud,
    ko: { title: "배포 가이드", desc: "8단계 CDK/Terraform/CloudFormation 배포, governanceOnly 옵션, 검증 절차." },
    en: { title: "Deployment", desc: "8-step CDK/Terraform/CloudFormation deployment, governanceOnly option, verification." },
    color: "from-accent-green/30 to-accent-green/5",
  },
  {
    href: "/usage",
    icon: Cpu,
    ko: { title: "사용법", desc: "EC2 모드 / Local 모드 사용 흐름, /admin/* 페이지 안내, Bedrock 모델 메뉴." },
    en: { title: "Usage", desc: "EC2 / Local mode usage flow, /admin/* page guide, Bedrock model menu." },
    color: "from-accent-orange/30 to-accent-orange/5",
  },
  {
    href: "/local-mode",
    icon: Terminal,
    ko: { title: "Local 모드", desc: "본인 PC + STS + normalized token 한도. 인프라 비용 0. ADR-014." },
    en: { title: "Local Mode", desc: "Your PC + STS + normalized token limits. Zero infra cost. ADR-014." },
    color: "from-accent-cyan/30 to-accent-cyan/5",
  },
  {
    href: "/user-portal",
    icon: Cpu,
    ko: { title: "내 환경", desc: "셀프서비스 포털: 환경/스토리지/설정 탭, SSE 프로비저닝, EBS 확장." },
    en: { title: "My Environment", desc: "Self-service portal: tabs, SSE provisioning, EBS expansion." },
    color: "from-accent-pink/30 to-accent-pink/5",
  },
  {
    href: "/cost",
    icon: DollarSign,
    ko: { title: "비용 관리", desc: "EC2/Local 단가표, 모델별 단가, ADR-019 추적 파이프라인, 비용 절감 팁." },
    en: { title: "Cost", desc: "EC2/Local pricing, model unit cost, ADR-019 tracking pipeline, savings tips." },
    color: "from-accent-green/30 to-accent-green/5",
  },
  {
    href: "/security",
    icon: ShieldCheck,
    ko: { title: "보안", desc: "7계층 보안 모델, DLP 3-tier, Permission Boundary, ADR-022/024 IAM lifecycle." },
    en: { title: "Security", desc: "7-layer security, DLP 3-tier, Permission Boundary, ADR-022/024 IAM lifecycle." },
    color: "from-accent-red/30 to-accent-red/5",
  },
  {
    href: "/faq",
    icon: HelpCircle,
    ko: { title: "FAQ", desc: "스토리지, 인증, 컨테이너, 네트워크, 비용, 보안에 대한 자주 묻는 질문 모음." },
    en: { title: "FAQ", desc: "Frequently asked questions: storage, auth, containers, network, cost, security." },
    color: "from-accent-purple/30 to-accent-purple/5",
  },
];

const stats: { value: string; ko: string; en: string }[] = [
  { value: "8", ko: "CDK 스택", en: "CDK Stacks" },
  { value: "24", ko: "ADR", en: "ADRs" },
  { value: "3", ko: "IaC 도구", en: "IaC Tools" },
  { value: "2", ko: "배포 모드", en: "Deploy modes" },
];

export default function HomePage() {
  const { locale, t } = useLanguage();

  return (
    <div className="px-6 lg:px-12 py-10 lg:py-16 max-w-7xl mx-auto">
      {/* Hero */}
      <section className="mb-16">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-accent-cyan/10 border border-accent-cyan/20 text-accent-cyan text-[11px] font-bold mb-5">
          <span className="w-1.5 h-1.5 rounded-full bg-accent-cyan animate-pulse" />
          {t("Enterprise v2 · Opus 4.7 Ready", "Enterprise v2 · Opus 4.7 Ready")}
        </div>
        <h1 className="text-4xl lg:text-6xl font-black tracking-tight text-white mb-4 leading-[1.05]">
          {t("멀티유저 Claude Code", "Multi-user Claude Code")}
          <br />
          <span className="bg-gradient-to-r from-accent-cyan via-accent-purple to-accent-pink bg-clip-text text-transparent">
            {t("on Amazon Bedrock", "on Amazon Bedrock")}
          </span>
        </h1>
        <p className="text-base lg:text-lg text-gray-400 leading-relaxed max-w-3xl mb-6">
          {t(
            "EC2-per-user DevEnv 와 Local Governance 모드를 모두 지원하는 엔터프라이즈 플랫폼. CDK / Terraform / CloudFormation 세 IaC 도구로 동일 인프라를 배포할 수 있고, ADR-022 사전 프로비저닝과 ADR-014 normalized token 한도까지 풀 라이프사이클 거버넌스를 제공합니다.",
            "Enterprise platform supporting both EC2-per-user DevEnv and Local Governance modes. Deploy the same infrastructure via CDK, Terraform, or CloudFormation, with full-lifecycle governance from ADR-022 pre-provisioning to ADR-014 normalized token limits."
          )}
        </p>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/intro"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-accent-cyan text-navy-900 text-sm font-bold hover:bg-accent-cyan/90 transition glow-cyan"
          >
            {t("가이드 시작", "Start the guide")}
            <ArrowRight className="w-4 h-4" />
          </Link>
          <Link
            href="/local-mode"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-navy-700 text-white text-sm font-bold hover:bg-navy-600 transition border border-navy-600"
          >
            <Terminal className="w-4 h-4 text-accent-cyan" />
            {t("Local 모드 빠른 시작", "Local Mode quickstart")}
          </Link>
        </div>
      </section>

      {/* Stats */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-16">
        {stats.map((s) => (
          <div
            key={s.value}
            className="rounded-xl border border-navy-600 bg-navy-800/40 p-5 hover:border-navy-500 transition"
          >
            <div className="text-3xl lg:text-4xl font-black text-white tracking-tight">
              {s.value}
            </div>
            <div className="text-[11px] font-bold text-gray-500 uppercase tracking-widest mt-1">
              {locale === "ko" ? s.ko : s.en}
            </div>
          </div>
        ))}
      </section>

      {/* Section cards */}
      <section>
        <h2 className="text-xl font-bold text-white mb-6 flex items-center gap-2">
          <span className="w-1 h-6 bg-accent-cyan rounded-full" />
          {t("가이드 둘러보기", "Browse the guide")}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {cards.map((c) => {
            const Icon = c.icon;
            const meta = locale === "ko" ? c.ko : c.en;
            return (
              <Link key={c.href} href={c.href} className="group">
                <div
                  className={`relative h-full p-5 rounded-xl bg-gradient-to-br ${c.color} border border-navy-600 hover:border-navy-500 transition-all`}
                >
                  <div className="flex items-start gap-3">
                    <div className="shrink-0 w-9 h-9 rounded-lg bg-navy-900/70 border border-navy-600 flex items-center justify-center">
                      <Icon className="w-4 h-4 text-accent-cyan" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1.5">
                        <h3 className="text-sm font-bold text-white group-hover:text-accent-cyan transition-colors">
                          {meta.title}
                        </h3>
                        <ArrowRight className="w-3.5 h-3.5 text-gray-600 group-hover:text-accent-cyan group-hover:translate-x-1 transition-all" />
                      </div>
                      <p className="text-xs text-gray-400 leading-relaxed">{meta.desc}</p>
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      {/* Footer note */}
      <section className="mt-20 pt-6 border-t border-navy-600 text-[11px] text-gray-600 flex flex-wrap items-center justify-between gap-2">
        <span>
          {t(
            "본 가이드는 v2 (EC2 + Local 공존 + Opus 4.7) 기준입니다.",
            "This guide reflects v2 (EC2 + Local coexist + Opus 4.7)."
          )}
        </span>
        <a
          href="https://github.com/Atom-oh/cc-on-bedrock"
          target="_blank"
          rel="noreferrer"
          className="hover:text-accent-cyan transition"
        >
          github.com/Atom-oh/cc-on-bedrock
        </a>
      </section>
    </div>
  );
}
