// The EisenQ side panel: capture what's on this tab into a quadrant.
//
// One panel per tab. Chrome hides it when you switch to another tab and shows it
// again, as you left it, when you come back. The toolbar icon (or Alt+Shift+E)
// opens and folds it; see sw.js.
//
// Everything that comes from the page or the AI (titles, email text, quotes,
// labels) is inserted with textContent, never as HTML.

import { QUADRANTS, getToken, openConnectPage } from "./lib/config.js";
import { buildCapture, sourceFor } from "./lib/page.js";
import { findKeyDate, forgetToken, postCapture } from "./lib/api.js";

const app = document.getElementById("app");
const openedAt = Date.now();
let tabId = Number(new URLSearchParams(location.search).get("tabId"));

// ---------- tiny DOM helper ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "value") node.value = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// Static, trusted markup only.
function icon(name, size = 14) {
  const paths = {
    refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    spinner: '<path d="M21 12a9 9 0 1 1-6.22-8.56"/>',
  };
  const span = document.createElement("span");
  span.style.display = "inline-flex";
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${name === "spinner" ? ' class="spin"' : ""}>${paths[name]}</svg>`;
  return span;
}

function show(...nodes) {
  app.replaceChildren(...nodes.filter(Boolean));
}

// ---------- dates (local time, no library) ----------

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const endOfDayIso = (s) => {
  const d = parseYmd(s);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).toISOString();
};
const fmt = (d, opts) => new Intl.DateTimeFormat("en-US", opts).format(d);
const fmtDay = (d) =>
  fmt(d, d.getFullYear() === new Date().getFullYear()
    ? { weekday: "short", month: "short", day: "numeric" }
    : { weekday: "short", month: "short", day: "numeric", year: "numeric" });
const fmtFull = (d) => fmt(d, { weekday: "short", month: "short", day: "numeric", year: "numeric" });

const DEADLINE_CHIPS = [
  { key: "none", label: "No date" },
  { key: "today", label: "Today" },
  { key: "tomorrow", label: "Tomorrow" },
  { key: "3days", label: "3 days" },
  { key: "pick", label: "Pick…" },
];

// One-click due dates around a detected date, for reminding yourself ahead of it.
const REMINDER_OFFSETS = [
  { key: "day", daysBefore: 0, label: (d) => `On ${fmt(d, { month: "short", day: "numeric" })}` },
  { key: "week", daysBefore: 7, label: () => "1 week before" },
  { key: "month", daysBefore: 30, label: () => "30 days before" },
];

// ---------- messages from the service worker ----------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.tabId !== tabId) return false;
  if (msg.type === "panel:status") sendResponse({ openedAt });
  else if (msg.type === "panel:fold") window.close();
  else if (msg.type === "panel:refresh") void start();
  return false;
});

// Connecting (in another tab) or a revoked token switches the view.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "captureToken" in changes) void start();
  // A right-click capture on this tab just finished.
  const result = area === "session" ? changes[`result:${tabId}`]?.newValue : null;
  if (result) void showResult(result);
});

// ---------- views ----------

function header({ refresh = true, url = "" } = {}) {
  const left = el(
    "div",
    { class: "stack", style: "gap:2px;min-width:0" },
    el("span", { class: "label" }, "Capture"),
    el("h1", { class: "title" }, "Add to EisenQ"),
    url &&
      el(
        "a",
        { class: "source", href: url, target: "_blank", rel: "noopener noreferrer", title: url },
        icon("external", 12),
        el("span", {}, url.replace(/^https?:\/\//, "")),
      ),
  );
  const button =
    refresh &&
    el("button", { class: "iconbtn", type: "button", title: "Read the page again", onclick: () => void start() }, icon("refresh"));
  return el("div", { class: "head" }, left, button);
}

function renderLoading(text) {
  show(header({ refresh: false }), el("p", { class: "note row" }, icon("spinner", 12), text));
}

function renderConnect() {
  show(
    el(
      "div",
      { class: "card" },
      el("span", { class: "label" }, "EisenQ Capture"),
      el("h1", { class: "title" }, "Connect this browser"),
      el(
        "p",
        { class: "muted", style: "margin:0;font-size:13px" },
        "One-time step: link the panel to your EisenQ account so it can add tasks to your matrix.",
      ),
      el("button", { class: "primary", type: "button", onclick: () => void openConnectPage() }, "Connect to EisenQ"),
    ),
  );
}

function renderDone({ quadrantName, deduped, title }) {
  show(
    el(
      "div",
      { class: "card", style: "align-items:flex-start" },
      el("div", { class: "check" }, icon("check", 22)),
      el("h1", { class: "title", style: "font-size:24px" }, deduped ? "Already in EisenQ" : `Filed in ${quadrantName}`),
      title && el("p", { style: "margin:0;font-size:14px;color:var(--ink2)" }, `“${title}”`),
      el(
        "p",
        { class: "muted", style: "margin:0;font-size:13px" },
        deduped
          ? "This email is already a task in your matrix."
          : "The panel stays here. Fold it with the EisenQ icon.",
      ),
      el("button", { class: "link", type: "button", onclick: () => void start() }, "Capture something else"),
    ),
  );
}

function renderForm(capture, { retry = false } = {}) {
  const s = { deadline: "none", pickedDate: "", detection: { state: "idle" }, submitting: null, userChose: false };

  // --- static parts ---
  const titleInput = el("input", {
    class: "field",
    id: "title",
    maxlength: "500",
    placeholder: "What needs doing?",
    value: capture.title.slice(0, 500),
  });
  const notesInput = el("textarea", {
    class: "field",
    id: "notes",
    rows: "3",
    placeholder: "Anything worth remembering",
    value: capture.text,
  });
  const dateInput = el("input", {
    class: "field",
    type: "date",
    oninput: (e) => {
      s.userChose = true;
      s.pickedDate = e.target.value;
      refresh();
    },
  });

  const chipsRow = el("div", { class: "row" });
  const detectionNote = el("p", { class: "note", style: "margin:0" });
  const reminderRow = el("div", { class: "row" });
  const dueLine = el("p", { class: "note", style: "margin:0" });
  const errorLine = el("p", { class: "error", style: "margin:0" });
  const grid = el("div", { class: "grid" });

  // --- derived values ---
  const dueYmd = () => {
    const today = new Date();
    switch (s.deadline) {
      case "today": return ymd(today);
      case "tomorrow": return ymd(addDays(today, 1));
      case "3days": return ymd(addDays(today, 3));
      case "pick": return s.pickedDate || null;
      default: return null;
    }
  };

  const reminderOptions = () => {
    if (s.detection.state !== "found") return [];
    const target = parseYmd(s.detection.date);
    const today = ymd(new Date());
    return REMINDER_OFFSETS.map((o) => ({
      key: o.key,
      ymd: ymd(addDays(target, -o.daysBefore)),
      label: o.label(target),
    })).filter((o) => o.ymd >= today);
  };

  // A detected date selects the matching chip when there is one, else "Pick…".
  function applyDate(value) {
    const now = new Date();
    if (value === ymd(now)) s.deadline = "today";
    else if (value === ymd(addDays(now, 1))) s.deadline = "tomorrow";
    else if (value === ymd(addDays(now, 3))) s.deadline = "3days";
    else {
      s.deadline = "pick";
      s.pickedDate = value;
    }
  }

  // --- re-render the dynamic parts (inputs are never rebuilt, so typing keeps focus) ---
  function refresh() {
    chipsRow.replaceChildren(
      ...DEADLINE_CHIPS.map((c) =>
        el(
          "button",
          {
            class: `chip${s.deadline === c.key ? " on" : ""}`,
            type: "button",
            onclick: () => {
              s.userChose = true;
              s.deadline = c.key;
              refresh();
            },
          },
          c.label,
        ),
      ),
    );

    dateInput.style.display = s.deadline === "pick" ? "" : "none";
    if (dateInput.value !== s.pickedDate) dateInput.value = s.pickedDate;

    const d = s.detection;
    detectionNote.className = `note${d.state === "past" ? " warn" : ""}`;
    detectionNote.replaceChildren();
    if (d.state === "checking") {
      detectionNote.append(el("span", { class: "row" }, icon("spinner", 12), "Looking for a date…"));
    } else if (d.state === "found") {
      const when = fmtFull(parseYmd(d.date));
      const heading = d.label ?? (d.kind === "deadline" ? "Deadline found" : "Coming up");
      detectionNote.append(
        el("span", { class: "accent" }, d.kind === "event" || d.label ? `${heading} · ${when}` : heading),
        d.quote ? ` — “${d.quote}”` : "",
      );
    } else if (d.state === "past") {
      detectionNote.append(
        `Mentions ${fmt(parseYmd(d.date), { month: "short", day: "numeric", year: "numeric" })}`,
        d.label ? ` (${d.label})` : "",
        ", which has already passed",
        d.quote ? ` — “${d.quote}”` : "",
        ". Pick a date yourself if it still matters.",
      );
    } else if (d.state === "none") {
      detectionNote.append("No date mentioned.");
    } else if (d.state === "unconfigured") {
      detectionNote.append("Add a Gemini key in EisenQ's settings to fill this in automatically.");
    } else if (d.state === "unavailable") {
      detectionNote.append("Couldn't check for a date this time.");
    }
    detectionNote.style.display = d.state === "idle" ? "none" : "";

    const options = reminderOptions();
    const saved = dueYmd();
    reminderRow.replaceChildren(
      ...(options.length
        ? [
            el("span", { class: "note" }, "Remind me"),
            ...options.map((o) =>
              el(
                "button",
                {
                  class: `chip ghost${saved === o.ymd ? " on" : ""}`,
                  type: "button",
                  onclick: () => {
                    s.userChose = true;
                    applyDate(o.ymd);
                    refresh();
                  },
                },
                o.label,
              ),
            ),
          ]
        : []),
    );
    reminderRow.style.display = options.length ? "" : "none";

    dueLine.textContent = saved ? `Due ${fmtDay(parseYmd(saved))}` : "";
    dueLine.style.display = saved ? "" : "none";

    for (const button of grid.querySelectorAll("button")) {
      button.disabled = s.submitting !== null;
      const busy = button.dataset.quadrant === s.submitting;
      button.querySelector(".num").replaceChildren(busy ? icon("spinner", 13) : button.dataset.index);
    }
  }

  // --- the task description: notes, the key date, and the link back ---
  function description() {
    const parts = [];
    if (notesInput.value.trim()) parts.push(notesInput.value.trim());
    const d = s.detection;
    // A reminder set a month early must not lose what it is a reminder of.
    if (d.state === "found" && (d.kind === "event" || dueYmd() !== d.date)) {
      parts.push(`Key date: ${fmtFull(parseYmd(d.date))}${d.label ? ` — ${d.label}` : ""}`);
    }
    // The dashboard doesn't show a task's source yet, so the link also goes here.
    if (capture.url) parts.push(`Source: ${capture.url}`);
    return parts.join("\n\n").slice(0, 5000);
  }

  async function file(quadrant) {
    const title = titleInput.value.trim();
    if (!title) {
      errorLine.textContent = "Give it a title first.";
      titleInput.focus();
      return;
    }
    errorLine.textContent = "";
    s.submitting = quadrant.id;
    refresh();

    try {
      const due = dueYmd();
      const { status, data } = await postCapture({
        title: title.slice(0, 500),
        description: description() || undefined,
        quadrant: quadrant.id,
        dueDate: due ? endOfDayIso(due) : undefined,
        source: sourceFor(capture),
      });
      if (status === 401) {
        await forgetToken(); // switches to the connect view
        return;
      }
      if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
      renderDone({ quadrantName: quadrant.name, deduped: Boolean(data.deduped) });
    } catch {
      s.submitting = null;
      errorLine.textContent = "Couldn't save that. Check your connection and try again.";
      refresh();
    }
  }

  // --- quadrant cards ---
  for (const q of QUADRANTS) {
    const card = el(
      "button",
      { class: "quad", type: "button", "data-quadrant": q.id, "data-index": q.index, onclick: () => void file(q) },
      el(
        "span",
        { class: "top" },
        el("span", { class: "dot" }),
        el("span", { class: "name" }, q.name),
        el("span", { class: "num" }, q.index),
      ),
      el("span", { class: "sub" }, q.subtitle),
    );
    card.style.setProperty("--qc", q.color);
    grid.append(card);
  }

  // --- assemble ---
  const unreadable = !capture.title && !capture.url;
  show(
    header({ url: capture.url }),
    retry && el("p", { class: "note warn", style: "margin:0" }, "This didn't save earlier. Choose a quadrant to try again."),
    unreadable &&
      el("p", { class: "note", style: "margin:0" }, "Couldn't read this page, so type a title below."),
    el("div", { class: "stack" }, el("label", { class: "label", for: "title" }, "Title"), titleInput),
    el("div", { class: "stack" }, el("label", { class: "label", for: "notes" }, "Notes"), notesInput),
    el(
      "div",
      { class: "stack", style: "gap:8px" },
      el("span", { class: "label" }, "Deadline"),
      chipsRow,
      dateInput,
      detectionNote,
      reminderRow,
      dueLine,
    ),
    el("div", { class: "stack", style: "gap:8px" }, el("span", { class: "label" }, "File it in"), grid),
    errorLine,
  );
  refresh();
  titleInput.focus();
  titleInput.setSelectionRange(titleInput.value.length, titleInput.value.length);

  // --- look for a date in what was captured ---
  const text = [capture.text, capture.body].filter(Boolean).join("\n\n").slice(0, 8000);
  if (!capture.title.trim() && !text.trim()) return;
  s.detection = { state: "checking" };
  refresh();

  findKeyDate({ title: capture.title, text, sentAt: capture.sentAt })
    .then(({ status, data }) => {
      // Any failure here, a 401 included, only means "no date this time". Saving
      // is what decides whether the token is still good: an app that can't yet
      // check dates with a token must not disconnect the browser.
      if (status < 200 || status >= 300) s.detection = { state: "unavailable" };
      else if (data.configured === false) s.detection = { state: "unconfigured" };
      else if (!data.date) s.detection = { state: "none" };
      else {
        const found = {
          kind: data.kind === "deadline" ? "deadline" : "event",
          date: data.date,
          quote: data.quote ?? "",
          label: data.label ?? null,
        };
        if (data.past) s.detection = { state: "past", ...found };
        else {
          s.detection = { state: "found", ...found };
          // A deadline is the due date. An event isn't: the user picks how far
          // ahead to be reminded, from the "Remind me" options.
          if (found.kind === "deadline" && !s.userChose) applyDate(found.date);
        }
      }
      refresh();
    })
    .catch(() => {
      s.detection = { state: "unavailable" };
      refresh();
    });
}

// ---------- start ----------

// A one-click capture that failed to save is parked for this tab, so the panel
// can offer it again instead of losing it.
async function takePending() {
  const key = `pending:${tabId}`;
  const stored = await chrome.storage.session.get(key);
  if (!stored[key]) return null;
  await chrome.storage.session.remove(key);
  return stored[key];
}

// The outcome of a right-click capture, reported by the service worker.
let waitingForResult = false;

async function showResult(result) {
  waitingForResult = false;
  await chrome.storage.session.remove([`result:${tabId}`, `filing:${tabId}`]);
  if (result.ok) renderDone(result);
  else void start(); // connect view, or the parked capture ready to retry
}

async function start() {
  if (!Number.isInteger(tabId)) {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = active?.id ?? -1;
  }

  if (!(await getToken())) {
    renderConnect();
    return;
  }

  // Opened by a right-click capture: show its result, or wait for it.
  const keys = [`result:${tabId}`, `filing:${tabId}`];
  const stored = await chrome.storage.session.get(keys);
  if (stored[keys[0]]) {
    await showResult(stored[keys[0]]);
    return;
  }
  if (Date.now() - (stored[keys[1]] ?? 0) < 15000) {
    waitingForResult = true;
    renderLoading("Filing it…");
    // Never hang: if no result arrives, fall back to the normal form.
    setTimeout(() => {
      if (!waitingForResult) return;
      waitingForResult = false;
      void chrome.storage.session.remove(keys[1]).then(start);
    }, 15000);
    return;
  }

  renderLoading("Reading the page…");

  const pending = await takePending();
  if (pending) {
    renderForm(pending, { retry: true });
    return;
  }

  let capture = { title: "", text: "", url: "", pageTitle: "", kind: "page", body: "", sentAt: "" };
  try {
    const tab = await chrome.tabs.get(tabId);
    capture = await buildCapture(tab);
  } catch {
    /* tab closed or unreadable: an empty form still works */
  }
  renderForm(capture);
}

void start();
