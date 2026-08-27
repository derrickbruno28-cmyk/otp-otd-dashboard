import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { newId } from "../lib/format";

type ToastKind = "ok" | "error";
interface ToastItem { id: string; kind: ToastKind; message: string; }
interface ToastApi { push(kind: ToastKind, message: string): void; }

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<string, number>());

  const dismiss = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t !== undefined) {
      window.clearTimeout(t);
      timers.current.delete(id);
    }
    setToasts((cur) => cur.filter((x) => x.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = newId("toast");
      setToasts((cur) => [...cur, { id, kind, message }]);
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), kind === "error" ? 8000 : 5000),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) window.clearTimeout(t);
      map.clear();
    };
  }, []);

  const api = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="fixed bottom-4 right-4 z-[70] flex flex-col items-end gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.kind === "error" ? "alert" : "status"}
            className={`flex items-start gap-2 bg-surface border rounded-lg shadow-2xl px-3 py-2 text-sm max-w-[min(380px,calc(100vw-2rem))] ${
              t.kind === "error" ? "border-late/50" : "border-ontime/50"
            }`}
          >
            <span
              aria-hidden="true"
              className={`font-mono shrink-0 ${t.kind === "error" ? "text-late" : "text-ontime"}`}
            >
              {t.kind === "error" ? "✕" : "✓"}
            </span>
            <span className={`break-words ${t.kind === "error" ? "text-late" : "text-ink"}`}>{t.message}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
              className="shrink-0 -mr-1 px-1 rounded text-ink3 hover:bg-surface2"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
