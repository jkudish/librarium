import { z } from 'zod/v4';
import { Rfc3339UtcSchema, SemverSchema } from '../common.js';

export const ContractAreaSchema = z.enum([
  'domain',
  'artifacts',
  'custom_provider',
  'interchange',
]);

export const SnapshotRelativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/, {
    message: 'Expected a safe snapshot-relative POSIX path',
  });

export const ContractSnapshotFileSchema = z
  .strictObject({
    path: SnapshotRelativePathSchema,
    role: z.enum(['schema', 'fixture_index', 'fixture']),
    areas: z.array(ContractAreaSchema).min(1).max(4),
  })
  .superRefine((file, ctx) => {
    if (new Set(file.areas).size !== file.areas.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Snapshot file areas must be unique',
        path: ['areas'],
      });
    }
  });

const fixtureIndexBase = {
  id: z.string().regex(/^(?:valid|invalid)\.[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
  area: ContractAreaSchema,
  path: SnapshotRelativePathSchema,
  schema_path: SnapshotRelativePathSchema,
  schema_ref: z.string().regex(/^#\/\$defs\/[a-z][a-z0-9_]*$/),
};

export const ContractFixtureIndexEntrySchema = z.union([
  z.strictObject({
    ...fixtureIndexBase,
    valid: z.literal(true),
  }),
  z.strictObject({
    ...fixtureIndexBase,
    valid: z.literal(false),
    enforcement: z.literal('json_schema'),
    expected_issue_path: z.string().max(1_024),
  }),
  z.strictObject({
    ...fixtureIndexBase,
    valid: z.literal(false),
    enforcement: z.literal('semantic_rule'),
    semantic_rule_id: z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/),
    expected_issue_path: z.string().max(1_024),
  }),
]);

export const ContractFixtureIndexSchema = z.strictObject({
  fixture_index_version: z.literal('1.0.0'),
  fixtures: z.array(ContractFixtureIndexEntrySchema).min(1).max(1_000),
});

export const SemanticRuleSchema = z.strictObject({
  rule_id: z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/),
  version: SemverSchema,
  description: z.string().min(1).max(1_024),
});

export const ContractSnapshotManifestSchema = z.strictObject({
  snapshot_format_version: z.literal('1.0.0'),
  contract_set: z.literal('librarium_contracts'),
  generated_at: Rfc3339UtcSchema,
  owner: z.literal('typescript_librarium'),
  ownership_policy: z.literal('canonical_upstream'),
  checksum_algorithm: z.literal('sha256'),
  checksum_file: z.literal('checksums.sha256'),
  versions: z.strictObject({
    domain: SemverSchema,
    artifacts: SemverSchema,
    custom_provider: SemverSchema,
    interchange: SemverSchema,
  }),
  semantic_rules: z.array(SemanticRuleSchema).min(1).max(64),
  files: z.array(ContractSnapshotFileSchema).min(1).max(1_000),
});

export type ContractArea = z.infer<typeof ContractAreaSchema>;
export type ContractFixtureIndex = z.infer<typeof ContractFixtureIndexSchema>;
export type ContractFixtureIndexEntry = z.infer<
  typeof ContractFixtureIndexEntrySchema
>;
export type ContractSnapshotFile = z.infer<typeof ContractSnapshotFileSchema>;
export type ContractSnapshotManifest = z.infer<
  typeof ContractSnapshotManifestSchema
>;
export type SemanticRule = z.infer<typeof SemanticRuleSchema>;
