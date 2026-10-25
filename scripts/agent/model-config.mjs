#!/usr/bin/env node
/**
 * Model configuration (`model-config.mjs`)
 *
 * Resolves the two model roles (implementer and strategist) and writes pi's
 * `.pi/agent/models.json`, so brand-new models work on day one even before pi's built-in
 * catalog knows them. Every role talks to one provider, chosen with MODEL_PROVIDER:
 *
 *   - "openai-compatible" (default) MODEL_BASE_URL + MODEL_API_KEY: OpenAI, OpenRouter, a LiteLLM
 *                                    proxy, a local server, or Azure OpenAI's /openai/v1 endpoint
 *   - "azure"                        preset for Azure OpenAI / Foundry resources: also accepts a bare
 *                                    resource URL and sends Azure's `api-key` header
 *   - "bedrock"                      Amazon Bedrock through the engine's native provider, using the
 *                                    standard AWS credential chain and AWS_REGION
 *
 * Older setups keep working: OPENAI_* and AZURE_OPENAI_* variables are read as fallbacks, and
 * an Azure endpoint URL selects the Azure preset automatically when MODEL_PROVIDER is unset.
 */

import fs from "node:fs";
import path from "node:path";

export const MODEL_PROVIDERS = {
  "openai-compatible": {
    label: "OpenAI-compatible",
    keyEnvs: ["MODEL_API_KEY", "OPENAI_API_KEY"],
    baseUrlEnvs: ["MODEL_BASE_URL", "OPENAI_BASE_URL"],
  },
  azure: {
    label: "Azure OpenAI",
    keyEnvs: ["MODEL_API_KEY", "AZURE_OPENAI_API_KEY"],
    baseUrlEnvs: ["MODEL_BASE_URL", "AZURE_OPENAI_BASE_URL"],
    keyHeader: "api-key",
  },
  bedrock: {
    label: "Amazon Bedrock",
    // Uses the engine's built-in provider with AWS credentials instead of a base URL and key
    native: "amazon-bedrock",
  },
};

const PROVIDER_ALIASES = { openai: "openai-compatible" };

const AZURE_HOST = /\.(openai\.azure\.com|services\.ai\.azure\.com|cognitiveservices\.azure\.com)$/i;

function firstSet(env, names) {
  return names.find((name) => env[name] && String(env[name]).trim());
}

export function resolveModelProvider(env = process.env) {
  const raw = (env.MODEL_PROVIDER || "").trim().toLowerCase();
  if (!raw) {
    // No explicit choice: an Azure endpoint (new or legacy variable) selects the Azure preset
    const url = env[firstSet(env, ["MODEL_BASE_URL", "OPENAI_BASE_URL", "AZURE_OPENAI_BASE_URL"]) || ""] || "";
    let azureHost = false;
    try {
      azureHost = AZURE_HOST.test(new URL(url.trim()).hostname);
    } catch {
      // A legacy Azure-specific setting still selects the preset for custom endpoints.
    }
    return azureHost || (!firstSet(env, ["MODEL_BASE_URL", "OPENAI_BASE_URL"]) && (env.AZURE_OPENAI_BASE_URL || env.AZURE_OPENAI_RESOURCE_NAME))
      ? "azure"
      : "openai-compatible";
  }
  const name = PROVIDER_ALIASES[raw] || raw;
  if (!MODEL_PROVIDERS[name]) {
    throw new Error(`Unsupported MODEL_PROVIDER "${env.MODEL_PROVIDER}" (use "openai-compatible", "azure" or "bedrock")`);
  }
  return name;
}

/** Name of the environment variable holding the API key (pi and opencode read the key from it). */
export function apiKeyEnvFor(provider, env = process.env) {
  const { keyEnvs } = MODEL_PROVIDERS[provider];
  if (!keyEnvs) return null;
  return firstSet(env, keyEnvs) || keyEnvs[0];
}

/** Endpoint credentials must be present; native providers resolve their own credential chain. */
export function hasModelApiKey(env = process.env) {
  const provider = resolveModelProvider(env);
  if (MODEL_PROVIDERS[provider].native) return true;
  return Boolean(env[apiKeyEnvFor(provider, env)]);
}

export function normalizeBaseUrl(rawUrl) {
  if (!rawUrl || !rawUrl.trim()) {
    return "https://api.openai.com/v1";
  }
  return rawUrl.trim().replace(/\/+$/, "");
}

