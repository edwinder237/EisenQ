# Myndlist

Reusable checklists authored in Myndlist and **copied** onto tasks. The copy is independent from
then on (`TaskChecklist` in `src/server/db/schema.ts`), so a run of a checklist reads as it did.

- **Settings:** Integrations tab. `myndlistApiUrlEnc`, `myndlistApiKeyEnc` (encrypted).
  `checklistGates` (plain, keyed by Myndlist checklist id) stores the "block the task until every
  required step is ticked" choice, which Myndlist has no field for.
- **Module:** `src/server/myndlist.ts` (`Authorization: Bearer <key>`, via `safeFetch`).
- **Routes:** `/api/myndlist/checklists` (GET list with usage counts, POST create),
  `/api/myndlist/checklists/[id]`, `/api/myndlist/test`, and per-task copies under
  `/api/tasks/[taskId]/checklists`.
- **Completion gate:** enforced server-side in `task-service.ts` for every write path, including AI
  connectors. Optional and blank steps never block. See [services.md](services.md).
