import { afterEach, describe, expect, it } from 'vitest';
import { FALLBACK_PATH, HAPPY_PATH } from '../fixtures/config/mock-config.js';
import {
  type PtySession,
  ptyAvailable,
  skipReason,
  spawnCli,
} from './harness.js';

const SHOW_CURSOR = '[?25h';

const describeMaybe = ptyAvailable() ? describe : describe.skip;

describeMaybe(
  `run (live table) [${ptyAvailable() ? 'pty' : skipReason()}]`,
  () => {
    let session: (PtySession & { dispose: () => void }) | null = null;

    afterEach(() => {
      session?.kill();
      session?.dispose();
      session = null;
    });

    it('renders all rows, resolves to ✓, prints summary, restores cursor, exits 0', async () => {
      session = spawnCli({
        args: ['run', 'pty smoke happy path', '-g', 'smoke'],
        config: HAPPY_PATH,
      });

      const { code } = await session.waitForExit();
      const out = session.output();
      const plain = session.plain();

      // Every provider row rendered and resolved to success.
      expect(plain).toContain('mock-grounded');
      expect(plain).toContain('mock-search');
      expect(plain).toContain('mock-second');
      expect(plain).toContain('✓');
      // No failures in the happy path.
      expect(plain).not.toContain('✗');

      // Summary block landmarks.
      expect(plain).toMatch(/3 succeeded, 0 failed, 0 async pending/);
      expect(plain).toContain('unique sources after dedupe');

      // Cursor restored: the final emitted control sequence shows the cursor
      // (live-table writes SHOW_CURSOR on stop), and the run does not end in a
      // hidden-cursor state.
      expect(out).toContain(SHOW_CURSOR);
      expect(out.trimEnd().endsWith(SHOW_CURSOR)).toBe(true);

      expect(code).toBe(0);
    });

    it('shows ✗ row, ↳ fallback notice, and a recovered fallback row', async () => {
      session = spawnCli({
        args: ['run', 'pty smoke fallback', '-g', 'smoke'],
        config: FALLBACK_PATH,
      });

      const { code } = await session.waitForExit();
      const plain = session.plain();

      // The failing primary surfaces an ✗ row with its error.
      expect(plain).toContain('mock-flaky');
      expect(plain).toContain('✗');
      expect(plain).toContain('HTTP 401 Unauthorized');

      // The fallback notice and the recovered fallback row both appear.
      expect(plain).toContain('↳ falling back to mock-backup');
      expect(plain).toContain('mock-backup');

      // The healthy primary still succeeds.
      expect(plain).toContain('mock-ok');
      expect(plain).toContain('✓');

      // A recovered primary means the run's intent was satisfied (exit 0),
      // and the cursor is restored.
      expect(session.output()).toContain(SHOW_CURSOR);
      expect(code).toBe(0);
    });
  },
);
