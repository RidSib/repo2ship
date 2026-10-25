/**
 * Seed data for the Task & Sprint Tracker demo UI.
 *
 * Kept in a standalone module so both the browser app (`app.js`) and the
 * unit tests can share a single source of truth for the initial task counts.
 */
export const INITIAL_TASKS = [
  {
    id: "task-1",
    title: "Configure the coding agent and model provider",
    priority: "critical",
    status: "done",
  },
  {
    id: "task-2",
    title: "Wire Step 5 Fresh-Context Critic before PR creation",
    priority: "high",
    status: "done",
  },
  {
    id: "task-3",
    title: "Stream JSONL trajectories and token costs into Langfuse",
    priority: "medium",
    status: "in_progress",
  },
  {
    id: "task-4",
    title: "Harden repair runner against flaky E2E selectors",
    priority: "critical",
    status: "in_progress",
  },
  {
    id: "task-5",
    title: "Add CODEOWNERS-gated review step before auto-merge",
    priority: "high",
    status: "todo",
  },
  {
    id: "task-6",
    title: "Backfill sprint summary unit tests for edge cases",
    priority: "medium",
    status: "done",
  },
  {
    id: "task-7",
    title: "Document local model provider setup in README",
    priority: "low",
    status: "done",
  },
  {
    id: "task-8",
    title: "Triage intermittent Langfuse export timeouts",
    priority: "low",
    status: "todo",
  },
];