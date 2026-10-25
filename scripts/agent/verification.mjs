#!/usr/bin/env node
/**
 * Stage 4/5 Independent Verifier Agent (`verification.mjs`)
 *
 * Runs inside the isolated, read-only `verify` job using the `strategist` model role:
 * 1. Extracts the refined spec (from the issue's `<!-- pi:refined-spec ... -->` marker, or
 *    falls back to the issue/PR Acceptance Criteria section).
 * 2. Computes the local git diff (`git diff origin/main...HEAD`) without any GitHub token.
 * 3. Starts the application server configured in `.pi/pipeline.json` (bound to `127.0.0.1`)
 *    and waits for the configured `url` to respond before invoking Pi.
 * 4. Invokes the strategist (pi or opencode, see `harness.mjs`) with its session in `.pi/sessions`
 *    to review the diff
 *    and run per-AC Playwright QA checks under `.pi/qa/` with screenshots (`.pi/qa/<AC-id>.png`).
 * 5. Strictly validates `.pi/artifacts/verification.json` (retrying once on invalid JSON,
 *    failing closed if still invalid).
 * 6. Also provides deterministic review-payload rendering and fix-round gating for `verify-publish`.
 */

import { execSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPipelineConfigFromRef } from "./pipeline-config.mjs";
import { extractRefinedSpecFromComments } from "./refinement.mjs";
import { runAgentOrThrow, setupEngines } from "./harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SECRET_ENV_PATTERN = /^(AWS_|MODEL_|AZURE_|OPENAI_|OPENCODE_|LANGFUSE_|GH_TOKEN$|GITHUB_TOKEN$|ACTIONS_|APP_PRIVATE_KEY$)/;

export function withoutSecrets(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !SECRET_ENV_PATTERN.test(key)));
}

const ALLOWED_TOP_KEYS = new Set(["verdict", "criteria", "findings"]);
const ALLOWED_CRITERIA_KEYS = new Set(["id", "status", "evidence", "screenshot"]);
const ALLOWED_FINDING_KEYS = new Set(["severity", "file", "line", "text"]);
const VALID_VERDICTS = new Set(["pass", "changes_needed"]);
const VALID_CRITERIA_STATUS = new Set(["pass", "fail", "unclear"]);
const VALID_SEVERITIES = new Set(["high", "medium", "low"]);

export const FIX_ROUND_LABEL = "pi-fix-round-1";

export function parseVerificationJson(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("Empty verification output.");
  }

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : text.trim();

  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error("No JSON object found in verification output.");
  }

  const jsonSlice = candidate.slice(firstBrace, lastBrace + 1);
  return JSON.parse(jsonSlice);
}

