# Browser Capture Extension — System Design

**Status:** Proposal
**Date:** 2026-10-27
**Feature:** A Chrome extension that captures an email, page, or text selection and files it
directly into one of the four EisenQ quadrants.

> **Rev 2 (2026-10-27)** — Replaced the copy/paste-a-token setup with a one-click
> **"Connect to EisenQ"** handoff (§4.4): the extension opens a Clerk-protected consent page on
> the app, which hands the token over directly. Tokens are now an array so multiple browsers can
> be connected and revoked independently. Phase 1 grows by ~0.5 d; v1 is now 4–5.5 d.
>
> **Rev 3 (2026-11-04)** — Rev 1 and 2 were written against a tree 106 commits behind `main`.
> Re-validated against current `main`. The important correction: **middleware is now
> deny-by-default**, which *inverts* the original Pitfall 1 — `/api/capture` must be added to
> `isPublicRoute` or it never reaches its own token check. Line references and the `Task` model
> are refreshed below; `archivedAt` joins `parentTaskId` as a null-convention field.

---

## 1. Current architecture (as found in the repo)

| Concern | Implementation |
|---|---|
| Framework | Next.js 15.5.7, App Router, React 19, Turbopack dev |
| Auth | Clerk v6 (`@clerk/nextjs`), **cookie sessions** |
| Route protection | `src/middleware.ts` — **deny-by-default**: everything is private unless listed in `isPublicRoute`. API routes answer 401; pages redirect to sign-in |
| Data | MongoDB official driver, no ORM (`src/server/db/index.ts`) |
| Collections | `tasks`, `checklistItems`, `maintenanceItems`, `userSettings` |
| UI | `src/app/dashboard/page.tsx` — a single **6,810-line** client component |
| Validation | Zod schemas inline per route |
| Hosting | Vercel (serverless; `@vercel/analytics` present) |

### Task model (`src/server/db/schema.ts`)

```ts
interface Task {
  _id?: ObjectId;
  title: string;                 // 1–500 chars
  description?: string;          // ≤5000 chars
  quadrant: TaskQuadrant;        // urgent-important | important-not-urgent
                                 // | urgent-not-important | not-urgent-not-important
  priority: TaskPriority;        // high | medium | low
  status: TaskStatus;            // pending | in-progress | completed
  dueDate?: Date;
  duration?: number;             // minutes, 1–1440
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  userId?: string;               // Clerk user id
  parentTaskId?: ObjectId;       // set ⇒ this is a subtask, and it leaves the matrix
  linkedParentId?: ObjectId;     // soft link: stays top-level but also shows under a parent
  goalId?: ObjectId;             // optional link to a weekly/monthly goal
  sortOrder?: number;            // manual position within its quadrant
  archivedAt?: Date;             // set ⇒ drops out of the matrix (see Pitfall 7)
  checklists?: TaskChecklist[];  // copied in from Myndlist; never surface as tasks
}
```

Quadrant → UI label mapping (`dashboard/page.tsx:162`): `urgent-important` → **Do First**,
`important-not-urgent` → **Schedule**, `urgent-not-important` → **Delegate**,
`not-urgent-not-important` → **Eliminate**.

### Three existing patterns worth reusing

1. **Per-user encrypted secrets.** `userSettings` stores `geminiApiKeyEnc` / `icalUrlsEnc`,
   AES-256-GCM via `src/server/crypto.ts`. This is the natural home for a capture token.
2. **Server-side AI proxy.** `src/app/api/weather/route.ts` POST calls Gemini
   (`gemini-2.5-flash-lite`) with the user's own key, with 503 retry/backoff. Directly reusable
   for "suggest a quadrant."
3. **Machine auth via header.** `/api/payments` calls the external finance ledger with
   `X-API-Key`. The same shape, inverted, is what the extension needs.

### Gaps that matter for this feature

- **No CORS headers and no `OPTIONS` handlers** anywhere in the codebase.
- **No polling or realtime.** `fetchTasks()` (`page.tsx:876`) runs on mount only.
- **No MongoDB indexes** are created in code.
- `X-Frame-Options: DENY` is set globally in `next.config.js`.
- The rate limiter in the weather route is a per-instance in-memory `Map`.

