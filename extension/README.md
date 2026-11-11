# EisenQ Capture

A Chrome extension that files the page you're on, or the text you've selected, into an EisenQ
quadrant. Personal use: it's loaded unpacked and never published to the Web Store.

Design and roadmap: [`docs/chrome-extension-capture-design.md`](../docs/chrome-extension-capture-design.md).

## Install

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and select this `extension/` folder.
3. **Check the ID** on the extension's card. It must be:

   ```
   kfchhokbhfkeimjnaifkhdahndkmfgjm
   ```

   It's fixed by the `key` in `manifest.json` and hardcoded in `src/lib/extension.ts`. If they
   ever differ, connecting does nothing and every one-click capture is refused — **with no error
   message anywhere**. That's the failure to rule out first.

## Connect (once per browser)

Click the EisenQ icon. The first time, the panel shows **Connect to EisenQ** — click it, sign in
if asked, confirm the account, click **Connect this browser**, and that tab closes itself. The panel
switches to the capture form on its own. (The same button is in the extension's **Options**.)

Connecting points the extension at whichever app you connected from, so connecting from
`localhost` and from the deployed app both just work.

If the button reports that the extension isn't responding, use **Connect manually with a code
instead** on that page and paste the code into the options page under *Connect with a code
instead*.

### Which address

The extension uses **`https://www.eisenq.app`** by default. Use the `www` address, not a
`*.vercel.app` one: Clerk's production keys only work on `eisenq.app` and its subdomains, so on
a Vercel address the sign-in page loads blank. (The bare `eisenq.app` should work too once its
DNS points only at Vercel.)

To test changes locally instead, run `pnpm dev`, set **App** to `http://localhost:3000` in the
extension's **Options**, and connect from there.

## Use

| How | What happens |
|---|---|
| Click the icon, or **Alt+Shift+E** | Opens the EisenQ panel beside the page. Again folds it |
| Right-click → **Add to EisenQ ▸ Do First** (or any quadrant) | Filed in one click, no panel. The icon flashes **✓** |
| Right-click → **Add to EisenQ ▸ Open panel…** | Opens the panel, reading what you just selected |

**The panel** sits on the right of Chrome, next to the page — never over it, never a new window,
and only ever one. It belongs to the tab you opened it on: switch tabs and it hides, come back and
it's there as you left it, half-filled task included. You can keep reading, scrolling and
selecting in the page while it's open. After you file a task it stays open; **Capture something
else** reads the page again, and so does the **↻** button (for example after opening another email
in the same Gmail tab). If the tab has moved to a different site, fold the panel and open it again
so it can read the new page.

**What becomes the title:** in the panel, the tab's title is the title and whatever you selected
goes into Notes, line breaks kept. Right-clicking selected text files *that text*: its first line
becomes the title, and the full selection goes into Notes when there's more. **On Gmail**, an open
thread's subject is the title, and capturing the same thread twice doesn't create a duplicate.

**Automatic dates:** when the panel opens, it reads what you captured — on Gmail, the open email
and the date it was sent — and asks Gemini for the date that matters, using the key in EisenQ's
settings. A **deadline** ("file by April 30") is pre-selected as the due date. An **event**
("as of February 1, 2027 your rate will increase") isn't; instead the form offers **Remind me: On
Feb 1 · 1 week before · 30 days before**, and the event's real date is written into the task's
notes so an early reminder never loses what it's for. A date that has already passed is pointed out
instead of selected. Relative phrases like "6 days to file" count from the email's sent date, not
from today.
A date is only shown if the words stating it are really in the email, so it can't invent one. On
other sites, highlight the text that includes the date before capturing. Without a Gemini key the
form says so and works as before.

**If something goes wrong:** when a one-click capture can't be saved, the icon shows a red **!**
and the capture is kept. Click the icon and the panel opens with it filled in, ready to file again.
Nothing you selected is lost. If the connection was revoked, the panel asks you to connect again.

**Permissions:** the panel reads a page only after you click the icon, the shortcut or the menu on
it (Chrome's `activeTab`), so the extension never asks to read all websites.

## Not yet

| Missing | Arrives in |
|---|---|
| Gmail sender, read from the page | Phase 3 |
| Automatic retry when you're offline (today a failed save waits for you in the panel) | Phase 3 |
| AI quadrant suggestion, and automatic deadlines for one-click capture | Phase 4 (deadlines in the form are done) |
| Source chip in the dashboard, list of connected browsers in Settings | Phase 5 |
| Captures appearing without reloading the dashboard | Phase 5 |

## About the key

`manifest.json` holds only the **public** key, which is all an unpacked extension needs to keep its
ID. The matching private key is only needed to pack a `.crx`, which a personal, unpacked
extension never does — so it isn't in the repository.
