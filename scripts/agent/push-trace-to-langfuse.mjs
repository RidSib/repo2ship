#!/usr/bin/env node
/**
 * Layer 6: Langfuse Trace & Cost Ingestion (`push-trace-to-langfuse.mjs`)
 *
 * Parses Pi's `.jsonl` session trajectory files (under `.pi/sessions/`),
 * reconstructs the full execution tree (user messages, LLM generations with
 * thinking + token usage + cost, tool calls, and bash executions), and sends
 * them to Langfuse's `/api/public/ingestion` endpoint.
 *
 * Also writes `.pi/artifacts/trace-summary.json` so the GitHub PR body
 * includes exact token counts, USD cost, and a direct link to the Langfuse trace.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveRoles } from "./model-config.mjs";

function findJsonlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsonlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      results.push(fullPath);
    }
  }
  return results.sort((a, b) => {
    const diff = fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs;
    return diff !== 0 ? diff : a.localeCompare(b);
  });
}

export function parsePiSessionFile(jsonlPath) {
  const lines = fs
    .readFileSync(jsonlPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let sessionHeader = null;
  const entries = [];
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    assistantTurns: 0,
    toolCalls: 0,
    modelsUsed: new Set(),
  };

  for (const line of lines) {
    const parsed = JSON.parse(line);
    if (parsed.type === "session") {
      sessionHeader = parsed;
      continue;
    }
    entries.push(parsed);

    if (parsed.type === "message" && parsed.message) {
      const msg = parsed.message;
      if (msg.role === "assistant") {
        totals.assistantTurns += 1;
        if (msg.model) totals.modelsUsed.add(msg.model);
        if (msg.usage) {
          totals.inputTokens += Number(msg.usage.input || 0);
          totals.outputTokens += Number(msg.usage.output || 0);
          totals.cacheReadTokens += Number(msg.usage.cacheRead || 0);
          totals.cacheWriteTokens += Number(msg.usage.cacheWrite || 0);
          totals.totalTokens += Number(msg.usage.totalTokens || 0);
          totals.totalCostUsd += Number(msg.usage.cost?.total || 0);
        }
        if (Array.isArray(msg.content)) {
          totals.toolCalls += msg.content.filter((b) => b.type === "toolCall").length;
        }
      }
    }
  }

  return {
    sessionId: sessionHeader?.id || crypto.randomUUID(),
    timestamp: sessionHeader?.timestamp || new Date().toISOString(),
    cwd: sessionHeader?.cwd || process.cwd(),
    // opencode sessions are written in this format by harness.mjs and say so in their header
    engine: sessionHeader?.engine || "pi",
    entries,
    totals: {
      ...totals,
      modelsUsed: Array.from(totals.modelsUsed),
    },
  };
}

// Keep traces readable and small: screenshots are replaced by a placeholder, and encrypted
// reasoning signatures (no readable content) are dropped.
export function sanitizeContent(content) {
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (block?.type === "image") {
      return { type: "image", mimeType: block.mimeType, omitted: `${block.data?.length || 0} base64 chars` };
    }
    if (block?.type === "thinking") {
      return { type: "thinking", thinking: block.thinking || "(encrypted by provider)" };
    }
    return block;
  });
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function resolveSessionRole(session, index, roles, tags = []) {
  if (session.role) return session.role;
  if (Array.isArray(tags) && (tags.includes("refinement") || tags.includes("verifier"))) {
    return "strategist";
  }
  const modelsUsed = session.totals?.modelsUsed || [];
  if (roles?.strategist?.model && roles.strategist.model !== roles?.implementer?.model) {
    if (modelsUsed.includes(roles.strategist.model)) {
      return "strategist";
    }
    return "implementer";
  }
  return index === 0 ? "implementer" : "strategist";
}

export function mergeSessionTotals(sessions) {
  const merged = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    assistantTurns: 0,
    toolCalls: 0,
    modelsUsed: [],
  };
  const modelSet = new Set();
  for (const s of sessions) {
    const t = s.totals || {};
    merged.inputTokens += Number(t.inputTokens || 0);
    merged.outputTokens += Number(t.outputTokens || 0);
    merged.cacheReadTokens += Number(t.cacheReadTokens || 0);
    merged.cacheWriteTokens += Number(t.cacheWriteTokens || 0);
    merged.totalTokens += Number(t.totalTokens || 0);
    merged.totalCostUsd += Number(t.totalCostUsd || 0);
    merged.assistantTurns += Number(t.assistantTurns || 0);
    merged.toolCalls += Number(t.toolCalls || 0);
    for (const m of t.modelsUsed || []) {
      modelSet.add(m);
    }
  }
  merged.modelsUsed = Array.from(modelSet);
  return merged;
}

export function buildVerificationScoreEvents(traceId, verification) {
  if (!verification || typeof verification !== "object") return [];
  const verdict = verification.verdict;
  if (verdict !== "pass" && verdict !== "changes_needed" && verdict !== "failed") return [];

  const criteria = Array.isArray(verification.criteria) ? verification.criteria : [];
  const total = criteria.length;
  const passed = criteria.filter((c) => c?.status === "pass").length;
  const passRate = total > 0 ? Number((passed / total).toFixed(4)) : 0;
  const now = new Date().toISOString();

  return [
    {
      id: `${traceId}-ac_pass_rate-event`,
      timestamp: now,
      type: "score-create",
      body: {
        id: `${traceId}-ac_pass_rate`,
        traceId,
        name: "ac_pass_rate",
        value: passRate,
        dataType: "NUMERIC",
        comment: `${passed}/${total} acceptance criteria passed`,
      },
    },
    {
      id: `${traceId}-verifier_verdict-event`,
      timestamp: now,
      type: "score-create",
      body: {
        id: `${traceId}-verifier_verdict`,
        traceId,
        name: "verifier_verdict",
        value: verdict,
        dataType: "CATEGORICAL",
        comment: `Verifier verdict: ${verdict}`,
      },
    },
  ];
}

export function buildLangfuseBatch(sessionsInput, /** @type {any} */ metadata = {}) {
  const rawSessions = Array.isArray(sessionsInput) ? sessionsInput : [sessionsInput];
  const sessions = [...rawSessions].sort((a, b) => Date.parse(a.timestamp || 0) - Date.parse(b.timestamp || 0));
  const oldestSession = sessions[0];
  const traceId = oldestSession.sessionId;
  /** @type {any[]} */
  const batch = [];
  const {
    taskPrompt,
    issueOrPrId,
    traceName,
    actor,
    tags = [],
    verification,
    env = process.env,
    roles: explicitRoles,
    ...extraMetadata
  } = metadata;
  const roles = explicitRoles || resolveRoles(env);
  const repository = env.GITHUB_REPOSITORY || process.env.GITHUB_REPOSITORY || "local";

  let finalAnswer = "";

  for (let idx = 0; idx < sessions.length; idx++) {
    const session = sessions[idx];
    const sessionRole = resolveSessionRole(session, idx, roles, tags);
    // Turn inputs: user/tool messages since the previous assistant turn become the next
    // generation's input. Tool calls are remembered so their results can show the arguments.
    let pendingInputs = [];
    const toolCalls = new Map();

    for (const entry of session.entries) {
      if (entry.type !== "message" || !entry.message) continue;
      const msg = entry.message;

      if (msg.role === "user") {
        pendingInputs.push({ role: "user", content: sanitizeContent(msg.content) });
      } else if (msg.role === "assistant") {
        const generationId = entry.id || crypto.randomUUID();
        for (const block of Array.isArray(msg.content) ? msg.content : []) {
          if (block?.type === "toolCall") {
            toolCalls.set(block.id, { generationId, name: block.name, arguments: block.arguments });
          }
        }
        const answer = textOf(msg.content);
        if (answer && (sessionRole === "implementer" || !finalAnswer)) {
          finalAnswer = answer;
        }

        const usage = msg.usage || {};
        const cost = usage.cost || {};
        // Unknown usage stays unknown instead of being reported as zero tokens
        const hasUsage = Boolean(msg.usage);
        batch.push({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          type: "generation-create",
          body: {
            id: generationId,
            traceId,
            name: `llm-turn-${msg.model || "model"}`,
            startTime: entry.timestamp || new Date(msg.timestamp || Date.now()).toISOString(),
            model: msg.model || roles.implementer.model || "unknown",
            input: pendingInputs.length > 0 ? pendingInputs : undefined,
            output: sanitizeContent(msg.content),
            usageDetails: hasUsage
              ? {
                  input: usage.input || 0,
                  output: usage.output || 0,
                  cache_read: usage.cacheRead || 0,
                  cache_write: usage.cacheWrite || 0,
                }
              : undefined,
            costDetails: hasUsage
              ? {
                  input: cost.input || 0,
                  output: cost.output || 0,
                  cache_read: cost.cacheRead || 0,
                  cache_write: cost.cacheWrite || 0,
                  total: cost.total || 0,
                }
              : undefined,
            level: msg.stopReason === "error" ? "ERROR" : "DEFAULT",
            statusMessage: msg.errorMessage || undefined,
            metadata: {
              provider: msg.provider,
              api: msg.api,
              stopReason: msg.stopReason,
              role: sessionRole,
              engine: session.engine || "pi",
              piSessionId: session.sessionId,
            },
          },
        });
        pendingInputs = [];
      } else if (msg.role === "toolResult" || msg.role === "bashExecution") {
        const call = toolCalls.get(msg.toolCallId);
        const output = msg.role === "bashExecution" ? msg.output : sanitizeContent(msg.content);
        pendingInputs.push({ role: "tool", toolName: msg.toolName || call?.name, content: output });

        batch.push({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          type: "span-create",
          body: {
            id: entry.id || crypto.randomUUID(),
            traceId,
            // Nest each tool run under the model turn that requested it
            parentObservationId: call?.generationId,
            name: msg.role === "bashExecution" ? "bash-execution" : `tool-${msg.toolName || call?.name || "call"}`,
            startTime: entry.timestamp || new Date(msg.timestamp || Date.now()).toISOString(),
            input: msg.role === "bashExecution" ? { command: msg.command } : { tool: call?.name, arguments: call?.arguments },
            output,
            level: msg.isError || (msg.exitCode && msg.exitCode !== 0) ? "ERROR" : "DEFAULT",
            metadata: {
              role: sessionRole,
              piSessionId: session.sessionId,
            },
          },
        });
      }
    }
  }

  const mergedTotals = mergeSessionTotals(sessions);
  const enginesUsed = [...new Set(sessions.map((session) => session.engine || "pi"))];

  // Trace-create goes first in the batch so observations attach to an existing trace
  batch.unshift({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type: "trace-create",
    body: {
      id: traceId,
      timestamp: oldestSession.timestamp,
      name: traceName || (issueOrPrId ? `pi-agent #${issueOrPrId}` : "pi-coding-agent-run"),
      // Langfuse sessions group every run for the same issue/PR
      sessionId: issueOrPrId ? `${repository}#${issueOrPrId}` : traceId,
      userId: actor || env.GITHUB_ACTOR || process.env.GITHUB_ACTOR || "autonomous-agent",
      input: taskPrompt || "(task prompt unavailable)",
      output: {
        finalAnswer,
        assistantTurns: mergedTotals.assistantTurns,
        toolCalls: mergedTotals.toolCalls,
        totalTokens: mergedTotals.totalTokens,
        totalCostUsd: Number(mergedTotals.totalCostUsd.toFixed(6)),
      },
      metadata: {
        repository,
        runId: env.GITHUB_RUN_ID || process.env.GITHUB_RUN_ID || "local",
        modelsUsed: mergedTotals.modelsUsed,
        enginesUsed,
        ...extraMetadata,
      },
      tags: ["pi-coding-agent", ...enginesUsed.map((engine) => `engine:${engine}`), ...mergedTotals.modelsUsed, ...tags],
    },
  });

  if (verification) {
    batch.push(...buildVerificationScoreEvents(traceId, verification));
  }

  return { traceId, batch, totals: mergedTotals };
}

