#!/usr/bin/env node
/**
 * Deterministic Publish-Job Patch Policy Gate (`validate-patch-policy.mjs`)
 *
 * Runs ONLY in the isolated `publish` job (where no LLM or agent code executes)
 * after applying the agent's patch onto the target branch.
 *
 * Enforces the 6-Row Security & Review Matrix against `origin/main` (new files included):
 *   1. `.github/`, `scripts/agent/`, `AGENTS.md`, `CLAUDE.md`, opencode config -> Hard Reject
 *   2. `tsconfig.json`, `vitest.config.ts`, `playwright.config.ts` -> Hard Reject
 *   3. `package.json` -> Allow ONLY if `.scripts` is 100% identical to base; Hard Reject otherwise
 *   4. `package-lock.json` / `package.json` -> Allow, add label `needs-dependency-review`, block auto-merge
 *   5. `tests/` -> Allow additions/edits; Hard Reject deleted test files or added `.skip`/`.only`;
 *                  add label `needs-test-review`, block auto-merge
 *   6. `src/`, `public/` -> Allow
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PIPELINE_CONFIG, loadPipelineConfigFromRef } from "./pipeline-config.mjs";

const HARD_PROTECTED_PREFIXES = [
  ".github/",
  "scripts/agent/",
  // opencode agents, plugins and tools; never loaded at runtime either (see harness.mjs)
  ".opencode/",
];

const BUILTIN_HARD_PROTECTED_EXACT = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  ".pi/pipeline.json",
  "opencode.json",
  "opencode.jsonc",
  ".npmrc",
]);

export function hasTestBypass(line) {
  return /\b(test|it|describe)\s*(?:\.\s*(skip|only|fixme|todo|skipIf|runIf)\b|\[\s*["'](skip|only|fixme|todo|skipIf|runIf)["']\s*\])/.test(line);
}

function canonicalizeScripts(pkgJsonText) {
  const parsed = JSON.parse(pkgJsonText);
  const scripts = parsed && typeof parsed.scripts === "object" && parsed.scripts !== null ? parsed.scripts : {};
  const sortedEntries = Object.keys(scripts)
    .sort()
    .map((k) => [k, scripts[k]]);
  return JSON.stringify(Object.fromEntries(sortedEntries));
}

/**
 * @param {{
 *   changedFiles?: string[],
 *   deletedFiles?: string[],
 *   basePackageJsonText?: string | null,
 *   headPackageJsonText?: string | null,
 *   testsDiffText?: string,
 *   protectedPaths?: readonly string[],
 * }} [options]
 */
export function evaluatePatchPolicy({
  changedFiles = [],
  deletedFiles = [],
  basePackageJsonText = null,
  headPackageJsonText = null,
  testsDiffText = "",
  protectedPaths = DEFAULT_PIPELINE_CONFIG.protectedPaths,
} = {}) {
  const violations = [];
  const labels = new Set();

  const hardProtectedExact = new Set(BUILTIN_HARD_PROTECTED_EXACT);
  const hardProtectedPrefixes = [...HARD_PROTECTED_PREFIXES];
  for (const entry of protectedPaths) {
    const clean = entry.replace(/^\/+/, "");
    if (clean.endsWith("/")) {
      hardProtectedPrefixes.push(clean);
    } else if (clean) {
      hardProtectedExact.add(clean);
    }
  }

  for (const file of changedFiles) {
    const normalized = file.replace(/^\/+/, "");

    if (
      hardProtectedExact.has(normalized) ||
      normalized.endsWith("/.npmrc") ||
      hardProtectedPrefixes.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix))
    ) {
      violations.push(`Forbidden modification to protected path: ${normalized}`);
    }

    if (normalized === "package.json") {
      labels.add("needs-dependency-review");
      if (basePackageJsonText !== null && headPackageJsonText !== null) {
        try {
          const baseScripts = canonicalizeScripts(basePackageJsonText);
          const headScripts = canonicalizeScripts(headPackageJsonText);
          if (baseScripts !== headScripts) {
            violations.push(
              "Forbidden modification to `package.json` scripts section (CI commands and lifecycle hooks are locked)."
            );
          }
        } catch (err) {
          violations.push(`Failed to parse package.json for scripts comparison: ${err.message}`);
        }
      }
    }

    if (normalized === "package-lock.json") {
      labels.add("needs-dependency-review");
    }

    if (normalized.startsWith("tests/")) {
      labels.add("needs-test-review");
    }

    if (normalized.startsWith("scripts/")) {
      labels.add("needs-runtime-review");
    }
  }

  for (const deleted of deletedFiles) {
    const normalized = deleted.replace(/^\/+/, "");
    if (normalized.startsWith("tests/")) {
      violations.push(`Forbidden deletion of existing test file: ${normalized}`);
    }
  }

  if (testsDiffText) {
    const addedTestLines = testsDiffText
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"));

    for (const line of addedTestLines) {
      if (hasTestBypass(line)) {
        violations.push(`Forbidden test bypass (.skip/.only or equivalent) added in tests/: ${line.slice(1).trim()}`);
        break;
      }
    }
  }

  const allowed = violations.length === 0;
  const eligibleForAutoMerge =
    allowed &&
    labels.size === 0 &&
    changedFiles.length > 0;

  return {
    allowed,
    eligibleForAutoMerge,
    labels: Array.from(labels),
    violations,
  };
}

