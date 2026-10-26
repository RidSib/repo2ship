#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

// SemVer 2.0.0, including prerelease identifiers and build metadata.
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function prepareRelease({ tag, packageManifest, lockfile, changelog }) {
  const match = typeof tag === "string" ? RELEASE_TAG.exec(tag) : null;
  if (!match) throw new Error("Release tag must be v followed by a valid SemVer version (for example v0.1.0).");
  const version = tag.slice(1);
  if (packageManifest.version !== version) {
    throw new Error(`Tag ${tag} does not match package.json version ${packageManifest.version}.`);
  }
  if (lockfile.version !== version || lockfile.packages?.[""]?.version !== version) {
    throw new Error("Both root versions in package-lock.json must match the release tag.");
  }

  const lines = changelog.split(/\r?\n/);
  const heading = `## [${version}] - `;
  const matches = lines.flatMap((line, index) => line.startsWith(heading) ? [index] : []);
  if (matches.length !== 1) throw new Error(`CHANGELOG.md must contain exactly one dated section for ${version}.`);
  const start = matches[0];
  const date = lines[start].slice(heading.length);
  const timestamp = Date.parse(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) {
    throw new Error("The changelog release date must be a valid YYYY-MM-DD date.");
  }
  const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  const notes = lines.slice(start + 1, next === -1 ? undefined : next).join("\n").trim();
  if (!notes) throw new Error(`CHANGELOG.md has no release notes for ${version}.`);
  return { version, notes, prerelease: match[1] === "0" || Boolean(match[4]) };
}

export function main() {
  const { values } = parseArgs({
    options: { tag: { type: "string" }, "notes-file": { type: "string" } },
  });
  const packageManifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const release = prepareRelease({
    tag: values.tag ?? `v${packageManifest.version}`,
    packageManifest,
    lockfile: JSON.parse(fs.readFileSync("package-lock.json", "utf8")),
    changelog: fs.readFileSync("CHANGELOG.md", "utf8"),
  });
  if (values["notes-file"]) {
    fs.mkdirSync(path.dirname(values["notes-file"]), { recursive: true });
    fs.writeFileSync(values["notes-file"], `${release.notes}\n`, "utf8");
  }
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${release.version}\nprerelease=${release.prerelease}\n`);
  }
  console.log(`Release metadata valid: v${release.version} (${release.prerelease ? "prerelease" : "stable"}).`);
  return release;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`[release] ${error.message}`);
    process.exitCode = 1;
  }
}
