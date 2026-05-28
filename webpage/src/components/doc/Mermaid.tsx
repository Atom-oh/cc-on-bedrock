"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Client-side Mermaid renderer.
 * - Static export safe (no SSR — `if (typeof window === 'undefined') return`)
 * - Dark theme matched to navy palette
 * - Re-renders on chart prop change
 */
export default function Mermaid({ chart, caption }: { chart: string; caption?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [id] = useState(() => `mmd-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
          themeVariables: {
            background: "#0f1629",
            primaryColor: "#1a2540",
            primaryTextColor: "#e5e7eb",
            primaryBorderColor: "#00d4ff",
            lineColor: "#00d4ff",
            secondaryColor: "#151d30",
            tertiaryColor: "#213052",
            fontFamily: 'Inter, "JetBrains Mono", monospace',
            fontSize: "13px",
          },
          flowchart: { useMaxWidth: true, htmlLabels: true, curve: "basis" },
          sequence: { useMaxWidth: true },
        });
        const { svg } = await mermaid.render(id, chart);
        if (!cancelled && ref.current) {
          ref.current.innerHTML = svg;
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Render failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chart, id]);

  return (
    <figure className="my-6 rounded-lg overflow-hidden border border-navy-600 bg-navy-800/40">
      <div ref={ref} className="p-4 overflow-x-auto flex justify-center text-sm" />
      {err && (
        <div className="px-4 py-2 text-xs text-accent-red border-t border-navy-600">
          Mermaid render error: {err}
        </div>
      )}
      {caption && (
        <figcaption className="px-4 py-2 text-[11px] font-bold text-gray-500 uppercase tracking-widest border-t border-navy-600">
          {caption}
        </figcaption>
      )}
    </figure>
  );
}
