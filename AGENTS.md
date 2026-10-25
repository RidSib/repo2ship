# Agent Engineering Contract (`AGENTS.md`)

You are an autonomous software engineering agent (`pi` or `opencode`) operating inside a policy-controlled repository. Follow these rules strictly on every task.

## 1. Repository Architecture

- `src/task-store.ts` — Pure domain logic & state management for the demo web application (Task & Sprint Tracker).
- `public/index.html` & `public/app.js` — Browser UI for the web application.
- `scripts/dev-server.mjs` — Zero-dependency HTTP server serving `public/` and API routes on `http://127.0.0.1:4173`.
- `tests/unit/` — Fast Vitest unit tests (`npm test`).
- `tests/e2e/` — Headless Playwright browser & UI tests (`npm run test:e2e`).
- `scripts/agent/` — Outer-loop orchestration scripts (provider-neutral model setup, Pi/OpenCode harness, bounded repair runner, cross-model critic, Langfuse trace exporter). **Protected path: Do not modify unless explicitly instructed by a human maintainer.**

## 2. Step-by-Step Execution Protocol

### Step A: Read-Only Discovery & Ambiguity Circuit Breaker
1. Read the issue specification or PR review comments carefully.
2. Inspect the relevant files in `src/`, `public/`, and `tests/`.
3. **Ambiguity Circuit Breaker**: If the requirements are genuinely contradictory, missing critical business logic, or impossible to verify without human input:
   - Write your concise, bulleted clarifying questions to `.pi/artifacts/clarification-needed.md`.
   - Stop immediately without modifying application files. The outer workflow will post your questions to the GitHub Issue/PR and pause until a human replies.

### Step B: Surgical Implementation & Tiered Verification
1. Keep diffs small, surgical, and idiomatic. Preserve existing comments and formatting.
2. **After every file edit (<5s loop)**:
   ```bash
   npm run typecheck
   ```
3. **After completing a logical milestone (<30s loop)**:
   ```bash
   npm test
   ```
4. **Whenever `public/` or UI behavior changes**:
   ```bash
   npm run test:e2e
   ```
   Ensure the Playwright test saves an updated screenshot to `.pi/artifacts/ui-verify.png` and passes with zero `pageerror` or `console.error` events.

### Step C: PR Summary Artifact
Before finishing, write a concise markdown summary of your changes, root cause (if fixing a bug), and verification results to `.pi/artifacts/pr-summary.md`.

## 3. Security & Policy Boundaries (Hard Rules)
- **Never** modify `.github/workflows/`, `.github/CODEOWNERS`, or `scripts/agent/` during automated issue runs.
- **Never** hardcode API keys, tokens, or secrets in source files or tests.
- **Never** bypass failing tests by deleting assertions or adding `.skip` unless the test itself was explicitly deprecated in the issue spec.
