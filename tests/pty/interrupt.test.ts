import { afterEach, describe, expect, it } from 'vitest';
import { SLOW } from '../fixtures/config/mock-config.js';
import {
  delay,
  type PtySession,
  ptyAvailable,
  skipReason,
  spawnCli,
} from './harness.js';

const SHOW_CURSOR = '[?25h';
const HIDE_CURSOR = '[?25l';

const describeMaybe = ptyAvailable() ? describe : describe.skip;

describeMaybe(
  `run interrupted (Ctrl+C) [${ptyAvailable() ? 'pty' : skipReason()}]`,
  () => {
    let session: (PtySession & { dispose: () => void }) | null = null;

    afterEach(() => {
      session?.kill();
      session?.dispose();
      session = null;
    });

    it('restores the cursor and exits non-zero when interrupted mid-run', async () => {
      // The slow mock provider holds the run open long enough to interrupt it
      // deterministically while the live table is still spinning.
      session = spawnCli({
        args: ['run', 'interrupt me', '-g', 'smoke'],
        config: SLOW,
      });

      // Wait until the table is rendered and the provider is in-flight.
      await session.waitForText('mock-slow');
      await delay(300);

      session.sigint();

      const { code } = await session.waitForExit(8_000);
      const out = session.output();

      // The SIGINT cursor-restore path (live-table.restoreCursorOnSigint) ran:
      // the cursor is shown and the terminal does not end hidden.
      expect(out).toContain(SHOW_CURSOR);
      expect(out.lastIndexOf(SHOW_CURSOR)).toBeGreaterThan(
        out.lastIndexOf(HIDE_CURSOR),
      );

      // Interrupted runs exit non-zero (the SIGINT handler exits 130).
      expect(code).not.toBe(0);
    });
  },
);