---

## 2. Requirements

**Functional**

- Capture from (a) any page — title + URL + selection, (b) Gmail — subject, sender, thread
  permalink, (c) a right-click on selected text.
- Pick the quadrant at capture time, in two clicks or fewer.
- **Set a deadline at capture time**, in one click for the common cases. For a large share of
  captures the expiry *is* the reason the thing is urgent — see the worked example below.
- Optional AI suggestion for quadrant + priority + expiry.
- Store a link back to the source so the task is actionable later.
- Don't create duplicates when the same email is captured twice.

### Worked example: a time-limited offer

Marc is on `pcoptimum.ca/offers`. A card reads **"$3.99 Each — Degree Men UltraClear
Black+White Antiperspirant — Ends in 3 days."** He wants that in **Do First** so it surfaces in
his day before it expires.

What this one example demands of the design:

| Observation | Consequence |
|---|---|
| The deadline is *why* it's urgent | A due date must be settable in the popup, not just accepted by the API |
| "Ends in 3 days" is relative, on-page text | Either a one-click "3 days" chip, or AI extraction of the expiry |
| The page holds ~20 offers; the URL is just `/offers` | `source.url` can't deep-link to one offer — the chip returns to the page, which is fine, but don't promise more |
| Two offers captured from the same URL are **not** duplicates | Dedupe must stay keyed on `externalId` only, never on `source.url` |
| Title lives in the card, not `document.title` | Text selection is the primary capture path for pages like this |

The last two are the ones that would have become bugs. A URL-based dedupe rule looks reasonable
on paper and would have silently swallowed every offer after the first.

**Non-functional**

- Single user today; design should not block multi-user later.
- Capture must feel instant — target < 400 ms perceived, so optimistic UI in the popup.
- Must not silently lose a capture when offline or when the API errors.

---

## 3. The crux: how does the extension authenticate?

This single decision drives most of the effort. Clerk uses cookie sessions, and a
`chrome-extension://` origin is cross-origin to the app, so nothing works by default.

```
┌──────────────────────┐        ┌──────────────────────────┐        ┌──────────┐
│  Chrome Extension    │        │  Next.js (Vercel)        │        │ MongoDB  │
│  chrome-extension:// │        │  app.eisenq.com          │        │          │
│                      │        │                          │        │          │
│  popup (quadrant UI) │───────▶│  middleware.ts           │        │          │
│  service worker      │  ???   │   auth.protect()         │        │          │
│  chrome.storage      │        │   on /api/tasks(.*)      │───────▶│  tasks   │
└──────────────────────┘        └──────────────────────────┘        └──────────┘
                                 ▲
                      Clerk cookie lives on app.eisenq.com,
                      NOT on the extension origin.
```

### Option A — Window hand-off ("share target")

The extension opens `https://app.eisenq.com/capture?title=…&url=…&text=…` in a small popup
window. That tab carries the normal Clerk cookie, so the existing session just works. The user
picks a quadrant on a real app page; it closes itself on submit.

- **No CORS, no tokens, no Clerk extension SDK, no new auth surface.**
- Needs one new page in the app (`/capture`) plus `chrome.windows.create` in the extension.
- Cost: a visible window flash, and it leans on the app being reachable and signed in.
- **Effort: ~0.5–1 day.** Genuinely useful on day one.

### Option B — Per-user capture token, delivered by one-click connect ✅ *recommended for v1*

The extension authenticates with a long random per-user token sent as `X-Capture-Token` to a new
`/api/capture` route, which validates it instead of using Clerk. The server stores only the
token's SHA-256 hash.

The token never passes through the user's hands. On first run the popup shows a single
**"Connect to EisenQ"** button, which opens `/connect-extension` on the app. That page is
Clerk-protected, so an unauthenticated user gets the normal sign-in screen and lands back on it —
**this is the "sign in" moment, and it happens in the real app, not in the extension.** The page
shows which account is about to be linked, and on an explicit click it mints a token and hands it
straight to the extension via `chrome.runtime.sendMessage`. The tab closes itself.

