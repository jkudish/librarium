import { safeWriteFile } from './core/fs-utils.js';
import { providerArtifactFileNames } from './node-provider-artifact-names.js';
import {
  DEFAULT_FS,
  fixedFile,
  type RunArtifactMetaInput,
  resolveContainedPathWithFs,
  resolveRunDirectoryWithFs,
} from './node-run-artifact-codecs.js';
import type { DeduplicatedSource } from './types.js';

/** Narrow one-way writer. It has no run.json read or mutation capability. */
export interface CanonicalDerivedArtifactWriter {
  writePrompt(runDir: string, content: string): void;
  writeSummary(runDir: string, content: string): void;
  writeProviderContent(
    runDir: string,
    providerId: string,
    content: string,
  ): void;
  writeProviderMeta(
    runDir: string,
    providerId: string,
    metadata: RunArtifactMetaInput,
  ): void;
  writeSources(runDir: string, sources: readonly DeduplicatedSource[]): void;
}

function runDirectory(runDir: string): string {
  const resolved = resolveRunDirectoryWithFs(DEFAULT_FS, runDir);
  if (!resolved) throw new Error(`Invalid canonical run directory: ${runDir}`);
  return resolved;
}

function writeText(runDir: string, fileName: string, content: string): void {
  safeWriteFile(
    resolveContainedPathWithFs(DEFAULT_FS, runDirectory(runDir), fileName),
    content,
  );
}

function writeJson(runDir: string, fileName: string, value: unknown): void {
  writeText(runDir, fileName, JSON.stringify(value, null, 2));
}

export class NodeCanonicalDerivedArtifactWriter
  implements CanonicalDerivedArtifactWriter
{
  writePrompt(runDir: string, content: string): void {
    writeText(runDir, fixedFile('prompt'), content);
  }

  writeSummary(runDir: string, content: string): void {
    writeText(runDir, fixedFile('summary'), content);
  }

  writeProviderContent(
    runDir: string,
    providerId: string,
    content: string,
  ): void {
    writeText(
      runDir,
      providerArtifactFileNames(providerId).outputFile,
      content,
    );
  }

  writeProviderMeta(
    runDir: string,
    providerId: string,
    metadata: RunArtifactMetaInput,
  ): void {
    if (metadata.provider !== undefined && metadata.provider !== providerId) {
      throw new Error('Derived provider metadata identity does not match.');
    }
    writeJson(runDir, providerArtifactFileNames(providerId).metaFile, {
      provider: providerId,
      ...metadata,
    });
  }

  writeSources(runDir: string, sources: readonly DeduplicatedSource[]): void {
    writeJson(runDir, fixedFile('sources'), sources);
  }
}
