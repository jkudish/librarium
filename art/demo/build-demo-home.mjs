#!/usr/bin/env node
/**
 * Compatibility entrypoint for older demo commands.
 *
 * The v2 recording does not need a HOME, credentials, provider config, or a
 * network stub. `demo-run.mjs` creates an isolated fixture state directory.
 */
process.stdout.write(
  'The v2 demo uses an isolated offline fixture. No HOME setup is required.\n',
);
