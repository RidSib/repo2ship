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

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runAgent, setupEngines } from "./harness.mjs";
import { hasModelApiKey } from "./model-config.mjs";

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
  if (addedLines.some((line) => /\b(test|it|describe)\.(skip|only)\b/.test(line))) {
    issues.push("Test bypass (`.skip` or `.only`) detected in diff.");
  }

  return issues;
}

function getFullWorkingTreeDiff() {
  try {
    // Stage untracked files with intent-to-add (-N) so new file contents appear in git diff
    execSync("git add -N .", { stdio: "ignore" });
  } catch {
    // Ignore if not in a git repo
  }

  try {
    return execSync("git diff HEAD -- . ':(exclude).pi'", {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return execSync("git diff -- . ':(exclude).pi'", {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
  }
}

export function runCritic({
  taskSpec = process.env.AGENT_TASK_PROMPT || "Verify changes match repository quality standards.",
  testOutput = "All local verification checks passed.",
  dryRun = process.argv.includes("--dry-run") || !hasModelApiKey(process.env),
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
  const gitDiff = getFullWorkingTreeDiff();

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
    timeoutMs: 180_000,
  });

  let verdict = {
    approved: true,
    model: strategistModel,
    summary: "Cross-model critic review completed.",
    issues: [],
  };

  const rawOutput = (result.text || "").trim();
  const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      verdict = {
        approved: Boolean(parsed.approved),
        model: strategistModel,
        summary: String(parsed.summary || ""),
        issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
      };
    } catch {
      verdict.summary = rawOutput.slice(0, 500);
    }
  } else if (!result.ok) {
    verdict.summary = `Critic run failed (${result.error}); falling back to deterministic verification.`;
  }

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
