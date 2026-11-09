// EisenQ Capture — service worker.
//
// Two ways to file a task:
//   • Icon / Alt+Shift+E / "Open full form…" — opens the app's /capture page in a
//     small window (Phase 0). Uses the normal signed-in session; no token needed.
//   • Right-click → Add to EisenQ ▸ <quadrant> — files it in one click with a
//     direct POST to /api/capture, authenticated by the capture token this
//     extension received from the app's /connect-extension page (Phase 1).
// See docs/chrome-extension-capture-design.md.

// www, not the bare domain: Clerk's production keys only work on eisenq.app and
// its subdomains, so the *.vercel.app addresses show a blank sign-in page.
const DEFAULT_APP_ORIGIN = "https://www.eisenq.app";

// Addresses an earlier version defaulted to that can never work, because sign-in
// doesn't load there. A stored value matching one is ignored.
const RETIRED_APP_ORIGINS = ["https://eisenq-lumevetech.vercel.app"];

// Only these origins may hand this extension a token. externally_connectable in
// the manifest already restricts who can message us; this re-checks the sender.
const TRUSTED_APP_ORIGINS = [/^http:\/\/localhost(:\d+)?$/, /^https:\/\/(www\.)?eisenq\.app$/];

// A selection shorter than this becomes the task title; anything longer is treated
// as notes and the page title is used instead. Picking one offer off a page of
// them is the common case, and that text makes a far better title.
const TITLE_FROM_SELECTION_MAX = 120;

const WINDOW_WIDTH = 480;
const WINDOW_HEIGHT = 700;

const QUADRANTS = [
  { id: "urgent-important", title: "Do First" },
  { id: "important-not-urgent", title: "Schedule" },
  { id: "urgent-not-important", title: "Delegate" },
  { id: "not-urgent-not-important", title: "Eliminate" },
];

// ---------- storage ----------
// The app origin isn't secret, so it syncs. The token stays in local storage: it
// belongs to this one browser, and each browser connects (and is revoked) on its own.

async function getAppOrigin() {
  const { appOrigin } = await chrome.storage.sync.get("appOrigin");
  const stored = (appOrigin || "").replace(/\/+$/, "");
  return stored && !RETIRED_APP_ORIGINS.includes(stored) ? stored : DEFAULT_APP_ORIGIN;
}

async function getToken() {
  const { captureToken } = await chrome.storage.local.get("captureToken");
  return captureToken || null;
}

function isTrustedOrigin(origin) {
  return typeof origin === "string" && TRUSTED_APP_ORIGINS.some((re) => re.test(origin));
}

// ---------- page context ----------

// activeTab is granted by the action click, the keyboard command and the context
// menu, so this works without host permissions — but not on chrome:// pages.
async function readSelection(tabId) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.getSelection()?.toString() ?? "",
    });
    return (injection?.result ?? "").trim();
  } catch {
    return "";
  }
}

// Gmail keeps the open thread's id at the end of the URL hash
// (…/#inbox/FMfcgzQ…). It is the one stable per-item id we can dedupe on.
function gmailThreadId(url) {
  if (!url?.startsWith("https://mail.google.com/")) return null;
  const match = /#[^?]*\/([A-Za-z0-9]{16,})$/.exec(url);
  return match ? match[1] : null;
}

// "Re: Q4 budget - marc@example.com - Gmail" → "Re: Q4 budget"
function cleanGmailTitle(title) {
  return title.replace(/\s+-\s+\S+@\S+\s+-\s+Gmail$/, "").trim();
}

// The open email's text and the date it was sent, for deadline detection. The
// sent date matters: "6 days to file" means six days from when it was sent.
// Gmail's `a3s` (message body) and `g3` (date) classes have been stable for
// years, but this is still best-effort — on any miss the capture simply goes
// ahead without them.
async function readGmailMessage(tabId) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const visible = (el) => el.offsetParent !== null;
        // In a thread, the last expanded message is the one being read.
        const bodies = [...document.querySelectorAll("div.a3s")].filter(
          (el) => visible(el) && el.innerText.trim(),
        );
        const dates = [...document.querySelectorAll("span.g3")].filter(visible);
        const body = bodies.length ? bodies[bodies.length - 1].innerText : "";
        const date = dates[dates.length - 1];
        const sentAt = date ? date.getAttribute("title") || date.innerText : "";
        return { body: body.trim().slice(0, 8000), sentAt: sentAt.trim().slice(0, 100) };
      },
    });
    return injection?.result ?? { body: "", sentAt: "" };
  } catch {
    return { body: "", sentAt: "" };
  }
}

async function buildCapture(tab, selectionFromMenu) {
  const selection = (selectionFromMenu ?? "").trim() || (await readSelection(tab.id));
  const threadId = gmailThreadId(tab.url);
  const pageTitle = threadId ? cleanGmailTitle(tab.title ?? "") : (tab.title ?? "").trim();
  const message = threadId ? await readGmailMessage(tab.id) : { body: "", sentAt: "" };

  const useSelectionAsTitle = selection.length > 0 && selection.length <= TITLE_FROM_SELECTION_MAX;

  return {
    title: useSelectionAsTitle ? selection : pageTitle,
    text: useSelectionAsTitle ? "" : selection,
    url: tab.url ?? "",
    pageTitle,
    kind: threadId ? "gmail" : selection ? "selection" : "page",
    externalId: threadId ?? undefined,
    // Only read for deadline detection on the form — never stored with the task.
    body: message.body,
    sentAt: message.sentAt,
  };
}

// ---------- full-form window (Phase 0 path) ----------

