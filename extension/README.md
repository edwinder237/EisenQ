# EisenQ Capture — Phase 0

A deliberately minimal Chrome extension that files the page you're on into an EisenQ quadrant.

This is the **Phase 0 spike** from [`docs/chrome-extension-capture-design.md`](../docs/chrome-extension-capture-design.md):
the window hand-off approach. There is no API token, no CORS, and no Clerk extension SDK — the
extension just opens the app's own `/capture` page in a small window, where your normal signed-in
session does the work.

## Install

1. `pnpm dev` in the project root (the extension defaults to `http://localhost:3000`).
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select this `extension/` folder.
5. If your app runs anywhere else, right-click the extension → **Options** and set the origin.

> The extension ID will change if you remove and re-add it. That's fine at Phase 0 — nothing
> depends on the ID yet. Phase 2 pins it with a `key` in the manifest, and from then on it
> matters.

## Use

Three ways in, all of which do the same thing:

- Click the extension icon
- Press **Alt+Shift+E**
- Right-click a page or a text selection → **Add to EisenQ**

A small window opens with the title, URL and any selected text already filled in. Set a deadline
if it needs one, click a quadrant, and it closes itself.

**Selection behaviour:** if you've selected fewer than 120 characters, that text becomes the
*title* — which is what you want when grabbing one offer off a page full of them. Longer
selections become the *notes* and the page title is used instead.

## What Phase 0 doesn't do

These are deliberate omissions, not bugs. Each is scheduled later in the design doc.

| Missing | Arrives in |
|---|---|
| In-place popup (this opens a window, with a visible flash) | Phase 2 |
| `source` field on the task — the URL currently goes in the description | Phase 1 |
| Source chip and link-back in the dashboard | Phase 5 |
| Gmail subject/sender extraction | Phase 3 |
| Offline queue and retry | Phase 3 |
| AI quadrant and expiry suggestion | Phase 4 |
| Captures appearing without a dashboard refresh | Phase 5 |

The last one is worth knowing while you're testing: if the dashboard is already open in another
tab, a new capture won't show up there until you reload it.
