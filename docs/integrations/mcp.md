# AI connectors (MCP)

EisenQ is a remote [Model Context Protocol](https://modelcontextprotocol.io) server at
`https://www.eisenq.app/api/mcp`. People add it as a custom connector in Claude or ChatGPT, sign
in with their EisenQ (Clerk) account, and the AI app can then read and change their tasks and
goals within what they allow in **Settings → Integrations → AI connectors**.

User guide: `/help/integrations#ai-connectors`.

## Files

| File | Role |
|---|---|
| `src/app/api/mcp/route.ts` | Verifies the bearer token (Clerk, audience-checked), then hands over |
| `src/server/mcp-handler.ts` | Master switch, revoked apps, client tracking, builds the per-request server |
| `src/server/mcp-server.ts` | Tools, prompt, server instructions (`buildMcpServer`) |
| `src/server/mcp-settings.ts` | Defaults, settings schema, client upsert, activity log, daily write counter |
| `src/app/.well-known/oauth-protected-resource/api/mcp/route.ts` | RFC 9728 protected-resource metadata |
| `src/app/api/mcp/clients/route.ts` | Revoke / allow an app (Clerk session) |
| `src/components/AiConnectorsPanel.tsx` | The Settings tab |
| `src/server/task-service.ts`, `goal-service.ts` | The rules every write goes through ([services.md](services.md)) |

Packages: `@modelcontextprotocol/server` 2.x (serves the 2026-07-28 spec, with a stateless
fallback for 2025-era clients) and `@clerk/mcp-tools` (token verification and metadata).

## Authentication

1. An unauthenticated request gets `401` with
   `WWW-Authenticate: Bearer resource_metadata="https://www.eisenq.app/.well-known/oauth-protected-resource/api/mcp"`.
2. The client reads that metadata, which names the Clerk instance as `authorization_servers`.
3. The client registers with Clerk (client ID metadata document or dynamic registration) and sends
   the person through the normal EisenQ sign-in and a consent screen.
4. Requests carry `Authorization: Bearer <Clerk OAuth access token>`. The route calls
   `clerkClient().authenticateRequest(req, { acceptsToken: "oauth_token", audience: MCP_RESOURCE_URL })`
   and `verifyClerkToken`. The **audience** check rejects Clerk tokens issued for anything else.
5. The verified token gives `extra.userId` (the same Clerk user id tasks are stored under) and
   `clientId` (which app is calling).

`/api/mcp` and `/.well-known/oauth-protected-resource(.*)` are in `isPublicRoute` in
`src/middleware.ts` so the middleware doesn't answer 401 before the handler can check the token.
`/api/mcp/clients` is deliberately *not* public.

## Request lifecycle

Every request is stateless and independent:

1. Verify the token (above).
2. `loadMcpSettings(userId)`. Switch off → `403` JSON-RPC error "AI connectors are switched off…".
3. The client is blocked → `403` "This app's access to EisenQ was revoked…".
4. `touchClient` records the app: first seen, last used, and a name. The name comes from the
   request's client info (`initialize` params or the 2026 `_meta` envelope), else from the host of
   a client-metadata URL (`claude.ai` → Claude, `chatgpt.com` / `openai.com` → ChatGPT).
5. `createMcpHandler` builds a fresh `McpServer` via `buildMcpServer`, registering **only the
   tools the person's permissions allow**. Because the server is rebuilt per request from that
   request's settings, a permission switched off applies to the very next call, even if the
   client cached an older tool list (the call fails as an unknown tool).

## Tools

| Tool | Permission | Annotations | Notes |
|---|---|---|---|
| `list_tasks` | readTasks | readOnly | filter by quadrant / text; `nextAction` flag; completed only with `shareCompleted` |
| `get_overview` | readTasks | readOnly | open tasks per quadrant, next actions, overdue, goals with progress (if readGoals) |
| `list_goals` | readGoals | readOnly | goals with linked-task progress |
| `add_task` | createTasks | — | quadrant defaults to `preferences.defaultQuadrant`; Do First ⇒ high; `source: { kind: "agent", title: <app> }` when `labelAiTasks` |
| `update_task` | editTasks | idempotent | any field; `due: null` clears; `status: pending` reopens |
| `complete_task` | completeTasks | idempotent | checklist gate; auto-archive per user setting |
| `delete_task` | deleteTasks | destructive only in delete mode | archives or deletes per `preferences.deleteMode` |
| `create_goal`, `update_goal` | editGoals | — | period derived from any date inside it; goal deletion isn't offered |

Prompt: `prioritize_my_matrix` (registered with readTasks), built from the assistant's
`PRIORITIZATION_GUIDELINES`; it asks the AI to list proposals and apply only approved ones.

Inputs use display names for quadrants (`Do First`, `Schedule`, `Delegate`, `Eliminate`) and
24-hex ids. Dates are `YYYY-MM-DD` (9:00 AM) or `YYYY-MM-DDTHH:MM`, read in
`preferences.timeZone`. Errors come back as tool results with `isError: true` and a sentence the
AI can relay; `TaskServiceError` messages pass through as-is.

## Limits and logging

- **Daily write limit** (`takeWriteSlot`): an atomic counter `mcp.writes = { day, count }`, the day
  taken in the person's zone. Every write tool takes a slot before acting; reads don't.
- **Activity** (`logActivity`): newest first, capped at 50 with `$push`/`$slice`. The in-app
  assistant writes here too (`clientId: "eisenq-assistant"`). The tab shows 20.
- **Clients**: capped at 20; when trimming, blocked apps are kept so a revoked app can't come back
  unblocked by being pushed out.

## Settings shape

`UserSettings.mcp` (see `src/server/db/schema.ts`), filled with defaults by
`normalizeMcpSettings`. `PUT /api/settings` with `{ mcp: { enabled?, permissions?, preferences? } }`
writes dot paths (`mcpUpdateToSet`), so saving never touches `clients`, `activity` or `writes`.
Defaults: switch off; read/add/edit/complete tasks and read goals on; remove tasks and edit goals
off; Schedule; archive; label on; completed hidden; 50 a day; `UTC` until saved from a browser.

## Deployment checklist

1. **Vercel firewall.** Bot Protection challenges non-browser clients with `429`. Add a bypass
   rule for paths starting with `/api/mcp` and `/.well-known/` (or turn Bot Protection off), or
   Claude's and ChatGPT's servers can't connect.
2. **Clerk.** Enable OAuth applications for the production instance and allow clients to register
   themselves (dynamic client registration / client ID metadata documents). Clerk's dashboard
   labels change; check Clerk's current MCP documentation.
3. The resource URL is fixed in `MCP_RESOURCE_URL` (`src/server/mcp-settings.ts`). Change it there
   if the canonical host changes; tokens are audience-bound to it.

## Testing locally

Without a real Clerk token, call `handleVerifiedMcpRequest(req, authInfo, userId)` from
`src/server/mcp-handler.ts` directly with a fake `authInfo` against a local MongoDB, and POST
JSON-RPC (`initialize`, `tools/list`, `tools/call`, `prompts/get`) with
`accept: application/json, text/event-stream` and `mcp-protocol-version: 2025-06-18`. Against the
running app, `POST /api/mcp` without a token must return `401` with the metadata header.

## Adding a tool

1. Pick (or add) a permission in `McpPermissions`, its default in `DEFAULT_MCP_PERMISSIONS`, the
   update schema in `mcp-settings.ts`, and a row in the tab's `PERMISSIONS` list.
2. Register it inside the matching `if (p.<permission>)` block in `buildMcpServer`, with honest
   annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint: false`).
3. Writes go through `write(tool, fn)`, which takes a daily slot and logs a one-line summary, and
   through the services, never straight to a collection.
4. Add it to the tool table here and to the user guide.
