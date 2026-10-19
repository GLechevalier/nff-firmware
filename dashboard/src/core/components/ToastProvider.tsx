// Global notification toasts (bottom-right), mounted once in App.tsx.
//
// Plain fire-and-forget notices — "your PR is open",
// "preview is live" — pushed from anywhere via useToast(). Same paper/ink
// visual language, auto-dismiss, optional action button (e.g. jump to a tab).

import { createContext, useCallback, useContext, useRef, useState } from 'react';

export type ToastTone = 'info' | 'success' | 'error';

interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  detail?: string;
  action?: { label: string; onClick: () => void };
}

type ToastCtx = {
  push: (t: Omit<Toast, 'id'>, ttlMs?: number) => void;
};

const Ctx = createContext<ToastCtx>({ push: () => {} });

// eslint-disable-next-line react-refresh/only-export-components
export function useToast() {
  return useContext(Ctx);
}

const TTL = 8000;

const TONE_STRIPE: Record<ToastTone, string> = {
  info: 'bg-ink',
  success: 'bg-emerald-600',
  error: 'bg-red-600',
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (t: Omit<Toast, 'id'>, ttlMs = TTL) => {
      const id = Math.random().toString(36).slice(2);
      timers.current.set(id, setTimeout(() => dismiss(id), ttlMs));
      setToasts((prev) => [...prev.slice(-3), { ...t, id }]); // keep at most 4
    },
    [dismiss],
  );

  return (
    <Ctx.Provider value={{ push }}>
      {children}
      {toasts.length > 0 && (
        <div className="fixed bottom-6 right-4 z-50 flex w-[min(20rem,calc(100vw-2rem))] flex-col gap-2 sm:right-6">
          {toasts.map((t) => (
            <div key={t.id} className="flex items-stretch border border-ink bg-paper shadow-hard">
              <div className={`w-1 shrink-0 ${TONE_STRIPE[t.tone]}`} />
              <div className="flex min-w-0 flex-1 flex-col gap-1 px-3 py-2">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-bold text-ink">{t.title}</span>
                  <button onClick={() => dismiss(t.id)} className="text-xs text-muted hover:text-ink">
                    ✕
                  </button>
                </div>
                {t.detail && <span className="break-words text-xs text-muted">{t.detail}</span>}
                {t.action && (
                  <button
                    onClick={() => {
                      t.action?.onClick();
                      dismiss(t.id);
                    }}
                    className="self-start text-xs font-bold text-ink underline hover:no-underline"
                  >
                    {t.action.label}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Ctx.Provider>
  );
}
