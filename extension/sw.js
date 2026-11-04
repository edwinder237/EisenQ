// EisenQ Capture — Phase 0 (window hand-off).
//
// There is no API token and no CORS here by design: the extension only opens the app's
// own /capture page in a small window, and the user's existing Clerk cookie session
// authenticates the task creation. Phase 1 replaces this with a direct POST.
// See docs/chrome-extension-capture-design.md.

const DEFAULT_APP_ORIGIN = "http://localhost:3000";

// A selection shorter than this becomes the task title; anything longer is treated as
// notes and the page title is used instead. Picking an offer or a line out of an email
// is the common case, and that text makes a far better title than "Offers | PC Optimum".
const TITLE_FROM_SELECTION_MAX = 120;

const WINDOW_WIDTH = 480;
const WINDOW_HEIGHT = 700;

async function getAppOrigin() {
  const { appOrigin } = await chrome.storage.sync.get("appOrigin");
  return (appOrigin || DEFAULT_APP_ORIGIN).replace(/\/+$/, "");
}

// activeTab is granted by the action click, the keyboard command and the context menu,
// so this works without host permissions — but not on chrome:// pages or the Web Store.
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

async function openCaptureWindow(tab, selectionFromMenu) {
  if (!tab?.id) return;

  const selection = (selectionFromMenu ?? "").trim() || (await readSelection(tab.id));
  const pageTitle = (tab.title ?? "").trim();

  const useSelectionAsTitle =
    selection.length > 0 && selection.length <= TITLE_FROM_SELECTION_MAX;

  const title = useSelectionAsTitle ? selection : pageTitle;
  const text = useSelectionAsTitle ? "" : selection;

  const origin = await getAppOrigin();
  const url = new URL("/capture", origin);
  if (title) url.searchParams.set("title", title);
  if (tab.url) url.searchParams.set("url", tab.url);
  if (text) url.searchParams.set("text", text);

  // Offset from the current window so the popup lands on the same screen rather than
  // wherever Chrome last left one.
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

chrome.action.onClicked.addListener((tab) => {
  void openCaptureWindow(tab);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "capture") void openCaptureWindow(tab);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "eisenq-capture",
    title: "Add to EisenQ",
    contexts: ["page", "selection", "link"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "eisenq-capture") return;
  void openCaptureWindow(tab, info.selectionText);
});
