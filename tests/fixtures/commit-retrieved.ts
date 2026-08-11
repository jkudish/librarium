import {
  providerArtifactFileNames,
  RunArtifactRepository,
} from '../../src/node-run-artifacts.js';

const [, , runDir, content] = process.argv;
if (!runDir || content === undefined) {
  throw new Error('Usage: commit-retrieved <run-dir> <content>');
}

const names = providerArtifactFileNames('provider-a');

new RunArtifactRepository({ now: () => 10 }).commitRetrieved({
  runDir,
  providerId: 'provider-a',
  taskId: 'task-a',
  report: {
    id: 'provider-a',
    tier: 'deep-research',
    status: 'success',
    durationMs: 1,
    wordCount: content.split(/\s+/).filter(Boolean).length,
    citationCount: 1,
    outputFile: names.outputFile,
    metaFile: names.metaFile,
  },
  content,
  meta: {
    citations: [{ url: 'https://provider-a.test', provider: 'provider-a' }],
  },
});
