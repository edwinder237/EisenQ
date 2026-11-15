# ADR-0002: One rulebook for every AI write, and no AI-to-AI calls

**Status:** Accepted
**Date:** 2026-11-15
**Deciders:** Marc Nelson

## Context

EisenQ gained a second AI path. The built-in assistant (`src/server/assistant.ts`) already proposed
changes, which the browser applied by assembling `PUT /api/tasks` bodies. AI connectors (MCP) let
Claude and ChatGPT change tasks and goals directly.

The task and goal rules lived inline in the route handlers, and some only in the client: "Do
First is always high priority" was enforced by the dashboard form and `/api/capture`, not by
`POST /api/tasks`. A new write path written against the database would have skipped them.

The question also came up whether the two AIs should talk to each other, for example an
`ask_eisenq_assistant` MCP tool that forwards the question to the built-in assistant.

## Decision

1. **Every task and goal write goes through `task-service.ts` / `goal-service.ts`.** The
   dashboard routes, the assistant (`/api/assistant/apply`) and MCP all call the same functions,
   so the checklist gate, ownership checks, the subtask cascade, period validation, Do First ⇒ high
   and time-zone-correct due dates hold everywhere. See `docs/integrations/services.md`.
2. **No AI-to-AI calls.** The assistant and AI connectors share the rulebook, the snapshot loader
   (`loadOpenTasksAndGoals`), the prioritization guidelines (the `prioritize_my_matrix` prompt) and
   one activity log, but neither calls the other.

## Consequences

- An outside AI is already a capable model reading the same data. Routing its questions through a
  second model would spend the user's Anthropic key on every question, add latency, and return
  an opinion the caller can't check. The prompt gives it the same guidance for free.
- Applying assistant suggestions moved server-side, so they now show up in the AI connectors
  activity log alongside Claude and ChatGPT.
- `/api/capture`, `/api/tasks/reorder` and the checklist routes don't use the services yet.
  Moving them is follow-up work; until then, they keep their own checks.
- Revisit if the built-in assistant gains something an outside AI can't do (for example, private
  data it shouldn't share), which would make delegating to it worth the cost.
