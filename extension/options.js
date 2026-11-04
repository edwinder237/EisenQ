const DEFAULT_APP_ORIGIN = "http://localhost:3000";

const originInput = document.getElementById("origin");
const statusEl = document.getElementById("status");

chrome.storage.sync.get("appOrigin").then(({ appOrigin }) => {
  originInput.value = appOrigin || DEFAULT_APP_ORIGIN;
});

document.getElementById("save").addEventListener("click", async () => {
  const raw = originInput.value.trim().replace(/\/+$/, "");

  let origin;
  try {
    origin = new URL(raw || DEFAULT_APP_ORIGIN).origin;
  } catch {
    statusEl.style.color = "#f87171";
    statusEl.textContent = "Not a valid URL";
    return;
  }

  await chrome.storage.sync.set({ appOrigin: origin });
  originInput.value = origin;
  statusEl.style.color = "#4ade80";
  statusEl.textContent = "Saved";
  setTimeout(() => (statusEl.textContent = ""), 1500);
});
