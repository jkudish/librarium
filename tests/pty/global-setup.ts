import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Vitest globalSetup for the PTY suite. The smoke tests drive the BUILT cli
 * (`dist/cli.js`), so fail fast with an actionable message if the build is
 * missing — running `npm run test:pty` chains the build, but invoking the
 * config directly can skip it.
 */
export default function setup(): void {
  const cli = resolve(
    fileURLToPath(new URL('../../dist/cli.js', import.meta.url)),
  );
  if (!existsSync(cli)) {
    throw new Error(
      `PTY smoke tests require the built CLI at ${cli}. Run \`npm run build\` first (or use \`npm run test:pty\`, which builds automatically).`,
    );
  }
}
