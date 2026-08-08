import { build } from 'esbuild';

const result = await build({
  entryPoints: ['scripts/generate-contract-snapshot.ts'],
  absWorkingDir: process.cwd(),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
});

const source = result.outputFiles[0]?.contents;
if (!source)
  throw new Error('Contract snapshot generator did not produce output');

const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
await import(url);
