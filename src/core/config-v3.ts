import { z } from 'zod';
import { MoneySchema, SourceNameSchema } from './run.js';
import { SOURCE_CATALOG, validateSourceOptions } from './source-catalog.js';
export const ConfigV3Schema = z
  .strictObject({
    version: z.literal(3),
    sources: z
      .record(
        SourceNameSchema,
        z
          .object({
            key: z.string().optional(),
            enabled: z.boolean().optional(),
          })
          .catchall(z.unknown()),
      )
      .default({}),
    engines: z
      .object({
        collector: z.string().default('searchapi'),
        key: z.string().optional(),
        enabled: z.boolean().optional(),
      })
      .catchall(z.unknown())
      .default({ collector: 'searchapi' }),
    groups: z.record(SourceNameSchema, z.array(SourceNameSchema)).default({}),
    max_cost: MoneySchema.nullable().optional(),
    summarize: z
      .strictObject({ source: SourceNameSchema.optional() })
      .optional(),
    runs: z
      .strictObject({
        store: z
          .union([
            z.literal('filesystem'),
            z.literal('memory'),
            z.strictObject({ module: z.string().min(1) }),
          ])
          .default('filesystem'),
        path: z.string().default('./agents/librarium'),
        keep_days: z.number().int().positive().nullable().default(null),
      })
      .default({
        store: 'filesystem',
        path: './agents/librarium',
        keep_days: null,
      }),
  })
  .superRefine((config, ctx) => {
    for (const name of Object.keys(config.groups))
      if (SOURCE_CATALOG.some((source) => source.id === name))
        ctx.addIssue({
          code: 'custom',
          message: `group_name_conflict: ${name}`,
        });
    for (const [name, configured] of Object.entries(config.sources)) {
      const source = SOURCE_CATALOG.find((source) => source.id === name);
      if (!source) continue; // registered custom sources are validated by their owner
      const { key: _key, enabled: _enabled, ...options } = configured;
      try {
        validateSourceOptions(source, options);
      } catch (error) {
        ctx.addIssue({ code: 'custom', message: String(error) });
      }
    }
  });
export type ConfigV3 = z.infer<typeof ConfigV3Schema>;
export type ConfigV3Input = z.input<typeof ConfigV3Schema>;
