import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { prepareRelease } from "../../.github/scripts/release.mjs";

function fixture(version = "0.1.0") {
  return {
    tag: `v${version}`,
    packageManifest: { version },
    lockfile: { version, packages: { "": { version } } },
    changelog: `# Changelog\n\n## [Unreleased]\n\n- Future change.\n\n## [${version}] - 2026-10-26\n\n### Added\n\n- Initial release.\n\n## [0.0.1] - 2026-10-01\n\n- Older change.\n`,
  };
}

describe("Release publication gates", () => {
  it("extracts only the selected release and marks early versions as prereleases", () => {
    expect(prepareRelease(fixture())).toEqual({
      version: "0.1.0",
      notes: "### Added\n\n- Initial release.",
      prerelease: true,
    });
    expect(prepareRelease(fixture("1.0.0")).prerelease).toBe(false);
    expect(prepareRelease(fixture("1.0.0-rc.1+build.7")).prerelease).toBe(true);
  });

  it.each(["0.1.0", "v01.2.3", "v1.0", "v1.0.0-01", "v1.0.0\nmalicious=true"])("rejects invalid release tag %j", (tag) => {
    expect(() => prepareRelease({ ...fixture(), tag })).toThrow(/valid SemVer/);
  });

  it("rejects mismatched package and both lockfile version fields", () => {
    expect(() => prepareRelease({ ...fixture(), tag: "v0.2.0" })).toThrow(/package.json/);
    const rootMismatch = fixture();
    rootMismatch.lockfile.version = "0.2.0";
    expect(() => prepareRelease(rootMismatch)).toThrow(/package-lock.json/);
    const packageMismatch = fixture();
    packageMismatch.lockfile.packages[""].version = "0.2.0";
    expect(() => prepareRelease(packageMismatch)).toThrow(/package-lock.json/);
  });

  it.each([
    "# Changelog\n\n## [Unreleased]\n\n- Future work.",
    "## [0.1.0] - 2026-10-26\n\n## [0.0.1] - 2026-10-01\n\n- Old work.",
    "## [0.1.0] - 2026-10-26\n\n- First.\n\n## [0.1.0] - 2026-10-26\n\n- Duplicate.",
    "## [0.1.0] - 2026-02-30\n\n- Invalid date.",
    "## [0.1.0] - 2026-99-99\n\n- Invalid date.",
  ])("rejects missing, empty, duplicate or invalidly dated release notes", (changelog) => {
    expect(() => prepareRelease({ ...fixture(), changelog })).toThrow(/CHANGELOG|changelog/);
  });

  it("writes the exact notes and workflow outputs; mismatched CLI tags fail before writing notes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repo2ship-release-test-"));
    try {
      const script = path.resolve(".github/scripts/release.mjs");
      const data = fixture();
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(data.packageManifest));
      fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify(data.lockfile));
      fs.writeFileSync(path.join(dir, "CHANGELOG.md"), data.changelog);
      const notes = path.join(dir, "notes.md");
      const outputs = path.join(dir, "outputs.txt");
      const env = { ...process.env, GITHUB_OUTPUT: outputs };
      const valid = spawnSync(process.execPath, [script, "--notes-file", notes], { cwd: dir, encoding: "utf8", env });
      expect(valid.status, valid.stderr).toBe(0);
      expect(fs.readFileSync(notes, "utf8")).toBe("### Added\n\n- Initial release.\n");
      expect(fs.readFileSync(notes, "utf8")).not.toContain("## [Unreleased]");
      expect(fs.readFileSync(outputs, "utf8")).toBe("version=0.1.0\nprerelease=true\n");
      const rejectedNotes = path.join(dir, "rejected.md");
      const invalid = spawnSync(process.execPath, [script, "--tag", "v9.0.0", "--notes-file", rejectedNotes], { cwd: dir, encoding: "utf8", env });
      expect(invalid.status).not.toBe(0);
      expect(invalid.stderr).toContain("does not match package.json");
      expect(fs.existsSync(rejectedNotes)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
