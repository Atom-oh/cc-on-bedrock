"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useLanguage } from "@/lib/i18n";
import { useAudience, type Audience } from "@/lib/audience";
import {
  Home,
  Layers,
  Cloud,
  BookOpen,
  Terminal,
  Cpu,
  ShieldCheck,
  DollarSign,
  HelpCircle,
  ChevronRight,
  Menu,
  X,
  User,
  Settings,
  Layers3,
} from "lucide-react";

type SectionDef = {
  href: string;
  ko: string;
  en: string;
  icon: typeof Home;
  /** Which audience this page primarily targets. `all` means show in every mode. */
  audience: readonly Audience[];
  /** Sidebar group key — drives the visible group heading. */
  group: "core" | "user" | "operator" | "common";
};

const sections: SectionDef[] = [
  { href: "/", ko: "홈", en: "Home", icon: Home, audience: ["all"], group: "core" },
  { href: "/intro", ko: "소개", en: "Introduction", icon: BookOpen, audience: ["all"], group: "core" },

  // 사용자용 ----------------------------------------------------------------
  { href: "/usage", ko: "사용법", en: "Usage", icon: Cpu, audience: ["user", "operator"], group: "user" },
  { href: "/user-portal", ko: "내 환경", en: "My Environment", icon: User, audience: ["user"], group: "user" },
  { href: "/local-mode", ko: "Local 모드", en: "Local Mode", icon: Terminal, audience: ["user", "operator"], group: "user" },

  // 운영자용 ----------------------------------------------------------------
  { href: "/architecture", ko: "아키텍처", en: "Architecture", icon: Layers, audience: ["operator"], group: "operator" },
  { href: "/deployment", ko: "배포 가이드", en: "Deployment", icon: Cloud, audience: ["operator"], group: "operator" },
  { href: "/cost", ko: "비용 관리", en: "Cost", icon: DollarSign, audience: ["operator"], group: "operator" },
  { href: "/security", ko: "보안", en: "Security", icon: ShieldCheck, audience: ["operator"], group: "operator" },

  // 공통 -------------------------------------------------------------------
  { href: "/faq", ko: "FAQ", en: "FAQ", icon: HelpCircle, audience: ["all"], group: "common" },
];

const groupLabels: Record<SectionDef["group"], { ko: string; en: string }> = {
  core: { ko: "둘러보기", en: "Overview" },
  user: { ko: "사용자 가이드", en: "User guide" },
  operator: { ko: "운영자 가이드", en: "Operator guide" },
  common: { ko: "공통", en: "Common" },
};

export default function Sidebar() {
  const pathname = usePathname();
  const { locale, setLocale } = useLanguage();
  const { audience, setAudience, shows } = useAudience();
  const [open, setOpen] = useState(false);

  const visible = sections.filter((s) => shows(s.audience));
  const grouped = (["core", "user", "operator", "common"] as const)
    .map((g) => ({ group: g, items: visible.filter((s) => s.group === g) }))
    .filter((g) => g.items.length > 0);

  return (
    <>
      {/* Mobile toggle */}
      <button
        className="fixed top-3 left-3 z-50 lg:hidden p-2 rounded-lg bg-navy-700 border border-navy-600 text-gray-300"
        onClick={() => setOpen(!open)}
        aria-label="Toggle menu"
      >
        {open ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
      </button>

      <aside
        className={`fixed lg:sticky top-0 left-0 z-40 h-screen w-64 shrink-0 bg-navy-900 border-r border-navy-600 transition-transform duration-200 lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex flex-col h-full">
          {/* Brand */}
          <Link href="/" className="px-5 py-5 border-b border-navy-600 hover:bg-navy-800/40">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-accent-cyan to-accent-purple flex items-center justify-center font-black text-navy-900 text-sm">
                CC
              </div>
              <div>
                <div className="text-sm font-black text-white tracking-tight">cc-on-bedrock</div>
                <div className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">
                  Enterprise v2
                </div>
              </div>
            </div>
          </Link>

          {/* Audience tabs */}
          <div className="px-4 pt-3 pb-2">
            <div className="text-[9px] font-bold text-gray-600 uppercase tracking-widest mb-1.5">
              {locale === "ko" ? "보는 관점" : "View as"}
            </div>
            <div className="grid grid-cols-3 rounded-md border border-navy-600 overflow-hidden text-[11px] font-bold">
              {([
                { v: "user", ko: "사용자", en: "User", icon: User },
                { v: "operator", ko: "운영자", en: "Operator", icon: Settings },
                { v: "all", ko: "전체", en: "All", icon: Layers3 },
              ] as { v: Audience; ko: string; en: string; icon: typeof User }[]).map((a) => {
                const Icon = a.icon;
                const active = audience === a.v;
                return (
                  <button
                    key={a.v}
                    onClick={() => setAudience(a.v)}
                    className={`flex items-center justify-center gap-1 py-1.5 transition border-r border-navy-600 last:border-r-0 ${
                      active
                        ? "bg-accent-cyan/20 text-accent-cyan"
                        : "text-gray-500 hover:text-gray-300 hover:bg-navy-800/40"
                    }`}
                    title={locale === "ko" ? a.ko : a.en}
                  >
                    <Icon className="w-3 h-3" />
                    <span className="hidden xl:inline">{locale === "ko" ? a.ko : a.en}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Lang tabs */}
          <div className="px-4 pt-2 pb-2">
            <div className="inline-flex rounded-md border border-navy-600 overflow-hidden text-[11px] font-bold">
              {(["ko", "en"] as const).map((l) => (
                <button
                  key={l}
                  onClick={() => setLocale(l)}
                  className={`px-3 py-1 transition ${
                    locale === l
                      ? "bg-accent-cyan/20 text-accent-cyan"
                      : "text-gray-500 hover:text-gray-300"
                  }`}
                >
                  {l.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* Nav */}
          <nav className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
            {grouped.map(({ group, items }) => (
              <div key={group}>
                {/* Group label — hide for 'core' since it's at the top */}
                {group !== "core" && (
                  <div className="px-3 py-1 text-[9px] font-bold text-gray-600 uppercase tracking-widest">
                    {locale === "ko" ? groupLabels[group].ko : groupLabels[group].en}
                  </div>
                )}
                <div className="space-y-0.5">
                  {items.map((s) => {
                    const Icon = s.icon;
                    const active = pathname === s.href || (s.href !== "/" && pathname.startsWith(s.href));
                    return (
                      <Link
                        key={s.href}
                        href={s.href}
                        onClick={() => setOpen(false)}
                        className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium transition-all ${
                          active
                            ? "bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/20"
                            : "text-gray-400 hover:text-gray-200 hover:bg-navy-800 border border-transparent"
                        }`}
                      >
                        <Icon className={`w-4 h-4 ${active ? "text-accent-cyan" : "text-gray-500"}`} />
                        <span className="flex-1">{locale === "ko" ? s.ko : s.en}</span>
                        {active && <ChevronRight className="w-3 h-3 opacity-60" />}
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>

          {/* Footer */}
          <div className="px-4 py-3 border-t border-navy-600 text-[10px] text-gray-600">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-accent-green/60 animate-pulse-slow" />
              <span className="font-bold uppercase tracking-widest">Live</span>
              <span className="ml-auto">v2.0</span>
            </div>
          </div>
        </div>
      </aside>

      {open && (
        <div
          className="lg:hidden fixed inset-0 bg-black/60 z-30"
          onClick={() => setOpen(false)}
        />
      )}
    </>
  );
}