function listPaths(command, cwd) {
  return execSync(command, { cwd, encoding: "utf8" }).split("\0").filter(Boolean);
}

export function runGitPatchPolicyCheck({
  baseRef = process.env.BASE_REF || "origin/main",
  cwd = process.cwd(),
} = {}) {
  // Always read pipeline config from baseRef (never from the patched working tree),
  // so a patch cannot loosen protectedPaths in the same run.
  const baseConfig = loadPipelineConfigFromRef(baseRef, cwd);

  // Stage untracked files with intent-to-add so git diff against baseRef sees brand-new files.
  // --no-renames everywhere: a rename must show up as delete + add, otherwise moving a
  // test or protected file elsewhere would hide the deletion from the checks below.
  execSync("git add -N .", { cwd, stdio: "ignore" });

  // -z: NUL-separated raw paths. Without it git quotes and escapes names with tabs or non-ASCII
  // characters ("scripts/agent/h\303\251lper.mjs"), which would no longer match protected prefixes.
  const changedFiles = listPaths(`git diff --no-renames --name-only -z ${baseRef}`, cwd);
  const deletedFiles = listPaths(`git diff --no-renames --diff-filter=D --name-only -z ${baseRef}`, cwd);

  let basePackageJsonText = null;
  let headPackageJsonText = null;
  if (changedFiles.includes("package.json")) {
    try {
      basePackageJsonText = execSync(`git show ${baseRef}:package.json`, { cwd, encoding: "utf8" });
    } catch {
      basePackageJsonText = "{}";
    }
    const pkgPath = path.resolve(cwd, "package.json");
    headPackageJsonText = fs.existsSync(pkgPath) ? fs.readFileSync(pkgPath, "utf8") : "{}";
  }

  let testsDiffText = "";
  if (changedFiles.some((f) => f.startsWith("tests/"))) {
    testsDiffText = execSync(`git diff --no-renames ${baseRef} -- tests/`, {
      cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  }

  return evaluatePatchPolicy({
    changedFiles,
    deletedFiles,
    basePackageJsonText,
    headPackageJsonText,
    testsDiffText,
    protectedPaths: baseConfig.protectedPaths,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = runGitPatchPolicyCheck();
  // In the publish job POLICY_OUTPUT points outside .pi/, which holds the untrusted agent artifact
  const outputPath = process.env.POLICY_OUTPUT || path.resolve(process.cwd(), ".pi/artifacts/policy-check.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n", "utf8");

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `policy_allowed=${result.allowed}`,
        `eligible_for_auto_merge=${result.eligibleForAutoMerge}`,
        `review_labels=${result.labels.join(",")}`,
      ].join("\n") + "\n"
    );
  }

  console.log(`[patch-policy] Allowed: ${result.allowed}`);
  console.log(`[patch-policy] Auto-Merge Eligible: ${result.eligibleForAutoMerge}`);
  if (result.labels.length > 0) {
    console.log(`[patch-policy] Required Review Labels: ${result.labels.join(", ")}`);
  }
  if (!result.allowed) {
    console.error("[patch-policy] Policy violations detected:");
    for (const v of result.violations) {
      console.error(`  - ${v}`);
    }
    process.exit(1);
  }
}
