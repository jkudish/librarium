# Contributing

Open an issue before starting a large provider, protocol, or public API change.
Keep changes focused and add a test that would fail for a plausible wrong
implementation.

## Setup

```bash
npm ci
npm run build
```

## Checks

```bash
npm test
npm run typecheck
npm run lint
npm run test:workers
npm run test:integration
npm run test:packed
npm run test:declarations
```

Use `npm run contracts:generate` only when changing the generated terminal
contract snapshot. Review the resulting diff and run its conformance checks;
the generator is not a read-only verification command.

Provider behavior needs offline fixtures and failure-boundary coverage. Live
validation is a separate paid workflow and requires explicit authorization.
Do not use a live request to replace deterministic tests.

Include the behavior changed, checks run, generated drift, and unresolved
provider claims in the pull request.
