import { describe, expect, it } from 'vitest';
import {
  actionForKey,
  applyAction,
  buildStatusLine,
  clampTopLine,
  positionLabel,
  sliceViewport,
} from '../src/commands/pager.js';

describe('actionForKey', () => {
  it('maps line scrolling keys', () => {
    expect(actionForKey({ name: 'down' })).toEqual({
      type: 'scroll',
      delta: 1,
    });
    expect(actionForKey({ name: 'j' })).toEqual({ type: 'scroll', delta: 1 });
    expect(actionForKey({ name: 'up' })).toEqual({ type: 'scroll', delta: -1 });
    expect(actionForKey({ name: 'k' })).toEqual({ type: 'scroll', delta: -1 });
  });

  it('maps page scrolling keys', () => {
    expect(actionForKey({ name: 'space' })).toEqual({ type: 'page', delta: 1 });
    expect(actionForKey({ name: 'pagedown' })).toEqual({
      type: 'page',
      delta: 1,
    });
    expect(actionForKey({ name: 'b' })).toEqual({ type: 'page', delta: -1 });
    expect(actionForKey({ name: 'pageup' })).toEqual({
      type: 'page',
      delta: -1,
    });
  });

  it('maps g and G to top and bottom', () => {
    expect(actionForKey({ name: 'g', sequence: 'g' })).toEqual({
      type: 'top',
    });
    expect(actionForKey({ name: 'g', shift: true, sequence: 'G' })).toEqual({
      type: 'bottom',
    });
  });

  it('maps exit keys', () => {
    expect(actionForKey({ name: 'q' })).toEqual({ type: 'exit' });
    expect(actionForKey({ name: 'escape' })).toEqual({ type: 'exit' });
    expect(actionForKey({ name: 'c', ctrl: true })).toEqual({ type: 'exit' });
  });

  it('maps o to open and ignores unknown keys', () => {
    expect(actionForKey({ name: 'o' })).toEqual({ type: 'open' });
    expect(actionForKey({ name: 'x' })).toEqual({ type: 'none' });
    expect(actionForKey({})).toEqual({ type: 'none' });
    expect(actionForKey({ name: 'j', ctrl: true })).toEqual({ type: 'none' });
  });
});

describe('clampTopLine', () => {
  it('clamps below zero', () => {
    expect(clampTopLine(-5, 100, 20)).toBe(0);
  });

  it('clamps past the end of the content', () => {
    expect(clampTopLine(999, 100, 20)).toBe(80);
  });

  it('keeps valid positions', () => {
    expect(clampTopLine(40, 100, 20)).toBe(40);
  });

  it('pins to zero when the content fits the viewport', () => {
    expect(clampTopLine(5, 10, 20)).toBe(0);
  });
});

describe('applyAction', () => {
  it('scrolls by lines', () => {
    expect(applyAction({ type: 'scroll', delta: 1 }, 0, 100, 20)).toBe(1);
    expect(applyAction({ type: 'scroll', delta: -1 }, 0, 100, 20)).toBe(0);
  });

  it('pages by viewport height minus one', () => {
    expect(applyAction({ type: 'page', delta: 1 }, 0, 100, 20)).toBe(19);
    expect(applyAction({ type: 'page', delta: -1 }, 30, 100, 20)).toBe(11);
  });

  it('jumps to top and bottom', () => {
    expect(applyAction({ type: 'top' }, 50, 100, 20)).toBe(0);
    expect(applyAction({ type: 'bottom' }, 0, 100, 20)).toBe(80);
  });

  it('clamps the result', () => {
    expect(applyAction({ type: 'page', delta: 1 }, 75, 100, 20)).toBe(80);
    expect(applyAction({ type: 'scroll', delta: -1 }, 0, 100, 20)).toBe(0);
  });
});

describe('sliceViewport', () => {
  const lines = ['a', 'b', 'c', 'd', 'e'];

  it('returns the visible window', () => {
    expect(sliceViewport(lines, 1, 3)).toEqual(['b', 'c', 'd']);
  });

  it('pads short content with empty lines', () => {
    expect(sliceViewport(lines, 3, 4)).toEqual(['d', 'e', '', '']);
    expect(sliceViewport([], 0, 2)).toEqual(['', '']);
  });
});

describe('positionLabel', () => {
  it('reports "all" when the content fits', () => {
    expect(positionLabel(0, 20, 10)).toBe('all');
  });

  it('reports top and bottom positions with line counts', () => {
    expect(positionLabel(0, 20, 100)).toBe('top 20/100');
    expect(positionLabel(80, 20, 100)).toBe('bot 100/100');
  });

  it('reports a percentage in the middle', () => {
    expect(positionLabel(30, 20, 100)).toBe('50% 50/100');
  });
});

describe('buildStatusLine', () => {
  it('includes the title, position, and key hints', () => {
    const status = buildStatusLine({
      title: 'perplexity-sonar-pro',
      topLine: 0,
      viewHeight: 20,
      totalLines: 100,
      width: 200,
      color: false,
    });
    expect(status).toContain('perplexity-sonar-pro');
    expect(status).toContain('top 20/100');
    expect(status).toContain('j/k scroll');
    expect(status).toContain('q back');
  });

  it('shows a transient message instead of the hints', () => {
    const status = buildStatusLine({
      title: 'summary.md',
      topLine: 0,
      viewHeight: 20,
      totalLines: 10,
      width: 200,
      color: false,
      message: 'Could not open pager (nope)',
    });
    expect(status).toContain('Could not open pager (nope)');
    expect(status).not.toContain('j/k scroll');
  });

  it('truncates to the terminal width', () => {
    const status = buildStatusLine({
      title: 'a-very-long-provider-identifier',
      topLine: 0,
      viewHeight: 20,
      totalLines: 100,
      width: 24,
      color: false,
    });
    expect(status.length).toBeLessThanOrEqual(24);
  });
});
