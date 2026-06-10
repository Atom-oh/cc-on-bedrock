"use client";

import { ReactNode } from "react";

export function PageShell({
  children,
  title,
  subtitle,
  tags,
}: {
  children: ReactNode;
  title: string;
  subtitle?: string;
  tags?: { label: string; color?: "cyan" | "green" | "purple" | "orange" | "red" }[];
}) {
  return (
    <article className="max-w-4xl mx-auto px-6 lg:px-10 py-8 lg:py-12">
      <header className="mb-10 pb-6 border-b border-navy-600">
        {tags && tags.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {tags.map((tag) => (
              <Tag key={tag.label} color={tag.color}>
                {tag.label}
              </Tag>
            ))}
          </div>
        )}
        <h1 className="text-3xl lg:text-4xl font-black tracking-tight text-white mb-3">{title}</h1>
        {subtitle && (
          <p className="text-base text-gray-400 leading-relaxed max-w-3xl">{subtitle}</p>
        )}
      </header>
      {children}
    </article>
  );
}

export function H2({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h2 id={id} className="anchor-offset text-2xl font-bold text-white mt-12 mb-4 flex items-center gap-2">
      <span className="w-1 h-7 bg-accent-cyan rounded-full" />
      {children}
    </h2>
  );
}

export function H3({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h3 id={id} className="anchor-offset text-lg font-bold text-white mt-8 mb-3">
      {children}
    </h3>
  );
}

export function P({ children }: { children: ReactNode }) {
  return <p className="text-sm text-gray-400 leading-7 mb-4">{children}</p>;
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="px-1.5 py-0.5 rounded bg-navy-700 border border-navy-600 text-accent-cyan text-[12px] font-mono">
      {children}
    </code>
  );
}

export function CodeBlock({
  children,
  title,
  lang,
}: {
  children: string;
  title?: string;
  lang?: string;
}) {
  return (
    <div className="rounded-lg overflow-hidden border border-navy-600 mb-5">
      {title && (
        <div className="px-4 py-2 bg-navy-700 text-[10px] font-bold text-gray-500 uppercase tracking-widest border-b border-navy-600 flex items-center justify-between">
          <span>{title}</span>
          {lang && <span className="text-accent-cyan/60">{lang}</span>}
        </div>
      )}
      <pre className="p-4 bg-navy-800 text-xs text-gray-300 overflow-x-auto leading-relaxed">
        <code>{children}</code>
      </pre>
    </div>
  );
}

export function Tag({
  children,
  color = "cyan",
}: {
  children: ReactNode;
  color?: "cyan" | "green" | "purple" | "orange" | "red";
}) {
  const cls = {
    cyan: "bg-accent-cyan/10 text-accent-cyan border-accent-cyan/30",
    green: "bg-accent-green/10 text-accent-green border-accent-green/30",
    purple: "bg-accent-purple/10 text-accent-purple border-accent-purple/30",
    orange: "bg-accent-orange/10 text-accent-orange border-accent-orange/30",
    red: "bg-accent-red/10 text-accent-red border-accent-red/30",
  }[color];
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border ${cls}`}
    >
      {children}
    </span>
  );
}

export function Callout({
  title,
  children,
  type = "info",
}: {
  title?: string;
  children: ReactNode;
  type?: "info" | "warn" | "tip" | "danger";
}) {
  const cls = {
    info: "border-accent-cyan/30 bg-accent-cyan/5",
    warn: "border-accent-orange/30 bg-accent-orange/5",
    tip: "border-accent-green/30 bg-accent-green/5",
    danger: "border-accent-red/30 bg-accent-red/5",
  }[type];
  const titleCls = {
    info: "text-accent-cyan",
    warn: "text-accent-orange",
    tip: "text-accent-green",
    danger: "text-accent-red",
  }[type];
  return (
    <div className={`rounded-lg border ${cls} p-4 mb-5`}>
      {title && <div className={`text-sm font-bold mb-1 ${titleCls}`}>{title}</div>}
      <div className="text-sm text-gray-400 leading-relaxed">{children}</div>
    </div>
  );
}

export function Table<T extends Record<string, ReactNode>>({
  columns,
  rows,
}: {
  columns: { key: keyof T; label: string; className?: string }[];
  rows: T[];
}) {
  return (
    <div className="rounded-lg border border-navy-600 overflow-hidden mb-5">
      <table className="w-full text-sm">
        <thead className="bg-navy-700 text-[10px] font-bold uppercase tracking-wider text-gray-500">
          <tr>
            {columns.map((c) => (
              <th key={String(c.key)} className={`text-left px-4 py-2.5 ${c.className ?? ""}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-navy-600">
          {rows.map((r, i) => (
            <tr key={i} className="hover:bg-navy-800/40 transition-colors">
              {columns.map((c) => (
                <td key={String(c.key)} className={`px-4 py-3 text-gray-400 ${c.className ?? ""}`}>
                  {r[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
