"use client";

import { useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { Check, Copy, Loader2 } from "lucide-react";
import { EXTENSION_ID } from "~/lib/extension";
import { useEditorialTheme } from "~/hooks/useEditorialTheme";

// The slice of the extension messaging API a web page can see. `chrome.runtime`
// only exists on this page if an installed extension lists this origin in its
// externally_connectable — otherwise it is simply undefined, with no error.
interface ExtensionRuntime {
  sendMessage: (extensionId: string, message: unknown, callback: (response: unknown) => void) => void;
  lastError?: { message?: string };
}

function getRuntime(): ExtensionRuntime | null {
  const chromeGlobal = (globalThis as { chrome?: { runtime?: ExtensionRuntime } }).chrome;
  return chromeGlobal?.runtime?.sendMessage ? chromeGlobal.runtime : null;
}

// Resolves to the extension's reply, or null if it isn't installed, isn't
// listening for this origin, or doesn't answer in time. A wrong extension ID or a
// missing externally_connectable entry looks exactly like "not installed" from
// here, which is why the manual fallback below exists (Pitfall 16).
function sendToExtension(message: unknown, timeoutMs = 2000): Promise<unknown> {
  const runtime = getRuntime();
  if (!runtime) return Promise.resolve(null);

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    try {
      runtime.sendMessage(EXTENSION_ID, message, (response) => {
        clearTimeout(timer);
        resolve(runtime.lastError ? null : (response ?? null));
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

type Phase = "detecting" | "missing" | "ready" | "connecting" | "connected" | "manual" | "error";

export default function ConnectExtension() {
  useEditorialTheme();
  const { user, isLoaded } = useUser();
  const [phase, setPhase] = useState<Phase>("detecting");
  const [error, setError] = useState("");
  const [manualToken, setManualToken] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void sendToExtension({ type: "eisenq:ping" }).then((reply) => {
      setPhase(reply ? "ready" : "missing");
    });
  }, []);

  async function mintToken(): Promise<string | null> {
    const res = await fetch("/api/capture/connect", { method: "POST" });
    const data = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
    if (!res.ok || !data.token) {
      setError(data.error ?? "Couldn't create a connection. Try again.");
      setPhase("error");
      return null;
    }
    return data.token;
  }

  // Minting happens only here, behind an explicit click — never on page load.
  async function connect() {
    setError("");
    setPhase("connecting");

    const token = await mintToken();
    if (!token) return;

    const ack = await sendToExtension({ type: "eisenq:token", token });
    if (ack) {
      setPhase("connected"); // the extension closes this tab itself
      return;
    }

    // The token exists but never reached the extension. Show it rather than
    // waste it, so the user can paste it into the extension's options.
    setManualToken(token);
    setPhase("manual");
  }

  async function connectManually() {
    setError("");
    setPhase("connecting");
    const token = await mintToken();
    if (!token) return;
    setManualToken(token);
    setPhase("manual");
  }

  async function copyToken() {
    try {
      await navigator.clipboard.writeText(manualToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* the code is visible and selectable regardless */
    }
  }

  const email = user?.primaryEmailAddress?.emailAddress;

  const label = "text-[10px] tracking-[0.14em] uppercase";

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div
        className="flex w-full max-w-[380px] flex-col gap-5 rounded-2xl p-7"
        style={{
          background: "var(--surface)",
          border: "1px solid var(--surface-bd)",
          boxShadow: "0 14px 34px -20px rgba(70,55,30,0.45)",
        }}
      >
        <div className="flex flex-col gap-1">
          <span className={label} style={{ color: "var(--muted2)" }}>
            EisenQ Capture
          </span>
          <h1 style={{ fontFamily: "var(--font-serif)", color: "var(--ink)" }} className="text-[26px] leading-tight">
            Connect this browser
          </h1>
          <p className="text-[13px]" style={{ color: "var(--muted)" }}>
            Lets the extension add tasks straight to your matrix.
          </p>
        </div>

        <div className="rounded-[10px] px-3.5 py-2.5" style={{ background: "var(--field)", border: "1px solid var(--field-bd)" }}>
          <p className={label} style={{ color: "var(--muted2)" }}>
            Account
          </p>
          <p className="truncate text-[14px]" style={{ color: "var(--ink)" }}>
            {!isLoaded ? (
              <span style={{ color: "var(--muted)" }}>Loading…</span>
            ) : user ? (
              (email ?? "Signed in")
            ) : (
              <span style={{ color: "var(--muted)" }}>Not signed in</span>
            )}
          </p>
        </div>

        {phase === "detecting" && (
          <p className="flex items-center gap-2 text-[13px]" style={{ color: "var(--muted)" }}>
            <Loader2 className="h-4 w-4 animate-spin" /> Looking for the extension…
          </p>
        )}

        {(phase === "ready" || phase === "connecting") && (
          <button
            type="button"
            onClick={() => void connect()}
            disabled={phase === "connecting"}
            className="flex items-center justify-center gap-2 rounded-[10px] px-4 py-2.5 text-[14px] font-medium transition-opacity hover:opacity-90 disabled:opacity-60"
            style={{ background: "var(--btn-primary)", color: "var(--btn-fg)" }}
          >
            {phase === "connecting" && <Loader2 className="h-4 w-4 animate-spin" />}
            Connect
          </button>
        )}

        {phase === "connected" && (
          <div className="flex items-center gap-2 text-[14px]" style={{ color: "var(--ink)" }}>
            <span
              className="flex h-6 w-6 items-center justify-center rounded-full"
              style={{ background: "var(--pill-active)", color: "var(--btn-fg)" }}
            >
              <Check className="h-3.5 w-3.5" />
            </span>
            Connected. This tab will close on its own.
          </div>
        )}

        {phase === "missing" && (
          <div className="flex flex-col gap-3 text-[13px]" style={{ color: "var(--ink3)" }}>
            <p>
              The EisenQ Capture extension isn&apos;t responding in this browser. Make sure it&apos;s
              installed and turned on in <code style={{ color: "var(--ink)" }}>chrome://extensions</code>,
              then reload this page.
            </p>
            <button
              type="button"
              onClick={() => void connectManually()}
              className="w-fit text-[12px] underline underline-offset-2"
              style={{ color: "var(--muted)" }}
            >
              Connect manually with a code instead
            </button>
          </div>
        )}

        {phase === "manual" && (
          <div className="flex flex-col gap-2">
            <p className="text-[13px]" style={{ color: "var(--ink3)" }}>
              Paste this code into the extension&apos;s options page. It&apos;s shown only once.
            </p>
            <div className="flex items-center gap-2">
              <code
                className="min-w-0 flex-1 truncate rounded-[10px] px-3 py-2 text-[12px] select-all"
                style={{ background: "var(--field)", border: "1px solid var(--field-bd)", color: "var(--ink)" }}
              >
                {manualToken}
              </code>
              <button
                type="button"
                onClick={() => void copyToken()}
                className="flex shrink-0 items-center gap-1 rounded-[10px] px-2.5 py-2 text-[12px]"
                style={{ background: "var(--chip)", border: "1px solid var(--line)", color: "var(--ink2)" }}
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        )}

        {phase === "error" && (
          <p className="text-[13px]" style={{ color: "var(--tag-fg)" }}>
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
