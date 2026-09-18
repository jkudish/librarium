import { mutateRunManifest } from '../../src/core/run-manifest.js';

const [dir, marker, countValue] = process.argv.slice(2);
if (!dir || !marker || !countValue) process.exit(2);
const count = Number.parseInt(countValue, 10);
for (let index = 0; index < count; index += 1) {
  mutateRunManifest(dir, (manifest) => {
    manifest.query += marker;
  });
}