From the user's side: click Connect, confirm the account, done — forever. No password typed into
the extension, no token copied, and the account being linked is visible before committing.

- Reuses the existing `userSettings` + crypto patterns; no Clerk extension SDK at all.
- Works cleanly in an MV3 service worker and survives Clerk upgrades.
- OAuth-like UX without implementing OAuth.
- Cost: you own a credential — needs hashing, revocation, and rate limiting; and the handoff
  couples the app to a pinned extension ID (see Pitfalls 12 and 16).
- **Effort: ~2.5–3.5 days** on top of Option A's groundwork.

### Option C — Clerk Sync Host + Bearer token

The official route: `@clerk/chrome-extension` with `syncHost` pointed at the Clerk Frontend API
domain, so a web sign-in carries into the extension; the extension then sends the Clerk session
token as `Authorization: Bearer …`.

Requirements and caveats, per Clerk's own docs:

- A **consistent CRX ID** (fixed `key` in the manifest) — the ID otherwise rotates and breaks
  the allowlist.
- The extension ID must be added to the instance's **`allowed_origins`** via the Clerk Backend
  API using the secret key.
- `host_permissions` for both the app host and the Clerk Frontend API domain; `storage` and
  `cookies` permissions.
- Production assumes a Clerk instance on a **custom Frontend API domain**
  (`clerk.your-domain.com`).
- **Sync Host is not fully supported in side panels** — the user must close and reopen the panel
  for auth state to update.
- **Clerk cannot be used in content scripts** (origin restrictions can't be enforced when a
  script may run on any domain); use `createClerkClient()` in the service worker instead.
- OAuth/SAML/email-link sign-in don't work inside a popup.
- **Effort: ~4–6 days**, plus ongoing fragility across Clerk and Chrome releases.

### Recommendation

**Ship Option A as a 1-day spike, then build Option B as the real v1.** Option B is the right
cost/benefit for a personal tool: one new page, two new routes, and no new dependencies. Keep
Option C as the documented upgrade path — it becomes the right answer the moment this is
multi-user or listed publicly, because then you don't want to be issuing and supporting your own
tokens.

---

## 4. Detailed design (Option B)

### 4.1 Schema changes

```ts
// schema.ts — new, optional, backward compatible
export interface TaskSource {
  kind: "gmail" | "page" | "selection";
  url: string;             // thread permalink or page URL
  title?: string;          // page/email subject as captured
  from?: string;           // email sender, when known
  externalId?: string;     // Gmail thread id — the dedupe key
  capturedAt: Date;
}

interface Task {
  // …existing fields…
  source?: TaskSource;
}

export interface CaptureToken {
  hash: string;            // SHA-256 hex, NOT the token
  label: string;           // "Chrome on MacBook" — from the UA at connect time
  createdAt: Date;
  lastUsedAt?: Date;
}

interface UserSettings {
  // …existing fields…
  captureTokens?: CaptureToken[];
}
```

Store the **hash**, not the ciphertext. The server never needs the token back — only to verify
one — so hashing is strictly safer than reusing `encrypt()` here.

An **array** rather than a single field, because connecting a second browser shouldn't silently
log out the first. It costs nothing now (a multikey index handles the lookup) and avoids a
migration later. Each entry is independently revocable from Settings.

### 4.2 New endpoints

```
GET  /connect-extension                     → Clerk-protected PAGE; the sign-in + consent step
POST /api/capture/connect                   → Clerk-authed; mints a token, returns it ONCE
DELETE /api/capture/connect?hash=…          → Clerk-authed; revoke one connected browser

POST /api/capture          X-Capture-Token  → create a task from a capture
POST /api/capture/suggest  X-Capture-Token  → { quadrant, priority } via Gemini
OPTIONS on the two capture routes           → CORS preflight
```

The first three are ordinary Clerk-authed app surface — same-origin, cookie session, no CORS. Only
the two capture routes are reachable from the extension origin.

`/api/capture` request body:

