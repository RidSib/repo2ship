#!/usr/bin/env node
/**
 * Agent Harness Adapter (`harness.mjs`)
 *
 * One interface for running a pipeline stage on either coding-agent engine:
 *   - `pi`       (@earendil-works/pi-coding-agent, the default)
 *   - `opencode` (opencode-ai)
 *
 * Engine, provider and model are independent choices. The provider (any OpenAI-compatible
 * API, the Azure preset, or Amazon Bedrock) and models come from `model-config.mjs`; the
 * engine is picked per role with IMPLEMENTER_ENGINE / STRATEGIST_ENGINE (or AGENT_ENGINE).
 *
 * Every stage gets an explicit session ID, so a continuation (repair pass, schema retry)
 * always resumes that stage's own conversation and never another stage's.
 *
 * Both engines run without any configuration from the repository under test:
 *   - pi:       --no-approve --no-mcp, models from PI_CODING_AGENT_DIR
 *   - opencode: OPENCODE_DISABLE_PROJECT_CONFIG, --pure, isolated HOME/XDG state, and a
 *               trusted inline config (OPENCODE_CONFIG_CONTENT) holding providers and permissions
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MODEL_PROVIDERS,
  apiKeyEnvFor,
  baseUrlFor,
  completionsSettingsFor,
  modelCompatJson,
  priceFor,
  resolveModelProvider,
  setupModels,
} from "./model-config.mjs";

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
// Pinned: opencode releases often, and its CLI flags and event format are part of this contract
export const OPENCODE_PACKAGE = "opencode-ai@1.19.4";
export const ENGINES = ["pi", "opencode"];

const PI_READ_ONLY_TOOLS = "read,grep,find,ls";

// Every key is explicit: an "ask" in non-interactive mode would stall the run
const OPENCODE_PERMISSIONS = {
  "read-only": {
    "*": "deny",
    read: "allow",
    grep: "allow",
    glob: "allow",
    list: "allow",
    doom_loop: "allow",
  },
  full: {
    "*": "deny",
    read: "allow",
    grep: "allow",
    glob: "allow",
    list: "allow",
    edit: "allow",
    bash: "allow",
    todowrite: "allow",
    external_directory: "allow",
    doom_loop: "allow",
  },
};

// pi thinking levels -> OpenAI reasoning effort, used as opencode model variants
const REASONING_VARIANTS = {
  off: { reasoningEffort: "none" },
  minimal: { reasoningEffort: "minimal" },
  low: { reasoningEffort: "low" },
  medium: { reasoningEffort: "medium" },
  high: { reasoningEffort: "high" },
  xhigh: { reasoningEffort: "xhigh" },
  max: { reasoningEffort: "xhigh" },
};

export function resolveEngine(role, env = process.env) {
  const raw = (role === "implementer" ? env.IMPLEMENTER_ENGINE : env.STRATEGIST_ENGINE) || env.AGENT_ENGINE || "pi";
  const engine = raw.trim().toLowerCase();
  if (!ENGINES.includes(engine)) {
    throw new Error(`Unsupported engine "${raw}" for the ${role} role (use "pi" or "opencode")`);
  }
  return engine;
}

export function apiForProvider(provider) {
  if (provider === "amazon-bedrock") return "bedrock";
  return provider.endsWith("-completions") ? "openai-completions" : "openai-responses";
}

/**
 * Writes pi's models.json and resolves engine + provider + model for both roles.
 * @param {{ agentDir?: string, env?: Record<string, string | undefined> }} [options]
 */
export function setupEngines({ agentDir, env = process.env } = {}) {
  const result = setupModels({ agentDir, env });
  const roles = {
    implementer: { ...result.roles.implementer, engine: resolveEngine("implementer", env) },
    strategist: { ...result.roles.strategist, engine: resolveEngine("strategist", env) },
  };
  return { ...result, roles };
}

/**
 * Trusted opencode config: providers for the roles that run on opencode, plus per-stage permissions.
 * @param {{ roles: any, access?: "read-only" | "full", instructionsPath?: string, env?: Record<string, string | undefined> }} options
 * @returns {any}
 */
