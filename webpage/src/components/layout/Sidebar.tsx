"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLanguage } from "@/lib/i18n";
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
} from "lucide-react";
import { useState } from "react";
import { Menu, X } from "lucide-react";

const sections: {
  href: string;
  ko: string;
  en: string;
  icon: typeof Home;
  group?: string;
}[] = [
  { href: "/", ko: "홈", en: "Home", icon: Home },
  { href: "/intro", ko: "소개", en: "Introduction", icon: BookOpen, group: "guide" },
  { href: "/architecture", ko: "아키텍처", en: "Architecture", icon: Layers, group: "guide" },
  { href: "/deployment", ko: "배포 가이드", en: "Deployment", icon: Cloud, group: "guide" },
  { href: "/usage", ko: "사용법", en: "Usage", icon: Cpu, group: "guide" },
  { href: "/user-portal", ko: "내 환경", en: "My Environment", icon: Cpu, group: "guide" },
  { href: "/local-mode", ko: "Local 모드", en: "Local Mode", icon: Terminal, group: "guide" },
  { href: "/cost", ko: "비용", en: "Cost", icon: DollarSign, group: "ops" },
  { href: "/security", ko: "보안", en: "Security", icon: ShieldCheck, group: "ops" },
  { href: "/faq", ko: "FAQ", en: "FAQ", icon: HelpCircle, group: "ops" },
];

export default function Sidebar() {
  const pathname = usePathname();
  const { locale, setLocale } = useLanguage();
  const [open, setOpen] = useState(false);

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

          {/* Lang toggle */}
          <div className="px-4 pt-3 pb-2">
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
          <nav className="flex-1 overflow-y-auto px-3 py-2 space-y-0.5">
            {sections.map((s, i) => {
              const Icon = s.icon;
              const active = pathname === s.href || (s.href !== "/" && pathname.startsWith(s.href));
              const prevGroup = sections[i - 1]?.group;
              const showDivider = i > 0 && s.group !== prevGroup;
              return (
                <div key={s.href}>
                  {showDivider && <div className="h-px bg-navy-600 my-2 mx-2" />}
                  <Link
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
                </div>
              );
            })}
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
