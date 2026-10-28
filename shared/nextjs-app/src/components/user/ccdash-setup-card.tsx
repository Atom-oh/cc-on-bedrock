"use client";

import { useSession } from "next-auth/react";
import { useCcdashLinks } from "@/components/ccdash-provider";
import { useI18n } from "@/lib/i18n";

// Optional ccdash collector guidance. cc-on-bedrock writes no telemetry settings; ccdash
// installs its own collector and identifies the user by `user.email`.
export default function CcdashSetupCard({ tone = "dark" }: { tone?: "dark" | "light" }) {
  const links = useCcdashLinks();
  const { data: session } = useSession();
  const { t } = useI18n();
  if (!links) return null;

  const email = session?.user?.email ?? "";
  const light = tone === "light";
  return (
    <section
      className={
        light
          ? "border rounded p-4 bg-white text-sm"
          : "mb-4 rounded border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs text-emerald-200"
      }
    >
      <h2 className={light ? "text-lg font-medium mb-2" : "font-semibold mb-1"}>{t("ccdash.title")}</h2>
      <ol className={`list-decimal pl-5 space-y-1 ${light ? "text-gray-600" : "text-emerald-200/80"}`}>
        <li>{t("ccdash.step1")}</li>
        <li>
          {t("ccdash.step2")}{" "}
          <a
            href={links.collector}
            target="_blank"
            rel="noopener noreferrer"
            className={light ? "text-blue-600 underline" : "text-emerald-300 underline"}
          >
            {links.collector}
          </a>
        </li>
        <li>
          {t("ccdash.step3")}{" "}
          <code className={light ? "bg-gray-100 rounded px-1" : "bg-black/40 rounded px-1 text-gray-200"}>
            user.email
          </code>{" "}
          =
          <input
            readOnly
            aria-label="user.email"
            value={email}
            className={
              light
                ? "ml-1 px-2 py-0.5 border rounded bg-gray-50 text-xs"
                : "ml-1 px-2 py-0.5 rounded bg-black/40 text-gray-200 text-xs"
            }
          />
        </li>
      </ol>
    </section>
  );
}
