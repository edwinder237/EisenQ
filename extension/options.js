const DEFAULT_APP_ORIGIN = "https://eisenq-lumevetech.vercel.app";

const $ = (id) => document.getElementById(id);

function showMessage(el, text, ok) {
  el.style.color = ok ? "#4ade80" : "#f87171";
  el.textContent = text;
  if (ok) setTimeout(() => (el.textContent = ""), 2000);
}

async function getAppOrigin() {
  const { appOrigin } = await chrome.storage.sync.get("appOrigin");
  return (appOrigin || DEFAULT_APP_ORIGIN).replace(/\/+$/, "");
}

async function render() {
  const [{ captureToken, connectedAt }, origin] = await Promise.all([
    chrome.storage.local.get(["captureToken", "connectedAt"]),
    getAppOrigin(),
  ]);

  const connected = Boolean(captureToken);
  $("dot").classList.toggle("on", connected);
  $("status-text").textContent = connected
    ? `Connected to ${new URL(origin).host}${connectedAt ? ` since ${new Date(connectedAt).toLocaleDateString()}` : ""}`
    : "Not connected";
  $("connect").textContent = connected ? "Reconnect" : "Connect to EisenQ";
  $("disconnect").hidden = !connected;
  $("disconnect-note").hidden = !connected;
  $("origin").value = origin;
}

$("connect").addEventListener("click", async () => {
  const origin = await getAppOrigin();
  await chrome.tabs.create({ url: new URL("/connect-extension", origin).toString() });
});

$("disconnect").addEventListener("click", async () => {
  await chrome.storage.local.remove(["captureToken", "connectedAt"]);
  await render();
});

$("save-origin").addEventListener("click", async () => {
  const raw = $("origin").value.trim().replace(/\/+$/, "");
  let origin;
  try {
    origin = new URL(raw || DEFAULT_APP_ORIGIN).origin;
  } catch {
    showMessage($("origin-msg"), "Not a valid URL", false);
    return;
  }
  await chrome.storage.sync.set({ appOrigin: origin });
  showMessage($("origin-msg"), "Saved", true);
  await render();
});

$("save-code").addEventListener("click", async () => {
  const code = $("code").value.trim();
  if (!/^eqc_[A-Za-z0-9_-]{40,}$/.test(code)) {
    showMessage($("code-msg"), "That doesn't look like an EisenQ code", false);
    return;
  }
  await chrome.storage.local.set({ captureToken: code, connectedAt: Date.now() });
  $("code").value = "";
  showMessage($("code-msg"), "Connected", true);
  await render();
});

// Reflect a connection made in another tab while this page is open.
chrome.storage.onChanged.addListener(() => void render());

void render();
