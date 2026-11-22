"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";

// One confirmation dialog for the whole app, in place of the browser's
// confirm(). Usage:
//   const confirm = useConfirm();
//   if (await confirm({ title: "Delete task?", confirmLabel: "Delete", destructive: true })) …

export type ConfirmOptions = {
  title: string;
  /** One line on what happens. Optional. */
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button, for actions that remove or revoke something. */
  destructive?: boolean;
};

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((o) => {
    // A second request while one is open answers the first with "no".
    resolver.current?.(false);
    setOpts(o);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOpts(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog.Root open={opts !== null} onOpenChange={(open) => { if (!open) close(false); }}>
        <Dialog.Portal>
          {/* Above every other overlay in the app (the highest is z-[100]). */}
          <Dialog.Overlay className="fixed inset-0 z-[200]" style={{ background: "var(--overlay)", animation: "fadeIn .15s ease" }} />
          <Dialog.Content
            className="fixed left-1/2 top-1/2 z-[201] w-[calc(100%-32px)] max-w-[400px] -translate-x-1/2 -translate-y-1/2 rounded-[16px] focus:outline-none"
            style={{ background: "var(--drawer)", border: "1px solid var(--drawer-bd)", padding: "22px 22px 18px", boxShadow: "0 20px 60px rgba(0,0,0,.35)" }}
          >
            <Dialog.Title className="text-[17px] font-semibold" style={{ color: "var(--ink)" }}>
              {opts?.title}
            </Dialog.Title>
            {opts?.message ? (
              <Dialog.Description className="mt-1.5 text-[13.5px] leading-snug" style={{ color: "var(--muted)" }}>
                {opts.message}
              </Dialog.Description>
            ) : (
              <Dialog.Description className="sr-only">Confirm this action</Dialog.Description>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                // Destructive: start on Cancel, so a stray Enter doesn't delete.
                autoFocus={opts?.destructive}
                onClick={() => close(false)}
                className="text-[13px] rounded-[10px]"
                style={{ padding: "9px 18px", border: "1px solid var(--field-bd)", color: "var(--ink2)" }}
              >
                {opts?.cancelLabel ?? "Cancel"}
              </button>
              <button
                autoFocus={!opts?.destructive}
                onClick={() => close(true)}
                className="text-[13px] font-semibold rounded-[10px]"
                style={
                  opts?.destructive
                    ? { padding: "9px 18px", background: "#b91c1c", color: "#fff" }
                    : { padding: "9px 18px", background: "var(--btn-primary)", color: "var(--btn-fg)" }
                }
              >
                {opts?.confirmLabel ?? "Confirm"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used inside <ConfirmProvider>");
  return ctx;
}
