import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completionsSettingsFor,
  hasModelApiKey,
  normalizeAzureV1BaseUrl,
  normalizeBaseUrl,
  priceFor,
  resolveApi,
  resolveModelProvider,
  apiKeyEnvFor,
  baseUrlFor,
  resolveRoles,
  setupModels,
} from "../../scripts/agent/model-config.mjs";
import { runDeterministicDiffChecks } from "../../scripts/agent/run-pi-critic.mjs";
import {
  buildLangfuseBatch,
  buildVerificationScoreEvents,
  parsePiSessionFile,
  pushTraceToLangfuse,
  summarizeIngestionResponse,
} from "../../scripts/agent/push-trace-to-langfuse.mjs";
import { evaluatePatchPolicy, runGitPatchPolicyCheck } from "../../scripts/agent/validate-patch-policy.mjs";
import {
  DEFAULT_PIPELINE_CONFIG,
  loadPipelineConfig,
  validatePipelineConfig,
} from "../../scripts/agent/pipeline-config.mjs";
import {
  buildScoreEvents,
  computeOutcome,
  extractTraceIds,
} from "../../scripts/agent/score-pr-outcome.mjs";
import { appendCriticSectionToSummary, isMandatoryCriticFailure } from "../../scripts/agent/run-pi-agent.mjs";
import {
  extractRefinedSpecFromComments,
  formatImplementerTaskWithSpec,
  parseRefinementJson,
  renderRefinementComment,
  validateRefinementResult,
} from "../../scripts/agent/refinement.mjs";
import {
  FIX_ROUND_LABEL,
  appendFixPrTaskPromptToFile,
  assertCriteriaCoverage,
  buildFailedVerificationReviewPayload,
  buildGitHubReviewPayload,
  extractSpecForVerification,
  parseDiffRightSideLines,
  parseVerificationJson,
  prepareVerificationPublish,
  shouldTriggerFixRound,
  validateVerificationResult,
  withoutSecrets,
} from "../../scripts/agent/verification.mjs";

beforeEach(() => vi.stubEnv("AGENT_PUBLISHER_LOGIN", "github-actions[bot]"));
afterEach(() => vi.unstubAllEnvs());

