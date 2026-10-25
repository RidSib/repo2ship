#!/usr/bin/env node
/**
 * Outcome Scores for Langfuse (`score-pr-outcome.mjs`)
 *
 * Runs when an agent PR is closed. Finds every Langfuse trace linked from the PR
 * (one per agent run, including follow-ups) and attaches the PR's outcome to each:
 *   - pr_merged                   BOOLEAN  merged (1) or closed without merging (0)
 *   - human_edited                BOOLEAN  a non-agent author committed to the PR branch
 *   - merged_without_human_edits  BOOLEAN  the headline quality metric
 *   - agent_runs_on_pr            NUMERIC  how many agent runs the PR needed
 *
 * Input: JSON from `gh pr view <n> --json number,url,state,mergedAt,body,comments,commits`.
 * Score ids are deterministic, so re-running the job updates instead of duplicating.
 */

import fs from "node:fs";
import { summarizeIngestionResponse } from "./push-trace-to-langfuse.mjs";

const AGENT_COMMIT_EMAIL = "pi-coding-agent[bot]@users.noreply.github.com";

export function extractTraceIds(texts) {
  const ids = new Set();
  for (const text of texts) {
    for (const match of String(text || "").matchAll(/\/trace\/([0-9a-zA-Z-]{8,})/g)) {
      ids.add(match[1]);
    }
  }
  return Array.from(ids);
}

export function computeOutcome(pr) {
  const traceIds = extractTraceIds([pr.body, ...(pr.comments || []).map((comment) => comment.body)]);
  const humanEdited = (pr.commits || []).some((commit) =>
    (commit.authors || []).some((author) => author.email && author.email !== AGENT_COMMIT_EMAIL)
  );
  const merged = pr.state === "MERGED" || Boolean(pr.mergedAt);
  return {
    traceIds,
    merged,
    humanEdited,
    mergedWithoutHumanEdits: merged && !humanEdited,
    agentRuns: traceIds.length,
  };
}

export function buildScoreEvents(outcome, prUrl) {
  const comment = `Outcome of ${prUrl}`;
  const scores = [
    { name: "pr_merged", value: outcome.merged ? 1 : 0, dataType: "BOOLEAN" },
    { name: "human_edited", value: outcome.humanEdited ? 1 : 0, dataType: "BOOLEAN" },
    { name: "merged_without_human_edits", value: outcome.mergedWithoutHumanEdits ? 1 : 0, dataType: "BOOLEAN" },
    { name: "agent_runs_on_pr", value: outcome.agentRuns, dataType: "NUMERIC" },
  ];
  const now = new Date().toISOString();
  return outcome.traceIds.flatMap((traceId) =>
    scores.map((score) => ({
      id: `${traceId}-${score.name}-event`,
      timestamp: now,
      type: "score-create",
      body: { id: `${traceId}-${score.name}`, traceId, ...score, comment },
    }))
  );
}

async function main() {
  const prJsonPath = process.argv[2];
  if (!prJsonPath) throw new Error("Usage: score-pr-outcome.mjs <pr.json>");
  const pr = JSON.parse(fs.readFileSync(prJsonPath, "utf8"));
  const outcome = computeOutcome(pr);
  console.log(`[outcome] PR #${pr.number}: ${JSON.stringify({ ...outcome, traceIds: outcome.traceIds.length })}`);

  if (outcome.traceIds.length === 0) {
    console.log("[outcome] No Langfuse trace linked from this PR; nothing to score.");
    return;
  }
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) {
    console.log("[outcome] No Langfuse keys set; skipping upload.");
    return;
  }

  const baseUrl = (process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com").replace(/\/+$/, "");
  const batch = buildScoreEvents(outcome, pr.url);
  const response = await fetch(`${baseUrl}/api/public/ingestion`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`,
    },
    body: JSON.stringify({ batch }),
  });
  const rawBody = await response.text();
  let parsedBody = rawBody;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    // Keep the raw text for the error message
  }
  const result = summarizeIngestionResponse(response.status, parsedBody);
  if (!result.ok) {
    for (const error of result.errors.slice(0, 10)) {
      console.error(`[outcome]   ${error.id || "-"}: ${error.status} ${error.message || ""}`);
    }
    throw new Error(`Langfuse rejected ${result.errors.length} of ${batch.length} score events (HTTP ${response.status})`);
  }
  console.log(`[outcome] Stored ${result.successes} scores on ${outcome.traceIds.length} trace(s).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[outcome] Error:", err.message || err);
    process.exit(1);
  });
}
