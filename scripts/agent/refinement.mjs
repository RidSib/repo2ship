#!/usr/bin/env node
/**
 * Stage 2 Refinement Agent Orchestrator & Schema Validator (`refinement.mjs`)
 *
 * Runs inside the isolated, read-only `refine` job using the `strategist` model role:
 * 1. Reads the issue prompt (`.pi/artifacts/task-prompt.txt`) + `AGENTS.md` + `scripts/agent/prompts/refine.md`.
 * 2. Invokes the strategist (pi or opencode, see `harness.mjs`) with read-only tools and its
 *    session in `.pi/sessions`.
 * 3. Strictly validates the JSON output against the refinement schema (retrying once on invalid JSON).
 * 4. Fails closed if the output is still invalid after 1 retry.
 * 5. Writes `.pi/artifacts/refinement.json` and `.pi/artifacts/refinement-comment.md`
 *    (including the `<!-- pi:refined-spec ... -->` marker when `status === "ready"`).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgentOrThrow, setupEngines } from "./harness.mjs";
import { isPipelinePublisher } from "./github-intake.mjs";

const ALLOWED_TOP_KEYS = new Set(["status", "questions", "spec"]);
const ALLOWED_SPEC_KEYS = new Set(["goal", "acceptanceCriteria", "outOfScope", "affectedAreas"]);
const ALLOWED_AC_KEYS = new Set(["id", "text"]);

export function parseRefinementJson(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("Empty refinement output.");
  }

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : text.trim();

  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error("No JSON object found in refinement output.");
  }

  const jsonSlice = candidate.slice(firstBrace, lastBrace + 1);
  return JSON.parse(jsonSlice);
}

export function validateRefinementResult(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid refinement result: expected a JSON object.");
  }

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_TOP_KEYS.has(key)) {
      throw new Error(`Invalid refinement result: unknown top-level key "${key}".`);
    }
  }

  if (raw.status !== "ready" && raw.status !== "needs_clarification") {
    throw new Error('Invalid refinement result: "status" must be "ready" or "needs_clarification".');
  }

  if (!Array.isArray(raw.questions) || raw.questions.some((q) => typeof q !== "string" || q.trim().length === 0)) {
    throw new Error('Invalid refinement result: "questions" must be an array of non-empty strings.');
  }

  if (raw.questions.length > 3) {
    throw new Error(`Invalid refinement result: "questions" allows at most 3 items (received ${raw.questions.length}).`);
  }

  if (raw.status === "needs_clarification" && raw.questions.length === 0) {
    throw new Error('Invalid refinement result: "needs_clarification" requires at least 1 question.');
  }

  if (raw.status === "ready" && raw.questions.length > 0) {
    throw new Error('Invalid refinement result: "questions" must be empty when status is "ready".');
  }

  const rawSpec = raw.spec ?? {};
  if (rawSpec === null || typeof rawSpec !== "object" || Array.isArray(rawSpec)) {
    throw new Error('Invalid refinement result: "spec" must be an object.');
  }

  for (const key of Object.keys(rawSpec)) {
    if (!ALLOWED_SPEC_KEYS.has(key)) {
      throw new Error(`Invalid refinement result: unknown spec key "${key}".`);
    }
  }

  const goal = typeof rawSpec.goal === "string" ? rawSpec.goal.trim() : "";
  const rawCriteria = Array.isArray(rawSpec.acceptanceCriteria) ? rawSpec.acceptanceCriteria : [];
  const rawOutOfScope = Array.isArray(rawSpec.outOfScope) ? rawSpec.outOfScope : [];
  const rawAffectedAreas = Array.isArray(rawSpec.affectedAreas) ? rawSpec.affectedAreas : [];

  if (rawOutOfScope.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error('Invalid refinement result: "spec.outOfScope" must be an array of non-empty strings.');
  }

  if (rawAffectedAreas.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error('Invalid refinement result: "spec.affectedAreas" must be an array of non-empty strings.');
  }

  const seenIds = new Set();
  const acceptanceCriteria = rawCriteria.map((item, idx) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Invalid refinement result: acceptanceCriteria[${idx}] must be an object.`);
    }
    for (const k of Object.keys(item)) {
      if (!ALLOWED_AC_KEYS.has(k)) {
        throw new Error(`Invalid refinement result: unknown key "${k}" in acceptanceCriteria[${idx}].`);
      }
    }
    if (typeof item.id !== "string" || !/^AC-\d+$/.test(item.id.trim())) {
      throw new Error(
        `Invalid refinement result: acceptanceCriteria[${idx}].id must match "AC-<number>" (received "${item.id}").`
      );
    }
    if (typeof item.text !== "string" || item.text.trim().length === 0) {
      throw new Error(`Invalid refinement result: acceptanceCriteria[${idx}].text must be a non-empty string.`);
    }
    const cleanId = item.id.trim();
    if (seenIds.has(cleanId)) {
      throw new Error(`Invalid refinement result: duplicate acceptance criterion id "${cleanId}".`);
    }
    seenIds.add(cleanId);
    return { id: cleanId, text: item.text.trim() };
  });

  if (raw.status === "ready") {
    if (!goal) {
      throw new Error('Invalid refinement result: "spec.goal" must be a non-empty string when status is "ready".');
    }
    if (acceptanceCriteria.length === 0) {
      throw new Error(
        'Invalid refinement result: "spec.acceptanceCriteria" must contain at least 1 item when status is "ready".'
      );
    }
  }

  return {
    status: raw.status,
    questions: raw.questions.map((q) => q.trim()),
    spec: {
      goal,
      acceptanceCriteria,
      outOfScope: rawOutOfScope.map((s) => s.trim()),
      affectedAreas: rawAffectedAreas.map((s) => s.trim()),
    },
  };
}

export function renderRefinementComment(result) {
  const validated = validateRefinementResult(result);

  if (validated.status === "needs_clarification") {
    const questionLines = validated.questions.map((q, idx) => `${idx + 1}. ${q}`).join("\n");
    return [
      "## 🤔 Clarification Needed Before Implementation",
      "",
      "Before the coding agent starts working on this issue, please clarify the following:",
      "",
      questionLines,
      "",
      "---",
      "*Reply in a comment mentioning `@pi` (for example, `@pi 1. ...`) to re-run refinement with your answers.*",
    ].join("\n");
  }

  const acLines = validated.spec.acceptanceCriteria
    .map((ac) => `- **${ac.id}:** ${ac.text}`)
    .join("\n");

  const outOfScopeLines =
    validated.spec.outOfScope.length > 0
      ? validated.spec.outOfScope.map((item) => `- ${item}`).join("\n")
      : "- None specified";

  const affectedLines =
    validated.spec.affectedAreas.length > 0
      ? validated.spec.affectedAreas.map((area) => `- \`${area}\``).join("\n")
      : "- To be determined during implementation";

  const markerPayload = JSON.stringify(validated);

  return [
    "## ✅ Refined Spec",
    "",
    `**Goal:** ${validated.spec.goal}`,
    "",
    "### Acceptance Criteria",
    acLines,
    "",
    "### Out of Scope",
    outOfScopeLines,
    "",
    "### Affected Areas",
    affectedLines,
    "",
    `<!-- pi:refined-spec\n${markerPayload}\n-->`,
  ].join("\n");
}

/**
 * Extracts the latest valid spec from the configured publisher's comments only.
 * Flattened text has no verifiable author and cannot supply a machine marker.
 */