```jsonc
{
  "title": "Re: Q4 budget approval needed",
  "description": "Finance needs sign-off by Friday…",
  "quadrant": "urgent-important",
  "priority": "high",          // optional; server applies the urgent-important rule
  "dueDate": "2026-10-31T17:00:00.000Z",   // full ISO datetime — z.string().datetime()
  "source": {
    "kind": "gmail",
    "url": "https://mail.google.com/mail/u/0/#inbox/FMfcgzQ…",
    "title": "Re: Q4 budget approval needed",
    "from": "finance@example.com",
    "externalId": "FMfcgzQ…"
  }
}
```

Handler outline:

```ts
export async function POST(req: NextRequest) {
  const token = req.headers.get("x-capture-token");
  if (!token) return json({ error: "Unauthorized" }, 401);

  const hash = sha256Hex(token);
  const settings = await userSettingsCollection.findOne({ "captureTokens.hash": hash });
  if (!settings) return json({ error: "Unauthorized" }, 401);   // constant-time by index lookup

  if (!(await allowCapture(settings.userId))) return json({ error: "Too many" }, 429);

  const parsed = captureSchema.safeParse(await req.json());
  if (!parsed.success) return json({ error: "Invalid", details: parsed.error.flatten() }, 400);

  const b = parsed.data;

  // Dedupe before insert — on externalId ONLY, never source.url (Pitfall 18)
  if (b.source?.externalId) {
    const existing = await tasksCollection.findOne({
      userId: settings.userId,
      "source.externalId": b.source.externalId,
      status: { $ne: "completed" },
    });
    if (existing) return json({ task: existing, deduped: true }, 200);
  }

  // Mirror the dashboard's business rule (page.tsx:1472, 1507)
  const priority = b.quadrant === "urgent-important" ? "high" : (b.priority ?? "medium");

  const task: Task = {
    title: b.title, description: b.description,
    quadrant: b.quadrant, priority, status: "pending",
    dueDate: b.dueDate ? new Date(b.dueDate) : undefined,
    source: b.source ? { ...b.source, capturedAt: new Date() } : undefined,
    createdAt: new Date(), updatedAt: new Date(),
    userId: settings.userId,
    // NOTE: never set parentTaskId — see Pitfall 7
  };

  const { insertedId } = await tasksCollection.insertOne(task);
  void userSettingsCollection.updateOne(
    { "captureTokens.hash": hash },
    { $set: { "captureTokens.$.lastUsedAt": new Date() } });
  return json({ task: { ...task, _id: insertedId } }, 201);
}
```

Looking up by `captureTokens.hash` directly (indexed, unique) avoids a timing-sensitive compare
entirely — there's no secret-dependent branch, and a wrong token is simply a miss.

### 4.3 Middleware change

Middleware is **deny-by-default**: every route the matcher reaches is private unless it appears
in `isPublicRoute`. That flips the original advice in this document.

```ts
const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/contact",
  "/api/capture",          // ADD — token-authenticated, must bypass Clerk
  "/api/capture/suggest",  // ADD — same
]);
// /capture and /connect-extension need NO entry: being private is exactly what
// gives a signed-out user the sign-in screen and returns them afterwards.
```

Two consequences, and they pull in opposite directions:

1. **The pages want protection, and get it for free.** `/capture` and `/connect-extension` are
   private by default, which is precisely the behaviour the connect flow depends on. Verified:
   `/capture?title=…` redirects to `/sign-in?redirect_url=…` with **every query parameter
   preserved**, so the user lands back on a pre-filled form.
2. **The token routes must be made public, or they are unreachable.** Under deny-by-default the
   middleware answers `401` for `/api/capture` *before* the handler can look at
   `X-Capture-Token`. Forgetting this produces an endpoint that rejects a perfectly valid token
   with no log line in your own code.

"Public" here means only "middleware does not check Clerk" — the route still authenticates, by
token, in its own handler. Leave a comment saying so, because a route listed under a matcher
named `isPublicRoute` looks alarming at a glance.

### 4.4 The connect handoff