describe("Autonomous Agent Pipeline Scripts", () => {
  it("normalizes Azure OpenAI and Microsoft Foundry URLs to /openai/v1", () => {
    expect(normalizeAzureV1BaseUrl("https://my-resource.openai.azure.com")).toBe(
      "https://my-resource.openai.azure.com/openai/v1"
    );
    expect(normalizeAzureV1BaseUrl("https://my-resource.openai.azure.com/openai/")).toBe(
      "https://my-resource.openai.azure.com/openai/v1"
    );
    expect(normalizeAzureV1BaseUrl("https://my-foundry.services.ai.azure.com/openai/v1/")).toBe(
      "https://my-foundry.services.ai.azure.com/openai/v1"
    );
  });

  it("resolves implementer and strategist roles with backwards-compatible fallbacks", () => {
    // Explicit role variables
    expect(
      resolveRoles({
        IMPLEMENTER_MODEL: "DeepSeek-V4.1-Flash",
        IMPLEMENTER_API: "completions",
        STRATEGIST_MODEL: "gpt-6.1-sol",
        STRATEGIST_API: "responses",
      })
    ).toEqual({
      implementer: { provider: "endpoint-completions", model: "DeepSeek-V4.1-Flash" },
      strategist: { provider: "endpoint-responses", model: "gpt-6.1-sol" },
    });

    // Fallback to legacy AZURE_OPENAI_MODEL / AZURE_OPENAI_API when IMPLEMENTER_* is unset
    expect(
      resolveRoles({
        AZURE_OPENAI_MODEL: "DeepSeek-V4.1-Flash",
        AZURE_OPENAI_API: "completions",
      })
    ).toEqual({
      implementer: { provider: "endpoint-completions", model: "DeepSeek-V4.1-Flash" },
      strategist: { provider: "endpoint-completions", model: "DeepSeek-V4.1-Flash" },
    });

    // No implicit model: each stage reports a missing model when invoked
    expect(resolveRoles({})).toEqual({
      implementer: { provider: "endpoint-responses", model: "" },
      strategist: { provider: "endpoint-responses", model: "" },
    });
  });

  it("generates .pi/agent/models.json with endpoint-responses and endpoint-completions providers", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-models-test-"));
    const result = setupModels({
      agentDir: tmpDir,
      env: {
        AZURE_OPENAI_BASE_URL: "https://acme-foundry.services.ai.azure.com",
        AZURE_OPENAI_API_KEY: "test-key",
        IMPLEMENTER_MODEL: "DeepSeek-V4.1-Flash",
        IMPLEMENTER_API: "completions",
        STRATEGIST_MODEL: "gpt-6.1-sol",
        STRATEGIST_API: "responses",
      },
    });

    expect(result.normalizedBaseUrl).toBe("https://acme-foundry.services.ai.azure.com/openai/v1");
    expect(result.roles).toEqual({
      implementer: { provider: "endpoint-completions", model: "DeepSeek-V4.1-Flash" },
      strategist: { provider: "endpoint-responses", model: "gpt-6.1-sol" },
    });

    const saved = JSON.parse(fs.readFileSync(result.modelsJsonPath, "utf8"));
    expect(Object.keys(saved.providers)).toEqual(["endpoint-responses", "endpoint-completions"]);
    expect(saved.providers["endpoint-responses"].api).toBe("openai-responses");
    expect(saved.providers["endpoint-completions"].api).toBe("openai-completions");
    // pi only reads the key from the environment with `$NAME`; a bare name would be sent as the key
    expect(saved.providers["endpoint-responses"].apiKey).toBe("$AZURE_OPENAI_API_KEY");
    expect(saved.providers["endpoint-responses"].headers).toEqual({ "api-key": "$AZURE_OPENAI_API_KEY" });

    const responsesModels = saved.providers["endpoint-responses"].models;
    expect(responsesModels.map((m: { id: string }) => m.id)).toEqual(["gpt-6.1-sol"]);
    expect(responsesModels[0].cost).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
    expect(responsesModels[0].compat).toBeUndefined();

    const completionsModels = saved.providers["endpoint-completions"].models;
    expect(completionsModels.map((m: { id: string }) => m.id)).toEqual(["DeepSeek-V4.1-Flash"]);
    const deepseek = completionsModels[0];
    expect(deepseek.cost).toEqual({ input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 });
    expect(deepseek.compat.thinkingFormat).toBe("openai");
    expect(deepseek.compat.supportsReasoningEffort).toBe(false);
    expect(deepseek.compat.supportsDeveloperRole).toBe(false);
    expect(deepseek.input).toEqual(["text", "image"]);
  });

  it("generates OpenAI-compatible providers with bearer auth when MODEL_PROVIDER=openai", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-models-test-"));
    const env = {
      MODEL_PROVIDER: "openai",
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: "https://openrouter.ai/api/v1/",
      IMPLEMENTER_MODEL: "deepseek/deepseek-v4.1-flash",
      IMPLEMENTER_API: "completions",
      STRATEGIST_MODEL: "gpt-6.1-sol",
      STRATEGIST_API: "responses",
    };
    const result = setupModels({ agentDir: tmpDir, env });

    expect(result.normalizedBaseUrl).toBe("https://openrouter.ai/api/v1");
    expect(result.roles).toEqual({
      implementer: { provider: "endpoint-completions", model: "deepseek/deepseek-v4.1-flash" },
      strategist: { provider: "endpoint-responses", model: "gpt-6.1-sol" },
    });

    const saved = JSON.parse(fs.readFileSync(result.modelsJsonPath, "utf8"));
    expect(Object.keys(saved.providers)).toEqual(["endpoint-responses", "endpoint-completions"]);
    for (const provider of Object.values(saved.providers) as Array<Record<string, unknown>>) {
      expect(provider.apiKey).toBe("$OPENAI_API_KEY");
      expect(provider.headers).toBeUndefined();
    }
    expect(normalizeBaseUrl("")).toBe("https://api.openai.com/v1");

    expect(hasModelApiKey({ MODEL_PROVIDER: "openai", AZURE_OPENAI_API_KEY: "x" })).toBe(false);
    expect(hasModelApiKey({ MODEL_PROVIDER: "openai", OPENAI_API_KEY: "x" })).toBe(true);
    expect(hasModelApiKey({ AZURE_OPENAI_BASE_URL: "https://acme.openai.azure.com", AZURE_OPENAI_API_KEY: "x" })).toBe(true);
    expect(() => resolveRoles({ MODEL_PROVIDER: "invalid" })).toThrow(/Unsupported MODEL_PROVIDER/);
  });

  it("prices known deployments from the table and unknown ones from AZURE_COST_* variables", () => {
    const env = { AZURE_COST_INPUT_PER_1M: "9", AZURE_COST_OUTPUT_PER_1M: "9", AZURE_COST_CACHE_READ_PER_1M: "9" };
    expect(priceFor("DeepSeek-V4.1-Flash", env)).toEqual({ input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 });
    expect(priceFor("gpt-6.1-sol", env)).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
    expect(priceFor("my-custom-deployment", env)).toEqual({ input: 9, output: 9, cacheRead: 9, cacheWrite: 0 });
  });

  it("validates AZURE_OPENAI_API and applies AZURE_MODEL_COMPAT overrides", () => {
    expect(resolveApi("")).toBe("openai-responses");
    expect(resolveApi("Completions")).toBe("openai-completions");
    expect(() => resolveApi("chat")).toThrow(/Unsupported model API/);

    const settings = completionsSettingsFor("DeepSeek-V4.1-Flash", '{"supportsReasoningEffort":true}');
    expect(settings.compat.supportsReasoningEffort).toBe(true);
    expect(settings.compat.requiresReasoningContentOnAssistantMessages).toBe(true);
  });

  it("defaults to a generic endpoint and detects Azure while preserving legacy settings", () => {
    expect(resolveModelProvider({})).toBe("openai-compatible");
    expect(resolveModelProvider({ MODEL_PROVIDER: "openai" })).toBe("openai-compatible");
    for (const host of ["acme.openai.azure.com", "acme.services.ai.azure.com", "acme.cognitiveservices.azure.com"]) {
      expect(resolveModelProvider({ MODEL_BASE_URL: `https://${host}/openai/v1` })).toBe("azure");
    }
    expect(resolveModelProvider({ AZURE_OPENAI_BASE_URL: "https://legacy.example/v1" })).toBe("azure");
    expect(resolveModelProvider({ AZURE_OPENAI_RESOURCE_NAME: "legacy" })).toBe("azure");
    expect(resolveModelProvider({ MODEL_BASE_URL: "https://models.example/v1", AZURE_OPENAI_BASE_URL: "https://old.openai.azure.com" })).toBe("openai-compatible");
    expect(resolveModelProvider({ MODEL_BASE_URL: "https://models.example/acme.openai.azure.com" })).toBe("openai-compatible");
    expect(resolveModelProvider({ MODEL_PROVIDER: "openai-compatible", MODEL_BASE_URL: "https://acme.openai.azure.com/openai/v1" })).toBe("openai-compatible");
    expect(apiKeyEnvFor("openai-compatible", { MODEL_API_KEY: "generic", OPENAI_API_KEY: "legacy" })).toBe("MODEL_API_KEY");
    expect(baseUrlFor("openai-compatible", { MODEL_BASE_URL: "https://models.example/v1/", OPENAI_BASE_URL: "https://old.example/v1" })).toBe("https://models.example/v1");
    expect(baseUrlFor("azure", { AZURE_OPENAI_RESOURCE_NAME: "legacy" })).toBe("https://legacy.openai.azure.com/openai/v1");
  });

  it("writes generic credentials and applies compatibility overrides", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "generic-models-test-"));
    const result = setupModels({ agentDir, env: {
      MODEL_BASE_URL: "https://models.example/v1/", MODEL_API_KEY: "test-key",
      IMPLEMENTER_MODEL: "deepseek-example", IMPLEMENTER_API: "completions",
      MODEL_COMPAT: '{"supportsReasoningEffort":true}',
    } });
    const saved = JSON.parse(fs.readFileSync(result.modelsJsonPath, "utf8"));
    expect(saved.providers["endpoint-completions"].apiKey).toBe("$MODEL_API_KEY");
    expect(saved.providers["endpoint-completions"].headers).toBeUndefined();
    expect(saved.providers["endpoint-completions"].models[0].compat.supportsReasoningEffort).toBe(true);
    expect(hasModelApiKey({ MODEL_API_KEY: "test-key" })).toBe(true);
    expect(hasModelApiKey({})).toBe(false);
  });

  it("uses native Bedrock roles without generating an OpenAI endpoint or requiring an API key", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "bedrock-models-test-"));
    const env = { MODEL_PROVIDER: "bedrock", IMPLEMENTER_MODEL: "us.anthropic.example-v1:0", IMPLEMENTER_API: "unused" };
    const result = setupModels({ agentDir, env });
    expect(result.roles).toEqual({
      implementer: { provider: "amazon-bedrock", model: env.IMPLEMENTER_MODEL },
      strategist: { provider: "amazon-bedrock", model: env.IMPLEMENTER_MODEL },
    });
    expect(result.normalizedBaseUrl).toBeNull();
    expect(JSON.parse(fs.readFileSync(result.modelsJsonPath, "utf8"))).toEqual({ providers: {} });
    expect(apiKeyEnvFor("bedrock", env)).toBeNull();
    // Credential discovery belongs to the native provider, including default profiles and instance roles.
    expect(hasModelApiKey({ MODEL_PROVIDER: "bedrock" })).toBe(true);
  });

  it("lets generic prices override host-specific estimates, including explicit zero costs", () => {
    expect(priceFor("gpt-6.1-sol", { MODEL_COST_INPUT_PER_1M: "0", MODEL_COST_OUTPUT_PER_1M: "1.5" })).toMatchObject({ input: 0, output: 1.5 });
    expect(priceFor("example", { MODEL_COST_INPUT_PER_1M: "3", AZURE_COST_INPUT_PER_1M: "9" }).input).toBe(3);
    expect(() => priceFor("example", { MODEL_COST_INPUT_PER_1M: "invalid" })).toThrow(/cost/i);
  });

  it("detects merge conflict markers, debugger statements, and .skip/.only in critic pre-checks", () => {
    const cleanDiff = "+const x = 42;\n+export default x;";
    expect(runDeterministicDiffChecks(cleanDiff)).toEqual([]);

    const dirtyDiff = "+<<<<<<< HEAD\n+debugger;\n+it.skip('bypasses test', () => {});\n+>>>>>>> branch";
    const issues = runDeterministicDiffChecks(dirtyDiff);
    expect(issues.length).toBe(3);

    // A bare ======= line is a conflict marker; ======= inside other text is not
    expect(runDeterministicDiffChecks("+=======")).toEqual(["Git merge conflict markers detected in diff."]);
    const lookalikes = "+Heading\n+=======================\n+console.log('====== banner ======');\n+// see <<<<<<<HEAD notes";
    expect(runDeterministicDiffChecks(lookalikes)).toEqual([]);
  });

  it("enforces the 6-row publish-job security & review matrix", () => {
    // Row 1 & 2: Reject protected workflow, harness, contract, and test/compiler configs
    expect(
      evaluatePatchPolicy({
        changedFiles: [".github/workflows/pi-agent.yml"],
      }).allowed
    ).toBe(false);

    expect(
      evaluatePatchPolicy({
        changedFiles: ["vitest.config.ts"],
      }).allowed
    ).toBe(false);

    // Row 3: Reject package.json when .scripts is modified
    expect(
      evaluatePatchPolicy({
        changedFiles: ["package.json"],
        basePackageJsonText: JSON.stringify({ scripts: { test: "vitest run" } }),
        headPackageJsonText: JSON.stringify({ scripts: { test: "echo passed" } }),
      }).allowed
    ).toBe(false);

    // Row 3 & 4: Allow package.json / package-lock.json dependency changes when .scripts is identical, adding label
    const depResult = evaluatePatchPolicy({
      changedFiles: ["package.json", "package-lock.json"],
      basePackageJsonText: JSON.stringify({
        scripts: { test: "vitest run" },
        dependencies: {},
      }),
      headPackageJsonText: JSON.stringify({
        scripts: { test: "vitest run" },
        dependencies: { zod: "^3.23.0" },
      }),
    });
    expect(depResult.allowed).toBe(true);
    expect(depResult.labels).toContain("needs-dependency-review");
    expect(depResult.eligibleForAutoMerge).toBe(false);

    // Row 5: Allow adding/editing tests, add needs-test-review label, but reject deleted test files or .skip/.only
    const validTestEdit = evaluatePatchPolicy({
      changedFiles: ["src/task-store.ts", "tests/unit/task-store.test.ts"],
      testsDiffText: "+  it('validates input', () => { expect(true).toBe(true); });",
    });
    expect(validTestEdit.allowed).toBe(true);
    expect(validTestEdit.labels).toContain("needs-test-review");
    expect(validTestEdit.eligibleForAutoMerge).toBe(false);

    const deletedTestEdit = evaluatePatchPolicy({
      changedFiles: ["tests/unit/task-store.test.ts"],
      deletedFiles: ["tests/unit/task-store.test.ts"],
    });
    expect(deletedTestEdit.allowed).toBe(false);

    const skippedTestEdit = evaluatePatchPolicy({
      changedFiles: ["tests/unit/task-store.test.ts"],
      testsDiffText: "+  it.skip('disabled failing assertion', () => {});",
    });
    expect(skippedTestEdit.allowed).toBe(false);

    // Pure src/ and public/ changes are allowed with no warning labels
    const appOnlyEdit = evaluatePatchPolicy({
      changedFiles: ["src/task-store.ts", "public/app.js"],
    });
    expect(appOnlyEdit.allowed).toBe(true);
    expect(appOnlyEdit.labels).toEqual([]);
    expect(appOnlyEdit.eligibleForAutoMerge).toBe(true);

    // .pi/pipeline.json is always hard-protected even if protectedPaths is empty
    const pipelineEdit = evaluatePatchPolicy({
      changedFiles: [".pi/pipeline.json"],
      protectedPaths: [],
    });
    expect(pipelineEdit.allowed).toBe(false);
    expect(pipelineEdit.violations[0]).toContain(".pi/pipeline.json");
  });

  it("loads .pi/pipeline.json with defaults when missing and rejects invalid schemas", () => {
    const missingPath = path.join(os.tmpdir(), "nonexistent-pipeline-config-12345.json");
    expect(loadPipelineConfig(missingPath)).toEqual({
      ...DEFAULT_PIPELINE_CONFIG,
      uiPaths: [...DEFAULT_PIPELINE_CONFIG.uiPaths],
      protectedPaths: [...DEFAULT_PIPELINE_CONFIG.protectedPaths],
    });

    // Committed .pi/pipeline.json matches defaults
    expect(loadPipelineConfig()).toEqual({
      ...DEFAULT_PIPELINE_CONFIG,
      uiPaths: [...DEFAULT_PIPELINE_CONFIG.uiPaths],
      protectedPaths: [...DEFAULT_PIPELINE_CONFIG.protectedPaths],
    });
    expect(loadPipelineConfig(process.cwd())).toEqual({
      ...DEFAULT_PIPELINE_CONFIG,
      uiPaths: [...DEFAULT_PIPELINE_CONFIG.uiPaths],
      protectedPaths: [...DEFAULT_PIPELINE_CONFIG.protectedPaths],
    });

    expect(() => validatePipelineConfig(null)).toThrow(/expected a JSON object/);
    expect(() => validatePipelineConfig({ unknownKey: "value" })).toThrow(/unknown key "unknownKey"/);
    expect(() => validatePipelineConfig({ verify: "" })).toThrow(/"verify" must be a non-empty string/);
    expect(() => validatePipelineConfig({ uiPaths: ["public/", ""] })).toThrow(
      /"uiPaths" must be an array of non-empty strings/
    );
    expect(() => validatePipelineConfig({ readyTimeoutSeconds: -5 })).toThrow(
      /"readyTimeoutSeconds" must be a positive number/
    );
  });

  it("reads .pi/pipeline.json from baseRef in runGitPatchPolicyCheck so a patch cannot weaken its own rules", () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-policy-git-test-"));
    execSync("git init -b main", { cwd: tmpRepo, stdio: "ignore" });
    execSync('git config user.name "Test"', { cwd: tmpRepo, stdio: "ignore" });
    execSync('git config user.email "test@example.com"', { cwd: tmpRepo, stdio: "ignore" });

    fs.mkdirSync(path.join(tmpRepo, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, ".pi/pipeline.json"),
      JSON.stringify({ protectedPaths: ["custom-lock.json"] }, null, 2) + "\n",
      "utf8"
    );
    fs.writeFileSync(path.join(tmpRepo, "custom-lock.json"), "{}\n", "utf8");
    execSync("git add -A && git commit -m 'base'", { cwd: tmpRepo, stdio: "ignore" });

    // Attacker patch tries to empty protectedPaths in .pi/pipeline.json AND modify custom-lock.json
    fs.writeFileSync(
      path.join(tmpRepo, ".pi/pipeline.json"),
      JSON.stringify({ protectedPaths: [] }, null, 2) + "\n",
      "utf8"
    );
    fs.writeFileSync(path.join(tmpRepo, "custom-lock.json"), '{"tampered":true}\n', "utf8");

    const result = runGitPatchPolicyCheck({ baseRef: "HEAD", cwd: tmpRepo });
    expect(result.allowed).toBe(false);
    // Both .pi/pipeline.json AND custom-lock.json (from baseRef's protectedPaths) are caught
    expect(result.violations).toContain("Forbidden modification to protected path: .pi/pipeline.json");
    expect(result.violations).toContain("Forbidden modification to protected path: custom-lock.json");
  });

  it("catches protected paths and test deletions whose names git would quote (tabs, non-ASCII)", () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-policy-quoted-test-"));
    execSync("git init -b main", { cwd: tmpRepo, stdio: "ignore" });
    execSync('git config user.name "Test"', { cwd: tmpRepo, stdio: "ignore" });
    execSync('git config user.email "test@example.com"', { cwd: tmpRepo, stdio: "ignore" });

    fs.mkdirSync(path.join(tmpRepo, "tests"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "tests/größe.test.ts"), "x\n", "utf8");
    fs.writeFileSync(path.join(tmpRepo, "tests/edge\tcase.test.ts"), "x\n", "utf8");
    execSync("git add -A && git commit -m 'base'", { cwd: tmpRepo, stdio: "ignore" });

    fs.mkdirSync(path.join(tmpRepo, ".github/workflows"), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, "scripts/agent"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, ".github/workflows/évil.yml"), "name: evil\n", "utf8");
    fs.writeFileSync(path.join(tmpRepo, "scripts/agent/edge\tcase.mjs"), "// injected\n", "utf8");
    fs.rmSync(path.join(tmpRepo, "tests/größe.test.ts"));
    fs.rmSync(path.join(tmpRepo, "tests/edge\tcase.test.ts"));

    const result = runGitPatchPolicyCheck({ baseRef: "HEAD", cwd: tmpRepo });
    expect(result.allowed).toBe(false);
    expect(result.eligibleForAutoMerge).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        "Forbidden modification to protected path: .github/workflows/évil.yml",
        "Forbidden modification to protected path: scripts/agent/edge\tcase.mjs",
        "Forbidden deletion of existing test file: tests/größe.test.ts",
        "Forbidden deletion of existing test file: tests/edge\tcase.test.ts",
      ])
    );
  });

  it("treats unapproved hygiene-gate verdicts (and LLM verdicts under STRICT_CRITIC) as blocking", () => {
    const hygieneFail = { approved: false, model: "deterministic-hygiene-gate", issues: ["debugger statement"] };
    const llmAdvisory = { approved: false, model: "gpt-6.1-sol", issues: ["missing test"] };
    expect(isMandatoryCriticFailure(hygieneFail)).toBe(true);
    expect(isMandatoryCriticFailure(llmAdvisory)).toBe(false);
    expect(isMandatoryCriticFailure(llmAdvisory, true)).toBe(true);
    expect(isMandatoryCriticFailure({ approved: true, model: "deterministic-hygiene-gate", issues: [] }, true)).toBe(false);
  });

  it("always appends Critic section to agent-authored PR summaries", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-summary-test-"));
    const summaryPath = path.join(tmpDir, "pr-summary.md");
    fs.writeFileSync(summaryPath, "## Summary\nFixed filter bug in `src/task-store.ts`.\n", "utf8");

    appendCriticSectionToSummary(summaryPath, {
      primaryModel: "chatgpt-6.1-sol",
      verificationCommand: "npm run verify",
      criticVerdict: {
        approved: true,
        model: "o3",
        summary: "Clean diff and full unit coverage.",
        issues: [],
      },
    });

    const merged = fs.readFileSync(summaryPath, "utf8");
    expect(merged).toContain("Fixed filter bug");
    expect(merged).toContain("### Step 5 Critic & Local Verification");
    expect(merged).toContain("Clean diff and full unit coverage.");
  });

  it("parses Pi JSONL session trajectories and builds Langfuse ingestion batches", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-test-"));
    const sampleJsonl = path.join(tmpDir, "session.jsonl");

    const lines = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "trace-session-123",
        timestamp: "2026-10-18T01:00:00.000Z",
        cwd: "/workspace",
      }),
      JSON.stringify({
        type: "message",
        id: "msg-1",
        parentId: null,
        timestamp: "2026-10-18T01:00:01.000Z",
        message: {
          role: "user",
          content: "Fix empty title bug",
        },
      }),
      JSON.stringify({
        type: "message",
        id: "msg-2",
        parentId: "msg-1",
        timestamp: "2026-10-18T01:00:03.000Z",
        message: {
          role: "assistant",
          provider: "azure-v1",
          api: "openai-responses",
          model: "chatgpt-6.1-sol",
          content: [
            { type: "thinking", thinking: "Checking src/task-store.ts" },
            { type: "toolCall", id: "call-1", name: "edit", arguments: { path: "src/task-store.ts" } },
          ],
          usage: {
            input: 1200,
            output: 300,
            cacheRead: 400,
            cacheWrite: 0,
            totalTokens: 1500,
            cost: { input: 0.003, output: 0.003, cacheRead: 0.00025, cacheWrite: 0, total: 0.00625 },
          },
          stopReason: "toolUse",
        },
      }),
      JSON.stringify({
        type: "message",
        id: "msg-3",
        parentId: "msg-2",
        timestamp: "2026-10-18T01:00:04.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "edit",
          content: [
            { type: "text", text: "Edited src/task-store.ts" },
            { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "msg-4",
        parentId: "msg-3",
        timestamp: "2026-10-18T01:00:06.000Z",
        message: {
          role: "assistant",
          model: "chatgpt-6.1-sol",
          content: [{ type: "text", text: "Done: empty titles are rejected." }],
          usage: { input: 50, output: 10, cacheRead: 1500, totalTokens: 1560, cost: { total: 0.0001 } },
          stopReason: "stop",
        },
      }),
    ];

    fs.writeFileSync(sampleJsonl, lines.join("\n") + "\n", "utf8");

    const parsed = parsePiSessionFile(sampleJsonl);
    expect(parsed.sessionId).toBe("trace-session-123");
    expect(parsed.totals.assistantTurns).toBe(2);
    expect(parsed.totals.toolCalls).toBe(1);
    expect(parsed.totals.totalTokens).toBe(3060);
    expect(parsed.totals.modelsUsed).toEqual(["chatgpt-6.1-sol"]);

    const { traceId, batch } = buildLangfuseBatch(parsed, {
      issueOrPrId: "42",
      taskPrompt: "# Issue #42: Fix empty title bug",
    });
    expect(traceId).toBe("trace-session-123");

    // Trace carries the task prompt and is grouped into a per-issue session
    expect(batch[0].type).toBe("trace-create");
    expect(batch[0].body.input).toBe("# Issue #42: Fix empty title bug");
    expect(batch[0].body.sessionId).toBe(`${process.env.GITHUB_REPOSITORY || "local"}#42`);
    expect(batch[0].body.output.finalAnswer).toBe("Done: empty titles are rejected.");

    // Each model turn gets the messages it responded to as input
    const generations = batch.filter((e: { type: string }) => e.type === "generation-create");
    expect(generations[0].body.input).toEqual([{ role: "user", content: "Fix empty title bug" }]);
    expect(generations[1].body.input[0]).toMatchObject({ role: "tool", toolName: "edit" });
    expect(generations[0].body.usageDetails).toEqual({ input: 1200, output: 300, cache_read: 400, cache_write: 0 });
    expect(generations[0].body.metadata.engine).toBe("pi");

    // Tool runs are nested under the requesting turn, with arguments; screenshots are not inlined
    const span = batch.find((e: { type: string }) => e.type === "span-create")!;
    expect(span.body.parentObservationId).toBe("msg-2");
    expect(span.body.input).toEqual({ tool: "edit", arguments: { path: "src/task-store.ts" } });
    expect(span.body.output[1]).toEqual({ type: "image", mimeType: "image/png", omitted: "12 base64 chars" });
  });

  it("aggregates multiple session files (implementer + strategist) into one Langfuse trace", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-multi-session-test-"));
    const sessionDir = path.join(tmpDir, "sessions");
    const artifactsDir = path.join(tmpDir, "artifacts");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(artifactsDir, { recursive: true });

    const implementerJsonl = path.join(sessionDir, "01-implementer.jsonl");
    const strategistJsonl = path.join(sessionDir, "02-strategist.jsonl");

    fs.writeFileSync(
      implementerJsonl,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "impl-session-001",
          timestamp: "2026-10-20T10:00:00.000Z",
          cwd: "/workspace",
        }),
        JSON.stringify({
          type: "message",
          id: "impl-user-1",
          timestamp: "2026-10-20T10:00:01.000Z",
          message: { role: "user", content: "Implement task" },
        }),
        JSON.stringify({
          type: "message",
          id: "impl-asst-1",
          timestamp: "2026-10-20T10:00:05.000Z",
          message: {
            role: "assistant",
            provider: "endpoint-completions",
            api: "openai-completions",
            model: "DeepSeek-V4.1-Flash",
            content: [{ type: "text", text: "Implemented feature." }],
            usage: { input: 1000, output: 200, cacheRead: 500, totalTokens: 1200, cost: { total: 0.00054 } },
            stopReason: "stop",
          },
        }),
      ].join("\n") + "\n",
      "utf8"
    );

    fs.writeFileSync(
      strategistJsonl,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "strat-session-002",
          timestamp: "2026-10-20T10:01:00.000Z",
          cwd: "/workspace",
        }),
        JSON.stringify({
          type: "message",
          id: "strat-user-1",
          timestamp: "2026-10-20T10:01:01.000Z",
          message: { role: "user", content: "Review diff" },
        }),
        JSON.stringify({
          type: "message",
          id: "strat-asst-1",
          timestamp: "2026-10-20T10:01:04.000Z",
          message: {
            role: "assistant",
            provider: "endpoint-responses",
            api: "openai-responses",
            model: "gpt-6.1-sol",
            content: [{ type: "text", text: '{"approved":true,"summary":"LGTM","issues":[]}' }],
            usage: { input: 2000, output: 100, cacheRead: 0, totalTokens: 2100, cost: { total: 0.005 } },
            stopReason: "stop",
          },
        }),
      ].join("\n") + "\n",
      "utf8"
    );

    const env = {
      IMPLEMENTER_MODEL: "DeepSeek-V4.1-Flash",
      IMPLEMENTER_API: "completions",
      STRATEGIST_MODEL: "gpt-6.1-sol",
      STRATEGIST_API: "responses",
      GITHUB_REPOSITORY: "acme/repo2ship",
    };

    const implParsed = parsePiSessionFile(implementerJsonl);
    const stratParsed = parsePiSessionFile(strategistJsonl);
    // Pass in reverse order to verify chronological sorting puts the older implementer session first
    const { traceId, batch } = buildLangfuseBatch([stratParsed, implParsed], {
      issueOrPrId: "19",
      taskPrompt: "Implement feature",
      env,
    });

    expect(traceId).toBe("impl-session-001");
    const traceEvent: any = batch[0];
    expect(traceEvent.type).toBe("trace-create");
    expect(traceEvent.body.id).toBe("impl-session-001");
    expect(traceEvent.body.output.finalAnswer).toBe("Implemented feature.");
    expect(traceEvent.body.output.assistantTurns).toBe(2);
    expect(traceEvent.body.output.totalTokens).toBe(3300);
    expect(traceEvent.body.output.totalCostUsd).toBe(0.00554);
    expect(traceEvent.body.metadata.modelsUsed).toEqual(["DeepSeek-V4.1-Flash", "gpt-6.1-sol"]);

    const generations = batch.filter((e: { type: string }) => e.type === "generation-create");
    expect(generations).toHaveLength(2);
    expect(generations[0].body.model).toBe("DeepSeek-V4.1-Flash");
    expect(generations[0].body.metadata.role).toBe("implementer");
    expect(generations[0].body.metadata.piSessionId).toBe("impl-session-001");
    expect(generations[1].body.model).toBe("gpt-6.1-sol");
    expect(generations[1].body.metadata.role).toBe("strategist");
    expect(generations[1].body.metadata.piSessionId).toBe("strat-session-002");

    // Also verify pushTraceToLangfuse reads all files in sessionDir and sums totals
    const summary = await pushTraceToLangfuse({ sessionDir, artifactsDir, dryRun: true, env });
    expect(summary.traceId).toBe("impl-session-001");
    expect(summary.assistantTurns).toBe(2);
    expect(summary.totalTokens).toBe(3300);
    expect(summary.modelsUsed).toEqual(["DeepSeek-V4.1-Flash", "gpt-6.1-sol"]);
  });

  it("treats Langfuse 207 responses with per-event errors as a failed upload", () => {
    expect(summarizeIngestionResponse(207, { successes: [{ id: "a" }, { id: "b" }], errors: [] })).toEqual({
      ok: true,
      successes: 2,
      errors: [],
    });

    const partial = summarizeIngestionResponse(207, {
      successes: [{ id: "a" }],
      errors: [{ id: "b", status: 400, message: "Invalid request data" }],
    });
    expect(partial.ok).toBe(false);
    expect(partial.errors[0].message).toBe("Invalid request data");

    expect(summarizeIngestionResponse(401, "Unauthorized").ok).toBe(false);
  });

  it("scores agent PR outcomes onto every linked Langfuse trace", () => {
    const agent = { login: "pi-coding-agent[bot]", email: "pi-coding-agent[bot]@users.noreply.github.com" };
    const pr = {
      url: "https://github.com/acme/repo/pull/7",
      state: "MERGED",
      mergedAt: "2026-10-20T10:00:00Z",
      body: "- **Langfuse Trace:** https://cloud.langfuse.com/trace/01a1-run-one",
      comments: [
        { body: "follow-up run\n- **Langfuse Trace:** https://cloud.langfuse.com/trace/01a1-run-two" },
        { body: "looks good" },
      ],
      commits: [{ authors: [agent] }],
    };

    expect(extractTraceIds(["see /trace/abc12345 and /trace/abc12345 again"])).toEqual(["abc12345"]);

    const outcome = computeOutcome(pr);
    expect(outcome).toMatchObject({ merged: true, humanEdited: false, mergedWithoutHumanEdits: true, agentRuns: 2 });

    const events = buildScoreEvents(outcome, pr.url);
    expect(events).toHaveLength(8);
    expect(events.every((e: { type: string }) => e.type === "score-create")).toBe(true);
    expect(events[0].body.id).toBe("01a1-run-one-pr_merged");

    // A human commit on the PR branch counts as an edit, even if the PR is merged
    const edited = computeOutcome({
      ...pr,
      commits: [{ authors: [agent] }, { authors: [{ login: "maintainer", email: "maintainer@example.com" }] }],
    });
    expect(edited).toMatchObject({ humanEdited: true, mergedWithoutHumanEdits: false });

    // Closed without merging
    expect(computeOutcome({ ...pr, state: "CLOSED", mergedAt: null }).merged).toBe(false);
  });

  it("validates refinement schema, rejects >3 questions or missing AC ids, renders Markdown, and extracts latest spec marker", () => {
    const validReady = validateRefinementResult(
      parseRefinementJson(`\`\`\`json
      {
        "status": "ready",
        "questions": [],
        "spec": {
          "goal": "Add Priority filter dropdown to the task queue UI.",
          "acceptanceCriteria": [
            { "id": "AC-1", "text": "Selecting High shows only high-priority tasks." },
            { "id": "AC-2", "text": "Selecting All restores the full list." }
          ],
          "outOfScope": ["Backend database changes"],
          "affectedAreas": ["public/index.html", "public/app.js"]
        }
      }
      \`\`\``)
    );
    expect(validReady.status).toBe("ready");
    expect(validReady.spec.acceptanceCriteria).toHaveLength(2);

    const validClarify = validateRefinementResult({
      status: "needs_clarification",
      questions: ["Which 5 task options should be added?", "Should they appear in the priority dropdown?"],
      spec: {
        goal: "",
        acceptanceCriteria: [],
        outOfScope: [],
        affectedAreas: [],
      },
    });
    expect(validClarify.status).toBe("needs_clarification");
    expect(validClarify.questions).toHaveLength(2);

    // Reject >3 questions
    expect(() =>
      validateRefinementResult({
        status: "needs_clarification",
        questions: ["Q1?", "Q2?", "Q3?", "Q4?"],
        spec: {},
      })
    ).toThrow(/allows at most 3 items/);

    // Reject needs_clarification with 0 questions
    expect(() =>
      validateRefinementResult({
        status: "needs_clarification",
        questions: [],
        spec: {},
      })
    ).toThrow(/requires at least 1 question/);

    // Reject ready with non-empty questions
    expect(() =>
      validateRefinementResult({
        status: "ready",
        questions: ["Wait, what about X?"],
        spec: {
          goal: "Do X",
          acceptanceCriteria: [{ id: "AC-1", text: "X works" }],
        },
      })
    ).toThrow(/"questions" must be empty when status is "ready"/);

    // Reject missing or invalid AC id
    expect(() =>
      validateRefinementResult({
        status: "ready",
        questions: [],
        spec: {
          goal: "Do X",
          acceptanceCriteria: [{ id: "1", text: "Missing AC- prefix" }],
        },
      })
    ).toThrow(/must match "AC-<number>"/);

    // Reject duplicate AC id
    expect(() =>
      validateRefinementResult({
        status: "ready",
        questions: [],
        spec: {
          goal: "Do X",
          acceptanceCriteria: [
            { id: "AC-1", text: "First" },
            { id: "AC-1", text: "Duplicate" },
          ],
        },
      })
    ).toThrow(/duplicate acceptance criterion id "AC-1"/);

    // Reject unknown keys
    expect(() =>
      validateRefinementResult({
        status: "ready",
        questions: [],
        extraField: true,
        spec: { goal: "G", acceptanceCriteria: [{ id: "AC-1", text: "T" }] },
      })
    ).toThrow(/unknown top-level key "extraField"/);

    // Render Markdown comments for both statuses
    const clarifyMd = renderRefinementComment(validClarify);
    expect(clarifyMd).toContain("Clarification Needed Before Implementation");
    expect(clarifyMd).toContain("1. Which 5 task options should be added?");
    expect(clarifyMd).not.toContain("<!-- pi:refined-spec");

    const readyMd1 = renderRefinementComment(validReady);
    expect(readyMd1).toContain("## ✅ Refined Spec");
    expect(readyMd1).toContain("- **AC-1:** Selecting High shows only high-priority tasks.");
    expect(readyMd1).toContain("<!-- pi:refined-spec");

    const updatedReady = validateRefinementResult({
      status: "ready",
      questions: [],
      spec: {
        goal: "Updated goal after human reply.",
        acceptanceCriteria: [{ id: "AC-1", text: "Updated criterion after clarification." }],
        outOfScope: [],
        affectedAreas: ["src/task-store.ts"],
      },
    });
    const readyMd2 = renderRefinementComment(updatedReady);

    // Latest refined spec from the designated publisher wins
    const extracted = extractRefinedSpecFromComments([
      { author: { login: "github-actions[bot]" }, body: clarifyMd },
      { author: { login: "github-actions[bot]" }, body: readyMd1 },
      { body: "@pi actually please use the updated spec" },
      { author: { login: "github-actions[bot]" }, body: readyMd2 },
    ]);
    expect(extracted).toEqual(updatedReady.spec);

    // Formatting the implementer prompt includes all AC IDs and the PR summary instruction
    const formattedPrompt = formatImplementerTaskWithSpec("# Issue #10", extracted!);
    expect(formattedPrompt).toContain("## Approved Refined Specification (Mandatory)");
    expect(formattedPrompt).toContain("- **AC-1:** Updated criterion after clarification.");
    expect(formattedPrompt).toContain("In `.pi/artifacts/pr-summary.md`, include an `### Acceptance Criteria` section");
  });

  it("validates verifier schema, enforces verdict invariants, renders COMMENT reviews, and gates fix rounds", () => {
    const passResult = validateVerificationResult(
      parseVerificationJson(`\`\`\`json
      {
        "verdict": "pass",
        "criteria": [
          {
            "id": "AC-1",
            "status": "pass",
            "evidence": "Input has aria-label=\\"New task title\\".",
            "screenshot": ".pi/qa/AC-1.png"
          },
          {
            "id": "AC-2",
            "status": "pass",
            "evidence": "Existing attributes preserved.",
            "screenshot": ".pi/qa/AC-2.png"
          }
        ],
        "findings": []
      }
      \`\`\``)
    );
    expect(passResult.verdict).toBe("pass");
    expect(passResult.criteria).toHaveLength(2);

    // Reject verdict: "pass" when a criterion failed or is unclear
    expect(() =>
      validateVerificationResult({
        verdict: "pass",
        criteria: [{ id: "AC-1", status: "fail", evidence: "Footer count did not update.", screenshot: ".pi/qa/AC-1.png" }],
        findings: [],
      })
    ).toThrow(/"verdict" cannot be "pass" when one or more criteria have status "fail" or "unclear"/);

    // Reject verdict: "pass" when high-severity finding exists
    expect(() =>
      validateVerificationResult({
        verdict: "pass",
        criteria: [{ id: "AC-1", status: "pass", evidence: "Works", screenshot: ".pi/qa/AC-1.png" }],
        findings: [{ severity: "high", file: "public/app.js", line: 10, text: "XSS vulnerability" }],
      })
    ).toThrow(/"verdict" cannot be "pass" when high-severity findings exist/);

    // Reject unknown keys or invalid line numbers
    expect(() =>
      validateVerificationResult({
        verdict: "changes_needed",
        criteria: [{ id: "AC-1", status: "fail", evidence: "Broken", extra: true }],
        findings: [],
      })
    ).toThrow(/unknown key "extra"/);

    expect(() =>
      validateVerificationResult({
        verdict: "changes_needed",
        criteria: [{ id: "AC-1", status: "fail", evidence: "Broken" }],
        findings: [{ severity: "medium", file: "public/app.js", line: 0, text: "Invalid line 0" }],
      })
    ).toThrow(/line must be a positive integer/);

    const changesNeeded = validateVerificationResult({
      verdict: "changes_needed",
      criteria: [
        { id: "AC-1", status: "pass", evidence: "Reopen button renders on done cards.", screenshot: ".pi/qa/AC-1.png" },
        { id: "AC-2", status: "fail", evidence: "Footer completed count stayed at 1 after Reopen.", screenshot: ".pi/qa/AC-2.png" },
      ],
      findings: [
        { severity: "high", file: "public/app.js", line: 15, text: "renderMetrics() is not called after reopening a task." },
        { severity: "low", file: "public/app.js", line: 999, text: "Line outside diff hunk should stay in body only." },
      ],
    });

    // Fix round gating: only when verdict == changes_needed AND pi-fix-round-1 is not present
    expect(shouldTriggerFixRound({ verdict: "pass", labels: [] })).toBe(false);
    expect(shouldTriggerFixRound({ verdict: "changes_needed", labels: [] })).toBe(true);
    expect(shouldTriggerFixRound({ verdict: "changes_needed", labels: ["needs-test-review"] })).toBe(true);
    expect(shouldTriggerFixRound({ verdict: "changes_needed", labels: [FIX_ROUND_LABEL] })).toBe(false);
    expect(shouldTriggerFixRound({ verdict: "changes_needed", labels: [{ name: FIX_ROUND_LABEL }] })).toBe(false);

    // Diff right-side line parser + GitHub review payload builder (always event: "COMMENT")
    const sampleDiff = [
      "diff --git a/public/app.js b/public/app.js",
      "index 1111111..2222222 100644",
      "--- a/public/app.js",
      "+++ b/public/app.js",
      "@@ -13,3 +13,5 @@ function handleClick() {",
      "   const x = 1;",
      "+  // added line 14",
      "+  // added line 15",
      "   return x;",
    ].join("\n");

    const diffLines = parseDiffRightSideLines(sampleDiff);
    expect(diffLines.get("public/app.js")?.has(15)).toBe(true);
    expect(diffLines.get("public/app.js")?.has(999)).toBe(false);

    const reviewPayload = buildGitHubReviewPayload(changesNeeded, {
      evidenceUrls: {
        "AC-1": "https://github.com/acme/repo/blob/agent-evidence/pr-9/run-1-AC-1.png?raw=true",
        "AC-2": "https://github.com/acme/repo/blob/agent-evidence/pr-9/run-1-AC-2.png?raw=true",
      },
      traceUrl: "https://cloud.langfuse.com/trace/verify-123",
      diffText: sampleDiff,
      willTriggerFix: true,
    });

    expect(reviewPayload.event).toBe("COMMENT");
    expect(reviewPayload.body).toContain("## ❌ Verifier Review: Changes Needed");
    expect(reviewPayload.body).toContain("1/2 acceptance criteria passed");
    expect(reviewPayload.body).toContain("pr-9/run-1-AC-2.png?raw=true");
    expect(reviewPayload.body).toContain("Automatic Fix Round");
    expect(reviewPayload.body).toContain("<!-- pi:verification");
    // Only line 15 is in the diff hunk; line 999 stays in the review body only
    expect(reviewPayload.comments).toEqual([
      {
        path: "public/app.js",
        line: 15,
        side: "RIGHT",
        body: "**[Verifier HIGH]** renderMetrics() is not called after reopening a task.",
      },
    ]);

    const failedPayload = buildFailedVerificationReviewPayload("Invalid JSON from model");
    expect(failedPayload.event).toBe("COMMENT");
    expect(failedPayload.comments).toEqual([]);
    expect(failedPayload.body).toContain("Verification Failed");

    // Extract verification from review comment and format fix_pr task prompt
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fix-prompt-test-"));
    const promptFile = path.join(tmpDir, "task-prompt.txt");
    fs.writeFileSync(promptFile, `# Pull request #9: Add Reopen button\n\n${reviewPayload.body}\n`, "utf8");
    fs.writeFileSync(path.join(tmpDir, "task-pr.json"), JSON.stringify({
      number: 9,
      reviews: [{ author: { login: "github-actions[bot]" }, body: reviewPayload.body }],
    }));
    const updatedPrompt = appendFixPrTaskPromptToFile(promptFile, "9");
    expect(updatedPrompt).toContain("## 🔧 Mandatory Verifier Fix Task (PR #9)");
    expect(updatedPrompt).toContain("- **AC-2** (`fail`): Footer completed count stayed at 1 after Reopen.");
    expect(updatedPrompt).toContain("renderMetrics() is not called after reopening a task.");
  });

  it("rejects verifier results that do not cover exactly the spec's acceptance criteria", () => {
    const criterion = (id: string) => ({ id, status: "pass", evidence: `checked ${id}` });
    const result = (...ids: string[]) =>
      validateVerificationResult({ verdict: "pass", criteria: ids.map(criterion), findings: [] });

    expect(assertCriteriaCoverage(result("AC-1", "AC-2"), ["AC-1", "AC-2"]).verdict).toBe("pass");
    // A pass that only reports an unrelated criterion must not count
    expect(() => assertCriteriaCoverage(result("AC-9"), ["AC-1", "AC-2"])).toThrow(/missing AC-1, AC-2; unknown AC-9/);
    expect(() => assertCriteriaCoverage(result("AC-1"), ["AC-1", "AC-2"])).toThrow(/missing AC-2/);
    // Schema validation already rejects duplicates; the coverage check catches them on its own too
    const duplicated = { verdict: "pass", criteria: ["AC-1", "AC-1", "AC-2"].map(criterion), findings: [] };
    expect(() => assertCriteriaCoverage(duplicated, ["AC-1", "AC-2"])).toThrow(/duplicate AC-1/);
  });

  it("extracts verification spec from refined-spec marker or falls back to issue Acceptance Criteria section", () => {
    const refinedComment = renderRefinementComment({
      status: "ready",
      questions: [],
      spec: {
        goal: "Refined goal",
        acceptanceCriteria: [{ id: "AC-1", text: "Criterion from marker" }],
        outOfScope: ["Out of scope item"],
        affectedAreas: ["public/index.html"],
      },
    });

    const fromMarker = extractSpecForVerification({
      issueJson: {
        title: "Raw issue title",
        body: "Raw body",
        comments: [{ author: { login: "github-actions[bot]" }, body: refinedComment }],
      },
    });
    expect(fromMarker.source).toBe("refined-spec");
    expect(fromMarker.goal).toBe("Refined goal");
    expect(fromMarker.acceptanceCriteria).toEqual([{ id: "AC-1", text: "Criterion from marker" }]);

    const fromFallback = extractSpecForVerification({
      issueJson: {
        title: "Fallback issue title",
        body: "### Goal\nDo fallback.\n\n### Acceptance Criteria\n- [ ] First fallback check\n- Second fallback check\n\n### Out of scope\n- Nothing",
        comments: [],
      },
    });
    expect(fromFallback.source).toBe("fallback-issue-body");
    expect(fromFallback.acceptanceCriteria).toEqual([
      { id: "AC-1", text: "First fallback check" },
      { id: "AC-2", text: "Second fallback check" },
    ]);
  });

  it("attaches ac_pass_rate and verifier_verdict scores to the verifier Langfuse trace", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-verifier-langfuse-test-"));
    const sessionDir = path.join(tmpDir, "sessions");
    const artifactsDir = path.join(tmpDir, "artifacts");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(artifactsDir, { recursive: true });

    fs.writeFileSync(
      path.join(sessionDir, "verifier.jsonl"),
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "verifier-trace-001",
          timestamp: "2026-10-20T12:00:00.000Z",
          cwd: "/workspace",
        }),
        JSON.stringify({
          type: "message",
          id: "v-msg-1",
          timestamp: "2026-10-20T12:00:01.000Z",
          message: {
            role: "assistant",
            provider: "endpoint-responses",
            api: "openai-responses",
            model: "gpt-6.1-sol",
            content: [{ type: "text", text: '{"verdict":"changes_needed"}' }],
            usage: { input: 500, output: 100, cacheRead: 0, totalTokens: 600, cost: { total: 0.002 } },
            stopReason: "stop",
          },
        }),
      ].join("\n") + "\n",
      "utf8"
    );

    const verification = {
      verdict: "changes_needed",
      criteria: [
        { id: "AC-1", status: "pass", evidence: "OK", screenshot: ".pi/qa/AC-1.png" },
        { id: "AC-2", status: "fail", evidence: "Failed", screenshot: ".pi/qa/AC-2.png" },
      ],
      findings: [],
    };
    fs.writeFileSync(path.join(artifactsDir, "verification.json"), JSON.stringify(verification), "utf8");

    const scoreEvents = buildVerificationScoreEvents("verifier-trace-001", verification);
    expect(scoreEvents).toHaveLength(2);
    expect(scoreEvents[0].body).toMatchObject({
      traceId: "verifier-trace-001",
      name: "ac_pass_rate",
      value: 0.5,
      dataType: "NUMERIC",
    });
    expect(scoreEvents[1].body).toMatchObject({
      traceId: "verifier-trace-001",
      name: "verifier_verdict",
      value: "changes_needed",
      dataType: "CATEGORICAL",
    });

    const summary = await pushTraceToLangfuse({
      sessionDir,
      artifactsDir,
      dryRun: true,
      env: {
        ISSUE_NUM: "31",
        LANGFUSE_TAG: "verifier",
        GITHUB_REPOSITORY: "acme/repo2ship",
      },
    });
    // 1 trace-create + 1 generation-create + 2 score-create = 4 events
    expect(summary.eventCount).toBe(4);
  });

  it("publishes evidence screenshots with and without suffix via publish-evidence.sh and prepareVerificationPublish", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-evidence-suffix-test-"));
    const bareRemote = path.join(tmpRoot, "remote.git");
    const workRepo = path.join(tmpRoot, "work");
    execSync(`git init --bare "${bareRemote}"`, { stdio: "ignore" });
    execSync(`git init -b main "${workRepo}"`, { stdio: "ignore" });
    execSync('git config user.name "Test"', { cwd: workRepo, stdio: "ignore" });
    execSync('git config user.email "test@example.com"', { cwd: workRepo, stdio: "ignore" });
    execSync(`git remote add origin "${bareRemote}"`, { cwd: workRepo, stdio: "ignore" });

    const scriptPath = path.resolve(process.cwd(), "scripts/agent/publish-evidence.sh");
    const qaDir = path.join(workRepo, ".pi/qa");
    const artifactsDir = path.join(workRepo, ".pi/artifacts");
    fs.mkdirSync(qaDir, { recursive: true });
    fs.mkdirSync(artifactsDir, { recursive: true });

    const mainShot = path.join(workRepo, "ui-verify.png");
    const ac1Shot = path.join(qaDir, "AC-1.png");
    const ac2Shot = path.join(qaDir, "AC-2.png");
    fs.writeFileSync(mainShot, "PNG-MAIN", "utf8");
    fs.writeFileSync(ac1Shot, "PNG-AC-1", "utf8");
    fs.writeFileSync(ac2Shot, "PNG-AC-2", "utf8");

    // 1. Without suffix: pr-<N>/run-<id>.png
    const outNoSuffix = execSync(`bash "${scriptPath}" "${mainShot}" 12 999`, {
      cwd: workRepo,
      encoding: "utf8",
    }).trim();
    expect(outNoSuffix).toBe("pr-12/run-999.png");

    // 2. With suffix via prepareVerificationPublish: pr-<N>/run-<id>-AC-1.png and AC-2.png
    fs.writeFileSync(
      path.join(artifactsDir, "verification.json"),
      JSON.stringify({
        verdict: "changes_needed",
        criteria: [
          { id: "AC-1", status: "pass", evidence: "AC-1 passed", screenshot: ".pi/qa/AC-1.png" },
          { id: "AC-2", status: "fail", evidence: "AC-2 failed", screenshot: ".pi/qa/AC-2.png" },
        ],
        findings: [],
      }),
      "utf8"
    );

    const payloadOut = path.join(tmpRoot, "review.json");
    const fallbackOut = path.join(tmpRoot, "review-fallback.json");
    const pubResult = prepareVerificationPublish({
      rootDir: workRepo,
      prNumber: "12",
      runId: "999",
      repository: "acme/repo2ship",
      serverUrl: "https://github.com",
      prLabels: [],
      reviewPayloadOut: payloadOut,
      reviewFallbackOut: fallbackOut,
      publishEvidenceFn: (pngPath: string, prNum: string, runId: string, suffix: string) =>
        execSync(`bash "${scriptPath}" "${pngPath}" "${prNum}" "${runId}" "${suffix}"`, {
          cwd: workRepo,
          encoding: "utf8",
        }).trim(),
    });

    expect(pubResult.willTriggerFix).toBe(true);
    expect(pubResult.evidenceUrls).toEqual({
      "AC-1": "https://github.com/acme/repo2ship/blob/agent-evidence/pr-12/run-999-AC-1.png?raw=true",
      "AC-2": "https://github.com/acme/repo2ship/blob/agent-evidence/pr-12/run-999-AC-2.png?raw=true",
    });

    // Verify all 3 files coexist on the orphan agent-evidence branch without overwriting each other
    const treeFiles = execSync("git ls-tree -r --name-only origin/agent-evidence", {
      cwd: workRepo,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .sort();
    expect(treeFiles).toEqual([
      "pr-12/run-999-AC-1.png",
      "pr-12/run-999-AC-2.png",
      "pr-12/run-999.png",
    ]);
  });

  it("starts the app under verification without any credentials in its environment", () => {
    const env = {
      PATH: "/usr/bin",
      HOME: "/home/runner",
      MODEL_API_KEY: "secret",
      MODEL_BASE_URL: "https://models.example/v1",
      MODEL_COMPAT: "{}",
      AWS_ACCESS_KEY_ID: "test-access-key",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "secret",
      AWS_BEARER_TOKEN_BEDROCK: "secret",
      AWS_REGION: "us-east-1",
      AWS_PROFILE: "test-profile",
      AWS_CONFIG_FILE: "/tmp/aws/config",
      AWS_SHARED_CREDENTIALS_FILE: "/tmp/aws/credentials",
      OPENCODE_API_KEY: "secret",
      AZURE_OPENAI_API_KEY: "secret",
      AZURE_OPENAI_BASE_URL: "https://x",
      OPENAI_API_KEY: "secret",
      OPENAI_BASE_URL: "https://y",
      LANGFUSE_SECRET_KEY: "secret",
      GH_TOKEN: "secret",
      GITHUB_TOKEN: "secret",
      ACTIONS_RUNTIME_TOKEN: "secret",
      GITHUB_REPOSITORY: "acme/repo",
    };
    expect(withoutSecrets(env)).toEqual({ PATH: "/usr/bin", HOME: "/home/runner", GITHUB_REPOSITORY: "acme/repo" });
  });
});
