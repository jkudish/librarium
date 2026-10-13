# Shared Librarium contract

The public request, Run, StoredRun and source catalog are owned by
[`jkudish/librarium-spec`](https://github.com/jkudish/librarium-spec).
This package pins its Git commit in `package.json` and `package-lock.json`.
There is no generated `contracts/v1` snapshot or language repinning step.

`tests/simplified-surface.test.ts` executes the shared selection fixtures,
valid/invalid Run fixtures, RunStore contract, and filesystem example.
`librarium/testing` exports the same `runStoreContract` for custom stores.
JS-only config migration fixtures live in this repository.
