import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { ContractFixtureIndexSchema } from '../src/contracts/artifacts/index.js';
import { HTTP_URL_PATTERN, HttpUrlSchema } from '../src/contracts/common.js';

const snapshotRoot = join(process.cwd(), 'contracts', 'v1');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

function schemaDocuments(): Array<Record<string, any>> {
  return listFiles(join(snapshotRoot, 'schema'))
    .filter((path) => path.endsWith('.schema.json'))
    .map((path) => readJson<Record<string, any>>(path));
}

function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const schema of schemaDocuments()) ajv.addSchema(schema);
  return ajv;
}

describe('published Draft 2020-12 contracts', () => {
  it('keeps shared and execution definitions in their intended bundles', () => {
    const schemas = schemaDocuments();
    const domain = schemas.find(
      (schema) => schema.$id === 'https://librarium.dev/contracts/v1/domain',
    );
    const interchange = schemas.find(
      (schema) =>
        schema.$id === 'https://librarium.dev/contracts/v1/interchange',
    );
    const artifacts = schemas.find(
      (schema) => schema.$id === 'https://librarium.dev/contracts/v1/artifacts',
    );
    const customProvider = schemas.find(
      (schema) =>
        schema.$id === 'https://librarium.dev/contracts/v1/custom-provider',
    );

    expect(Object.keys(domain?.$defs ?? {}).sort()).toEqual([
      'citation',
      'collection_provenance',
      'normalized_source',
      'profile_target',
      'profile_target_slot',
      'provider_identity',
      'research_profile',
      'runtime_effective_target',
      'semantic_facts',
      'structured_error',
      'surface_context',
      'surface_context_constraint',
      'usage',
    ]);
    expect(Object.keys(interchange?.$defs ?? {}).sort()).toEqual([
      'research_error',
      'research_response',
      'research_result',
      'research_result_provenance',
    ]);
    expect(Object.keys(artifacts?.$defs ?? {}).sort()).toEqual([
      'artifact',
      'artifact_producer',
      'durable_handle',
      'execution_attempt',
      'execution_profile',
      'execution_request',
      'execution_response',
      'execution_result',
      'fixture_index',
      'historical_reader',
      'jsonl_record',
      'lifecycle_trace',
      'provider_metadata',
      'run_manifest',
      'snapshot_manifest',
      'sources',
    ]);
    expect(Object.keys(customProvider?.$defs ?? {}).sort()).toEqual([
      'exchange',
      'request',
      'response',
    ]);
  });

  it('independently compiles every manifest-exposed definition and resolves every ref', () => {
    const ajv = createAjv();

    for (const schema of schemaDocuments()) {
      for (const definitionName of Object.keys(schema.$defs)) {
        const schemaUri = `${schema.$id}#/$defs/${definitionName}`;
        expect(() => ajv.compile({ $ref: schemaUri }), schemaUri).not.toThrow();
      }
    }
  });

  it('validates JSON-Schema fixtures and preserves semantic-rule classification', () => {
    const ajv = createAjv();
    const fixtureIndex = ContractFixtureIndexSchema.parse(
      readJson(join(snapshotRoot, 'fixtures', 'index.json')),
    );
    const schemasByPath = new Map(
      schemaDocuments().map((schema) => [
        schema.$id.replace('https://librarium.dev/contracts/v1/', ''),
        schema,
      ]),
    );

    for (const fixture of fixtureIndex.fixtures) {
      const schemaName = fixture.schema_path
        .replace('schema/', '')
        .replace('.schema.json', '');
      const schema = schemasByPath.get(schemaName);
      expect(schema, fixture.id).toBeDefined();
      if (!schema) continue;
      const validate = ajv.compile({
        $ref: `${schema.$id}${fixture.schema_ref}`,
      });
      const payload = readJson(join(snapshotRoot, fixture.path));
      const accepted = validate(payload);

      if (fixture.valid || fixture.enforcement === 'semantic_rule') {
        expect(
          accepted,
          `${fixture.id}: ${JSON.stringify(validate.errors)}`,
        ).toBe(true);
      } else {
        expect(accepted, fixture.id).toBe(false);
      }
    }
  });

  it('uses the exact strict HTTP(S) wire pattern in Zod and published JSON Schema', () => {
    const ajv = createAjv();
    const domainSchema = schemaDocuments().find(
      (schema) => schema.$id === 'https://librarium.dev/contracts/v1/domain',
    );
    expect(domainSchema).toBeDefined();
    const publishedUrlSchema = domainSchema?.$defs.citation.properties.url;
    expect(publishedUrlSchema).toMatchObject({
      type: 'string',
      maxLength: 4096,
      pattern: HTTP_URL_PATTERN,
    });
    expect(publishedUrlSchema).not.toHaveProperty('format');
    const validatePublishedUrl = ajv.compile(publishedUrlSchema);

    const cases = [
      ['https://example.com', true],
      ['http://example.com', true],
      ['http://localhost:8080/path', true],
      ['https://EXAMPLE.com', true],
      ['https://sub-domain.example.com', true],
      ['https://xn--bcher-kva.example', true],
      ['http://127.0.0.1', true],
      ['https://example.com:1', true],
      ['https://example.com:9999', true],
      ['https://example.com:10000', true],
      ['https://example.com:59999', true],
      ['https://example.com:60000', true],
      ['https://example.com:64999', true],
      ['https://example.com:65000', true],
      ['https://example.com:65499', true],
      ['https://example.com:65500', true],
      ['https://example.com:65529', true],
      ['https://example.com:65530', true],
      ['https://example.com:65535', true],
      ['https://example.com/', true],
      ['https://example.com/path/to/resource', true],
      ['https://example.com?query=value', true],
      ['https://example.com#fragment', true],
      ['https://example.com/a%20path?q=a%2Fb#part-1', true],
      ['HTTP://example.com', false],
      ['Https://example.com', false],
      ['http://', false],
      ['https://?query=missing-host', false],
      ['https://#missing-host', false],
      ['https://:443/path', false],
      ['https://user:pass@example.com/path', false],
      ['https://user@example.com/path', false],
      ['https://[::1]/', false],
      ['https://[v1.example]/', false],
      ['https://[]/', false],
      ['https://under_score.example', false],
      ['https://-leading.example', false],
      ['https://trailing-.example', false],
      ['https://empty..label.example', false],
      ['https://example.com.', false],
      ['https://b\u00fccher.example', false],
      ['https://example.com:0', false],
      ['https://example.com:01', false],
      ['https://example.com:65536', false],
      ['https://example.com:99999', false],
      ['https://example.com:', false],
      ['https://example.com:not-a-port', false],
      ['https:/example.com', false],
      ['https:///example.com', false],
      ['https:////example.com', false],
      [String.raw`https:\\example.com`, false],
      [String.raw`https://example.com\path`, false],
      [' https://example.com', false],
      ['https://example.com ', false],
      ['https://example.com\n', false],
      ['https://example.com/path\tvalue', false],
      ['https://example.com/caf\u00e9', false],
    ] as const;

    for (const [url, expected] of cases) {
      expect(HttpUrlSchema.safeParse(url).success, `Zod: ${url}`).toBe(
        expected,
      );
      expect(validatePublishedUrl(url), `JSON Schema: ${url}`).toBe(expected);
    }
  });

  it('regenerates byte-for-byte with the exact canonical inventory', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'librarium-contracts-'));

    try {
      for (const directory of ['first', 'second']) {
        const output = join(temporaryRoot, directory);
        const result = spawnSync(
          process.execPath,
          ['scripts/generate-contract-snapshot.mjs'],
          {
            cwd: process.cwd(),
            encoding: 'utf8',
            env: {
              ...process.env,
              LIBRARIUM_CONTRACTS_OUTPUT: output,
            },
          },
        );
        expect(result.status, result.stderr || result.stdout).toBe(0);
      }

      const canonicalFiles = listFiles(snapshotRoot)
        .map((path) => relative(snapshotRoot, path))
        .sort();
      for (const directory of ['first', 'second']) {
        const output = join(temporaryRoot, directory);
        const outputFiles = listFiles(output)
          .map((path) => relative(output, path))
          .sort();
        expect(outputFiles).toEqual(canonicalFiles);
        for (const path of canonicalFiles) {
          expect(readFileSync(join(output, path)), path).toEqual(
            readFileSync(join(snapshotRoot, path)),
          );
        }
      }
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('rejects retired or otherwise unlisted snapshot files', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'librarium-stale-'));
    const output = join(temporaryRoot, 'snapshot');

    try {
      mkdirSync(join(output, 'fixtures', 'invalid'), { recursive: true });
      writeFileSync(
        join(output, 'fixtures', 'invalid', 'retired-fixture.json'),
        '{}\n',
      );
      const result = spawnSync(
        process.execPath,
        ['scripts/generate-contract-snapshot.mjs'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: {
            ...process.env,
            LIBRARIUM_CONTRACTS_OUTPUT: output,
          },
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Contract snapshot inventory mismatch');
      expect(result.stderr).toContain('retired-fixture.json');
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });
});
