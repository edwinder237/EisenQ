import { getAppOrigin, getToken } from "./config.js";

// Calls to the EisenQ app, authenticated by the capture token this browser got
// when it connected. Each returns { status, data } and never throws for an HTTP
// error; network failures throw.

async function post(path, body) {
  const [origin, token] = await Promise.all([getAppOrigin(), getToken()]);
  const res = await fetch(new URL(path, origin), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Capture-Token": token ?? "" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// Files a task. { title, description?, quadrant, dueDate?, source? }
export function postCapture(task) {
  return post("/api/capture", task);
}

// Asks for the date that matters in what was captured: a deadline or an event.
export function findKeyDate({ title, text, sentAt }) {
  return post("/api/capture/deadline", {
    title,
    text,
    sentAt: sentAt || undefined,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
}

// A revoked or unknown token. The caller forgets it so the panel asks to reconnect.
export async function forgetToken() {
  await chrome.storage.local.remove(["captureToken", "connectedAt"]);
}
