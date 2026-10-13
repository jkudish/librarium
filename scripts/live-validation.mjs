// Maintainer-only approval-gated validation. Public `librarium` has no live-validation command.
import { createMaintainerProgram } from '../dist/maintainer.js';

await createMaintainerProgram().parseAsync([
  ...process.argv.slice(0, 2),
  'live-validation',
  ...process.argv.slice(2),
]);
