"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import {
  BookOpen,
  Layers,
  Rocket,
  User,
  Settings,
  Shield,
  HelpCircle,
  ChevronRight,
} from "lucide-react";

const docsSections = [
  { href: "/docs", label: { ko: "개요", en: "Overview" }, icon: BookOpen, exact: true },
  { href: "/docs/architecture", label: { ko: "아키텍처", en: "Architecture" }, icon: Layers },
  { href: "/docs/getting-started", label: { ko: "시작하기", en: "Getting Started" }, icon: Rocket },
  { href: "/docs/user-guide", label: { ko: "사용자 가이드", en: "User Guide" }, icon: User },
  { href: "/docs/admin-guide", label: { ko: "관리자 가이드", en: "Admin Guide" }, icon: Settings },
  { href: "/docs/security", label: { ko: "보안", en: "Security" }, icon: Shield },
  { href: "/docs/faq", label: { ko: "FAQ", en: "FAQ" }, icon: HelpCircle },
];

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { locale } = useI18n();

  return (
    <div className="flex gap-0 -m-6 lg:-m-8 min-h-[calc(100vh-0px)]">
      {/* Docs sidebar */}
      <aside className="w-60 shrink-0 bg-[#0d1117]/50 border-r border-white/5 p-4 sticky top-0 h-screen overflow-y-auto">
        <div className="mb-6 px-3">
          <h2 className="text-xs font-black uppercase tracking-widest text-gray-500">
            {locale === "ko" ? "가이드 문서" : "Documentation"}
          </h2>
        </div>
        <nav className="space-y-1">
          {docsSections.map((section) => {
            const isActive = section.exact
              ? pathname === section.href
              : pathname.startsWith(section.href);
            const Icon = section.icon;
            return (
              <Link key={section.href} href={section.href} className="block group">
                <div
                  className={cn(
                    "relative flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200",
                    isActive
                      ? "bg-primary-500/10 text-primary-400 border border-primary-500/20"
                      : "text-gray-400 hover:bg-white/5 hover:text-gray-200 border border-transparent"
                  )}
                >
                  <Icon className={cn("w-4 h-4", isActive ? "text-primary-400" : "text-gray-500")} />
                  <span>{section.label[locale]}</span>
                  {isActive && <ChevronRight className="w-3 h-3 ml-auto opacity-50" />}
                </div>
              </Link>
            );
          })}
        </nav>

        {/* Version badge */}
        <div className="mt-8 px-3">
          <div className="flex items-center gap-2 text-[10px] font-bold text-gray-600 uppercase tracking-wider">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500/60" />
            Enterprise v2
          </div>
        </div>
      </aside>

      {/* Content */}
      <main className="flex-1 overflow-y-auto p-6 lg:p-8">
        {children}
      </main>
    </div>
  );
}
