// Reads what the user is capturing from a tab: its title and URL, any selected
// text, and on Gmail the open email's body and sent date.
//
// Page access comes from activeTab, which clicking the icon, the keyboard
// shortcut or the context menu grants for that tab until it navigates away —
// so no host permissions are needed. Restricted pages (chrome://, the Web Store)
// can't be read at all; everything here then degrades to the tab's own title.

// Longest title taken from a selection's first line (right-click capture).
const SELECTION_TITLE_MAX = 200;

function trimAtWord(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd() + "…";
}

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

// Where the selection goes depends on the gesture (docs/adr/0001):
//   mode "page"      — the icon, shortcut or panel: "capture this page". The
//                      tab's title is the title; the selection goes to notes.
//   mode "selection" — right-click on selected text: "capture this text". Its
//                      first line is the title; the whole selection also goes to
//                      notes when it has more lines or didn't fit.
export async function buildCapture(tab, selectionFromMenu, mode = "page") {
  // Read from the page first: unlike the menu's copy, it keeps line breaks.
  const selection = (await readSelection(tab.id)) || (selectionFromMenu ?? "").trim();
  const threadId = gmailThreadId(tab.url);
  const pageTitle = threadId ? cleanGmailTitle(tab.title ?? "") : (tab.title ?? "").trim();
  const message = threadId ? await readGmailMessage(tab.id) : { body: "", sentAt: "" };

  let title = pageTitle;
  let text = selection;
  if (mode === "selection" && selection) {
    const firstLine = selection.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
    title = trimAtWord(firstLine, SELECTION_TITLE_MAX);
    text = selection === title ? "" : selection;
  }

  return {
    title,
    text,
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
