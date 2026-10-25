#!/usr/bin/env node
/**
 * Pipeline Configuration Loader (`pipeline-config.mjs`)
 *
 * Loads and strictly validates `.pi/pipeline.json` so project-specific commands,
 * UI paths, dev server settings, and protected paths are not hard-coded across scripts.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_PIPELINE_CONFIG = Object.freeze({
  verify: "npm run verify",
  verifyFull: "npm run verify:full",
  uiPaths: Object.freeze(["public/", "tests/e2e/"]),
  start: "npm run dev",
  url: "http://127.0.0.1:4173",
  readyTimeoutSeconds: 30,
  protectedPaths: Object.freeze(["tsconfig.json", "vitest.config.ts", "playwright.config.ts"]),
  screenshotPath: ".pi/artifacts/ui-verify.png",
});

const STRING_KEYS = new Set(["verify", "verifyFull", "start", "url", "screenshotPath"]);
const STRING_ARRAY_KEYS = new Set(["uiPaths", "protectedPaths"]);
const NUMBER_KEYS = new Set(["readyTimeoutSeconds"]);
const ALLOWED_KEYS = new Set([...STRING_KEYS, ...STRING_ARRAY_KEYS, ...NUMBER_KEYS]);

export function validatePipelineConfig(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid pipeline config: expected a JSON object.");
  }

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`Invalid pipeline config: unknown key "${key}".`);
    }
  }

  for (const key of STRING_KEYS) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== "string" || raw[key].trim().length === 0) {
        throw new Error(`Invalid pipeline config: "${key}" must be a non-empty string.`);
      }
    }
  }

  for (const key of STRING_ARRAY_KEYS) {
    if (raw[key] !== undefined) {
      if (
        !Array.isArray(raw[key]) ||
        raw[key].some((item) => typeof item !== "string" || item.trim().length === 0)
      ) {
        throw new Error(`Invalid pipeline config: "${key}" must be an array of non-empty strings.`);
      }
    }
  }

  for (const key of NUMBER_KEYS) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== "number" || !Number.isFinite(raw[key]) || raw[key] <= 0) {
        throw new Error(`Invalid pipeline config: "${key}" must be a positive number.`);
      }
    }
  }

  return {
    verify: raw.verify ?? DEFAULT_PIPELINE_CONFIG.verify,
    verifyFull: raw.verifyFull ?? DEFAULT_PIPELINE_CONFIG.verifyFull,
    uiPaths: raw.uiPaths ? [...raw.uiPaths] : [...DEFAULT_PIPELINE_CONFIG.uiPaths],
    start: raw.start ?? DEFAULT_PIPELINE_CONFIG.start,
    url: raw.url ?? DEFAULT_PIPELINE_CONFIG.url,
    readyTimeoutSeconds: raw.readyTimeoutSeconds ?? DEFAULT_PIPELINE_CONFIG.readyTimeoutSeconds,
    protectedPaths: raw.protectedPaths ? [...raw.protectedPaths] : [...DEFAULT_PIPELINE_CONFIG.protectedPaths],
    screenshotPath: raw.screenshotPath ?? DEFAULT_PIPELINE_CONFIG.screenshotPath,
  };
}

export function loadPipelineConfig(configPath = path.resolve(process.cwd(), ".pi/pipeline.json")) {
  const resolvedPath =
    fs.existsSync(configPath) && fs.statSync(configPath).isDirectory()
      ? path.join(configPath, ".pi/pipeline.json")
      : configPath;
  if (!fs.existsSync(resolvedPath)) {
    return validatePipelineConfig({});
  }
  const text = fs.readFileSync(resolvedPath, "utf8");
  const parsed = JSON.parse(text);
  return validatePipelineConfig(parsed);
}

/**
 * Reads `.pi/pipeline.json` from a git ref (e.g. `origin/main`) rather than the working tree,
 * so an untrusted patch cannot weaken `protectedPaths` in the same run.
 */
export function loadPipelineConfigFromRef(baseRef = "origin/main", cwd = process.cwd()) {
  try {
    const text = execSync(`git show ${baseRef}:.pi/pipeline.json`, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return validatePipelineConfig(JSON.parse(text));
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Invalid pipeline config")) {
      throw err;
    }
    return validatePipelineConfig({});
  }
}
