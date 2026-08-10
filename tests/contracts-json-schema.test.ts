import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { resolveSnapshotWritePath } from '../scripts/contract-snapshot-path.js';

const root = join(process.cwd(), 'contracts', 'v1');
const read = <T>(path: string): T =>
  JSON.parse(readFileSync(path, 'utf8')) as T;
const list = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? list(join(directory, entry.name))
      : [join(directory, entry.name)],
  );

describe('published terminal interchange snapshot', () => {
  const schema = read<Record<string, any>>(
    join(root, 'schema', 'interchange.schema.json'),
  );
  const fixtures = read<{
    fixtures: Array<{
      id: string;
      path: string;
      valid: boolean;
      enforcement: 'structural' | 'semantic_rule';
      semantic_rule_id?: string;
    }>;
  }>(join(root, 'fixtures', 'index.json'));

  it('contains exactly the seven shared definitions and no other schema bundles', () => {
    expect(Object.keys(schema.$defs).sort()).toEqual([
      'citation',
      'research_error',
      'research_response',
      'research_result',
      'result_provenance',
      'source',
      'usage',
    ]);
    expect(
      list(join(root, 'schema')).map((path) => relative(root, path)),
    ).toEqual(['schema/interchange.schema.json']);
  });

  it('compiles every shared definition', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    ajv.addSchema(schema);
    for (const name of Object.keys(schema.$defs))
      expect(() =>
        ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` }),
      ).not.toThrow();
  });

  it('separates structural rejection from the five stable semantic rules', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    ajv.addSchema(schema);
    const validate = ajv.compile({
      $ref: `${schema.$id}#/$defs/research_response`,
    });
    const semanticRules = new Set<string>();
    for (const fixture of fixtures.fixtures) {
      const accepted = validate(read(join(root, fixture.path)));
      if (fixture.valid || fixture.enforcement === 'semantic_rule') {
        expect(accepted, fixture.id).toBe(true);
      } else {
        expect(accepted, fixture.id).toBe(false);
      }
      if (fixture.semantic_rule_id) semanticRules.add(fixture.semantic_rule_id);
    }
    expect([...semanticRules].sort()).toEqual([
      'provider_meta.safe_metadata',
      'research_response.terminal_shape',
      'result_provenance.surface_requires_collector',
      'source.locator_required',
      'usage.cost_requires_currency',
    ]);
  });

  it('regenerates deterministically and removes stale retired files', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'librarium-contracts-'));
    try {
      const first = join(temporary, 'first');
      const second = join(temporary, 'second');
      mkdirSync(join(first, 'fixtures', 'invalid'), { recursive: true });
      writeFileSync(join(first, 'fixtures', 'invalid', 'retired.json'), '{}\n');
      writeFileSync(
        join(first, 'manifest.json'),
        JSON.stringify({
          snapshot_version: 1,
          title: 'Librarium terminal interchange snapshot',
        }),
      );
      for (const output of [first, second]) {
        const result = spawnSync(
          process.execPath,
          ['scripts/generate-contract-snapshot.mjs'],
          {
            cwd: process.cwd(),
            encoding: 'utf8',
            env: { ...process.env, LIBRARIUM_CONTRACTS_OUTPUT: output },
          },
        );
        expect(result.status, result.stderr).toBe(0);
      }
      const paths = list(root)
        .map((path) => relative(root, path))
        .sort();
      for (const output of [first, second]) {
        expect(
          list(output)
            .map((path) => relative(output, path))
            .sort(),
        ).toEqual(paths);
        for (const path of paths)
          expect(readFileSync(join(output, path))).toEqual(
            readFileSync(join(root, path)),
          );
      }
      expect(() =>
        readFileSync(join(first, 'fixtures', 'invalid', 'retired.json')),
      ).toThrow();
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('rejects traversal and symlinked roots, ancestors, and targets', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'librarium-contract-path-'));
    try {
      const root = join(temporary, 'snapshot');
      const outside = join(temporary, 'outside');
      mkdirSync(root);
      mkdirSync(outside);

      for (const path of [
        '',
        '.',
        '../outside.json',
        'schema/../../outside.json',
        '/tmp/outside.json',
        String.raw`..\outside.json`,
        String.raw`C:\outside.json`,
      ]) {
        expect(() => resolveSnapshotWritePath(root, path), path).toThrow(
          /Refusing/,
        );
      }

      const symlinkRoot = join(temporary, 'snapshot-link');
      symlinkSync(root, symlinkRoot, 'dir');
      expect(() =>
        resolveSnapshotWritePath(symlinkRoot, 'schema/interchange.schema.json'),
      ).toThrow(/symlink/);

      const schemaDirectory = join(root, 'schema');
      symlinkSync(outside, schemaDirectory, 'dir');
      expect(() =>
        resolveSnapshotWritePath(root, 'schema/interchange.schema.json'),
      ).toThrow(/symlink/);
      rmSync(schemaDirectory);

      mkdirSync(schemaDirectory);
      const outsideFile = join(outside, 'interchange.schema.json');
      writeFileSync(outsideFile, '{}');
      symlinkSync(
        outsideFile,
        join(schemaDirectory, 'interchange.schema.json'),
      );
      expect(() =>
        resolveSnapshotWritePath(root, 'schema/interchange.schema.json'),
      ).toThrow(/symlink/);

      const symlinkParent = join(temporary, 'output-link');
      symlinkSync(outside, symlinkParent, 'dir');
      expect(() =>
        resolveSnapshotWritePath(
          join(symlinkParent, 'new-snapshot'),
          'schema/interchange.schema.json',
        ),
      ).toThrow(/symlink/);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('does not delete an unrecognized nonempty output root', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'librarium-contracts-'));
    try {
      const output = join(temporary, 'unrecognized');
      mkdirSync(output);
      const keep = join(output, 'keep.txt');
      writeFileSync(keep, 'do not delete\n');
      const result = spawnSync(
        process.execPath,
        ['scripts/generate-contract-snapshot.mjs'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: { ...process.env, LIBRARIUM_CONTRACTS_OUTPUT: output },
        },
      );
      expect(result.status).not.toBe(0);
      expect(readFileSync(keep, 'utf8')).toBe('do not delete\n');
      expect(() => readFileSync(join(output, 'manifest.json'))).toThrow();
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
