// EisenQ Capture — service worker.
//
// Two ways to file a task:
//   • The side panel (panel.html) — the EisenQ icon or Alt+Shift+E opens it next
//     to the page and folds it again; right-click → "Open panel…" opens it too.
//     One panel per tab: Chrome hides it when you switch tabs and brings it back,
//     as you left it, when you return.
//   • Right-click → Add to EisenQ ▸ <quadrant> — files it in one click, no panel.
// Both save with the capture token this extension received from the app's
// /connect-extension page. See docs/chrome-extension-capture-design.md.

import { QUADRANTS, getToken, isTrustedOrigin, openConnectPage } from "./lib/config.js";
import { buildCapture, sourceFor } from "./lib/page.js";
import { forgetToken, postCapture } from "./lib/api.js";

// ---------- side panel ----------

// Only tab-specific panels exist. With the global panel off, switching to a tab
// that has no panel of its own hides the panel instead of showing a shared one.
// The icon click is handled here (not by Chrome) so it grants activeTab, which is
// how the panel is allowed to read the page.
void chrome.sidePanel.setOptions({ enabled: false }).catch(() => undefined);
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);

// Both calls must go out immediately: open() only works inside the user's click,
// so nothing may be awaited before it.
function openPanel(tabId) {
  void chrome.sidePanel
    .setOptions({ tabId, path: `panel.html?tabId=${tabId}`, enabled: true })
    .catch(() => undefined);
  void chrome.sidePanel.open({ tabId }).catch(() => undefined);
}

// The icon toggles the panel. Whether it was already open can only be learned
// asynchronously — too late to decide whether to open — so the click always
// opens (a no-op if it's open), then asks the tab's panel how long it has been
// open. One that predates the click means this click was meant to fold it.
function togglePanel(tab) {
  if (tab?.id == null) return;
  const tabId = tab.id;
  const clickedAt = Date.now();
  openPanel(tabId);
  void clearBadge(tabId);

  void (async () => {
    const reply = await chrome.runtime.sendMessage({ type: "panel:status", tabId }).catch(() => null);
    if (!reply?.openedAt || reply.openedAt >= clickedAt - 300) return;
    // close() is Chrome 141+; the panel can also close itself, which covers
    // older versions. Whichever lands first wins; the other is a no-op.
    if (chrome.sidePanel.close) await chrome.sidePanel.close({ tabId }).catch(() => undefined);
    await chrome.runtime.sendMessage({ type: "panel:fold", tabId }).catch(() => undefined);
  })();
}

// ---------- badge ----------

async function setBadge(tabId, text, color, title) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setTitle({ tabId, title });
  } catch {
    /* the tab may have closed */
  }
}

async function clearBadge(tabId) {
  await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => undefined);
  await chrome.action.setTitle({ tabId, title: "EisenQ" }).catch(() => undefined);
}

// ---------- one-click capture ----------

async function quickCapture(tab, quadrant, selectionFromMenu) {
  const capture = await buildCapture(tab, selectionFromMenu);

  if (!(await getToken())) {
    await openConnectPage();
    return;
  }

  // A capture that can't be saved is parked for the tab, and the panel offers it
  // again the next time it opens there. Nothing the user picked is lost.
  const park = async (why) => {
    await chrome.storage.session.set({ [`pending:${tab.id}`]: capture });
    await setBadge(tab.id, "!", "#dc2626", `${why} Click the EisenQ icon to finish it.`);
  };

  if (!capture.title) {
    await park("Nothing to title this with.");
    return;
  }

  try {
    const { status, data } = await postCapture({
      title: capture.title.slice(0, 500),
      description: capture.text ? capture.text.slice(0, 5000) : undefined,
      quadrant,
      source: sourceFor(capture),
    });

    if (status === 401) {
      // Revoked in the app, or never valid for this origin. Reconnect.
      await forgetToken();
      await openConnectPage();
      return;
    }
    if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);

    const name = QUADRANTS.find((q) => q.id === quadrant)?.name ?? "EisenQ";
    await setBadge(tab.id, "✓", "#16a34a", data.deduped ? "Already in EisenQ" : `Added to ${name}`);
    setTimeout(() => void clearBadge(tab.id), 3000);
  } catch {
    await park("Couldn't reach EisenQ.");
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

chrome.action.onClicked.addListener((tab) => togglePanel(tab));

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "capture") togglePanel(tab);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    const contexts = ["page", "selection", "link"];
    chrome.contextMenus.create({ id: "eisenq", title: "Add to EisenQ", contexts });
    for (const q of QUADRANTS) {
      chrome.contextMenus.create({ id: `eisenq:${q.id}`, parentId: "eisenq", title: q.name, contexts });
    }
    chrome.contextMenus.create({ id: "eisenq:sep", parentId: "eisenq", type: "separator", contexts });
    chrome.contextMenus.create({ id: "eisenq:panel", parentId: "eisenq", title: "Open panel…", contexts });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (tab?.id == null || typeof info.menuItemId !== "string") return;

  if (info.menuItemId === "eisenq:panel") {
    openPanel(tab.id);
    void clearBadge(tab.id);
    // An already-open panel re-reads the page, picking up what was just selected.
    void chrome.runtime.sendMessage({ type: "panel:refresh", tabId: tab.id }).catch(() => undefined);
    return;
  }

  const quadrant = info.menuItemId.replace(/^eisenq:/, "");
  if (QUADRANTS.some((q) => q.id === quadrant)) {
    void quickCapture(tab, quadrant, info.selectionText);
  }
});

// A closed tab's parked capture has nowhere to go.
chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.remove(`pending:${tabId}`).catch(() => undefined);
});
