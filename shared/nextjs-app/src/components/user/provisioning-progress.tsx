"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { PROVISIONING_STEPS, type ProvisioningEvent } from "@/lib/types";

interface ProvisioningProgressProps {
  tier: "light" | "standard" | "power";
  os: "ubuntu" | "al2023";
  onComplete: (url?: string) => void;
  onError: (error: string) => void;
}

export default function ProvisioningProgress({ tier, os, onComplete, onError }: ProvisioningProgressProps) {
  const [events, setEvents] = useState<Map<string, ProvisioningEvent>>(new Map());
  const [currentStep, setCurrentStep] = useState(0);
  const [failed, setFailed] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const startedRef = useRef(false);

  const progressPercent = Math.max(5, (currentStep / 7) * 100);

  const handleCancel = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    setCancelled(true);
    onError("Provisioning cancelled by user");
  }, [onError]);

  const startProvisioning = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/user/container/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", resourceTier: tier, containerOs: os }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: "Failed to start provisioning" }));
        onError(errorData.error ?? `HTTP ${response.status}`);
        return;
      }

      if (!response.body) {
        onError("No response body");
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const event: ProvisioningEvent = JSON.parse(line.slice(6));
              setEvents(prev => {
                const next = new Map(prev);
                next.set(event.name, event);
                return next;
              });

              if (event.status === "in_progress") {
                setCurrentStep(event.step);
              } else if (event.status === "completed" && event.step === 6) {
                setCompleted(true);
                setTimeout(() => onComplete(event.url), 1500);
              } else if (event.status === "failed") {
                setFailed(true);
                onError(event.error ?? `Step ${event.step} failed`);
              }
            } catch { /* ignore parse errors */ }
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      onError(err instanceof Error ? err.message : "Connection failed");
    }
  }, [tier, os, onComplete, onError]);

  useEffect(() => {
    startProvisioning();
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, [startProvisioning]);

  const getStepStatus = (stepName: string): ProvisioningEvent["status"] => {
    return events.get(stepName)?.status ?? "pending";
  };

  if (cancelled) return null;

  return (
    <div className="bg-[#161b22] rounded-xl border border-gray-800 p-6">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold text-gray-100">Provisioning Environment</h2>
        <div className="flex items-center gap-2">
          {completed && (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-green-900/30 text-green-400">
              Complete
            </span>
          )}
          {failed && (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-red-900/30 text-red-400">
              Failed
            </span>
          )}
          {!completed && !failed && (
            <>
              <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-blue-900/30 text-blue-400">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" aria-hidden="true" />
                In Progress
              </span>
              <button
                onClick={handleCancel}
                className="text-xs text-gray-500 hover:text-red-400 transition-colors px-2 py-1"
                aria-label="Cancel provisioning"
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>

      <p className="text-xs text-gray-500 mb-4">Usually takes 1-2 minutes</p>

      {/* Progress Bar */}
      <div
        className="w-full h-2 bg-gray-800 rounded-full overflow-hidden mb-6"
        role="progressbar"
        aria-valuenow={Math.round(progressPercent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Provisioning progress"
      >
        <div
          className={`h-full rounded-full transition-all duration-700 ease-out ${
            failed ? "bg-red-500" : completed ? "bg-green-500" : "bg-blue-500"
          }`}
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {/* Step Indicators */}
      <div className="space-y-3" aria-live="polite">
        {PROVISIONING_STEPS.map(({ step, name, label }) => {
          const status = getStepStatus(name);
          const event = events.get(name);
          return (
            <div key={name} className="flex items-center gap-3">
              {/* Step Icon */}
              <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-all duration-300 ${
                status === "completed"
                  ? "bg-green-900/50 text-green-400"
                  : status === "in_progress"
                  ? "bg-blue-900/50 text-blue-400 animate-pulse"
                  : status === "failed"
                  ? "bg-red-900/50 text-red-400"
                  : "bg-gray-800 text-gray-600"
              }`} aria-hidden="true">
                {status === "completed" ? (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                ) : status === "failed" ? (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                ) : (
                  <span className="text-xs font-medium">{step}</span>
                )}
              </div>

              {/* Step Label */}
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium ${
                  status === "completed" ? "text-green-400"
                  : status === "in_progress" ? "text-blue-400"
                  : status === "failed" ? "text-red-400"
                  : "text-gray-500"
                }`}>
                  {label}
                  <span className="sr-only"> — {status}</span>
                </p>
                {event?.message && (
                  <p className="text-xs text-gray-500 truncate">{event.message}</p>
                )}
                {event?.error && (
                  <p className="text-xs text-red-400 truncate">{event.error}</p>
                )}
              </div>

              {/* Spinner for active step */}
              {status === "in_progress" && (
                <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" aria-hidden="true" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
