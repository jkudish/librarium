import { PROVIDER_ID_ALIASES } from '../constants.js';
import { BUILTIN_PROVIDER_DEFINITIONS } from './provider-descriptor.js';
import { BUILTIN_PROVIDER_CATALOG } from './provider-profiles.js';
import { RETIRED_PROVIDER_REPLACEMENTS } from './retired-provider-ids.js';

/**
 * Every current, planned, adapter, and retired built-in spelling is reserved.
 * Custom code must never be able to claim a future built-in identity merely
 * because that profile does not have an executable binding yet.
 */
export const RESERVED_BUILTIN_PROVIDER_IDS: ReadonlySet<string> = new Set([
  ...BUILTIN_PROVIDER_CATALOG.map(({ provider_id }) => provider_id),
  ...BUILTIN_PROVIDER_DEFINITIONS.map(({ id }) => id),
  ...Object.keys(PROVIDER_ID_ALIASES),
  ...Object.keys(RETIRED_PROVIDER_REPLACEMENTS),
]);
