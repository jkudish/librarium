import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCENARIO_CONFORMANCE_EVIDENCE } from './fixtures/scenario-conformance.js';

describe('v2 validation foundation', () => {
  it('keeps every required scenario attached to a named executable test', () => {
    expect(Object.keys(SCENARIO_CONFORMANCE_EVIDENCE).sort()).toEqual([
      'budget_cutoff',
      'collected_surface_provenance',
      'concurrent_fan_out',
      'durable_cancellation',
      'ordered_fallback',
      'partial_terminal_response',
      'secret_redaction',
      'source_deduplication',
      'transport_consistency',
      'unsafe_link_neutralization',
    ]);

    for (const [scenario, evidence] of Object.entries(
      SCENARIO_CONFORMANCE_EVIDENCE,
    )) {
      const source = readFileSync(evidence.file, 'utf8');
      expect(source, `${scenario}:${evidence.file}`).toContain(
        evidence.assertion,
      );
    }
  });

  it('runs expensive portable gates once and keeps CI permissions narrow', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    const certification = readFileSync(
      '.github/workflows/release-candidate.yml',
      'utf8',
    );
    const promotion = readFileSync('.github/workflows/release.yml', 'utf8');

    expect(ci).toContain('permissions:\n  contents: read');
    expect(ci).toContain("autoformat:\n    if: github.event_name == 'push'");
    expect(ci).toContain('contents: write');
    expect(ci.match(/Declaration consumer fixtures/g)).toHaveLength(1);
    expect(ci.match(/Contract snapshot drift/g)).toHaveLength(1);
    expect(ci).toContain('matrix.node-version == 24');
    expect(ci).not.toMatch(/--coverage|--shard/);

    for (const gate of [
      'Declaration consumer fixtures from frozen dist',
      'Workers compatibility tests from frozen dist',
      'Integration tests from frozen dist',
      'Offline benchmark fixture replay',
    ]) {
      expect(certification).toContain(`- name: ${gate}`);
    }
    expect(certification).toContain('run: npm test');
    expect(certification).toContain('node scripts/verify-packed-consumer.mjs');
    expect(certification).not.toMatch(/--coverage|--shard/);
    expect(promotion).not.toContain('npm run build');
  });
});
