import type { Metadata } from "next";
import "./globals.css";
import { LanguageProvider } from "@/lib/i18n";
import { AudienceProvider } from "@/lib/audience";
import Sidebar from "@/components/layout/Sidebar";

export const metadata: Metadata = {
  title: "CC-on-Bedrock — Multi-user Claude Code platform",
  description:
    "AWS Bedrock 기반 멀티유저 Claude Code 개발환경 플랫폼 — 가이드, 아키텍처, 배포, 비용/보안",
  icons: { icon: "/img/favicon.ico" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className="dark">
      <body className="bg-navy-900 text-gray-100 antialiased min-h-screen">
        <LanguageProvider>
          <AudienceProvider>
            <div className="flex">
              <Sidebar />
              <main className="flex-1 min-w-0">{children}</main>
            </div>
          </AudienceProvider>
        </LanguageProvider>
      </body>
    </html>
  );
}