export function normalizeAzureV1BaseUrl(rawUrl, env = process.env) {
  if (!rawUrl || !rawUrl.trim()) {
    const resource = env.AZURE_OPENAI_RESOURCE_NAME?.trim();
    if (resource) {
      return `https://${resource}.openai.azure.com/openai/v1`;
    }
    return "https://your-resource.openai.azure.com/openai/v1";
  }
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/openai/v1")) {
    return trimmed;
  }
  if (trimmed.endsWith("/openai")) {
    return `${trimmed}/v1`;
  }
  return `${trimmed}/openai/v1`;
}

/** Endpoint URL for the configured provider; null for native providers such as Bedrock. */
export function baseUrlFor(provider, env = process.env) {
  const { baseUrlEnvs, native } = MODEL_PROVIDERS[provider];
  if (native) return null;
  const raw = env[firstSet(env, baseUrlEnvs) || ""];
  return provider === "azure" ? normalizeAzureV1BaseUrl(raw, env) : normalizeBaseUrl(raw);
}

export function modelCompatJson(env = process.env) {
  return env.MODEL_COMPAT || env.AZURE_MODEL_COMPAT || "";
}

// Compat settings for DeepSeek models served over Chat Completions. Some hosts (e.g. Azure AI
// Foundry) reject DeepSeek's native `thinking` argument, so by default no reasoning parameters are
// sent and the host's default reasoning applies. Opt into `reasoning_effort` with
// MODEL_COMPAT='{"supportsReasoningEffort":true}'.
const DEEPSEEK_COMPLETIONS_PRESET = {
  // V4.1-Flash is natively multimodal (pi's catalog still lists the text-only V4-Flash);
  // image input lets the agent inspect its Playwright screenshot.
  input: ["text", "image"],
  contextWindow: 1000000,
  maxTokens: 65536,
  compat: {
    requiresReasoningContentOnAssistantMessages: true,
    thinkingFormat: "openai",
    supportsReasoningEffort: false,
    supportsDeveloperRole: false,
    supportsStore: false,
  },
};

/**
 * Wire format per role (IMPLEMENTER_API / STRATEGIST_API):
 *   - "responses"   (default) the Responses API, for OpenAI models
 *   - "completions" Chat Completions, for most other models (DeepSeek, GLM, Qwen, ...)
 * Not used for native providers such as Bedrock.
 */
export function resolveApi(value) {
  const normalized = (value || "responses").trim().toLowerCase();
  if (normalized === "responses" || normalized === "openai-responses") return "openai-responses";
  if (normalized === "completions" || normalized === "openai-completions") return "openai-completions";
  throw new Error(`Unsupported model API "${value}" (use "responses" or "completions")`);
}

/**
 * Chat Completions settings for one model. Models whose name contains "deepseek" get the
 * DeepSeek preset; MODEL_COMPAT (JSON) overrides the compat fields for hosts that need others.
 */
export function completionsSettingsFor(modelId, compatOverrideJson = modelCompatJson()) {
  const preset = /deepseek/i.test(modelId) ? DEEPSEEK_COMPLETIONS_PRESET : { compat: {} };
  const override = compatOverrideJson ? JSON.parse(compatOverrideJson) : {};
  return { ...preset, compat: { ...preset.compat, ...override } };
}

