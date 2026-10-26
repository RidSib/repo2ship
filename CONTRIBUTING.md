# Contributing to Repo2Ship

Use an issue to describe a bug or proposed change, including how to reproduce it or the behavior you want. Keep pull requests focused and include verification results.

## Development

Use Node.js 24, matching CI, and install dependencies from the lockfile:

```bash
npm ci
npx playwright install chromium
npm run verify:full
```

The demo runs with `npm run dev` at http://127.0.0.1:4173. A local dry run requires no model credentials:

```bash
node scripts/agent/run-pi-agent.mjs --dry-run
```

Read [AGENTS.md](AGENTS.md) before editing. Run `npm run typecheck` after each file edit and `npm test` after a logical milestone. UI changes also require `npm run test:e2e`, which captures `.pi/artifacts/ui-verify.png` and checks for browser errors.

## Pipeline changes

Workflow files, `scripts/agent/`, and policy configuration require human maintainer review. Automated issue runs must not change these paths. Document provider assumptions and use mocked credentials in tests; never commit live keys, session transcripts, screenshots, or generated artifacts.

Provider integrations that require live credentials should state whether they were tested against the service. Default CI does not call model providers.

## Versioning and releases

The documented configuration, CLI commands, and pipeline behavior form Repo2Ship's compatibility contract. Follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html):

- Before `1.0.0`, use a new minor version for features or breaking changes (`0.1.0` to `0.2.0`), and a patch version for compatible fixes (`0.1.0` to `0.1.1`). Describe breaking changes and migration steps in the changelog.
- From `1.0.0`, increment major for incompatible changes, minor for compatible features, and patch for compatible fixes.
- Optional suffixes such as `1.0.0-rc.1` identify release candidates. The release workflow also marks all `0.x` releases as prereleases to make their early-development status clear.
- Keep published versions and tags immutable. Correct a release with a new version rather than moving its tag or rewriting its notes.

Version bumps are deliberate, not inferred automatically from commit messages. During development, collect noteworthy changes under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md).

### Prepare a release PR

1. Start a release branch from current `main`.
2. For subsequent releases, run `npm version patch --no-git-tag-version` (or `minor`, `major`, or an explicit version) to update both package files. The initial `0.1.0` version is already prepared.
3. Move the relevant unreleased entries into a dated `## [<version>] - YYYY-MM-DD` section. Include known limitations and any migration instructions.
4. Run `npm run verify:full`. This includes `npm run release:check`, which rejects inconsistent package/lockfile versions and missing or invalid release notes. `release:check` reads local files only and publishes nothing.
5. Commit the package files and changelog, open a PR, and obtain maintainer review. Changes to the release workflow or `.github/scripts/release.mjs` also require code-owner review.

### Publish after the PR is merged

For the first release, use the commands below; replace `0.1.0` with the intended version for later releases. Confirm `main` contains the version you intend to publish:

```bash
git switch main
git pull --ff-only origin main
npm ci
npm run verify:full
node .github/scripts/release.mjs --tag v0.1.0
git tag -a v0.1.0 -m "Repo2Ship v0.1.0"
git push origin v0.1.0
```

Pushing the tag starts **Publish Release**. Its verification job uses a read-only token, requires a commit reachable from `main`, validates the exact tag against both package files and its changelog entry, and runs typecheck, unit tests, and browser tests. A separate job receives write permission only to publish the GitHub release using the validated notes; it also refuses a tag that moved after verification. No model calls or npm publication occur.

A failed validation or test run blocks publication. Inspect and rerun a transient failure in Actions. If the release content needs a correction, prepare a new reviewed version and tag. The workflow does not overwrite an existing release.

Keep the MIT license and existing attribution. For security reports, follow [SECURITY.md](SECURITY.md).
