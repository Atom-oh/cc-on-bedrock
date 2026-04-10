"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { useI18n } from "@/lib/i18n";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import {
  Home,
  Terminal,
  Building2,
  Sparkles,
  BarChart3,
  Activity,
  ShieldCheck,
  Users2,
  Server,
  Coins,
  Wallet,
  ClipboardCheck,
  BookOpen,
  LogOut,
  ChevronRight,
  Globe
} from "lucide-react";

interface NavItem {
  href: string;
  labelKey: string;
  icon: any;
  adminOnly?: boolean;
  deptManagerOnly?: boolean;
  showForAll?: boolean;
}

const navItems: NavItem[] = [
  { href: "/", labelKey: "nav.home", icon: Home },
  { href: "/user", labelKey: "nav.myEnv", icon: Terminal, showForAll: true },
  { href: "/dept", labelKey: "nav.department", icon: Building2, deptManagerOnly: true },
  { href: "/ai", labelKey: "nav.ai", icon: Sparkles },
  { href: "/analytics", labelKey: "nav.analytics", icon: BarChart3 },
  { href: "/monitoring", labelKey: "nav.monitoring", icon: Activity, adminOnly: true },
  { href: "/security", labelKey: "nav.security", icon: ShieldCheck, adminOnly: true },
  { href: "/admin", labelKey: "nav.users", icon: Users2, adminOnly: true },
  { href: "/admin/instances", labelKey: "nav.containers", icon: Server, adminOnly: true },
  { href: "/admin/tokens", labelKey: "nav.tokens", icon: Coins, adminOnly: true },
  { href: "/admin/budgets", labelKey: "nav.budgets", icon: Wallet, adminOnly: true },
  { href: "/admin/approvals", labelKey: "nav.approvals", icon: ClipboardCheck, adminOnly: true },
  { href: "/admin/dlp", labelKey: "nav.dlpManagement", icon: ShieldCheck, adminOnly: true },
  { href: "/docs", labelKey: "nav.docs", icon: BookOpen, showForAll: true },
];

export default function Sidebar() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const { locale, setLocale, t } = useI18n();
  const isAdmin = session?.user?.isAdmin ?? false;
  const groups = session?.user?.groups ?? [];
  const isDeptManager = groups.includes("dept-manager") || isAdmin;

  const filteredItems = navItems.filter((item) => {
    if (item.adminOnly && !isAdmin) return false;
    if (item.deptManagerOnly && !isDeptManager) return false;
    return true;
  });

  return (
    <aside className="flex flex-col w-64 min-h-screen bg-[#0d1117] border-r border-white/5 relative z-50">
      {/* Branding */}
      <div className="p-6">
        <div className="flex items-center gap-3 mb-8">
          <div className="relative group">
            <div className="absolute -inset-1 bg-gradient-to-r from-primary-600 to-blue-600 rounded-xl blur opacity-25 group-hover:opacity-50 transition duration-1000 group-hover:duration-200"></div>
            <div className="relative flex items-center justify-center w-10 h-10 rounded-xl bg-[#161b22] border border-white/10 text-white font-black text-lg">
              CC
            </div>
          </div>
          <div>
            <h1 className="text-sm font-black text-white tracking-tight uppercase">CC-on-Bedrock</h1>
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]" />
              <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Enterprise v2</p>
            </div>
          </div>
        </div>

        {/* Language Toggle */}
        <div className="flex items-center bg-[#161b22] rounded-xl border border-white/5 p-1 mb-6">
          <button
            onClick={() => setLocale("ko")}
            className={cn(
              "flex-1 flex items-center justify-center gap-1.5 py-1.5 text-[10px] font-bold rounded-lg transition-all duration-200",
              locale === "ko" ? "bg-primary-600 text-white shadow-lg shadow-primary-900/20" : "text-gray-500 hover:text-gray-300"
            )}
          >
            <Globe className="w-3 h-3" />
            한글
          </button>
          <button
            onClick={() => setLocale("en")}
            className={cn(
              "flex-1 flex items-center justify-center gap-1.5 py-1.5 text-[10px] font-bold rounded-lg transition-all duration-200",
              locale === "en" ? "bg-primary-600 text-white shadow-lg shadow-primary-900/20" : "text-gray-500 hover:text-gray-300"
            )}
          >
            <Globe className="w-3 h-3" />
            ENG
          </button>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-4 space-y-1 overflow-y-auto custom-scrollbar">
        {filteredItems.map((item) => {
          const isActive = pathname === item.href;
          const Icon = item.icon;
          
          return (
            <Link key={item.href} href={item.href} className="block group">
              <div className={cn(
                "relative flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200",
                isActive 
                  ? "bg-primary-500/10 text-primary-400 border border-primary-500/20 shadow-[0_0_20px_rgba(59,130,246,0.05)]" 
                  : "text-gray-400 hover:bg-white/5 hover:text-gray-200 border border-transparent"
              )}>
                {isActive && (
                  <motion.div 
                    layoutId="sidebar-active"
                    className="absolute left-0 w-1 h-5 bg-primary-500 rounded-r-full"
                  />
                )}
                <Icon className={cn("w-5 h-5 transition-transform duration-200 group-hover:scale-110", isActive ? "text-primary-400" : "text-gray-500 group-hover:text-gray-300")} />
                <span className="text-sm font-bold tracking-tight">{t(item.labelKey)}</span>
                {isActive && <ChevronRight className="w-3.5 h-3.5 ml-auto opacity-50" />}
              </div>
            </Link>
          );
        })}
      </nav>

      {/* User Section */}
      <div className="p-4 mt-auto border-t border-white/5 bg-[#161b22]/30 backdrop-blur-sm">
        <div className="flex items-center gap-3 px-2 py-3 mb-2">
          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-primary-500 to-blue-600 flex items-center justify-center font-bold text-white shadow-lg border border-white/10">
            {session?.user?.name?.[0] || "U"}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-white truncate">{session?.user?.name || "User"}</p>
            <p className="text-[10px] font-bold text-gray-500 truncate uppercase tracking-tighter">
              {isAdmin ? "Administrator" : "Developer"}
            </p>
          </div>
        </div>
        <button
          onClick={() => signOut()}
          className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl text-xs font-bold text-rose-400 hover:bg-rose-500/10 border border-transparent hover:border-rose-500/20 transition-all duration-200"
        >
          <LogOut className="w-4 h-4" />
          {t("nav.signout")}
        </button>
      </div>
    </aside>
  );
}