export function validateVerificationResult(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid verification result: expected a JSON object.");
  }

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_TOP_KEYS.has(key)) {
      throw new Error(`Invalid verification result: unknown top-level key "${key}".`);
    }
  }

  if (!VALID_VERDICTS.has(raw.verdict)) {
    throw new Error('Invalid verification result: "verdict" must be "pass" or "changes_needed".');
  }

  if (!Array.isArray(raw.criteria) || raw.criteria.length === 0) {
    throw new Error('Invalid verification result: "criteria" must be a non-empty array.');
  }

  const seenIds = new Set();
  const criteria = raw.criteria.map((item, idx) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Invalid verification result: criteria[${idx}] must be an object.`);
    }
    for (const k of Object.keys(item)) {
      if (!ALLOWED_CRITERIA_KEYS.has(k)) {
        throw new Error(`Invalid verification result: unknown key "${k}" in criteria[${idx}].`);
      }
    }
    if (typeof item.id !== "string" || item.id.trim().length === 0) {
      throw new Error(`Invalid verification result: criteria[${idx}].id must be a non-empty string.`);
    }
    const cleanId = item.id.trim();
    if (seenIds.has(cleanId)) {
      throw new Error(`Invalid verification result: duplicate criterion id "${cleanId}".`);
    }
    seenIds.add(cleanId);

    if (!VALID_CRITERIA_STATUS.has(item.status)) {
      throw new Error(
        `Invalid verification result: criteria[${idx}].status must be "pass", "fail", or "unclear" (received "${item.status}").`
      );
    }

    if (typeof item.evidence !== "string" || item.evidence.trim().length === 0) {
      throw new Error(`Invalid verification result: criteria[${idx}].evidence must be a non-empty string.`);
    }

    if (item.screenshot !== undefined && item.screenshot !== null && typeof item.screenshot !== "string") {
      throw new Error(`Invalid verification result: criteria[${idx}].screenshot must be a string when provided.`);
    }

    return {
      id: cleanId,
      status: item.status,
      evidence: item.evidence.trim(),
      screenshot: typeof item.screenshot === "string" ? item.screenshot.trim() : "",
    };
  });

  if (!Array.isArray(raw.findings)) {
    throw new Error('Invalid verification result: "findings" must be an array.');
  }

  const findings = raw.findings.map((item, idx) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Invalid verification result: findings[${idx}] must be an object.`);
    }
    for (const k of Object.keys(item)) {
      if (!ALLOWED_FINDING_KEYS.has(k)) {
        throw new Error(`Invalid verification result: unknown key "${k}" in findings[${idx}].`);
      }
    }
    if (!VALID_SEVERITIES.has(item.severity)) {
      throw new Error(
        `Invalid verification result: findings[${idx}].severity must be "high", "medium", or "low" (received "${item.severity}").`
      );
    }
    if (typeof item.text !== "string" || item.text.trim().length === 0) {
      throw new Error(`Invalid verification result: findings[${idx}].text must be a non-empty string.`);
    }

    let file = "";
    if (item.file !== undefined && item.file !== null) {
      if (typeof item.file !== "string") {
        throw new Error(`Invalid verification result: findings[${idx}].file must be a string.`);
      }
      file = item.file.trim();
    }

    let line = null;
    if (item.line !== undefined && item.line !== null) {
      if (typeof item.line !== "number" || !Number.isInteger(item.line) || item.line <= 0) {
        throw new Error(`Invalid verification result: findings[${idx}].line must be a positive integer.`);
      }
      line = item.line;
    }

    return {
      severity: item.severity,
      file,
      ...(line !== null ? { line } : {}),
      text: item.text.trim(),
    };
  });

  const hasNonPassCriterion = criteria.some((c) => c.status !== "pass");
  if (raw.verdict === "pass" && hasNonPassCriterion) {
    throw new Error(
      'Invalid verification result: "verdict" cannot be "pass" when one or more criteria have status "fail" or "unclear".'
    );
  }

  const hasHighFinding = findings.some((f) => f.severity === "high");
  if (raw.verdict === "pass" && hasHighFinding) {
    throw new Error('Invalid verification result: "verdict" cannot be "pass" when high-severity findings exist.');
  }

  return {
    verdict: raw.verdict,
    criteria,
    findings,
  };
}

/**
 * Extracts the specification for the verifier from the issue JSON (preferring the
 * `<!-- pi:refined-spec ... -->` marker comment, falling back to the issue's
 * Acceptance Criteria section or PR body).
 * @param {any} [options]
 */
export function extractSpecForVerification(options = {}) {
  const { issueJson = null, prJson = null } = options;
  const commentTexts = [];
  if (issueJson?.body) commentTexts.push(issueJson.body);
  if (Array.isArray(issueJson?.comments)) {
    for (const c of issueJson.comments) {
      if (c?.body) commentTexts.push(c.body);
    }
  }
  if (prJson?.body) commentTexts.push(prJson.body);

  const refined = extractRefinedSpecFromComments(commentTexts);
  if (refined && Array.isArray(refined.acceptanceCriteria) && refined.acceptanceCriteria.length > 0) {
    return {
      source: "refined-spec",
      goal: refined.goal,
      acceptanceCriteria: refined.acceptanceCriteria,
      outOfScope: refined.outOfScope || [],
      affectedAreas: refined.affectedAreas || [],
    };
  }

  // Fallback: parse Acceptance Criteria section from issue body or PR body
  const fallbackSourceText = String(issueJson?.body || prJson?.body || "");
  const fallbackTitle = String(issueJson?.title || prJson?.title || "Verify pull request changes").trim();
  const acSectionMatch = fallbackSourceText.match(
    /###\s*Acceptance\s+Criteria\s*\r?\n([\s\S]*?)(?=\r?\n###\s+|\r?\n##\s+|$)/i
  );
  const sectionText = acSectionMatch ? acSectionMatch[1] : fallbackSourceText;
  const bulletLines = sectionText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line));

  const acceptanceCriteria = [];
  for (const rawLine of bulletLines) {
    const cleaned = rawLine
      .replace(/^[-*]\s+(\[[ xX]\]\s+)?/, "")
      .replace(/^\d+\.\s+/, "")
      .trim();
    if (!cleaned) continue;
    const explicitIdMatch = cleaned.match(/^\*\*?(AC-\d+)\*?\*?:\s*(.+)$/i);
    if (explicitIdMatch) {
      acceptanceCriteria.push({
        id: explicitIdMatch[1].toUpperCase(),
        text: explicitIdMatch[2].trim(),
      });
    } else {
      acceptanceCriteria.push({
        id: `AC-${acceptanceCriteria.length + 1}`,
        text: cleaned,
      });
    }
  }

  if (acceptanceCriteria.length === 0) {
    acceptanceCriteria.push({
      id: "AC-1",
      text: fallbackTitle,
    });
  }

  return {
    source: "fallback-issue-body",
    goal: fallbackTitle,
    acceptanceCriteria,
    outOfScope: [],
    affectedAreas: [],
  };
}

