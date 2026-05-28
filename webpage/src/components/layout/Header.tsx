"use client";

import { useLanguage } from "@/lib/i18n";
import { Github, ExternalLink } from "lucide-react";

export default function Header({
  title,
  subtitle,
}: {
  title?: { ko: string; en: string };
  subtitle?: { ko: string; en: string };
}) {
  const { locale } = useLanguage();

  return (
    <header className="sticky top-0 z-20 bg-navy-900/80 backdrop-blur border-b border-navy-600">
      <div className="flex items-center gap-4 px-6 lg:px-8 py-3 ml-12 lg:ml-0">
        <div className="flex-1 min-w-0">
          {title && (
            <h1 className="text-base font-bold text-white truncate">
              {locale === "ko" ? title.ko : title.en}
            </h1>
          )}
          {subtitle && (
            <p className="text-[11px] text-gray-500 truncate">
              {locale === "ko" ? subtitle.ko : subtitle.en}
            </p>
          )}
        </div>
        <a
          href="https://github.com/Atom-oh/cc-on-bedrock"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-gray-400 hover:text-white border border-navy-600 hover:border-navy-500 transition-colors"
        >
          <Github className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">GitHub</span>
          <ExternalLink className="w-3 h-3 opacity-60" />
        </a>
      </div>
    </header>
  );
}
