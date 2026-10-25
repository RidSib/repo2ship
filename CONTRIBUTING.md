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

Keep the MIT license and existing attribution. For security reports, follow [SECURITY.md](SECURITY.md).