```
┌─────────────────┐                      ┌──────────────────────────────┐
│ popup, 1st run  │                      │ app.eisenq.com               │
│                 │                      │                              │
│ [Connect to     │──chrome.tabs.create─▶│ /connect-extension           │
│  EisenQ]        │                      │   ├ not signed in? ──▶ Clerk │
│                 │                      │   │                   sign-in│
│                 │                      │   └ "Link this extension to  │
│                 │                      │      marc@…?"  [Connect]     │
│                 │                      │             │                │
│                 │                      │             ▼ POST           │
│                 │                      │     /api/capture/connect     │
│                 │                      │       → { token } (once)     │
│ onMessageExternal◀──chrome.runtime──────┤             │                │
│   store token   │     .sendMessage      │   window.close()            │
│   show "✓ as    │                      └──────────────────────────────┘
│   marc@…"       │
└─────────────────┘
```

Manifest side:

```jsonc
{
  "key": "<pinned public key>",                     // freezes the extension ID
  "externally_connectable": {
    "matches": ["https://app.eisenq.com/*"]         // ONLY the app may message us
  }
}
```

Page side:

```ts
// /connect-extension — client component, behind Clerk
async function onConnect() {
  const res = await fetch("/api/capture/connect", { method: "POST" });  // explicit POST only
  const { token } = await res.json();
  chrome.runtime.sendMessage(
    process.env.NEXT_PUBLIC_EXTENSION_ID!,
    { type: "eisenq:token", token },
    () => window.close(),
  );
}
```

Three rules this design depends on:

1. **Mint on an explicit `POST`, never on page load.** A GET that mints is a CSRF hole; a POST
   behind a click, same-origin, with the Clerk cookie, is safe by construction.
2. **Return the token exactly once.** It is never stored client-side, never logged, never
   re-readable. Lose it and you reconnect.
3. **`externally_connectable` is the trust boundary.** Only `app.eisenq.com` can reach the
   extension, so no other site can inject a token.

**Portable alternative** if you ever want Firefox/Edge or dislike the pinned-ID coupling: a
device-code flow instead. The extension generates a random `pairingCode`, opens
`/connect-extension?code=…`, and polls `POST /api/capture/claim { pairingCode }` until the server
hands over the token. Same UX, no `externally_connectable`, no extension ID on the server — at the
cost of a short-lived pairing collection and a polling loop. Not worth it for Chrome-only v1.

### 4.5 CORS

```ts
const ALLOWED_ORIGIN = `chrome-extension://${env.EXTENSION_ID}`;

function corsHeaders(origin: string | null) {
  if (origin !== ALLOWED_ORIGIN) return {};              // echo nothing for other origins
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Capture-Token",
    "Access-Control-Max-Age": "86400",
  };
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}
```

No `Access-Control-Allow-Credentials` — the token is the credential, so cookies stay out of it.
Pin to the one extension ID via a new `EXTENSION_ID` env var; don't use `*`.

### 4.6 Indexes (new — none exist today)

```js
db.tasks.createIndex({ userId: 1, parentTaskId: 1, createdAt: -1 })     // the main GET
db.tasks.createIndex({ userId: 1, "source.externalId": 1 },
                     { sparse: true })                                   // dedupe lookup
db.userSettings.createIndex({ "captureTokens.hash": 1 },
                            { unique: true, sparse: true })              // token auth (multikey)
```

The third one is load-bearing: token auth does a lookup on every capture. `unique` across a
multikey index also guarantees no two users can ever hold the same token.

### 4.7 Extension (Manifest V3)

```
extension/
  manifest.json          key: <pinned>  — required, see §4.4
                         permissions: storage, activeTab, contextMenus, scripting, alarms
                         host_permissions: https://app.eisenq.com/*
                         externally_connectable.matches: https://app.eisenq.com/*
  sw.js                  onMessageExternal (token handoff), context menu,
                         queue flush on chrome.alarms, badge state
  popup.html / popup.js  first run: "Connect to EisenQ"
                         connected: title/notes, deadline chips, 4-quadrant picker, "Suggest"
  options.html           shows "Connected as marc@…", Disconnect, test connection
