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

Right-click the extension icon → **Options** → **Connect to EisenQ**. A tab opens on the app;
sign in if asked, confirm the account, click **Connect this browser**, and the tab closes itself.
The options page then shows **Connected**.

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
| Right-click → **Add to EisenQ ▸ Do First** (or any quadrant) | Filed in one click, no window. The icon flashes **✓** |
| Right-click → **Add to EisenQ ▸ Open full form…** | Opens the form with deadline chips |
| Click the icon, or **Alt+Shift+E** | Opens the form |

**What becomes the title:** a selection under 120 characters becomes the title — select one offer
on a page of them and that's what you get. Longer selections become the notes, with the page title
as the title. **On Gmail**, an open thread's subject becomes the title, and capturing the same
thread twice doesn't create a duplicate.

**Automatic deadlines:** when the form opens, it reads what you captured — on Gmail, the open
email and the date it was sent — and asks Gemini for the deadline, using the key in EisenQ's
settings. A date it finds is pre-selected; one that has already passed is pointed out instead of
selected. Relative phrases like "6 days to file" count from the email's sent date, not from today.
A date is only shown if the words stating it are really in the email, so it can't invent one. On
other sites, highlight the text that includes the date before capturing. Without a Gemini key the
form says so and works as before.

**If something goes wrong:** the icon flashes **!** and the full form opens with everything you
selected, so a failed capture never loses anything. If the connection was revoked, the connect
page opens instead.

## Not yet

| Missing | Arrives in |
|---|---|
| In-place popup with deadline chips (one-click capture has no deadline yet) | Phase 2 |
| Gmail sender, read from the page | Phase 3 |
| Offline queue — today a failure falls back to the form instead | Phase 3 |
| AI quadrant suggestion, and automatic deadlines for one-click capture | Phase 4 (deadlines in the form are done) |
| Source chip in the dashboard, list of connected browsers in Settings | Phase 5 |
| Captures appearing without reloading the dashboard | Phase 5 |

## About the key

`manifest.json` holds only the **public** key, which is all an unpacked extension needs to keep its
ID. The matching private key is only needed to pack a `.crx`, which a personal, unpacked
extension never does — so it isn't in the repository.
