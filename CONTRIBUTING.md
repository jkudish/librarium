# Contributing

Open an issue before starting a large provider, protocol, or public API change.
Keep changes focused and add a test that would fail for a plausible wrong
implementation.

## Setup

Use Node.js 22.12 or newer and npm.

```bash
npm ci
npm run build
```

## Checks

Run one test file while you work:

```bash
npx vitest run tests/simplified-surface.test.ts
```

Before opening a pull request, run:

```bash
npm test
npm run typecheck
npm run lint
npm run test:workers
npm run test:integration
npm run test:packed
npm run test:declarations
npm run test:pty
```

Tests use offline transports and the pinned
[`librarium-spec`](https://github.com/jkudish/librarium-spec) selection, Run,
RunStore and filesystem fixtures. `npm run test:conformance` runs only the
shared-spec conformance suite. See [contracts/README.md](contracts/README.md)
for how the spec is pinned.

Provider behavior needs offline fixtures and failure-boundary coverage. Live
validation is a separate paid workflow and requires explicit authorization.
Do not use a live request to replace deterministic tests.

`tests/public-documentation-drift.test.ts` checks that the README names every
catalog source and CLI command and that `SKILL.md` names the MCP tools. Update
the docs in the same change as the code.

Include the behavior changed, checks run, and unresolved provider claims in
the pull request.

## Releases

Release certification and publication are owner-only and need separate
authorization. The procedure is in
[docs/release-candidate-recovery.md](docs/release-candidate-recovery.md).
