# Integrations

Developer documentation for everything EisenQ connects to. The user guide is the in-app page
[`/help/integrations`](../../src/app/help/integrations/page.tsx); each Settings tab links to its section.

| Integration | What it does | Settings (stored in `userSettings`) | Routes | Auth to EisenQ | Outbound call |
|---|---|---|---|---|---|
| [AI connectors (MCP)](mcp.md) | Claude / ChatGPT read and change tasks and goals | `mcp` (plain: switches, permissions, prefs, clients, activity, write counter) | `/api/mcp`, `/.well-known/oauth-protected-resource/api/mcp`, `/api/mcp/clients` | Clerk OAuth bearer token (MCP); Clerk session (clients) | none |
| [Built-in assistant](assistant.md) | Prioritization suggestions on the user's own Claude key | `anthropicApiKeyEnc` | `/api/assistant`, `/api/assistant/apply` | Clerk session | Anthropic API, server-side |
| [Assistant hand-offs](assistant-routine.md) | Delegate quadrant hands a task to the person's Claude Code routine, which reports back through the connector | `assistantRoutineUrlEnc`, `assistantRoutineTokenEnc`; `assistantRun` on the task | `/api/tasks/[taskId]/assistant`, `/api/settings/assistant-routine` | Clerk session | Claude Code routine trigger (`api.anthropic.com`), server-side |
| Browser capture | Files tasks from the extension | `captureTokens` (SHA-256 hashes) | `/api/capture`, `/api/capture/connect`, `/api/capture/deadline` | `X-Capture-Token` (capture, deadline); Clerk session (connect, deadline) | Gemini, server-side (deadline) |
| [CashFold](cashfold.md) | Payments due / day-end strip | `financeApiUrlEnc`, `financeApiKeyEnc`, `financeUserIdEnc` | `/api/payments`, `/api/payments/test` | Clerk session | user's CashFold API via `safeFetch` |
| [Myndlist](myndlist.md) | Reusable checklists copied onto tasks | `myndlistApiUrlEnc`, `myndlistApiKeyEnc`, `checklistGates` | `/api/myndlist/checklists[/id]`, `/api/myndlist/test`, `/api/tasks/[taskId]/checklists[...]` | Clerk session | user's Myndlist API via `safeFetch` |
| [Calendar feeds](calendar.md) | Today's events beside the routine | `icalUrlsEnc` | `/api/calendar`, `/api/calendar/feeds` | Clerk session | iCal URLs via `safeFetch` |
| [Gemini](gemini.md) | What-to-wear line; capture deadlines | `geminiApiKeyEnc` | `/api/weather` (POST), `/api/capture/deadline` | Clerk session / capture token | Gemini API |
| [Notifications email](../notifications/README.md) | The daily notifications email, through Socle | `notifications`, `notificationDigest` (plain) | `/api/notifications/*`, `/api/cron/notifications-digest` | Clerk session; `CRON_SECRET` (cron) | Socle (`SOCLE_API_URL`, `SOCLE_API_KEY`), server-side |

The capture extension has its own design document: [`../chrome-extension-capture-design.md`](../chrome-extension-capture-design.md).

## Conventions every integration follows

- **Per-user credentials, encrypted at rest.** Secrets are AES-256-GCM encrypted with
  `SETTINGS_ENCRYPTION_KEY` (`src/server/crypto.ts`) and stored as `…Enc` fields. A value that
  fails to decrypt (key rotated, corrupt) reads as empty rather than throwing.
- **Server-side calls.** Calls to third parties are made by EisenQ's server with the stored
  credentials. Two exceptions: the Gemini key is sent from the browser with the what-to-wear
  request, and both it and the iCal URLs are cached in `localStorage` for a fast first paint.
  Note that `GET /api/settings` returns the user's own decrypted values to fill the Settings form;
  it's Clerk-protected and never cached (`no-store`).
- **`safeFetch` for user-supplied URLs** (`src/server/safe-fetch.ts`): refuses private, loopback and
  link-local addresses, so a URL typed into Settings can't reach EisenQ's own network.
- **Deny-by-default middleware** (`src/middleware.ts`): every route needs a Clerk session unless it
  is listed in `isPublicRoute`. Routes listed there authenticate in their own handler (capture
  token, MCP bearer token). List exact paths, never a prefix, so sibling routes stay protected.
- **Settings save pattern.** The Settings dialog keeps drafts, compares them to applied values
  (`settingsDirty`), and `handleSaveSettings` sends only what changed through `PUT /api/settings`.
  Security actions (revoking an AI app) apply immediately instead.
- **One rulebook for task and goal writes:** see [services.md](services.md). New write paths call
  the services; they never write to `tasks` or `goals` directly.

## Adding an integration

1. Store its settings on `UserSettings` (`src/server/db/schema.ts`): secrets as `…Enc`.
2. Extend `updateSettingsSchema` and GET in `src/app/api/settings/route.ts`.
3. Put outbound calls in one `src/server/<name>.ts` module, used by both the feature and its
   "Test connection" route, so the test exercises the real request.
4. Add the UI to a Settings tab (draft → dirty → save), and a section to `/help/integrations` with
   a stable anchor, plus an entry in `SETTINGS_HELP_ANCHOR` if it has its own tab.
5. Document it here.
