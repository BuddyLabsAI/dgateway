// Short confirmations for saves and failures. Announced politely, dismissed by time.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { enter } from "../motion/motion";
import { Icon } from "./icons";

export type ToastTone = "ok" | "error";

interface ToastItem {
  id: number;
  tone: ToastTone;
  text: string;
}

interface ToastApi {
  notify: (text: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
const LIFETIME_MS = 4500;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: number) => setItems((current) => current.filter((item) => item.id !== id)), []);

  const notify = useCallback(
    (text: string, tone: ToastTone = "ok") => {
      counter.current += 1;
      const id = counter.current;
      setItems((current) => [...current.slice(-2), { id, tone, text }]);
      window.setTimeout(() => dismiss(id), LIFETIME_MS);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toaster" role="status" aria-live="polite">
        {items.map((item) => (
          <ToastView key={item.id} item={item} onDismiss={() => dismiss(item.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    enter(ref.current);
  }, []);
  return (
    <div ref={ref} className={`toast toast--${item.tone}`}>
      <Icon name={item.tone === "ok" ? "check" : "flag"} size={14} />
      <span className="toast-text">{item.text}</span>
      <button type="button" className="toast-close" onClick={onDismiss} aria-label="Dismiss">
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

export function useNotify(): ToastApi["notify"] {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useNotify must be used inside ToastProvider");
  return api.notify;
}
