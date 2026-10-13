import contract from 'librarium-spec/fixtures/run-store/contract.json' with {
  type: 'json',
};
import fixture from 'librarium-spec/fixtures/run-store/stored-run.json' with {
  type: 'json',
};
import { type RunStore, RunStoreConflict, type StoredRun } from './core/run.js';

export { RunStoreConflict } from './core/run.js';

// Stores may reorder JSON object keys; array order is part of the contract.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

/** Executes the normative fixture contract. Pass an empty, disposable store. */
export async function runStoreContract(store: RunStore): Promise<void> {
  const check = (condition: boolean, message: string) => {
    if (!condition) throw new Error(`RunStore contract: ${message}`);
  };
  for (const step of contract.steps) {
    if (step.op === 'save') {
      const doc = structuredClone(fixture) as StoredRun;
      Object.assign(doc.run, step.with ?? {});
      let version: number | undefined;
      let conflict = false;
      try {
        version = await store.save(doc, step.expected_version ?? null);
      } catch (error) {
        if (!(error instanceof RunStoreConflict)) throw error;
        conflict = true;
      }
      check(
        step.expect.error === 'conflict'
          ? conflict
          : !conflict && version === step.expect.version,
        'save/CAS',
      );
    } else if (step.op === 'get') {
      const doc = await store.get(step.id as string);
      if (step.expect.result === null) check(doc === null, 'not found');
      else {
        check(doc?.version === step.expect.version, 'get version');
        if (step.expect.equals_doc) {
          const expected = { ...fixture, version: step.expect.version };
          check(
            JSON.stringify(canonical(doc)) ===
              JSON.stringify(canonical(expected)),
            'round trip',
          );
        }
        if (step.expect.run_status)
          check(doc?.run.status === step.expect.run_status, 'get status');
      }
    } else if (step.op === 'list') {
      const rows = await store.list({ limit: step.limit, before: step.before });
      check(
        JSON.stringify(rows.map((row) => row.id)) ===
          JSON.stringify(step.expect.ids),
        'list order/paging',
      );
    } else if (step.op === 'delete') await store.delete(step.id as string);
  }
}