```

Deliberately **no persistent content script.** Use `activeTab` + `chrome.scripting.executeScript`
on demand to read the selection and, on Gmail, the subject/sender. This keeps the permission
story small (important if it ever goes to the Web Store) and sidesteps Clerk's content-script
restriction entirely.

Capture flow:

```
user hits Alt+Shift+E (or right-clicks a selection)
        │
        ├─ no token in chrome.storage? ──▶ "Connect to EisenQ" (§4.4), once ever
        │
        ▼
popup opens ──▶ sw.js: chrome.scripting.executeScript on active tab
        │            └─ returns { title, url, selection, gmail?: {subject, from, threadId} }
        ▼
popup prefills ──▶ deadline chips:  [none] [today] [tomorrow] [3 days] [pick…]
        │              pre-selected if an expiry was detected in the text
        ▼
user clicks a quadrant  ──[optional]──▶ POST /api/capture/suggest
        │
        ▼
POST /api/capture  ──success──▶ popup shows ✓, closes in 400ms
        │
        └──failure──▶ push onto chrome.storage.local queue, badge "1",
                      retry on chrome.alarms (1 min, then backoff)
```

**Gmail extraction.** Take the thread id from the URL hash — `#inbox/<threadId>` — which is
stable and gives both the permalink and the `externalId` for dedupe. Read subject and sender from
the DOM as a *best-effort enrichment only*, with fallback to `tab.title`. Never let a selector
miss fail the capture.

### 4.8 AI quadrant suggestion

Reuse the weather route's Gemini call shape, decrypting `geminiApiKeyEnc` server-side:

```
POST /api/capture/suggest { title, snippet, capturedAt }
  → prompt: classify into one of the four Eisenhower quadrants AND extract any
    deadline mentioned in the text, resolved against capturedAt. JSON only.
  → { quadrant, priority, dueDate: string | null, reason }
```

**Expiry extraction is the highest-value part of this endpoint**, not the classification. Text
like *"Ends in 3 days"*, *"Valid Oct 31 – Nov 6"*, or *"RSVP by Friday"* is exactly what a model
is good at and what a regex is bad at. Resolve relative phrases server-side against `capturedAt`,
and return a full ISO datetime (Pitfall 8). The popup pre-selects the matching deadline chip; the
user can always override.

Two guardrails: the model must return `null` rather than guess when no deadline is stated, and a
`dueDate` in the past is discarded rather than saved.

Keep this server-side. The dashboard currently decrypts the Gemini key and ships it to the
browser, mirroring it into `localStorage` (`settings/route.ts:32`, `page.tsx:840`) — don't extend
that pattern to the extension.

### 4.9 Dashboard changes

- Refetch tasks on window `focus` / `visibilitychange` so captures appear without a manual
  reload. This is a ~10-line change and it's the difference between the feature feeling real and
  feeling broken.
- Render a small source chip on tasks with `source` — Gmail icon / site favicon, linking to
  `source.url`. Because only the extension sets `source`, the chip doubles as the
  "captured, not typed" marker.
- Settings panel: **Connected browsers** list — label, created, last used, and a Revoke button
  per entry. No token is ever displayed here; connecting happens at `/connect-extension`.

---

## 5. Effort estimate

| Phase | Scope | Estimate |
|---|---|---|
| 0 | `/capture` page + window hand-off extension (Option A spike) | 0.5–1 d |
| 1 | Schema + `/api/capture` + CORS + indexes + **`/connect-extension` page and token handoff** | 2–2.5 d |
| 2 | MV3 extension: pinned key, first-run connect, quadrant picker, deadline chips, shortcut | 1.5–2 d |
| 3 | Gmail enrichment, context menu, offline queue + retry | 1.5–2 d |
| 4 | AI suggestion endpoint (quadrant + **expiry extraction**) + popup button | 0.5–1 d |
| 5 | Dashboard: refetch-on-focus, source chip, connected-browsers UI | 1–1.5 d |
| 6 | Hardening: rate limiting, revocation paths, error states, manual QA | 1 d |
| — | **Usable personal v1 (phases 0–2)** | **4–5.5 d** |
| — | **Full feature (phases 0–6)** | **8–11 d** |
| + | Chrome Web Store listing, if public: packaging, privacy policy, review | +1–2 d, then 3–20 d review wait |

