import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  apiForProvider,
  buildOpenCodeConfig,
  openCodeEnv,
  setupEngines,
  finalTextFromEvents,
  normalizeOpenCodeEvents,
  resolveEngine,
  runAgent,
} from "../../scripts/agent/harness.mjs";
import { parsePiSessionFile } from "../../scripts/agent/push-trace-to-langfuse.mjs";
import { evaluatePatchPolicy } from "../../scripts/agent/validate-patch-policy.mjs";

const implementer = { engine: "opencode", provider: "endpoint-completions", model: "DeepSeek-V4.1-Flash" };
const strategist = { engine: "opencode", provider: "endpoint-responses", model: "gpt-6.1-sol" };
const roles = { implementer, strategist };

// Two opencode model steps: a tool call, then the final answer
const OPENCODE_EVENTS = [
  { type: "step_start", timestamp: 1, sessionID: "ses_abc", part: { type: "step-start" } },
  { type: "text", timestamp: 2, sessionID: "ses_abc", part: { type: "text", text: "Reading the file." } },
  {
    type: "tool_use",
    timestamp: 3,
    sessionID: "ses_abc",
    part: { type: "tool", tool: "read", callID: "call_1", state: { status: "completed", input: { filePath: "a.ts" }, output: "export {}" } },
  },
  {
    type: "step_finish",
    timestamp: 4,
    sessionID: "ses_abc",
    part: { type: "step-finish", messageID: "msg_1", reason: "tool-calls", cost: 0.004, tokens: { total: 1800, input: 3, output: 70, reasoning: 5, cache: { write: 1722, read: 0 } } },
  },
  { type: "step_start", timestamp: 5, sessionID: "ses_abc", part: { type: "step-start" } },
  { type: "text", timestamp: 6, sessionID: "ses_abc", part: { type: "text", text: '{"approved": true}' } },
  {
    type: "step_finish",
    timestamp: 7,
    sessionID: "ses_abc",
    part: { type: "step-finish", messageID: "msg_2", reason: "stop", cost: 0.001, tokens: { total: 1900, input: 3, output: 9, reasoning: 0, cache: { write: 166, read: 1722 } } },
  },
];

/** A stand-in for `npx`: records how it was called and prints a canned engine response. */
function fakeEngine(dir: string, mode: string) {
  const log = path.join(dir, "calls.jsonl");
  const script = path.join(dir, "fake-npx.mjs");
  const events = OPENCODE_EVENTS.map((event) => JSON.stringify(event)).join("\n");
  fs.writeFileSync(
    script,
    `#!/usr/bin/env node
import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env: {
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  HOME: process.env.HOME,
  AWS_PROFILE: process.env.AWS_PROFILE,
  AWS_REGION: process.env.AWS_REGION,
  AWS_CONFIG_FILE: process.env.AWS_CONFIG_FILE,
  AWS_SHARED_CREDENTIALS_FILE: process.env.AWS_SHARED_CREDENTIALS_FILE,
  OPENCODE_CONFIG: process.env.OPENCODE_CONFIG,
  OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT,
  OPENCODE_DISABLE_PROJECT_CONFIG: process.env.OPENCODE_DISABLE_PROJECT_CONFIG,
} }) + "\\n");
const mode = ${JSON.stringify(mode)};
if (mode === "pi") process.stdout.write("pi final answer\\n");
if (mode === "opencode") process.stdout.write(${JSON.stringify(events)} + "\\n");
if (mode === "malformed") process.stdout.write("not json\\n{broken\\n");
if (mode === "fail") process.exit(3);
if (mode === "hang") setTimeout(() => {}, 60000);
`,
    { mode: 0o755 }
  );
  const calls = () =>
    fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  return { script, calls };
}

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harness-test-"));
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# rules\n");
  return { dir, agentDir: path.join(dir, ".pi/agent"), sessionDir: path.join(dir, ".pi/sessions") };
}

const env = { PATH: process.env.PATH, MODEL_BASE_URL: "https://acme.openai.azure.com", MODEL_API_KEY: "test-key", OPENCODE_CONFIG: "/evil.json" };

