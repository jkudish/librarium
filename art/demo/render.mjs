#!/usr/bin/env node
/**
 * Render fixture-backed terminal proof as a PNG and a small deterministic GIF.
 *
 * The text is captured from demo-run.mjs, which invokes the built CLI twice to
 * materialize and resume a durable canonical fixture. This renderer never
 * synthesizes provider output and does not call a network service.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const demoDir = fileURLToPath(new URL('.', import.meta.url));
const artDir = dirname(demoDir);
const output = spawnSync(process.execPath, [join(demoDir, 'demo-run.mjs')], {
  encoding: 'utf8',
});

if (output.status !== 0) {
  process.stderr.write(output.stderr || 'Fixture demo failed.\n');
  process.exit(output.status ?? 1);
}

const command =
  '$ librarium live-validation --fixture /absolute/path/to/fixture.json';
const lines = [command, '', ...output.stdout.trimEnd().split('\n')];

const png = join(artDir, 'demo.png');
const gif = join(artDir, 'demo.gif');
mkdirSync(artDir, { recursive: true });
const fontCache = join(tmpdir(), 'librarium-font-cache');
mkdirSync(fontCache, { recursive: true });
const frame = join(fontCache, 'librarium-demo-frame.txt');
writeFileSync(frame, `${lines.join('\n')}\n`);
const render = spawnSync(
  'magick',
  [
    '-size',
    '1200x630',
    'xc:#1e1e2e',
    '-fill',
    '#11111b',
    '-stroke',
    '#45475a',
    '-strokewidth',
    '2',
    '-draw',
    'roundrectangle 24,24 1176,606 16,16',
    '(',
    '-background',
    'none',
    '-fill',
    '#cdd6f4',
    '-font',
    '/System/Library/Fonts/Supplemental/Andale Mono.ttf',
    '-pointsize',
    '19',
    '-size',
    '1080x520',
    `caption:@${frame}`,
    ')',
    '-geometry',
    '+52+64',
    '-composite',
    `png:${png}`,
  ],
  {
    encoding: 'utf8',
    env: { ...process.env, XDG_CACHE_HOME: fontCache },
  },
);
if (render.status !== 0) {
  process.stderr.write(render.stderr || 'Image rendering failed.\n');
  process.exit(render.status ?? 1);
}
const animate = spawnSync(
  'magick',
  ['-delay', '45', png, '-delay', '120', png, '-loop', '0', gif],
  { encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: fontCache } },
);
if (animate.status !== 0) {
  process.stderr.write(animate.stderr || 'GIF rendering failed.\n');
  process.exit(animate.status ?? 1);
}

process.stdout.write(`Wrote ${png} and ${gif}\n`);