/**
 * Langfuse answers 207 Multi-Status when some events in a batch were rejected,
 * so a 2xx status alone does not mean everything was stored.
 */
export function summarizeIngestionResponse(status, body) {
  if (status < 200 || status >= 300) {
    return { ok: false, successes: 0, errors: [{ status, message: typeof body === "string" ? body : JSON.stringify(body) }] };
  }
  const successes = Array.isArray(body?.successes) ? body.successes.length : 0;
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  return { ok: errors.length === 0, successes, errors };
}

export async function pushTraceToLangfuse({
  sessionDir = path.resolve(process.cwd(), ".pi/sessions"),
  artifactsDir = path.resolve(process.cwd(), ".pi/artifacts"),
  dryRun = process.argv.includes("--dry-run"),
  env = process.env,
} = {}) {
  fs.mkdirSync(artifactsDir, { recursive: true });
  const files = findJsonlFiles(sessionDir);
  const roles = resolveRoles(env);

  let sessions;
  if (files.length > 0) {
    sessions = files.map((f) => parsePiSessionFile(f));
  } else {
    sessions = [
      {
        sessionId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
        entries: [],
        totals: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 0,
          totalCostUsd: 0,
          assistantTurns: 0,
          toolCalls: 0,
          modelsUsed: [roles.implementer.model],
        },
      },
    ];
  }

  const baseUrl = (env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com").replace(/\/+$/, "");
  const publicKey = env.LANGFUSE_PUBLIC_KEY;
  const secretKey = env.LANGFUSE_SECRET_KEY;

  const taskPromptPath = path.join(artifactsDir, "task-prompt.txt");
  const verificationPath = path.join(artifactsDir, "verification.json");
  let verification = null;
  if (fs.existsSync(verificationPath)) {
    try {
      verification = JSON.parse(fs.readFileSync(verificationPath, "utf8"));
    } catch {
      verification = null;
    }
  }
  const extraTags = env.LANGFUSE_TAG
    ? env.LANGFUSE_TAG.split(",").map((t) => t.trim()).filter(Boolean)
    : [];
  const { traceId, batch, totals } = buildLangfuseBatch(sessions, {
    taskPrompt: fs.existsSync(taskPromptPath) ? fs.readFileSync(taskPromptPath, "utf8").trim() : undefined,
    issueOrPrId: env.ISSUE_NUM || undefined,
    traceName: env.LANGFUSE_TRACE_NAME || undefined,
    tags: extraTags,
    verification,
    event: env.GITHUB_EVENT_NAME,
    branch: env.BRANCH_NAME,
    runUrl: env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : undefined,
    env,
    roles,
  });
  const traceUrl = `${baseUrl}/trace/${traceId}`;

  let uploaded = false;
  if (!dryRun && publicKey && secretKey) {
    const authHeader = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
    const response = await fetch(`${baseUrl}/api/public/ingestion`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${authHeader}`,
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
    uploaded = result.ok;
    if (result.ok) {
      console.log(`[langfuse] Uploaded ${result.successes} of ${batch.length} events for trace ${traceId}`);
    } else {
      console.warn(
        `::warning::Langfuse rejected ${result.errors.length} of ${batch.length} events (HTTP ${response.status})`
      );
      for (const error of result.errors.slice(0, 10)) {
        console.warn(`[langfuse]   ${error.id || "-"}: ${error.status} ${error.message || ""} ${error.error ? JSON.stringify(error.error) : ""}`);
      }
    }
  } else {
    console.log(
      `[langfuse] ${dryRun ? "Dry-run" : "No LANGFUSE_PUBLIC_KEY/SECRET_KEY set"}: prepared ${batch.length} trace events locally.`
    );
  }

  const summary = {
    traceId,
    traceUrl,
    uploaded,
    eventCount: batch.length,
    ...totals,
  };

  const summaryPath = path.join(artifactsDir, "trace-summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  pushTraceToLangfuse()
    .then((summary) => {
      console.log(`[langfuse] Trace summary saved:`, JSON.stringify(summary));
    })
    .catch((err) => {
      console.error(`[langfuse] Error:`, err);
      process.exit(1);
    });
}