export function buildOpenCodeConfig({ roles, access = "full", instructionsPath, env = process.env }) {
  const modelProvider = resolveModelProvider(env);
  const { label, native } = MODEL_PROVIDERS[modelProvider];
  const baseURL = baseUrlFor(modelProvider, env);
  const apiKeyEnv = apiKeyEnvFor(modelProvider, env);

  const provider = {};
  for (const role of [roles.implementer, roles.strategist]) {
    if (role.engine !== "opencode") continue;
    const api = apiForProvider(role.provider);
    const completions = api === "openai-completions";
    const entry = (provider[role.provider] ||= native
      ? // opencode's built-in Bedrock provider reads AWS credentials from the environment
        { options: { region: env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1" }, models: {} }
      : {
          // OpenAI-compatible endpoints (Azure's /openai/v1 included) take the key as a bearer token
          npm: completions ? "@ai-sdk/openai-compatible" : "@ai-sdk/openai",
          name: `${label} ${completions ? "Chat Completions" : "Responses"}`,
          options: { baseURL, apiKey: `{env:${apiKeyEnv}}` },
          models: {},
        });
    const price = priceFor(role.model, env);
    const settings = completions ? completionsSettingsFor(role.model, modelCompatJson(env)) : {};
    entry.models[role.model] = {
      name: role.model,
      cost: { input: price.input, output: price.output, cache_read: price.cacheRead, cache_write: price.cacheWrite },
      limit: { context: settings.contextWindow || 256000, output: settings.maxTokens || 32768 },
      // Reasoning effort is only sent where pi sends it too (Responses models)
      ...(api === "openai-responses" ? { variants: REASONING_VARIANTS } : {}),
    };
  }

  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    // Project instruction discovery is off with the project config, so AGENTS.md is passed explicitly
    instructions: instructionsPath ? [instructionsPath] : [],
    provider,
    permission: OPENCODE_PERMISSIONS[access],
  };
}

/**
 * Isolated runtime state so neither the repo nor the machine's own opencode setup can leak in.
 * @returns {Record<string, string | undefined>}
 */
export function openCodeEnv({ config, agentDir, env = process.env }) {
  const home = path.join(agentDir, "opencode-home");
  const realHome = env.HOME || os.homedir();
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("OPENCODE_")));
  return {
    ...clean,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_STATE_HOME: path.join(home, "state"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    // Keep the real npm cache, Playwright browsers and AWS profile files reachable from the isolated HOME
    npm_config_cache: env.npm_config_cache || path.join(realHome, ".npm"),
    PLAYWRIGHT_BROWSERS_PATH: env.PLAYWRIGHT_BROWSERS_PATH || defaultPlaywrightBrowsersPath(realHome),
    AWS_CONFIG_FILE: env.AWS_CONFIG_FILE || path.join(realHome, ".aws/config"),
    AWS_SHARED_CREDENTIALS_FILE: env.AWS_SHARED_CREDENTIALS_FILE || path.join(realHome, ".aws/credentials"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  };
}

function defaultPlaywrightBrowsersPath(realHome) {
  return process.platform === "darwin"
    ? path.join(realHome, "Library/Caches/ms-playwright")
    : path.join(realHome, ".cache/ms-playwright");
}

/**
 * Converts opencode `run --format json` events into pi-style session entries, so the Langfuse
 * exporter reads both engines the same way. Each model step becomes one assistant message.
 */
export function normalizeOpenCodeEvents(events, { role, prompt }) {
  const entries = [];
  let sessionId = null;
  let step = null;
  const timestamp = (ms) => new Date(ms || Date.now()).toISOString();

  entries.push({
    type: "message",
    id: crypto.randomUUID(),
    timestamp: timestamp(events[0]?.timestamp),
    message: { role: "user", content: [{ type: "text", text: prompt }] },
  });

  for (const event of events) {
    sessionId ||= event.sessionID || null;
    const part = event.part || {};
    if (event.type === "step_start") {
      step = { text: [], calls: [], results: [], start: event.timestamp };
    } else if (event.type === "text" && step) {
      step.text.push(part.text || "");
    } else if (event.type === "tool_use" && step) {
      const state = part.state || {};
      step.calls.push({ type: "toolCall", id: part.callID || part.id, name: part.tool, arguments: state.input || {} });
      step.results.push({
        type: "message",
        id: crypto.randomUUID(),
        timestamp: timestamp(state.time?.end || event.timestamp),
        message: {
          role: "toolResult",
          toolCallId: part.callID || part.id,
          toolName: part.tool,
          content: [{ type: "text", text: String(state.output ?? state.error ?? "") }],
          isError: state.status === "error",
        },
      });
    } else if (event.type === "step_finish" && step) {
      const tokens = part.tokens;
      entries.push({
        type: "message",
        id: part.messageID ? `${part.messageID}-${entries.length}` : crypto.randomUUID(),
        timestamp: timestamp(step.start),
        message: {
          role: "assistant",
          model: role.model,
          provider: role.provider,
          api: apiForProvider(role.provider),
          stopReason: part.reason || "stop",
          content: [...step.text.filter(Boolean).map((text) => ({ type: "text", text })), ...step.calls],
          // Keep usage unknown rather than reporting zeros when opencode sends none
          usage: tokens
            ? {
                input: tokens.input || 0,
                // pi counts reasoning as output; do the same so both engines compare directly
                output: (tokens.output || 0) + (tokens.reasoning || 0),
                reasoning: tokens.reasoning || 0,
                cacheRead: tokens.cache?.read || 0,
                cacheWrite: tokens.cache?.write || 0,
                totalTokens: tokens.total || 0,
                cost: { total: Number(part.cost || 0) },
              }
            : undefined,
        },
      });
      entries.push(...step.results);
      step = null;
    }
  }

  return { sessionId, entries };
}

/** Final answer = text of the last model step that produced any, like pi's --print output. */
export function finalTextFromEvents(events) {
  const steps = [];
  let current = null;
  for (const event of events) {
    if (event.type === "step_start") current = [];
    else if (event.type === "text" && current) current.push(event.part?.text || "");
    else if (event.type === "step_finish" && current) {
      steps.push(current.join(""));
      current = null;
    }
  }
  const withText = steps.filter((text) => text.trim());
  return withText.length > 0 ? withText[withText.length - 1] : "";
}

export function parseJsonLines(stdout) {
  const events = [];
  for (const line of (stdout || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Ignore partial or non-event lines
    }
  }
  return events;
}

function runPi({ role, prompt, cwd, agentDir, sessionDir, sessionId, access, thinking, timeoutMs, env, command }) {
  const id = sessionId || crypto.randomUUID();
  const args = [
    "--yes",
    PI_PACKAGE,
    // Print mode: never load project-local extensions, settings or MCP servers from the repo
    "--no-approve",
    "--no-mcp",
    "--provider",
    env.PI_PROVIDER || role.provider,
    "--model",
    role.model,
    "--session-dir",
    sessionDir,
    "--session-id",
    id,
    ...(thinking ? ["--thinking", thinking] : []),
    ...(access === "read-only" ? ["--tools", PI_READ_ONLY_TOOLS] : []),
    "--print",
    prompt,
  ];
  const res = spawnSync(command, args, {
    cwd,
    env: { ...env, PI_CODING_AGENT_DIR: agentDir },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });
  const ok = !res.error && res.status === 0;
  return {
    ok,
    engine: "pi",
    sessionId: id,
    text: res.stdout || "",
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    status: res.status,
    error: ok ? null : res.error ? res.error.message : `pi exited with status ${res.status}`,
  };
}

function runOpenCode({ role, roles, prompt, cwd, agentDir, sessionDir, sessionId, access, thinking, timeoutMs, env, command }) {
  const instructionsPath = fs.existsSync(path.join(cwd, "AGENTS.md")) ? path.join(cwd, "AGENTS.md") : undefined;
  const config = buildOpenCodeConfig({ roles, access, instructionsPath, env });
  const variant = thinking && apiForProvider(role.provider) === "openai-responses" ? thinking : null;
  const args = [
    "--yes",
    OPENCODE_PACKAGE,
    "run",
    "--pure",
    "--format",
    "json",
    "-m",
    `${role.provider}/${role.model}`,
    ...(variant ? ["--variant", variant] : []),
    ...(sessionId ? ["--session", sessionId] : []),
    prompt,
  ];
  const res = spawnSync(command, args, {
    cwd,
    env: openCodeEnv({ config, agentDir, env }),
    encoding: "utf8",
    // stdin must be closed: opencode run otherwise waits for piped input
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });

  const events = parseJsonLines(res.stdout);
  const { sessionId: reportedId, entries } = normalizeOpenCodeEvents(events, { role, prompt });
  const id = sessionId || reportedId;
  const errorEvent = events.find((event) => event.type === "error");
  const finished = events.some((event) => event.type === "step_finish");

  if (id) {
    const sessionFile = path.join(sessionDir, `opencode-${id}.jsonl`);
    const lines = [];
    if (!fs.existsSync(sessionFile)) {
      lines.push({ type: "session", id, timestamp: new Date().toISOString(), cwd, engine: "opencode" });
    }
    lines.push(...entries);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.appendFileSync(sessionFile, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  }

  const ok = !res.error && res.status === 0 && !errorEvent && finished;
  return {
    ok,
    engine: "opencode",
    sessionId: id,
    text: finalTextFromEvents(events),
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    status: res.status,
    error: ok
      ? null
      : res.error
        ? res.error.message
        : errorEvent
          ? `opencode error: ${JSON.stringify(errorEvent.error || errorEvent.part || errorEvent).slice(0, 500)}`
          : res.status !== 0
            ? `opencode exited with status ${res.status}`
            : "opencode produced no completed model step",
  };
}

/**
 * Runs one pipeline stage. `role` is roles.implementer or roles.strategist from setupEngines().
 * Pass the returned sessionId back in to continue the same conversation.
 *
 * access: "read-only" (read/search tools only) or "full" (edit + shell).
 *
 * @param {{
 *   role: any, roles: any, stage: string, prompt: string, cwd?: string, agentDir: string,
 *   sessionDir: string, sessionId?: string, access?: "read-only" | "full", thinking?: string,
 *   timeoutMs?: number, env?: Record<string, string | undefined>, command?: string
 * }} options
 */
export function runAgent({
  role,
  roles,
  stage,
  prompt,
  cwd = process.cwd(),
  agentDir,
  sessionDir,
  sessionId,
  access = "full",
  thinking,
  timeoutMs = 600_000,
  env = process.env,
  command = env.PI_HARNESS_NPX || "npx",
}) {
  if (!role.model) {
    return {
      ok: false,
      engine: role.engine,
      sessionId,
      text: "",
      stdout: "",
      stderr: "",
      status: null,
      error: `No model configured for the ${stage} stage: set IMPLEMENTER_MODEL and STRATEGIST_MODEL`,
    };
  }
  fs.mkdirSync(sessionDir, { recursive: true });
  console.log(
    `[harness] ${stage}: ${role.engine} ${role.provider}/${role.model} (access=${access}, session=${sessionId || "new"})`
  );
  const run = role.engine === "opencode" ? runOpenCode : runPi;
  const result = run({ role, roles, prompt, cwd, agentDir, sessionDir, sessionId, access, thinking, timeoutMs, env, command });
  if (result.text) process.stdout.write(result.text.endsWith("\n") ? result.text : `${result.text}\n`);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

/** runAgent, but a failed model call stops the stage instead of feeding a broken result onwards. */
export function runAgentOrThrow(options) {
  const result = runAgent(options);
  if (!result.ok) throw new Error(result.error);
  return result;
}
