# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository: [Report a vulnerability](https://github.com/RidSib/repo2ship/security/advisories/new). Please include affected versions or commits, reproduction steps, and the expected impact. Avoid posting credentials or exploit details in a public issue.

Repo2Ship is early-stage software. Security fixes target the current `main` branch; there are no maintained release branches yet.

## Trust boundaries

Repo2Ship runs generated commands, dependency installation, project tests, and a browser on disposable GitHub Actions runners. It is intended for repositories whose maintainers and configured dependencies you trust. A runner is not a sandbox between the agent and its child processes.

Model-running steps can access their model credentials and job permissions. Environment filtering removes configured credentials from the verifier's app process, but does not isolate the filesystem, dependency lifecycle scripts, or other processes in the job. Use dedicated, least-privilege model credentials and provider spending controls. An AWS OIDC-enabled job can request AWS credentials; restrict its role accordingly.

Only collaborators with write access should trigger agent work. Policy checks and an independent verifier reduce risk but cannot prove generated code is safe. Keep branch protection, code-owner review, and human review enabled. Do not adapt these workflows to execute arbitrary fork code with secrets.

## Merge behavior

Keep `ENABLE_AUTO_MERGE` unset or `false`. The optional queue request checks policy and verifier results against the same commit, but does not bind the lifetime of GitHub's auto-merge queue to that commit. A later collaborator push may retain auto-merge eligibility without a fresh verifier pass. Use human merges until that limitation is resolved.

## Credentials and generated data

Store credentials in GitHub Actions secrets or an ignored local `.env` file. Never add them to prompts, source code, screenshots, or tests. Revoke or rotate exposed credentials before attempting history cleanup.

Optional Langfuse tracing can send prompts, code, tool output, and session data to the configured Langfuse service. Actions artifacts and the `agent-evidence` branch can contain logs or screenshots. Review those outputs before publishing a repository or sharing a run; public repositories expose their Actions logs and published evidence.

The release repository starts with `AGENT_ENABLED=false`, `ENABLE_AUTO_MERGE=false`, and no model-provider secrets. Configure credentials and review settings deliberately before enabling it.