Focused working days, single developer already familiar with this codebase. Phases 1 and 2 are
parallelizable if you want to compress.

The one-click connect flow added ~0.5 d to Phase 1 over the original copy/paste-a-token design:
the `/connect-extension` page and consent UI, the `externally_connectable` + pinned-key wiring,
the `onMessageExternal` listener, and the middleware change. It buys an onboarding step the user
can actually follow, and it removes a plaintext credential from the clipboard.

---

## 6. Pitfalls

Ordered by how likely they are to actually bite.

**1. Deny-by-default middleware will reject the capture route however you name it.**
Every route is private unless listed in `isPublicRoute`, so `/api/capture` returns 401 before
your token logic ever runs — and the failure looks like a bug in the extension, not the
middleware. Add both capture routes to `isPublicRoute` (§4.3). Renaming them doesn't help; this
is not the older "don't nest under `/api/tasks`" trap, it applies to every path you could pick.

**2. There is no CORS anywhere in the app today, and MV3 enforces it.**
MV2 background pages were exempt from CORS; MV3 service workers are **not**. Without an `OPTIONS`
handler the preflight fails and `fetch` rejects with an opaque network error that tells you
nothing. Expect to lose an hour here if you don't write `OPTIONS` up front.

**3. Cookie auth will not work from the extension origin.**
`credentials: "include"` against `/api/tasks` will not authenticate — Clerk's cookie is scoped to
the app domain, and `auth.protect()` has no allowlisted origin for `chrome-extension://…`. This
is the trap that makes people reach for Option C mid-build. Decide the auth model before writing
extension code.

**4. Captured tasks won't appear in an open dashboard.**
`fetchTasks()` runs on mount with no polling, no websocket, no revalidation. You'll capture
something, look at the dashboard, and conclude the API failed. Fix the refetch in the same PR as
the capture endpoint, not later. The pattern is already in the file — `page.tsx:1401` refreshes
*calendar* events on window focus — so this is a copy of nine existing lines, not a design
question.

**5. `TaskQuadrant` is defined twice already; don't let the extension make it three.**
`src/server/db/schema.ts:3` and `src/app/dashboard/page.tsx:91` each declare it independently.
The capture page sidesteps this with `import type { TaskQuadrant } from "~/server/db/schema"` —
erased at compile time, so no server code reaches the client bundle — but the real fix is to
extract a shared `src/lib/task-types.ts` and have both the dashboard and the extension mirror
it. Otherwise a renamed quadrant silently diverges across files.

**6. The `urgent-important ⇒ priority: high` rule lives only in the UI.**
It's applied at `page.tsx:2266`, `:2302`, `:2364` and `:3071` — four copies now — and nowhere in
`POST /api/tasks`. A capture that bypasses the dashboard produces tasks that violate an
invariant the rest of the app assumes. Replicate it in `/api/capture` (shown above) or, better,
move it server-side into both routes; four copies is itself the argument for the latter.

**7. Two null-convention fields are load-bearing, not one.**
`GET /api/tasks` filters on **both** `parentTaskId: null` *and* `archivedAt: null`, each of which
in MongoDB matches *null or missing*. A captured task that sets either to anything else
disappears from the dashboard entirely while sitting happily in the database. Don't set either
field — and re-check this list when new matrix-filtering fields land, because it has already
grown once.

**8. `dueDate` must be a full ISO datetime.**
The Zod schema is `z.string().datetime()` — `"2026-10-31"` fails validation. If the extension
offers a "due today/tomorrow" shortcut it must send a full timestamp.

**9. The in-memory rate limiter doesn't survive serverless.**
The `Map` in the weather route is per-instance and resets on cold start. That's acceptable for a
Clerk-protected route; it's weak as the only guard on a token-authenticated endpoint reachable
from anywhere. Either back the counter with MongoDB or accept the risk explicitly, documented,
given a single user and a high-entropy token.

**10. No indexes exist, and token auth adds a query to the hot path.**
Every capture does a `userSettings` lookup plus a possible dedupe lookup. Add the three indexes
in §4.6 before you notice latency, not after.