/**
 * Parses a unified git diff and returns a Map<filePath, Set<rightSideLineNumber>>
 * so we only attach inline GitHub PR review comments to lines that exist in the diff.
 */
export function parseDiffRightSideLines(diffText) {
  const fileMap = new Map();
  if (typeof diffText !== "string" || !diffText.trim()) return fileMap;

  let currentFile = null;
  let rightLine = 0;
  let inHunk = false;

  for (const rawLine of diffText.split(/\r?\n/)) {
    if (rawLine.startsWith("diff --git ")) {
      currentFile = null;
      inHunk = false;
      continue;
    }
    if (rawLine.startsWith("+++ b/")) {
      currentFile = rawLine.slice("+++ b/".length).trim();
      if (!fileMap.has(currentFile)) {
        fileMap.set(currentFile, new Set());
      }
      inHunk = false;
      continue;
    }
    const hunkMatch = rawLine.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunkMatch && currentFile) {
      rightLine = Number.parseInt(hunkMatch[1], 10);
      inHunk = true;
      continue;
    }
    if (!inHunk || !currentFile) continue;

    if (rawLine.startsWith("+")) {
      fileMap.get(currentFile).add(rightLine);
      rightLine += 1;
    } else if (rawLine.startsWith(" ")) {
      fileMap.get(currentFile).add(rightLine);
      rightLine += 1;
    } else if (rawLine.startsWith("-")) {
      // Deleted line does not advance right-side line counter
    } else if (rawLine.startsWith("\\")) {
      // "\ No newline at end of file"
    } else {
      inHunk = false;
    }
  }

  return fileMap;
}

/**
 * @param {any} [options]
 */
export function shouldTriggerFixRound(options = {}) {
  const { verdict, labels = [] } = options;
  if (verdict !== "changes_needed") return false;
  const normalized = Array.isArray(labels)
    ? labels.map((l) => (typeof l === "string" ? l : l?.name || "")).filter(Boolean)
    : [];
  return !normalized.includes(FIX_ROUND_LABEL);
}

