"use client";

import { useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { Check, Copy, Loader2, PlugZap } from "lucide-react";
import { EXTENSION_ID } from "~/lib/extension";

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

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-950 p-6 text-white">
      <div className="flex w-full max-w-sm flex-col gap-5 rounded-2xl border border-gray-800 bg-gray-900/60 p-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white text-gray-950">
            <PlugZap className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-base font-semibold">Connect EisenQ Capture</h1>
            <p className="text-xs text-gray-400">Lets the extension add tasks to your matrix</p>
          </div>
        </div>

        <div className="rounded-lg border border-gray-800 bg-gray-950 px-3 py-2.5">
          <p className="text-[11px] uppercase tracking-wide text-gray-500">Account</p>
          <p className="truncate text-sm">
            {!isLoaded ? (
              <span className="text-gray-500">Loading…</span>
            ) : user ? (
              (email ?? "Signed in")
            ) : (
              <span className="text-gray-500">Not signed in</span>
            )}
          </p>
        </div>

        {phase === "detecting" && (
          <p className="flex items-center gap-2 text-sm text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Looking for the extension…
          </p>
        )}

        {(phase === "ready" || phase === "connecting") && (
          <button
            type="button"
            onClick={() => void connect()}
            disabled={phase === "connecting"}
            className="flex items-center justify-center gap-2 rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-gray-950 transition-opacity disabled:opacity-60"
          >
            {phase === "connecting" && <Loader2 className="h-4 w-4 animate-spin" />}
            Connect this browser
          </button>
        )}

        {phase === "connected" && (
          <div className="flex items-center gap-2 text-sm text-green-400">
            <Check className="h-4 w-4" /> Connected. This tab will close on its own.
          </div>
        )}

        {phase === "missing" && (
          <div className="flex flex-col gap-3 text-sm text-gray-300">
            <p>
              The EisenQ Capture extension isn&apos;t responding in this browser. Make sure it&apos;s
              installed and enabled in <code className="text-gray-100">chrome://extensions</code>,
              then reload this page.
            </p>
            <button
              type="button"
              onClick={() => void connectManually()}
              className="w-fit text-xs text-gray-400 underline underline-offset-2 hover:text-gray-200"
            >
              Connect manually with a code instead
            </button>
          </div>
        )}

        {phase === "manual" && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-gray-300">
              Paste this code into the extension&apos;s options page. It&apos;s shown only once.
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg border border-gray-800 bg-gray-950 px-3 py-2 text-xs select-all">
                {manualToken}
              </code>
              <button
                type="button"
                onClick={() => void copyToken()}
                className="flex shrink-0 items-center gap-1 rounded-lg border border-gray-700 px-2.5 py-2 text-xs hover:border-gray-500"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        )}

        {phase === "error" && <p className="text-sm text-red-400">{error}</p>}
      </div>
    </main>
  );
}
