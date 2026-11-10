// Reads what the user is capturing from a tab: its title and URL, any selected
// text, and on Gmail the open email's body and sent date.
//
// Page access comes from activeTab, which clicking the icon, the keyboard
// shortcut or the context menu grants for that tab until it navigates away —
// so no host permissions are needed. Restricted pages (chrome://, the Web Store)
// can't be read at all; everything here then degrades to the tab's own title.

// A selection shorter than this becomes the task title; anything longer is treated
// as notes and the page title is used instead. Picking one offer off a page of
// them is the common case, and that text makes a far better title.
const TITLE_FROM_SELECTION_MAX = 120;

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
export function gmailThreadId(url) {
  if (!url?.startsWith("https://mail.google.com/")) return null;
  const match = /#[^?]*\/([A-Za-z0-9]{16,})$/.exec(url);
  return match ? match[1] : null;
}

// "Re: Q4 budget - marc@example.com - Gmail" → "Re: Q4 budget"
function cleanGmailTitle(title) {
  return title.replace(/\s+-\s+\S+@\S+\s+-\s+Gmail$/, "").trim();
}

// The open email's text and the date it was sent, for date detection. The sent
// date matters: "6 days to file" means six days from when it was sent. Gmail's
// `a3s` (message body) and `g3` (date) classes have been stable for years, but
// this is still best-effort — on any miss the capture goes ahead without them.
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

export async function buildCapture(tab, selectionFromMenu) {
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
    // Only read for date detection — never stored with the task.
    body: message.body,
    sentAt: message.sentAt,
  };
}

// The task's link back, in the shape POST /api/capture expects. Only http(s)
// pages qualify; the server rejects anything else.
export function sourceFor(capture) {
  if (!/^https?:\/\//i.test(capture.url)) return undefined;
  return {
    kind: capture.kind,
    url: capture.url,
    title: capture.pageTitle || undefined,
    externalId: capture.externalId,
  };
}
