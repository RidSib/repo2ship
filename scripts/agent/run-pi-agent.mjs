#!/usr/bin/env node
/**
 * Inner-Loop & Bounded Repair Orchestrator (`run-pi-agent.mjs`)
 *
 * Runs inside the untrusted `agent` job:
 * 1. Configures Azure OpenAI v1 Responses API models in `.pi/agent/models.json`.
 * 2. Runs the implementer on the configured engine (pi or opencode, see `harness.mjs`) while
 *    saving the JSONL trajectory to `.pi/sessions/`.
 * 3. Checks the Ambiguity Circuit Breaker (`.pi/artifacts/clarification-needed.md`).
 * 4. Runs tiered local verification (`npm run verify` + Playwright E2E when UI changes)
 *    with a bounded 3-attempt self-repair loop.
 * 5. Runs Step 5 Critic (`run-pi-critic.mjs`) and ALWAYS appends the Critic's notes
 *    to `.pi/artifacts/pr-summary.md` (even when the agent wrote its own summary).
 *
 * Security Note:
 * Path protection is enforced deterministically in the separate `publish` job
 * (`validate-patch-policy.mjs`) where the agent has no shell access.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runAgentOrThrow, setupEngines } from "./harness.mjs";
import { runCritic } from "./run-pi-critic.mjs";
import { loadPipelineConfig } from "./pipeline-config.mjs";
import {
  extractRefinedSpecFromComments,
  formatImplementerTaskWithSpec,
  validateRefinementResult,
} from "./refinement.mjs";

const MAX_REPAIR_ATTEMPTS = Number(process.env.MAX_REPAIR_ATTEMPTS || 3);

export function runVerificationSuite(pipelineConfig = loadPipelineConfig()) {
  const statusOutput = execSync("git status --porcelain", { encoding: "utf8" });
  const touchedUi =
    pipelineConfig.uiPaths.some((uiPath) => statusOutput.includes(uiPath)) ||
    process.env.FORCE_E2E_VERIFY === "true";

  const command = touchedUi ? pipelineConfig.verifyFull : pipelineConfig.verify;
  console.log(`[pi-runner] Running deterministic verification: ${command}`);

  try {
    const output = execSync(command, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180_000,
    });
    return { ok: true, command, output };
  } catch (err) {
    const stdout = err.stdout ? String(err.stdout) : "";
    const stderr = err.stderr ? String(err.stderr) : "";
    return {
      ok: false,
      command,
      output: `${stdout}\n${stderr}`.trim(),
    };
  }
}

function invokeImplementer({ prompt, sessionId, agentDir, sessionDir, roles, rootDir }) {
  // A failed model call (API error, timeout) is not something the repair loop can fix,
  // so stop instead of re-invoking the agent with test output it never saw.
  return runAgentOrThrow({
    role: roles.implementer,
    roles,
    stage: "implementer",
    prompt,
    cwd: rootDir,
    agentDir,
    sessionDir,
    sessionId,
    access: "full",
    thinking: process.env.PI_THINKING_LEVEL || "high",
    timeoutMs: 600_000,
  }).sessionId;
}

/**
 * A critic verdict blocks publishing when the deterministic hygiene gate failed (conflict markers,
 * debugger statements, .skip/.only) or when STRICT_CRITIC makes LLM critic objections mandatory.
 */
export function isMandatoryCriticFailure(criticVerdict, strictCritic = false) {
  if (criticVerdict.approved) return false;
  return criticVerdict.model === "deterministic-hygiene-gate" || strictCritic;
}

export function appendCriticSectionToSummary(prSummaryPath, { primaryModel, verificationCommand, criticVerdict }) {
  let existing = "";
  if (fs.existsSync(prSummaryPath)) {
    existing = fs.readFileSync(prSummaryPath, "utf8").trim();
  } else {
    existing = [
      "## Automated Changes Summary",
      "",
      `Implemented requested changes using \`${primaryModel}\` and verified locally via \`${verificationCommand}\`.`,
    ].join("\n");
  }

  const issueBullets =
    criticVerdict.issues && criticVerdict.issues.length > 0
      ? "\n" + criticVerdict.issues.map((item) => `  - ⚠️ ${item}`).join("\n")
      : "";

  const criticBlock = [
    "",
    "### Step 5 Critic & Local Verification",
    `- **Implementer Model:** \`${primaryModel}\``,
    `- **Local Verification:** \`${verificationCommand}\` passed`,
    `- **Critic Model:** \`${criticVerdict.model}\``,
    `- **Critic Verdict:** ${criticVerdict.approved ? "✅ Approved" : "⚠️ Advisory Notes"} — ${criticVerdict.summary}${issueBullets}`,
  ].join("\n");

  if (!existing.includes("### Step 5 Critic & Local Verification")) {
    fs.writeFileSync(prSummaryPath, `${existing}\n${criticBlock}\n`, "utf8");
  }
}