function escapeTableCell(text) {
  return String(text || "")
    .replace(/\r?\n+/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

/**
 * @param {any} result
 * @param {any} [options]
 */
export function renderVerificationReview(result, options = {}) {
  const { evidenceUrls = {}, traceUrl = "", willTriggerFix = false } = options;
  const validated = validateVerificationResult(result);
  const passedCount = validated.criteria.filter((c) => c.status === "pass").length;
  const totalCount = validated.criteria.length;

  const heading =
    validated.verdict === "pass"
      ? "## ✅ Verifier Review: Passed"
      : "## ❌ Verifier Review: Changes Needed";

  const statusBadge = (status) => {
    if (status === "pass") return "✅ `pass`";
    if (status === "fail") return "❌ `fail`";
    return "⚠️ `unclear`";
  };

  const tableRows = validated.criteria.map((c) => {
    const url = evidenceUrls[c.id];
    const screenshotCell = url ? `[View Screenshot](${url})` : c.screenshot ? `\`${escapeTableCell(c.screenshot)}\`` : "—";
    return `| **${escapeTableCell(c.id)}** | ${statusBadge(c.status)} | ${escapeTableCell(c.evidence)} | ${screenshotCell} |`;
  });

  const findingsLines =
    validated.findings.length > 0
      ? validated.findings.map((f) => {
          const loc = f.file ? ` \`${f.file}${f.line ? `:${f.line}` : ""}\`` : "";
          return `- **[${f.severity.toUpperCase()}]**${loc} — ${f.text}`;
        })
      : ["_No code review findings._"];

  const inlineScreenshots = validated.criteria
    .filter((c) => Boolean(evidenceUrls[c.id]))
    .map((c) => `#### ${c.id} (${c.status})\n![${c.id} screenshot](${evidenceUrls[c.id]})`);

  const lines = [
    heading,
    "",
    `- **Verdict:** \`${validated.verdict}\` (${passedCount}/${totalCount} acceptance criteria passed)`,
    ...(traceUrl ? [`- **Langfuse Verifier Trace:** ${traceUrl}`] : []),
    "",
    "### Acceptance Criteria QA",
    "",
    "| Criterion | Status | Evidence | Screenshot |",
    "| :--- | :--- | :--- | :--- |",
    ...tableRows,
    "",
    "### Code Review Findings",
    "",
    ...findingsLines,
  ];

  if (inlineScreenshots.length > 0) {
    lines.push(
      "",
      "<details>",
      "<summary>📸 Per-AC QA Screenshots</summary>",
      "",
      ...inlineScreenshots,
      "",
      "</details>"
    );
  }

  if (willTriggerFix) {
    lines.push(
      "",
      `> 🔄 **Automatic Fix Round:** Triggering bounded repair run (\`${FIX_ROUND_LABEL}\`) to address the failed acceptance criteria / review findings.`
    );
  }

  lines.push("", `<!-- pi:verification\n${JSON.stringify(validated)}\n-->`);
  return lines.join("\n");
}

/**
 * Builds the GitHub Pull Request Review API payload.
 * Hard rule: `event` is ALWAYS `"COMMENT"` (never `"APPROVE"` or `"REQUEST_CHANGES"`).
 * @param {any} result
 * @param {any} [options]
 */
export function buildGitHubReviewPayload(result, options = {}) {
  const { evidenceUrls = {}, traceUrl = "", diffText = "", willTriggerFix = false } = options;
  const validated = validateVerificationResult(result);
  const body = renderVerificationReview(validated, { evidenceUrls, traceUrl, willTriggerFix });
  const diffLines = diffText ? parseDiffRightSideLines(diffText) : null;

  const comments = [];
  for (const finding of validated.findings) {
    if (!finding.file || !finding.line) continue;
    if (diffLines && (!diffLines.has(finding.file) || !diffLines.get(finding.file).has(finding.line))) {
      continue;
    }
    comments.push({
      path: finding.file,
      line: finding.line,
      side: "RIGHT",
      body: `**[Verifier ${finding.severity.toUpperCase()}]** ${finding.text}`,
    });
  }

  return {
    event: "COMMENT",
    body,
    comments,
  };
}

/**
 * @param {string} reason
 * @param {any} [options]
 */
export function buildFailedVerificationReviewPayload(reason, options = {}) {
  const { traceUrl = "" } = options;
  const body = [
    "## ⚠️ Verifier Review: Verification Failed",
    "",
    "The verifier agent could not produce a valid verification report (failing closed without triggering an automatic fix round).",
    "",
    `- **Reason:** ${reason}`,
    ...(traceUrl ? [`- **Langfuse Verifier Trace:** ${traceUrl}`] : []),
    "",
    `<!-- pi:verification\n${JSON.stringify({ verdict: "failed", reason, criteria: [], findings: [] })}\n-->`,
  ].join("\n");

  return {
    event: "COMMENT",
    body,
    comments: [],
  };
}

export function extractLatestVerificationFromReviews(reviewsOrTexts) {
  const texts = Array.isArray(reviewsOrTexts)
    ? reviewsOrTexts.map((r) => (typeof r === "string" ? r : r?.body || ""))
    : [typeof reviewsOrTexts === "string" ? reviewsOrTexts : ""];
  const combined = texts.join("\n\n");
  const regex = /<!--\s*pi:verification\s*([\s\S]*?)\s*-->/g;
  let match;
  let latest = null;
  while ((match = regex.exec(combined)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      latest = validateVerificationResult(parsed);
    } catch {
      // Ignore malformed or failed-closed blocks
    }
  }
  return latest;
}

/**
 * @param {any} [options]
 */
export function formatFixPrTaskPrompt(options = {}) {
  const { prNumber, prTitle = "", prThreadText = "", verification = null } = options;
  const lines = [
    prThreadText.trim() || `# Pull Request #${prNumber}: ${prTitle}`,
    "",
    "---",
    `## 🔧 Mandatory Verifier Fix Task (PR #${prNumber})`,
    "",
    "The independent Verifier Agent reviewed this Pull Request and reported `changes_needed`.",
    "Fix every failed or unclear Acceptance Criterion and resolve the verifier findings below:",
  ];

  if (verification) {
    const failedCriteria = (verification.criteria || []).filter((c) => c.status !== "pass");
    if (failedCriteria.length > 0) {
      lines.push("", "### Failed / Unclear Acceptance Criteria");
      for (const c of failedCriteria) {
        lines.push(`- **${c.id}** (\`${c.status}\`): ${c.evidence}`);
      }
    }
    if (Array.isArray(verification.findings) && verification.findings.length > 0) {
      lines.push("", "### Verifier Findings to Fix");
      for (const f of verification.findings) {
        const loc = f.file ? ` \`${f.file}${f.line ? `:${f.line}` : ""}\`` : "";
        lines.push(`- **[${f.severity.toUpperCase()}]**${loc}: ${f.text}`);
      }
    }
  }

  return lines.join("\n");
}

async function waitForAppReady(url, timeoutSeconds = 15) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Application at ${url} did not become ready within ${timeoutSeconds}s (${lastError?.message || "timeout"})`);
}

function invokeStrategistVerifier({ prompt, sessionId, agentDir, sessionDir, roles, cwd }) {
  return runAgentOrThrow({
    role: roles.strategist,
    roles,
    stage: "verifier",
    prompt,
    cwd,
    agentDir,
    sessionDir,
    sessionId,
    // Browser QA needs a shell and file writes (.pi/qa scripts, verification.json)
    access: "full",
    thinking: process.env.PI_THINKING_LEVEL || "high",
    timeoutMs: 600_000,
  });
}

/**
 * A verdict only counts if it reports on exactly the spec's acceptance criteria: every expected ID
 * once, nothing else. Otherwise a "pass" could silently skip criteria.
 */
export function assertCriteriaCoverage(result, expectedIds) {
  if (!expectedIds || expectedIds.length === 0) return result;
  const reported = result.criteria.map((c) => c.id);
  const missing = expectedIds.filter((id) => !reported.includes(id));
  const unexpected = reported.filter((id) => !expectedIds.includes(id));
  const duplicates = reported.filter((id, idx) => reported.indexOf(id) !== idx);
  const problems = [
    missing.length > 0 ? `missing ${missing.join(", ")}` : "",
    unexpected.length > 0 ? `unknown ${unexpected.join(", ")}` : "",
    duplicates.length > 0 ? `duplicate ${[...new Set(duplicates)].join(", ")}` : "",
  ].filter(Boolean);
  if (problems.length > 0) {
    throw new Error(
      `Invalid verification result: criteria must cover exactly ${expectedIds.join(", ")} (${problems.join("; ")}).`
    );
  }
  return result;
}

function readCandidateVerification(verificationJsonPath, stdout, expectedIds) {
  if (fs.existsSync(verificationJsonPath)) {
    try {
      const fileRaw = JSON.parse(fs.readFileSync(verificationJsonPath, "utf8"));
      return assertCriteriaCoverage(validateVerificationResult(fileRaw), expectedIds);
    } catch (fileErr) {
      // Fall through to stdout if file was not valid yet
      if (!stdout || !stdout.trim()) throw fileErr;
    }
  }
  return assertCriteriaCoverage(validateVerificationResult(parseVerificationJson(stdout)), expectedIds);
}

export async function runVerification({
  rootDir = process.cwd(),
  dryRun = process.argv.includes("--dry-run"),
} = {}) {
  const agentDir = path.join(rootDir, ".pi/agent");
  const sessionDir = path.join(rootDir, ".pi/sessions");
  const artifactsDir = path.join(rootDir, ".pi/artifacts");
  const qaDir = path.join(rootDir, ".pi/qa");
  const verificationJsonPath = path.join(artifactsDir, "verification.json");

  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.mkdirSync(qaDir, { recursive: true });
  fs.writeFileSync(path.join(qaDir, ".keep"), "", "utf8");

  if (dryRun && fs.existsSync(verificationJsonPath)) {
    const raw = JSON.parse(fs.readFileSync(verificationJsonPath, "utf8"));
    const validated = validateVerificationResult(raw);
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `verdict=${validated.verdict}\n`);
    }
    return validated;
  }

  let appProcess = null;
  try {
    // Read the start command from main, never from the PR under verification
    const pipelineConfig = loadPipelineConfigFromRef("origin/main", rootDir);
    const { roles } = setupEngines({ agentDir });

    const issueJsonPath = path.join(artifactsDir, "verify-issue.json");
    const prJsonPath = path.join(artifactsDir, "verify-pr.json");
    const issueJson = fs.existsSync(issueJsonPath) ? JSON.parse(fs.readFileSync(issueJsonPath, "utf8")) : null;
    const prJson = fs.existsSync(prJsonPath) ? JSON.parse(fs.readFileSync(prJsonPath, "utf8")) : null;

    const spec = extractSpecForVerification({ issueJson, prJson });
    fs.writeFileSync(path.join(artifactsDir, "verify-spec.json"), JSON.stringify(spec, null, 2) + "\n", "utf8");
    const expectedCriteriaIds = spec.acceptanceCriteria.map((ac) => ac.id);

    let diffText = "";
    try {
      diffText = execSync("git diff origin/main...HEAD", { cwd: rootDir, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    } catch {
      diffText = execSync("git diff HEAD~1...HEAD", { cwd: rootDir, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    }
    fs.writeFileSync(path.join(artifactsDir, "pr-diff.patch"), diffText, "utf8");

    const rubricPath = path.join(__dirname, "prompts/verify.md");
    const rubricText = fs.existsSync(rubricPath) ? fs.readFileSync(rubricPath, "utf8") : "";

    const acFormatted = spec.acceptanceCriteria.map((ac) => `- **${ac.id}:** ${ac.text}`).join("\n");
    const outOfScopeFormatted =
      spec.outOfScope.length > 0 ? spec.outOfScope.map((s) => `- ${s}`).join("\n") : "- None specified";

    const fullPrompt = [
      rubricText.trim(),
      "",
      "---",
      "## Verification Target & Environment",
      `- **Running App URL:** ${pipelineConfig.url || "http://127.0.0.1:4173"}`,
      `- **Spec Source:** ${spec.source}`,
      `- **Goal:** ${spec.goal}`,
      "",
      "### Acceptance Criteria to Verify",
      acFormatted,
      "",
      "### Out of Scope",
      outOfScopeFormatted,
      "",
      "### Pull Request Unified Diff (`git diff origin/main...HEAD`)",
      "```diff",
      diffText.slice(0, 60_000),
      "```",
    ].join("\n");

    fs.writeFileSync(path.join(artifactsDir, "task-prompt.txt"), fullPrompt, "utf8");

    if (pipelineConfig.start && pipelineConfig.url) {
      console.log(`[verifier] Starting application with "${pipelineConfig.start}" and waiting for ${pipelineConfig.url}...`);
      appProcess = spawn(pipelineConfig.start, {
        cwd: rootDir,
        shell: true,
        detached: true,
        stdio: "ignore",
        // The app under test is PR code: give it no credentials
        env: { ...withoutSecrets(process.env), HOST: "127.0.0.1" },
      });
      appProcess.unref();
      await waitForAppReady(pipelineConfig.url, pipelineConfig.readyTimeoutSeconds || 15);
      console.log(`[verifier] Application is ready at ${pipelineConfig.url}.`);
    }

    let stdout = "";
    let verifierSession;
    try {
      // Remove any stale verification.json before running Pi
      if (fs.existsSync(verificationJsonPath)) fs.unlinkSync(verificationJsonPath);
      const first = invokeStrategistVerifier({ prompt: fullPrompt, agentDir, sessionDir, roles, cwd: rootDir });
      stdout = first.text;
      verifierSession = first.sessionId;
    } catch (err) {
      return failClosed(artifactsDir, `Strategist verifier invocation failed: ${err.message}`);
    } finally {
      // Clean up any accidental edits to tracked files before validating
      try {
        execSync("git checkout -- .", { cwd: rootDir, stdio: "ignore" });
      } catch {
        // Ignore
      }
    }

    let validated = null;
    let firstError = null;
    try {
      validated = readCandidateVerification(verificationJsonPath, stdout, expectedCriteriaIds);
    } catch (err) {
      firstError = err;
    }

    if (!validated) {
      console.warn(`[verifier] First attempt failed schema validation (${firstError.message}). Retrying once...`);
      try {
        if (fs.existsSync(verificationJsonPath)) fs.unlinkSync(verificationJsonPath);
        const retryPrompt = [
          `Your previous verification output failed schema validation with error: ${firstError.message}`,
          "Write and output ONLY a valid JSON object matching the required schema (`verdict`, `criteria`, `findings`) to `.pi/artifacts/verification.json`.",
        ].join("\n\n");

        const retryStdout = invokeStrategistVerifier({
          prompt: retryPrompt,
          sessionId: verifierSession,
          agentDir,
          sessionDir,
          roles,
          cwd: rootDir,
        }).text;
        validated = readCandidateVerification(verificationJsonPath, retryStdout, expectedCriteriaIds);
      } catch (retryErr) {
        return failClosed(
          artifactsDir,
          `Verification output failed schema validation after retry: ${retryErr.message}`
        );
      } finally {
        try {
          execSync("git checkout -- .", { cwd: rootDir, stdio: "ignore" });
        } catch {
          // Ignore
        }
      }
    }

    fs.writeFileSync(verificationJsonPath, JSON.stringify(validated, null, 2) + "\n", "utf8");
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `verdict=${validated.verdict}\n`);
    }
    console.log(`[verifier] Completed with verdict="${validated.verdict}"`);
    return validated;
  } catch (unexpectedErr) {
    return failClosed(artifactsDir, `Verifier setup or execution error: ${unexpectedErr.message || unexpectedErr}`);
  } finally {
    if (appProcess?.pid) {
      try {
        process.kill(-appProcess.pid, "SIGTERM");
      } catch {
        try {
          appProcess.kill("SIGTERM");
        } catch {
          // Ignore
        }
      }
    }
  }
}

