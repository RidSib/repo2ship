#!/usr/bin/env node
/**
 * Step 5: Cross-Model / Fresh-Context Adversarial Critic
 *
 * Behavior (Phase 2 Honest Setup):
 * 1. Stages new untracked files with intent-to-add (`git add -N .`) so `git diff`
 *    includes brand-new files, not just previously tracked files.
 * 2. Runs deterministic diff hygiene checks (conflict markers, `debugger`, `.skip`/`.only`).
 * 3. Runs the LLM Critic ONLY when a distinct `AZURE_CRITIC_MODEL` is configured
 *    (e.g. `o3` reviewing `chatgpt-6.1-sol`) or `ENABLE_CRITIC=true` is explicitly set.
 *    Otherwise skips duplicate same-model token spend and reports deterministic status.
 */

import fs from "node:fs";
import path from "node:path";
import { runAgent, setupEngines } from "./harness.mjs";
import { hasModelApiKey } from "./model-config.mjs";
import { getTaskChanges } from "./git-changes.mjs";
import { hasTestBypass } from "./validate-patch-policy.mjs";

export function runDeterministicDiffChecks(diffText) {
  const issues = [];

  const addedLines = diffText
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"));

  // Real conflict markers start the line; "=======" inside text (Markdown underlines, log banners) is fine
  if (addedLines.some((line) => /^\+(<<<<<<< |=======$|>>>>>>> |<<<<<<<$|>>>>>>>$)/.test(line))) {
    issues.push("Git merge conflict markers detected in diff.");
  }
  if (addedLines.some((line) => /\bdebugger\b/.test(line))) {
    issues.push("Leftover `debugger` statement detected in diff.");
  }
  if (addedLines.some(hasTestBypass)) {
    issues.push("Test bypass (`.skip`/`.only` or equivalent) detected in diff.");
  }

  return issues;
}

export function parseCriticVerdict(result, model) {
  try {
    if (!result.ok) throw new Error(result.error || "Critic process failed.");
    const match = (result.text || "").match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Critic returned no JSON verdict.");
    const parsed = JSON.parse(match[0]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        Object.keys(parsed).some((key) => !["approved", "summary", "issues"].includes(key)) ||
        typeof parsed.approved !== "boolean" || typeof parsed.summary !== "string" || !parsed.summary.trim() ||
        !Array.isArray(parsed.issues) || parsed.issues.some((issue) => typeof issue !== "string" || !issue.trim()) ||
        (parsed.approved && parsed.issues.length > 0) || (!parsed.approved && parsed.issues.length === 0)) {
      throw new Error("Critic returned an invalid or contradictory verdict.");
    }
    return { ...parsed, model, status: parsed.approved ? "approved" : "rejected" };
  } catch (err) {
    return { approved: false, model, status: "error", summary: `Critic review failed: ${err.message}`, issues: [] };
  }
}

export function runCritic({
  taskSpec = process.env.AGENT_TASK_PROMPT || "Verify changes match repository quality standards.",
  testOutput = "All local verification checks passed.",
  dryRun = process.argv.includes("--dry-run") || !hasModelApiKey(process.env),
  baseRef = process.env.AGENT_BASE_SHA || "origin/main",
  timeoutMs = 180_000,
} = {}) {
  const rootDir = process.cwd();
  const artifactsDir = path.join(rootDir, ".pi/artifacts");
  const agentDir = path.join(rootDir, ".pi/agent");
  const sessionDir = path.join(rootDir, ".pi/sessions");
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });

  const { roles } = setupEngines({ agentDir });
  const implementerModel = roles.implementer.model;
  const strategistModel = roles.strategist.model;
  const gitDiff = getTaskChanges({ baseRef }).diff;

  const deterministicIssues = runDeterministicDiffChecks(gitDiff);
  if (deterministicIssues.length > 0) {
    const verdict = {
      approved: false,
      model: "deterministic-hygiene-gate",
      summary: "Deterministic pre-critic diff check failed.",
      issues: deterministicIssues,
    };
    fs.writeFileSync(path.join(artifactsDir, "critic-verdict.json"), JSON.stringify(verdict, null, 2) + "\n", "utf8");
    return verdict;
  }

  const hasDistinctCriticModel = strategistModel !== implementerModel;
  const criticExplicitlyEnabled = process.env.ENABLE_CRITIC === "true" || hasDistinctCriticModel;

  if (dryRun || !criticExplicitlyEnabled) {
    const reason = dryRun
      ? "dry-run mode"
      : "skipped LLM call (set STRATEGIST_MODEL to a second model or ENABLE_CRITIC=true to enable cross-model review)";
    const verdict = {
      approved: true,
      model: `deterministic-only (${reason})`,
      summary: "Deterministic diff hygiene passed (zero conflict markers, debugger statements, or .skip/.only).",
      issues: [],
    };
    fs.writeFileSync(path.join(artifactsDir, "critic-verdict.json"), JSON.stringify(verdict, null, 2) + "\n", "utf8");
    return verdict;
  }

  const criticPrompt = [
    "You are an Adversarial Code Reviewer (Step 5 Critic) with a fresh context window.",
    "Inspect the task specification, git diff (including new files), and test results below.",
    "Check ONLY for this narrow rubric:",
    "1. Does the change match the task specification?",
    "2. Are there leftover debug artifacts or hardcoded secrets?",
    "3. Are tests missing for the new behavior or edge cases?",
    "",
    "Do NOT nitpick code style or formatting.",
    "Respond ONLY with a valid JSON object matching this exact schema (no markdown fences):",
    '{"approved": true, "summary": "Short 1-2 sentence explanation", "issues": []}',
    'If issues are found, set "approved": false and list concise items in "issues".',
    "",
    "=== TASK SPECIFICATION ===",
    taskSpec,
    "",
    "=== VERIFICATION OUTPUT ===",
    testOutput.slice(-4000),
    "",
    "=== GIT DIFF (INCLUDING NEW FILES) ===",
    gitDiff.slice(0, 24000) || "(No source file diff)",
  ].join("\n");

  // Fresh session with read-only tools: the critic never sees the implementer's conversation
  const result = runAgent({
    role: roles.strategist,
    roles,
    stage: "critic",
    prompt: criticPrompt,
    cwd: rootDir,
    agentDir,
    sessionDir,
    access: "read-only",
    timeoutMs,
  });

  const verdict = parseCriticVerdict(result, strategistModel);

  fs.writeFileSync(path.join(artifactsDir, "critic-verdict.json"), JSON.stringify(verdict, null, 2) + "\n", "utf8");
  return verdict;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const verdict = runCritic();
  console.log(`[pi-critic] Approved: ${verdict.approved} (${verdict.model})`);
  console.log(`[pi-critic] Summary: ${verdict.summary}`);
  if (!verdict.approved) {
    console.error("[pi-critic] Issues:", verdict.issues);
    process.exit(1);
  }
}
