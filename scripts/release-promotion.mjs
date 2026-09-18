import { build } from 'esbuild';

const result = await build({
  entryPoints: ['scripts/release-promotion.ts'],
  absWorkingDir: process.cwd(),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22.12',
  write: false,
});

const source = result.outputFiles[0]?.contents;
if (!source) throw new Error('Release promotion did not produce output');

try {
  await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
