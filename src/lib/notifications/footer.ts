import type { NotificationPreferences } from "./types";

// The bell panel's footer, as Marc's bell had it: "Daily email at 7:00 AM",
// or "Daily email is off". Moved here from src/components/NotificationBell.tsx
// when the dashboard took Socle's bell, which takes the footer as a prop.

function formatHm(hm: string) {
  const [h, m] = hm.split(":").map(Number);
  const d = new Date();
  d.setHours(h ?? 7, m ?? 0, 0, 0);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function bellFooterText(prefs: Pick<NotificationPreferences, "digest"> | null): string {
  return prefs?.digest.enabled ? `Daily email at ${formatHm(prefs.digest.sendAt)}` : "Daily email is off";
}