export async function main() {
  const rootDir = process.cwd();
  const agentDir = path.join(rootDir, ".pi/agent");
  const sessionDir = path.join(rootDir, ".pi/sessions");
  const artifactsDir = path.join(rootDir, ".pi/artifacts");
  const clarificationFile = path.join(artifactsDir, "clarification-needed.md");

  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(artifactsDir, { recursive: true });

  if (fs.existsSync(clarificationFile)) {
    fs.unlinkSync(clarificationFile);
  }

  const pipelineConfig = loadPipelineConfig(path.join(rootDir, ".pi/pipeline.json"));
  const { roles } = setupEngines({ agentDir });
  const { provider: implementerProvider, model: implementerModel } = roles.implementer;
  // The implementer keeps one session for its first pass, repairs and the critic repair pass
  let implementerSession;
  const dryRun = process.argv.includes("--dry-run");

  const rawTaskPrompt =
    process.env.AGENT_TASK_PROMPT ||
    process.argv.slice(2).filter((a) => a !== "--dry-run").join(" ") ||
    "Inspect the repository and run the verification suite.";

  let refinedSpec = null;
  const refinementJsonPath = path.join(artifactsDir, "refinement.json");
  if (fs.existsSync(refinementJsonPath)) {
    try {
      const parsed = validateRefinementResult(JSON.parse(fs.readFileSync(refinementJsonPath, "utf8")));
      if (parsed.status === "ready") {
        refinedSpec = parsed.spec;
      }
    } catch {
      // Fallback to marker extraction if file is malformed
    }
  }
  if (!refinedSpec) {
    refinedSpec = extractRefinedSpecFromComments(rawTaskPrompt);
  }

  const taskPrompt = formatImplementerTaskWithSpec(rawTaskPrompt, refinedSpec);

  console.log("====================================================================");
  console.log("[pi-runner] Starting Inner-Loop Execution (Steps 3-5)");
  console.log(
    `[pi-runner] Implementer: ${roles.implementer.engine} ${implementerProvider}/${implementerModel} | Strategist: ${roles.strategist.engine} ${roles.strategist.provider}/${roles.strategist.model} | Max Repair Attempts: ${MAX_REPAIR_ATTEMPTS}`
  );
  console.log("====================================================================");

  if (!dryRun) {
    implementerSession = invokeImplementer({
      prompt: taskPrompt,
      sessionId: implementerSession,
      agentDir,
      sessionDir,
      roles,
      rootDir,
    });
  } else {
    console.log("[pi-runner] Dry-run mode active: skipping live LLM call, running verification & critic gates.");
  }

  // Step 3 Circuit Breaker: Did the agent request human clarification?
  if (fs.existsSync(clarificationFile)) {
    const questions = fs.readFileSync(clarificationFile, "utf8").trim();
    if (questions.length > 0) {
      console.log("[pi-runner] CIRCUIT BREAKER TRIGGERED: Clarification needed from human.");
      if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, "clarification_needed=true\n");
      }
      return { status: "clarification_needed", questions };
    }
  }

  // Step 4: Bounded Local Verification & Self-Repair Loop
  let verification = runVerificationSuite(pipelineConfig);
  let attempt = 1;

  while (!verification.ok && attempt <= MAX_REPAIR_ATTEMPTS && !dryRun) {
    console.warn(`[pi-runner] Verification failed (Attempt ${attempt}/${MAX_REPAIR_ATTEMPTS}). Sending errors to Pi...`);
    const repairPrompt = [
      `Verification command \`${verification.command}\` failed on attempt ${attempt}/${MAX_REPAIR_ATTEMPTS}.`,
      "Fix the root cause of the failure below without weakening tests or modifying protected paths:",
      "",
      "```",
      verification.output.slice(-6000),
      "```",
    ].join("\n");

    implementerSession = invokeImplementer({
      prompt: repairPrompt,
      sessionId: implementerSession,
      agentDir,
      sessionDir,
      roles,
      rootDir,
    });

    verification = runVerificationSuite(pipelineConfig);
    attempt++;
  }

  if (!verification.ok) {
    console.error("[pi-runner] Verification still failing after bounded repair attempts.");
    throw new Error(`Verification failed after ${MAX_REPAIR_ATTEMPTS} repair attempts:\n${verification.output}`);
  }

  // Step 5: Critic Check (Deterministic hygiene + optional cross-model review)
  console.log("[pi-runner] Step 5: Running Critic check...");
  let criticVerdict = runCritic({
    taskSpec: taskPrompt,
    testOutput: verification.output,
    dryRun,
  });

  const strictCritic = process.env.STRICT_CRITIC === "true";

  if (!dryRun && isMandatoryCriticFailure(criticVerdict, strictCritic)) {
    console.warn("[pi-runner] Critic requested mandatory fixes. Running 1 final bounded pass...");
    const criticRepairPrompt = [
      "The Critic reviewed your diff and requested the following mandatory fixes before PR creation:",
      ...criticVerdict.issues.map((issue, idx) => `${idx + 1}. ${issue}`),
      "",
      `Apply these fixes surgically and re-verify with \`${pipelineConfig.verify}\`.`,
    ].join("\n");

    implementerSession = invokeImplementer({
      prompt: criticRepairPrompt,
      sessionId: implementerSession,
      agentDir,
      sessionDir,
      roles,
      rootDir,
    });

    verification = runVerificationSuite(pipelineConfig);
    if (!verification.ok) {
      throw new Error(`Verification failed after critic pass:\n${verification.output}`);
    }
    criticVerdict = runCritic({
      taskSpec: taskPrompt,
      testOutput: verification.output,
      dryRun,
    });
    // The repair pass gets one chance; publishing a diff that still fails mandatory checks is not allowed
    if (isMandatoryCriticFailure(criticVerdict, strictCritic)) {
      const unresolved = (criticVerdict.issues || []).map((issue) => `- ${issue}`).join("\n");
      throw new Error(`Critic issues still unresolved after the repair pass:\n${unresolved}`);
    }
  }

  // Always append the Critic & Verification section to `.pi/artifacts/pr-summary.md`
  const prSummaryPath = path.join(artifactsDir, "pr-summary.md");
  appendCriticSectionToSummary(prSummaryPath, {
    primaryModel: implementerModel,
    verificationCommand: verification.command,
    criticVerdict,
  });

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, "clarification_needed=false\n");
  }

  console.log("[pi-runner] Inner-loop Steps 3-5 completed successfully!");
  return { status: "success", verification, criticVerdict };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[pi-runner] Fatal error:", err.message || err);
    process.exit(1);
  });
}