export function extractRefinedSpecFromComments(commentsOrThread, publisherLogin = process.env.AGENT_PUBLISHER_LOGIN || "github-actions[bot]") {
  const texts = Array.isArray(commentsOrThread)
    ? commentsOrThread.filter((comment) => isPipelinePublisher(comment, publisherLogin)).map((comment) => comment.body || "")
    : [];

  const combined = texts.join("\n\n");
  const regex = /<!--\s*pi:refined-spec\s*([\s\S]*?)\s*-->/g;
  let match;
  let latestSpec = null;

  while ((match = regex.exec(combined)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const validated = validateRefinementResult(parsed);
      if (validated.status === "ready") {
        latestSpec = validated.spec;
      }
    } catch {
      // Ignore malformed marker blocks
    }
  }

  return latestSpec;
}

export function formatImplementerTaskWithSpec(taskPrompt, spec) {
  if (!spec || !Array.isArray(spec.acceptanceCriteria) || spec.acceptanceCriteria.length === 0) {
    return taskPrompt;
  }

  const acList = spec.acceptanceCriteria.map((ac) => `- **${ac.id}:** ${ac.text}`).join("\n");
  const outOfScopeList =
    Array.isArray(spec.outOfScope) && spec.outOfScope.length > 0
      ? spec.outOfScope.map((item) => `- ${item}`).join("\n")
      : "- None specified";
  const affectedList =
    Array.isArray(spec.affectedAreas) && spec.affectedAreas.length > 0
      ? spec.affectedAreas.map((area) => `- \`${area}\``).join("\n")
      : "- Inspect repository as needed";

  return [
    taskPrompt.trim(),
    "",
    "---",
    "## Approved Refined Specification (Mandatory)",
    "",
    `**Goal:** ${spec.goal}`,
    "",
    "### Acceptance Criteria",
    acList,
    "",
    "### Out of Scope",
    outOfScopeList,
    "",
    "### Affected Areas",
    affectedList,
    "",
    "### PR Summary Requirement",
    "In `.pi/artifacts/pr-summary.md`, include an `### Acceptance Criteria` section with one line per criterion ID (`- **AC-1:** ...`) explaining how it was implemented and verified.",
  ].join("\n");
}