function failClosed(artifactsDir, reason) {
  console.error(`[verifier] FAIL CLOSED: ${reason}`);
  const failedObj = {
    verdict: "failed",
    reason,
    criteria: [],
    findings: [],
  };
  fs.writeFileSync(path.join(artifactsDir, "verification.json"), JSON.stringify(failedObj, null, 2) + "\n", "utf8");
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, "verdict=failed\n");
  }
  return failedObj;
}

function defaultPublishEvidence(pngPath, prNumber, runId, suffix) {
  const scriptPath = path.join(__dirname, "publish-evidence.sh");
  const res = spawnSync("bash", [scriptPath, pngPath, String(prNumber), String(runId), String(suffix || "")], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.status !== 0) return "";
  return (res.stdout || "").trim();
}

/**
 * @param {any} [options]
 */
export function prepareVerificationPublish(options = {}) {
  const {
    rootDir = process.cwd(),
    prNumber = process.env.PR_NUM || "",
    runId = process.env.GITHUB_RUN_ID || "",
    repository = process.env.GITHUB_REPOSITORY || "",
    serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com",
    prLabels = null,
    prLabelsFile = process.env.PR_LABELS_FILE || "",
    reviewPayloadOut = process.env.REVIEW_PAYLOAD_OUT || "/tmp/review-payload.json",
    reviewFallbackOut = process.env.REVIEW_FALLBACK_OUT || "/tmp/review-payload-no-inline.json",
    publishEvidenceFn = defaultPublishEvidence,
  } = options;
  const artifactsDir = path.join(rootDir, ".pi/artifacts");
  const qaDir = path.join(rootDir, ".pi/qa");
  const verificationJsonPath = path.join(artifactsDir, "verification.json");
  const traceSummaryPath = path.join(artifactsDir, "trace-summary.json");
  const diffPath = path.join(artifactsDir, "pr-diff.patch");

  let traceUrl = "";
  if (fs.existsSync(traceSummaryPath)) {
    try {
      traceUrl = JSON.parse(fs.readFileSync(traceSummaryPath, "utf8")).traceUrl || "";
    } catch {
      traceUrl = "";
    }
  }

  let labels = Array.isArray(prLabels) ? prLabels : [];
  if (!prLabels && prLabelsFile && fs.existsSync(prLabelsFile)) {
    try {
      const parsedLabels = JSON.parse(fs.readFileSync(prLabelsFile, "utf8"));
      labels = Array.isArray(parsedLabels) ? parsedLabels : parsedLabels?.labels || [];
    } catch {
      labels = [];
    }
  }

  let validated = null;
  let failureReason = "";
  if (!fs.existsSync(verificationJsonPath)) {
    failureReason = "Missing .pi/artifacts/verification.json artifact.";
  } else {
    try {
      const raw = JSON.parse(fs.readFileSync(verificationJsonPath, "utf8"));
      if (raw?.verdict === "failed") {
        failureReason = raw.reason || "Verifier failed closed.";
      } else {
        validated = validateVerificationResult(raw);
      }
    } catch (err) {
      failureReason = `Invalid verification.json: ${err.message}`;
    }
  }

  if (!validated) {
    const failedPayload = buildFailedVerificationReviewPayload(failureReason, { traceUrl });
    if (reviewPayloadOut) fs.writeFileSync(reviewPayloadOut, JSON.stringify(failedPayload, null, 2) + "\n", "utf8");
    if (reviewFallbackOut) fs.writeFileSync(reviewFallbackOut, JSON.stringify(failedPayload, null, 2) + "\n", "utf8");
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, "will_trigger_fix=false\n");
    }
    return { payload: failedPayload, fallbackPayload: failedPayload, willTriggerFix: false, evidenceUrls: {} };
  }

  const evidenceUrls = {};
  for (const criterion of validated.criteria) {
    if (!criterion.screenshot) continue;
    const baseName = path.basename(criterion.screenshot);
    if (!baseName.endsWith(".png")) continue;
    const candidatePath = path.join(qaDir, baseName);
    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).size > 0) {
      const storedPath = publishEvidenceFn(candidatePath, prNumber, runId, criterion.id);
      if (storedPath) {
        evidenceUrls[criterion.id] = `${serverUrl.replace(/\/+$/, "")}/${repository}/blob/agent-evidence/${storedPath}?raw=true`;
      }
    }
  }

  const diffText = fs.existsSync(diffPath) ? fs.readFileSync(diffPath, "utf8") : "";
  const willTriggerFix = shouldTriggerFixRound({ verdict: validated.verdict, labels });
  const payload = buildGitHubReviewPayload(validated, {
    evidenceUrls,
    traceUrl,
    diffText,
    willTriggerFix,
  });
  const fallbackPayload = {
    event: "COMMENT",
    body: payload.body,
    comments: [],
  };

  if (reviewPayloadOut) fs.writeFileSync(reviewPayloadOut, JSON.stringify(payload, null, 2) + "\n", "utf8");
  if (reviewFallbackOut) fs.writeFileSync(reviewFallbackOut, JSON.stringify(fallbackPayload, null, 2) + "\n", "utf8");
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `will_trigger_fix=${willTriggerFix}\n`);
  }

  return { payload, fallbackPayload, willTriggerFix, evidenceUrls };
}

export function appendFixPrTaskPromptToFile(promptFilePath, prNumber) {
  const existing = fs.existsSync(promptFilePath) ? fs.readFileSync(promptFilePath, "utf8") : "";
  const verification = extractLatestVerificationFromReviews(existing);
  const formatted = formatFixPrTaskPrompt({
    prNumber,
    prThreadText: existing,
    verification,
  });
  fs.writeFileSync(promptFilePath, formatted + "\n", "utf8");
  return formatted;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--prepare-publish")) {
    try {
      prepareVerificationPublish();
    } catch (err) {
      console.error("[verifier-publish] Fatal error:", err.message || err);
      process.exit(1);
    }
  } else if (process.argv.includes("--prepare-fix-prompt")) {
    try {
      const promptFile = process.env.PROMPT_FILE || ".pi/artifacts/task-prompt.txt";
      const prNum = process.env.INPUT_FIX_PR || "";
      appendFixPrTaskPromptToFile(promptFile, prNum);
    } catch (err) {
      console.error("[verifier-fix-prompt] Fatal error:", err.message || err);
      process.exit(1);
    }
  } else {
    runVerification().catch((err) => {
      console.error("[verifier] Fatal error:", err.message || err);
      process.exit(1);
    });
  }
}
