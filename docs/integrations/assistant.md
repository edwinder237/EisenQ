# Built-in AI assistant

A prioritization assistant inside the dashboard, run on the user's own Anthropic key (Settings →
Greeting → Claude API key, stored as `anthropicApiKeyEnc`).

## Flow

1. `POST /api/assistant` with the chat history → `runAssistant` (`src/server/assistant.ts`).
2. It loads a snapshot with `loadOpenTasksAndGoals` (shared with MCP's `get_overview`): up to 300
   open, unarchived, top-level tasks and the active goals, given short refs (`T1`, `G1`).
3. One Claude call with a cached system prompt and a JSON output schema returns a reply plus suggestions
   (the prompt asks for at most 7). `buildSuggestion` validates each against the snapshot; refs become ids.
4. Nothing is written. The panel shows suggestions; the person applies them one by one.

## Applying

`handleApplySuggestion` in `src/app/dashboard/page.tsx`:

- `move_to_top` stays in the browser (`handleReorderTask`), because it reorders against what the
  dashboard is showing.
- Everything else posts to `POST /api/assistant/apply` with the browser's time zone, which calls
  `applySuggestion` in `task-service.ts`, the same rules as the matrix and MCP (Do First ⇒ high,
  goal ownership, `set_due_date` = 9:00 in that zone). The change is logged in the AI connectors
  activity as "EisenQ assistant".

## Relation to AI connectors

They share the rulebook ([services.md](services.md)), the snapshot loader, the guidelines
(`PRIORITIZATION_GUIDELINES`, also used by the `prioritize_my_matrix` prompt) and the activity log.
They don't call each other; see [ADR-0002](../adr/0002-one-rulebook-for-ai-writes.md).
