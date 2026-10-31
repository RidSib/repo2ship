# Changelog

Notable changes are recorded here for each release. Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html); while Repo2Ship is at `0.x`, minor releases may include breaking changes.

## [Unreleased]

### Fixed

- Authenticate task comment authors and machine-marker publishers before using refinement or verifier feedback; retain author metadata for fix rounds.
- Include committed changes in UI verification and critic review, and stop publication when an enabled critic fails or returns an invalid verdict.
- Recheck policy on the exact PR commit before verifier dependency installation; protect npm configuration, detect additional test bypasses, and require review of project scripts.
- Share a bounded execution deadline across implementation and repair calls, and report successful runs that produce no patch.

## [0.1.0] - 2026-10-26

### Added

- GitHub-native issue refinement, implementation, bounded repair, policy checks, and independent verification.
- Pi and OpenCode engines, selectable per model role, with OpenAI-compatible endpoints, Azure configuration, and native Amazon Bedrock examples.
- Optional Langfuse traces and outcome scores, plus a task-tracker demo with unit and browser tests.
- Setup, model-selection, contributor, and security guidance.
- Semantic versioning, release validation, and a tag-triggered GitHub release workflow.

### Known limitations

- Early development: configuration and behavior may change between minor releases.
- Amazon Bedrock has not been live-tested.
- Model environment filtering is not filesystem/process isolation. Review generated code before merging.
- Keep optional auto-merge disabled: a queued merge can survive a later push without a fresh verifier pass. See [SECURITY.md](SECURITY.md).