**11. `X-Frame-Options: DENY` blocks the obvious side-panel shortcut.**
You cannot iframe the dashboard into a Chrome side panel. If you want a side panel it has to be
native extension UI — and note that Clerk's Sync Host is explicitly not fully supported in side
panels, so Option C plus side panel is the worst combination available.

**12. CRX ID rotation invalidates both the CORS allowlist and the connect handoff.**
An unpacked extension gets a new ID on reinstall. Pin it with a `key` in the manifest **before**
you hardcode `EXTENSION_ID` / `NEXT_PUBLIC_EXTENSION_ID`, or you'll be chasing 403s on capture
*and* a connect button that appears to work and silently links nothing. Do this in the first hour
of Phase 2, not when it breaks.

**13. Gmail DOM selectors are obfuscated and change without notice.**
Treat subject/sender scraping as enrichment that is allowed to fail. The URL thread id is the
only part you should depend on. Resist building a selector library here.

**14. Decide the distribution model early.**
If this stays personal, load it unpacked or self-host a private CRX and skip the Web Store
entirely — no review, no privacy policy, no justification for `host_permissions`. If it ever goes
public, broad host permissions and any remote-code pattern draw review scrutiny, and the review
wait is measured in weeks. This choice changes phase 6 and the manifest, so make it at the start.

**15. The token is a bearer credential in `chrome.storage.local`.**
It's readable by anyone with local machine access and by a compromised extension process. Scope
it narrowly: the capture routes only, never a general-purpose API key, with per-browser revocation
in Settings and `lastUsedAt` surfaced so unexpected use is visible. Because tokens are an array,
revoking one browser doesn't disturb the others.

**16. `chrome.runtime.sendMessage` from the page fails *silently* when anything is misconfigured.**
A wrong extension ID, a missing `externally_connectable` entry, or a host that doesn't match gives
you no exception and no console error — `chrome.runtime` is simply `undefined`, or the callback
never fires. Guard it explicitly:

```ts
if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
  // extension not installed, or this origin isn't in externally_connectable
  showManualFallback();   // keep a "copy token" escape hatch for exactly this case
}
```

Keep a hidden copy/paste fallback on the connect page. It costs ten lines and it's the only way
to recover when the handoff misbehaves on someone's machine.

**17. Dev and prod need different `externally_connectable` matches.**
`http://localhost:3000/*` must be listed too, or the connect flow can't be tested locally — and
`matches` does not accept the `$ENV_VAR` interpolation that `host_permissions` does in some build
tools. Expect to maintain two manifests (or a build step) from the start, and remember that the
unpacked dev extension has a different ID than the packaged one unless the `key` is shared.

**18. Never dedupe on `source.url` — only on `externalId`.**
It reads as the obvious general case and it causes silent data loss. One offers page, one flyer,
one newsletter holds many separately actionable items that all share a URL; a URL-keyed rule
accepts the first capture and quietly returns the *existing* task for every one after it. The
user sees a success checkmark and nothing new in the quadrant. Only a genuinely per-item id
(a Gmail thread id) is safe as a dedupe key — and when there isn't one, don't dedupe.

---

## 7. What I'd revisit as this grows

- **Auth:** migrate to Option C (Clerk Sync Host) the moment there's a second *paying* user —
  issuing your own tokens doesn't scale to a support burden. The connect flow buys time here,
  because the UX is already OAuth-shaped: swapping the token for a Clerk session token later is a
  change behind the same button, not a change the user sees.
- **Freshness:** refetch-on-focus is the right fix at one user. At "shared with a partner," this
  wants SSE or polling with an `updatedAt` cursor.
- **The 6,810-line dashboard:** this feature adds a source chip, a token panel, and a refetch
  hook to a file that's already unmaintainable — and which grew by ~1,650 lines in the 106
  commits this document was first written against. Splitting out `TaskCard`, `SettingsDialog`,
  and the data-fetching hooks is a prerequisite for comfortable work here, not a nice-to-have.
- **Capture backlog:** if captures regularly land unsorted, an "Inbox" pseudo-quadrant with a
  triage view beats forcing a quadrant choice at capture time.
