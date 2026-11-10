// Settings shared by the service worker, the side panel and the options page.

// www, not the bare domain: Clerk's production keys only work on eisenq.app and
// its subdomains, so the *.vercel.app addresses show a blank sign-in page.
export const DEFAULT_APP_ORIGIN = "https://www.eisenq.app";

// Addresses an earlier version defaulted to that can never work, because sign-in
// doesn't load there. A stored value matching one is ignored.
const RETIRED_APP_ORIGINS = ["https://eisenq-lumevetech.vercel.app"];

// Only these origins may hand this extension a token. externally_connectable in
// the manifest already restricts who can message us; this re-checks the sender.
const TRUSTED_APP_ORIGINS = [/^http:\/\/localhost(:\d+)?$/, /^https:\/\/(www\.)?eisenq\.app$/];

// Same names, subtitles, numbering and colour tokens as the dashboard's matrix.
export const QUADRANTS = [
  { id: "urgent-important", name: "Do First", subtitle: "Urgent & Important", index: "01", color: "var(--q-do-first)" },
  { id: "important-not-urgent", name: "Schedule", subtitle: "Important & Not Urgent", index: "02", color: "var(--q-schedule)" },
  { id: "urgent-not-important", name: "Delegate", subtitle: "Urgent & Not Important", index: "03", color: "var(--q-delegate)" },
  { id: "not-urgent-not-important", name: "Eliminate", subtitle: "Not Urgent & Not Important", index: "04", color: "var(--q-eliminate)" },
];

// The app origin isn't secret, so it syncs. The token stays in local storage: it
// belongs to this one browser, and each browser connects (and is revoked) on its own.
export async function getAppOrigin() {
  const { appOrigin } = await chrome.storage.sync.get("appOrigin");
  const stored = (appOrigin || "").replace(/\/+$/, "");
  return stored && !RETIRED_APP_ORIGINS.includes(stored) ? stored : DEFAULT_APP_ORIGIN;
}

export async function getToken() {
  const { captureToken } = await chrome.storage.local.get("captureToken");
  return captureToken || null;
}

export function isTrustedOrigin(origin) {
  return typeof origin === "string" && TRUSTED_APP_ORIGINS.some((re) => re.test(origin));
}

export async function openConnectPage() {
  const origin = await getAppOrigin();
  await chrome.tabs.create({ url: new URL("/connect-extension", origin).toString() });
}