function invokeStrategistRefinement({ prompt, sessionId, agentDir, sessionDir, roles, rootDir }) {
  return runAgentOrThrow({
    role: roles.strategist,
    roles,
    stage: "refinement",
    prompt,
    cwd: rootDir,
    agentDir,
    sessionDir,
    sessionId,
    access: "read-only",
    thinking: process.env.PI_THINKING_LEVEL || "high",
    timeoutMs: 300_000,
  });
}

export async function runRefinement({
  rootDir = process.cwd(),
  issuePromptText = "",
  dryRun = process.argv.includes("--dry-run"),
} = {}) {
  const agentDir = path.join(rootDir, ".pi/agent");
  const sessionDir = path.join(rootDir, ".pi/sessions");
  const artifactsDir = path.join(rootDir, ".pi/artifacts");
  const refinementJsonPath = path.join(artifactsDir, "refinement.json");
  const refinementCommentPath = path.join(artifactsDir, "refinement-comment.md");

  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(artifactsDir, { recursive: true });

  const { roles } = setupEngines({ agentDir });

  const rubricPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts/refine.md");
  const rubricText = fs.existsSync(rubricPath) ? fs.readFileSync(rubricPath, "utf8") : "";

  const taskPromptFile = path.join(artifactsDir, "task-prompt.txt");
  const effectiveIssueText =
    issuePromptText ||
    process.env.AGENT_TASK_PROMPT ||
    (fs.existsSync(taskPromptFile) ? fs.readFileSync(taskPromptFile, "utf8") : "");

  if (dryRun && fs.existsSync(refinementJsonPath)) {
    const raw = JSON.parse(fs.readFileSync(refinementJsonPath, "utf8"));
    const validated = validateRefinementResult(raw);
    const comment = renderRefinementComment(validated);
    fs.writeFileSync(refinementCommentPath, comment + "\n", "utf8");
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `status=${validated.status}\n`);
    }
    return validated;
  }

  const fullPrompt = [
    rubricText.trim(),
    "",
    "---",
    "## GitHub Issue to Refine",
    "",
    effectiveIssueText.trim(),
  ].join("\n");

  let stdout = "";
  let sessionId;
  try {
    const first = invokeStrategistRefinement({ prompt: fullPrompt, agentDir, sessionDir, roles, rootDir });
    stdout = first.text;
    sessionId = first.sessionId;
  } catch (err) {
    return failClosed(refinementCommentPath, `Strategist model invocation failed: ${err.message}`);
  }

  let validated = null;
  let firstError = null;
  try {
    validated = validateRefinementResult(parseRefinementJson(stdout));
  } catch (err) {
    firstError = err;
  }

  // Retry once if the model returned invalid JSON or violated the schema
  if (!validated) {
    console.warn(`[refinement] First attempt failed validation (${firstError.message}). Retrying once...`);
    try {
      const retryPrompt = [
        `Your previous response failed schema validation with error: ${firstError.message}`,
        "Respond with ONLY a valid JSON object matching the required schema (`status`, `questions`, `spec`).",
      ].join("\n\n");

      const retryStdout = invokeStrategistRefinement({
        prompt: retryPrompt,
        sessionId,
        agentDir,
        sessionDir,
        roles,
        rootDir,
      }).text;
      validated = validateRefinementResult(parseRefinementJson(retryStdout));
    } catch (retryErr) {
      return failClosed(
        refinementCommentPath,
        `Refinement output failed schema validation after retry: ${retryErr.message}`
      );
    }
  }

  fs.writeFileSync(refinementJsonPath, JSON.stringify(validated, null, 2) + "\n", "utf8");
  const comment = renderRefinementComment(validated);
  fs.writeFileSync(refinementCommentPath, comment + "\n", "utf8");

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `status=${validated.status}\n`);
  }

  console.log(`[refinement] Completed with status="${validated.status}"`);
  return validated;
}

function failClosed(refinementCommentPath, reason) {
  console.error(`[refinement] FAIL CLOSED: ${reason}`);
  const body = [
    "## ⚠️ Refinement Failed",
    "",
    "The refinement agent could not produce a valid specification for this issue, so implementation was skipped.",
    "",
    `- **Reason:** ${reason}`,
  ].join("\n");
  fs.writeFileSync(refinementCommentPath, body + "\n", "utf8");
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, "status=failed\n");
  }
  return { status: "failed", reason };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRefinement().catch((err) => {
    console.error("[refinement] Fatal error:", err.message || err);
    process.exit(1);
  });
}