async function openCaptureWindow(tab, capture) {
  const origin = await getAppOrigin();
  const url = new URL("/capture", origin);
  if (capture.title) url.searchParams.set("title", capture.title);
  if (capture.url) url.searchParams.set("url", capture.url);
  if (capture.text) url.searchParams.set("text", capture.text);
  // The email body rides in the #fragment, which the browser never sends to the
  // server — so it stays out of request logs and redirect URLs. The form reads
  // it client-side and posts it, in a request body, to the deadline check.
  if (capture.body || capture.sentAt) {
    url.hash = "ctx=" + encodeURIComponent(JSON.stringify({ body: capture.body, sentAt: capture.sentAt }));
  }

  // Centre over the current window so it lands on the same screen.
  const parent = await chrome.windows.get(tab.windowId).catch(() => null);
  const left =
    parent?.left != null && parent?.width != null
      ? Math.round(parent.left + (parent.width - WINDOW_WIDTH) / 2)
      : undefined;
  const top = parent?.top != null ? parent.top + 80 : undefined;

  await chrome.windows.create({
    url: url.toString(),
    type: "popup",
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    left,
    top,
  });
}

async function openConnectPage() {
  const origin = await getAppOrigin();
  await chrome.tabs.create({ url: new URL("/connect-extension", origin).toString() });
}

// ---------- one-click capture (Phase 1 path) ----------

async function flashBadge(tabId, text, color, title) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setBadgeText({ tabId, text });
    if (title) await chrome.action.setTitle({ tabId, title });
    setTimeout(() => {
      void chrome.action.setBadgeText({ tabId, text: "" }).catch(() => undefined);
      void chrome.action.setTitle({ tabId, title: "Add to EisenQ" }).catch(() => undefined);
    }, 3000);
  } catch {
    /* the tab may have closed */
  }
}

async function quickCapture(tab, quadrant, selectionFromMenu) {
  const capture = await buildCapture(tab, selectionFromMenu);

  const token = await getToken();
  if (!token) {
    await openConnectPage();
    return;
  }

  if (!capture.title) {
    // Nothing usable to title it with; let the user write one.
    await openCaptureWindow(tab, capture);
    return;
  }

  const source = /^https?:\/\//i.test(capture.url)
    ? {
        kind: capture.kind,
        url: capture.url,
        title: capture.pageTitle || undefined,
        externalId: capture.externalId,
      }
    : undefined;

  try {
    const origin = await getAppOrigin();
    const res = await fetch(new URL("/api/capture", origin), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Capture-Token": token },
      body: JSON.stringify({
        title: capture.title.slice(0, 500),
        description: capture.text ? capture.text.slice(0, 5000) : undefined,
        quadrant,
        source,
      }),
    });

    if (res.status === 401) {
      // Revoked in the app, or never valid for this origin. Reconnect.
      await chrome.storage.local.remove("captureToken");
      await openConnectPage();
      return;
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const { deduped } = await res.json();
    const name = QUADRANTS.find((q) => q.id === quadrant)?.title ?? "EisenQ";
    await flashBadge(
      tab.id,
      "✓",
      "#16a34a",
      deduped ? "Already in EisenQ" : `Added to ${name}`,
    );
  } catch {
    // Network or server failure. Never drop a capture: fall back to the form,
    // which keeps everything the user selected.
    await flashBadge(tab.id, "!", "#dc2626", "Couldn't reach EisenQ — opened the form instead");
    await openCaptureWindow(tab, capture);
  }
}

// ---------- token handoff from /connect-extension ----------

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!isTrustedOrigin(sender.origin)) return false;

  if (message?.type === "eisenq:ping") {
    void getToken().then((token) => sendResponse({ ok: true, connected: Boolean(token) }));
    return true; // async response
  }

  if (message?.type === "eisenq:token" && typeof message.token === "string" && message.token.startsWith("eqc_")) {
    void (async () => {
      await chrome.storage.local.set({ captureToken: message.token, connectedAt: Date.now() });
      // Point every future capture at the app that just connected us, so
      // connecting from localhost or from the deployed app both just work.
      await chrome.storage.sync.set({ appOrigin: sender.origin });
      sendResponse({ ok: true });

      // The page can't close a tab it didn't open, so we close it for them.
      const tabId = sender.tab?.id;
      if (tabId != null) setTimeout(() => void chrome.tabs.remove(tabId).catch(() => undefined), 1500);
    })();
    return true; // async response
  }

  return false;
});

// ---------- entry points ----------

chrome.action.onClicked.addListener((tab) => {
  void buildCapture(tab).then((capture) => openCaptureWindow(tab, capture));
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "capture" && tab) {
    void buildCapture(tab).then((capture) => openCaptureWindow(tab, capture));
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    const contexts = ["page", "selection", "link"];
    chrome.contextMenus.create({ id: "eisenq", title: "Add to EisenQ", contexts });
    for (const q of QUADRANTS) {
      chrome.contextMenus.create({ id: `eisenq:${q.id}`, parentId: "eisenq", title: q.title, contexts });
    }
    chrome.contextMenus.create({ id: "eisenq:sep", parentId: "eisenq", type: "separator", contexts });
    chrome.contextMenus.create({ id: "eisenq:form", parentId: "eisenq", title: "Open full form…", contexts });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id || typeof info.menuItemId !== "string") return;

  if (info.menuItemId === "eisenq:form") {
    void buildCapture(tab, info.selectionText).then((capture) => openCaptureWindow(tab, capture));
    return;
  }

  const quadrant = info.menuItemId.replace(/^eisenq:/, "");
  if (QUADRANTS.some((q) => q.id === quadrant)) {
    void quickCapture(tab, quadrant, info.selectionText);
  }
});