describe("Agent harness adapter", () => {
  it("picks the engine per role, defaulting to pi, and rejects unknown engines", () => {
    expect(resolveEngine("implementer", {})).toBe("pi");
    expect(resolveEngine("implementer", { AGENT_ENGINE: "opencode" })).toBe("opencode");
    expect(resolveEngine("strategist", { AGENT_ENGINE: "opencode", STRATEGIST_ENGINE: "pi" })).toBe("pi");
    expect(() => resolveEngine("implementer", { IMPLEMENTER_ENGINE: "codex" })).toThrow(/Unsupported engine/);
  });

  it("builds a trusted opencode config with explicit permissions and no 'ask' rules", () => {
    const readOnly = buildOpenCodeConfig({ roles, access: "read-only", instructionsPath: "/repo/AGENTS.md", env });
    expect(readOnly.instructions).toEqual(["/repo/AGENTS.md"]);
    expect(readOnly.permission).toMatchObject({ "*": "deny", read: "allow", grep: "allow" });
    expect(readOnly.permission.bash).toBeUndefined();
    expect(readOnly.permission.edit).toBeUndefined();

    const full = buildOpenCodeConfig({ roles, access: "full", env });
    expect(full.permission).toMatchObject({ "*": "deny", edit: "allow", bash: "allow" });
    for (const config of [readOnly, full]) {
      expect(Object.values(config.permission)).not.toContain("ask");
    }

    // Responses models use the OpenAI SDK with reasoning variants; completions models get neither
    expect(full.provider["endpoint-responses"].npm).toBe("@ai-sdk/openai");
    expect(full.provider["endpoint-responses"].options).toEqual({
      baseURL: "https://acme.openai.azure.com/openai/v1",
      apiKey: "{env:MODEL_API_KEY}",
    });
    expect(full.provider["endpoint-responses"].models["gpt-6.1-sol"].variants.high).toEqual({ reasoningEffort: "high" });
    expect(full.provider["endpoint-completions"].npm).toBe("@ai-sdk/openai-compatible");
    expect(full.provider["endpoint-completions"].models["DeepSeek-V4.1-Flash"].variants).toBeUndefined();
    expect(full.provider["endpoint-completions"].models["DeepSeek-V4.1-Flash"].cost).toEqual({
      input: 0.3,
      output: 1.2,
      cache_read: 0.006,
      cache_write: 0,
    });

    // Roles that stay on pi get no opencode provider
    const mixed = buildOpenCodeConfig({ roles: { implementer, strategist: { ...strategist, engine: "pi" } }, env });
    expect(Object.keys(mixed.provider)).toEqual(["endpoint-completions"]);
  });

  it("configures native Bedrock for both engines and preserves AWS profile locations", () => {
    const { dir, agentDir, sessionDir } = workspace();
    const awsEnv = {
      PATH: process.env.PATH, HOME: dir, MODEL_PROVIDER: "bedrock", AWS_PROFILE: "example",
      AWS_REGION: "eu-central-1", IMPLEMENTER_MODEL: "us.anthropic.example-v1:0", STRATEGIST_ENGINE: "opencode",
    };
    const { roles: bedrockRoles } = setupEngines({ agentDir, env: awsEnv });
    expect(bedrockRoles.implementer).toMatchObject({ engine: "pi", provider: "amazon-bedrock" });
    expect(bedrockRoles.strategist).toMatchObject({ engine: "opencode", provider: "amazon-bedrock" });
    expect(apiForProvider("amazon-bedrock")).toBe("bedrock");
    const config = buildOpenCodeConfig({ roles: bedrockRoles, env: awsEnv });
    expect(config.provider["amazon-bedrock"].options).toEqual({ region: "eu-central-1" });
    expect(config.provider["amazon-bedrock"].npm).toBeUndefined();
    expect(config.provider["amazon-bedrock"].models[awsEnv.IMPLEMENTER_MODEL].variants).toBeUndefined();
    const isolated = openCodeEnv({ config, agentDir, env: awsEnv });
    expect(isolated.AWS_PROFILE).toBe("example");
    expect(isolated.AWS_CONFIG_FILE).toBe(path.join(dir, ".aws/config"));
    expect(isolated.AWS_SHARED_CREDENTIALS_FILE).toBe(path.join(dir, ".aws/credentials"));
    expect(openCodeEnv({ config, agentDir, env: { ...awsEnv, AWS_CONFIG_FILE: "/tmp/custom-config", AWS_SHARED_CREDENTIALS_FILE: "/tmp/custom-credentials" } })).toMatchObject({ AWS_CONFIG_FILE: "/tmp/custom-config", AWS_SHARED_CREDENTIALS_FILE: "/tmp/custom-credentials" });
    const fakePi = fakeEngine(dir, "pi");
    expect(runAgent({ role: bedrockRoles.implementer, roles: bedrockRoles, stage: "implementer", prompt: "code", cwd: dir, agentDir, sessionDir, env: awsEnv, command: fakePi.script }).ok).toBe(true);
    expect(fakePi.calls()[0].args).toEqual(expect.arrayContaining(["--provider", "amazon-bedrock"]));
    const fakeOpenCode = fakeEngine(dir, "opencode");
    expect(runAgent({ role: bedrockRoles.strategist, roles: bedrockRoles, stage: "critic", prompt: "review", cwd: dir, agentDir, sessionDir, thinking: "high", env: awsEnv, command: fakeOpenCode.script }).ok).toBe(true);
    const call = fakeOpenCode.calls().at(-1);
    expect(call.args).toEqual(expect.arrayContaining(["-m", `amazon-bedrock/${awsEnv.IMPLEMENTER_MODEL}`]));
    expect(call.args).not.toContain("--variant");
    expect(call.env.AWS_CONFIG_FILE).toBe(path.join(dir, ".aws/config"));
  });

  it("rejects an unspecified model before launching either engine", () => {
    for (const engine of ["pi", "opencode"]) {
      const { dir, agentDir, sessionDir } = workspace();
      const fake = fakeEngine(dir, engine);
      const result = runAgent({ role: { engine, provider: "endpoint-responses", model: "" }, roles, stage: "implementer", prompt: "code", cwd: dir, agentDir, sessionDir, env, command: fake.script });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/No model configured/);
      expect(fake.calls()).toEqual([]);
    }
  });

  it("runs pi with an explicit session ID, safety flags, and read-only tools when asked", () => {
    const { dir, agentDir, sessionDir } = workspace();
    const fake = fakeEngine(dir, "pi");
    const piRole = { engine: "pi", provider: "endpoint-responses", model: "gpt-6.1-sol" };

    const first = runAgent({ role: piRole, roles, stage: "critic", prompt: "review", cwd: dir, agentDir, sessionDir, access: "read-only", env, command: fake.script });
    expect(first.ok).toBe(true);
    expect(first.text).toBe("pi final answer\n");
    const again = runAgent({ role: piRole, roles, stage: "critic", prompt: "retry", cwd: dir, agentDir, sessionDir, sessionId: first.sessionId, access: "full", thinking: "high", env, command: fake.script });

    const [call1, call2] = fake.calls();
    expect(call1.args).toEqual(expect.arrayContaining(["--no-approve", "--no-mcp", "--print", "review"]));
    expect(call1.args.slice(call1.args.indexOf("--tools"), call1.args.indexOf("--tools") + 2)).toEqual(["--tools", "read,grep,find,ls"]);
    expect(call1.args[call1.args.indexOf("--session-id") + 1]).toBe(first.sessionId);
    expect(call1.env.PI_CODING_AGENT_DIR).toBe(agentDir);
    // Continuing resumes the same session by ID, never "the most recent one"
    expect(call2.args[call2.args.indexOf("--session-id") + 1]).toBe(first.sessionId);
    expect(call2.args).not.toContain("--continue");
    expect(call2.args).not.toContain("--tools");
    expect(call2.args.slice(call2.args.indexOf("--thinking"), call2.args.indexOf("--thinking") + 2)).toEqual(["--thinking", "high"]);
    expect(again.sessionId).toBe(first.sessionId);
  });

  it("runs opencode isolated from repo and machine config, and records a pi-style session", () => {
    const { dir, agentDir, sessionDir } = workspace();
    const fake = fakeEngine(dir, "opencode");

    const first = runAgent({ role: strategist, roles, stage: "verifier", prompt: "verify", cwd: dir, agentDir, sessionDir, access: "read-only", thinking: "high", env, command: fake.script });
    expect(first.ok).toBe(true);
    expect(first.sessionId).toBe("ses_abc");
    expect(first.text).toBe('{"approved": true}');

    const [call] = fake.calls();
    expect(call.args).toEqual(expect.arrayContaining(["run", "--pure", "--format", "json", "-m", "endpoint-responses/gpt-6.1-sol", "--variant", "high"]));
    expect(call.args).not.toContain("--session");
    expect(call.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
    expect(call.env.HOME).toBe(path.join(agentDir, "opencode-home"));
    // An inherited OPENCODE_CONFIG must not point opencode at another config file
    expect(call.env.OPENCODE_CONFIG).toBeUndefined();
    const config = JSON.parse(call.env.OPENCODE_CONFIG_CONTENT);
    expect(config.permission["*"]).toBe("deny");
    expect(config.permission.bash).toBeUndefined();
    expect(config.instructions).toEqual([path.join(dir, "AGENTS.md")]);

    // The normalized session reads like a pi session, including cache writes and reasoning
    const sessionFile = path.join(sessionDir, "opencode-ses_abc.jsonl");
    const parsed = parsePiSessionFile(sessionFile);
    expect(parsed.engine).toBe("opencode");
    expect(parsed.totals).toMatchObject({
      inputTokens: 6,
      outputTokens: 84,
      cacheReadTokens: 1722,
      cacheWriteTokens: 1888,
      assistantTurns: 2,
      toolCalls: 1,
      modelsUsed: ["gpt-6.1-sol"],
    });
    expect(parsed.totals.totalCostUsd).toBeCloseTo(0.005, 6);

    // Continuing passes the captured session ID and appends to the same file without a new header
    runAgent({ role: strategist, roles, stage: "verifier", prompt: "retry", cwd: dir, agentDir, sessionDir, sessionId: first.sessionId, env, command: fake.script });
    const second = fake.calls()[1];
    expect(second.args.slice(second.args.indexOf("--session"), second.args.indexOf("--session") + 2)).toEqual(["--session", "ses_abc"]);
    const lines = fs.readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.filter((line) => line.type === "session")).toHaveLength(1);
    expect(parsePiSessionFile(sessionFile).totals.assistantTurns).toBe(4);
  });

  it("does not send reasoning variants to Chat Completions models", () => {
    const { dir, agentDir, sessionDir } = workspace();
    const fake = fakeEngine(dir, "opencode");
    runAgent({ role: implementer, roles, stage: "implementer", prompt: "code", cwd: dir, agentDir, sessionDir, thinking: "high", env, command: fake.script });
    expect(fake.calls()[0].args).not.toContain("--variant");
  });

  it("reports malformed output, non-zero exits and timeouts as failed runs", () => {
    for (const [mode, expected] of [
      ["malformed", /no completed model step/],
      ["fail", /exited with status 3/],
    ] as const) {
      const { dir, agentDir, sessionDir } = workspace();
      const fake = fakeEngine(dir, mode);
      const result = runAgent({ role: strategist, roles, stage: "critic", prompt: "x", cwd: dir, agentDir, sessionDir, env, command: fake.script });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(expected);
    }
    const { dir, agentDir, sessionDir } = workspace();
    const fake = fakeEngine(dir, "hang");
    const piRole = { ...strategist, engine: "pi" };
    const result = runAgent({ role: piRole, roles, stage: "critic", prompt: "x", cwd: dir, agentDir, sessionDir, timeoutMs: 300, env, command: fake.script });
    expect(result.ok).toBe(false);
  });

  it("extracts the final answer from the last step that produced text", () => {
    expect(finalTextFromEvents(OPENCODE_EVENTS)).toBe('{"approved": true}');
    const { entries } = normalizeOpenCodeEvents([{ type: "step_start" }, { type: "step_finish", part: {} }], {
      role: strategist,
      prompt: "x",
    });
    // Without token data the usage stays unknown rather than zero
    expect(entries[1].message.usage).toBeUndefined();
  });

  it("rejects agent patches that add opencode config", () => {
    const result = evaluatePatchPolicy({ changedFiles: ["opencode.json", ".opencode/plugins/x.js", "opencode.jsonc"] });
    expect(result.allowed).toBe(false);
    expect(result.violations).toEqual([
      "Forbidden modification to protected path: opencode.json",
      "Forbidden modification to protected path: .opencode/plugins/x.js",
      "Forbidden modification to protected path: opencode.jsonc",
    ]);
  });
});