// List prices in USD per 1M tokens for models this template was tuned on, keyed by lowercase
// model name. Hosts can price differently; MODEL_COST_* can override these estimates.
// GPT-6.1 Sol long-context requests are billed higher (4 / 0.20 / 5 / 15) and are not modeled.
export const KNOWN_MODEL_PRICES = {
  "gpt-6.1-sol": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "deepseek-v4.1-flash": { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
};

/** Generic prices override estimates; legacy prices remain fallbacks for unknown models. */
export function priceFor(modelId, env = process.env) {
  const known = KNOWN_MODEL_PRICES[modelId.toLowerCase()];
  const cost = (name, fallback) => {
    const value = Number(env[`MODEL_COST_${name}_PER_1M`] || (!known && env[`AZURE_COST_${name}_PER_1M`]) || fallback);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid model cost for ${name}: expected a non-negative number`);
    }
    return value;
  };
  return {
    input: cost("INPUT", known?.input ?? 2.5),
    output: cost("OUTPUT", known?.output ?? 10.0),
    cacheRead: cost("CACHE_READ", known?.cacheRead ?? 0.625),
    cacheWrite: cost("CACHE_WRITE", known?.cacheWrite ?? 0),
  };
}

/** Provider ID as pi and opencode see it. */
export function providerFor(api, modelProvider = "openai-compatible") {
  const { native } = MODEL_PROVIDERS[modelProvider];
  if (native) return native;
  return api === "openai-completions" ? "endpoint-completions" : "endpoint-responses";
}

/**
 * Resolves the implementer and strategist roles. Legacy fallbacks: AZURE_OPENAI_MODEL /
 * AZURE_OPENAI_API for the implementer, AZURE_CRITIC_MODEL for the strategist. A missing model
 * stays empty here and is reported when a stage actually runs.
 */
export function resolveRoles(env = process.env) {
  const modelProvider = resolveModelProvider(env);
  const implementerModel = (env.IMPLEMENTER_MODEL || env.AZURE_OPENAI_MODEL || "").trim();
  const native = MODEL_PROVIDERS[modelProvider].native;
  const implementerApi = native ? null : resolveApi(env.IMPLEMENTER_API || env.AZURE_OPENAI_API);
  const implementer = {
    provider: providerFor(implementerApi, modelProvider),
    model: implementerModel,
  };

  const strategistModel = (env.STRATEGIST_MODEL || env.AZURE_CRITIC_MODEL || implementerModel).trim();
  const strategistApi = native ? null : env.STRATEGIST_API ? resolveApi(env.STRATEGIST_API) : implementerApi;
  const strategist = {
    provider: providerFor(strategistApi, modelProvider),
    model: strategistModel,
  };

  return { implementer, strategist };
}

function buildResponsesModelDef(id, env, label) {
  return {
    id,
    name: `${id} (${label} Responses)`,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 256000,
    maxTokens: 32768,
    // Cost in USD per 1M tokens, used by pi and the Langfuse export
    cost: priceFor(id, env),
  };
}

function buildCompletionsModelDef(id, env, label) {
  return {
    ...buildResponsesModelDef(id, env, label),
    name: `${id} (${label} Chat Completions)`,
    ...completionsSettingsFor(id, modelCompatJson(env)),
  };
}

export function setupModels({
  agentDir = process.env.PI_CODING_AGENT_DIR || path.resolve(process.cwd(), ".pi/agent"),
  env = process.env,
} = {}) {
  const modelProvider = resolveModelProvider(env);
  const { label, keyHeader, native } = MODEL_PROVIDERS[modelProvider];
  const normalizedBaseUrl = baseUrlFor(modelProvider, env);
  fs.mkdirSync(agentDir, { recursive: true });

  const roles = resolveRoles(env);
  const modelsConfig = { providers: {} };

  // Native providers (Bedrock) come from pi's built-in catalog; only endpoints need entries here
  if (!native) {
    const apiKeyEnv = apiKeyEnvFor(modelProvider, env);
    // pi resolves `$NAME` from the environment; a bare name would be sent as the key itself
    const auth = { apiKey: `$${apiKeyEnv}`, ...(keyHeader ? { headers: { [keyHeader]: `$${apiKeyEnv}` } } : {}) };
    const modelIds = { "endpoint-responses": [], "endpoint-completions": [] };
    for (const role of [roles.implementer, roles.strategist]) {
      if (role.model && !modelIds[role.provider].includes(role.model)) {
        modelIds[role.provider].push(role.model);
      }
    }
    modelsConfig.providers["endpoint-responses"] = {
      baseUrl: normalizedBaseUrl,
      api: "openai-responses",
      ...auth,
      models: modelIds["endpoint-responses"].map((id) => buildResponsesModelDef(id, env, label)),
    };
    modelsConfig.providers["endpoint-completions"] = {
      baseUrl: normalizedBaseUrl,
      api: "openai-completions",
      ...auth,
      models: modelIds["endpoint-completions"].map((id) => buildCompletionsModelDef(id, env, label)),
    };
  }

  const modelsJsonPath = path.join(agentDir, "models.json");
  fs.writeFileSync(modelsJsonPath, JSON.stringify(modelsConfig, null, 2) + "\n", "utf8");

  return {
    modelsJsonPath,
    modelProvider,
    normalizedBaseUrl,
    roles,
    primaryModel: roles.implementer.model,
    criticModel: roles.strategist.model,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = setupModels();
  console.log(`[model-config] Wrote ${result.modelsJsonPath}`);
  console.log(`[model-config] Provider: ${result.modelProvider}${result.normalizedBaseUrl ? ` (${result.normalizedBaseUrl})` : ""}`);
  console.log(
    `[model-config] Implementer: ${result.roles.implementer.provider}/${result.roles.implementer.model || "(unset)"} | Strategist: ${result.roles.strategist.provider}/${result.roles.strategist.model || "(unset)"}`
  );
}
