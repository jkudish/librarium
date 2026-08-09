import { describe, expect, it } from 'vitest';
import {
  BUILTIN_WORKFLOW_IDS,
  customWorkflowId,
  migrateUserWorkflowNames,
  QUICK_WORKFLOW_ROSTER,
  REMOVED_BUILTIN_WORKFLOW_IDS,
  RESERVED_WORKFLOW_IDS,
  resolveWorkflowSelection,
  VISIBILITY_WORKFLOW_ROSTER,
} from '../src/core/builtin-workflows.js';

describe('built-in workflows -- reserved names', () => {
  it('reserves exactly quick, deep, visibility, and all', () => {
    expect([...BUILTIN_WORKFLOW_IDS]).toEqual([
      'quick',
      'deep',
      'visibility',
      'all',
    ]);
    expect(RESERVED_WORKFLOW_IDS.size).toBe(4);
  });

  it('does not reserve any removed built-in name', () => {
    for (const removed of REMOVED_BUILTIN_WORKFLOW_IDS) {
      expect(RESERVED_WORKFLOW_IDS.has(removed)).toBe(false);
    }
  });

  it('removes raw, fast, llm, models, comprehensive, social, and xai', () => {
    expect([...REMOVED_BUILTIN_WORKFLOW_IDS].sort()).toEqual([
      'comprehensive',
      'fast',
      'llm',
      'models',
      'raw',
      'social',
      'xai',
    ]);
  });

  it('curates quick and visibility rosters in policy order', () => {
    expect(
      QUICK_WORKFLOW_ROSTER.map((m) => `${m.provider_id}/${m.profile_id}`),
    ).toEqual([
      'gemini-grounded/grounded',
      'openrouter/grounded',
      'brave-answers/grounded',
      'exa/search',
      'kagi-fastgpt/grounded',
    ]);
    expect(
      VISIBILITY_WORKFLOW_ROSTER.map((m) => `${m.provider_id}/${m.profile_id}`),
    ).toEqual([
      'searchapi-chatgpt/surface',
      'searchapi-gemini/surface',
      'searchapi-perplexity/surface',
      'searchapi-google-ai-mode/surface',
      'searchapi-bing-copilot/surface',
      'searchapi-google-ai-overview/surface',
      'perplexity-sonar-pro/grounded',
      'gemini-grounded/grounded',
      'grok/web',
    ]);
  });
});

describe('built-in workflows -- selection syntax', () => {
  it('resolves each reserved name to its built-in workflow', () => {
    for (const id of BUILTIN_WORKFLOW_IDS) {
      expect(resolveWorkflowSelection(id)).toEqual({
        kind: 'builtin',
        workflow_id: id,
      });
    }
  });

  it('resolves an explicit custom:<name> reference', () => {
    expect(resolveWorkflowSelection('custom:team', ['custom:team'])).toEqual({
      kind: 'custom',
      group_id: 'custom:team',
    });
  });

  it('rejects an unprefixed custom group with the correct spelling', () => {
    const resolution = resolveWorkflowSelection('team', ['custom:team']);
    expect(resolution.kind).toBe('unknown');
    if (resolution.kind !== 'unknown') return;
    expect(resolution.message).toContain('"custom:team"');
    expect(resolution.message).toContain('not "team"');
  });

  it('rejects a removed built-in name actionably', () => {
    for (const removed of REMOVED_BUILTIN_WORKFLOW_IDS) {
      const resolution = resolveWorkflowSelection(removed);
      expect(resolution.kind).toBe('unknown');
      if (resolution.kind !== 'unknown') continue;
      expect(resolution.message).toContain('no longer a built-in workflow');
      expect(resolution.message).toContain('quick, deep, visibility, all');
      expect(resolution.message).toContain(customWorkflowId(removed));
    }
  });

  it('rejects an undefined custom group without inventing one', () => {
    const resolution = resolveWorkflowSelection('custom:missing', []);
    expect(resolution.kind).toBe('unknown');
    if (resolution.kind !== 'unknown') return;
    expect(resolution.message).toContain('Unknown custom group');
  });
});

describe('built-in workflows -- user-defined name migration', () => {
  it('migrates a colliding user group to custom:<name> with a notice', () => {
    const result = migrateUserWorkflowNames({ quick: ['exa/search'] });
    expect(result.groups).toEqual({ 'custom:quick': ['exa/search'] });
    expect(result.issues).toEqual([]);
    expect(result.notices).toEqual([
      expect.objectContaining({
        code: 'reserved_workflow_name_migrated',
        phase: 'migration',
        path: '/groups/quick',
      }),
    ]);
  });

  it('leaves non-reserved names untouched', () => {
    const result = migrateUserWorkflowNames({ team: ['exa/search'] });
    expect(result.groups).toEqual({ team: ['exa/search'] });
    expect(result.notices).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it('never clobbers when both quick and custom:quick exist', () => {
    const forward = migrateUserWorkflowNames({
      quick: ['exa/search'],
      'custom:quick': ['tavily/search'],
    });
    const reverse = migrateUserWorkflowNames({
      'custom:quick': ['tavily/search'],
      quick: ['exa/search'],
    });

    for (const result of [forward, reverse]) {
      expect(result.groups).toEqual({
        quick: ['exa/search'],
        'custom:quick': ['tavily/search'],
      });
      expect(result.notices).toEqual([]);
      expect(result.issues).toEqual([
        expect.objectContaining({
          code: 'reserved_workflow_name_collision',
          phase: 'migration',
          path: '/groups/quick',
        }),
      ]);
    }
  });

  it('produces identical output for either insertion order', () => {
    const forward = migrateUserWorkflowNames({
      visibility: ['grok/web'],
      'custom:visibility': ['exa/search'],
      team: ['tavily/search'],
      deep: ['gemini-deep/research'],
    });
    const reverse = migrateUserWorkflowNames({
      deep: ['gemini-deep/research'],
      team: ['tavily/search'],
      'custom:visibility': ['exa/search'],
      visibility: ['grok/web'],
    });

    expect(Object.keys(forward.groups)).toEqual(Object.keys(reverse.groups));
    expect(forward).toEqual(reverse);
    // `deep` had no collision and migrated; `visibility` collided and both
    // definitions survived untouched.
    expect(forward.groups).toEqual({
      'custom:deep': ['gemini-deep/research'],
      'custom:visibility': ['exa/search'],
      team: ['tavily/search'],
      visibility: ['grok/web'],
    });
  });
});
