import { describe, it, expect } from 'vitest';
import { parseCustomTheme } from '../src/customTheme';

// A complete 12-slot dark scheme; the light scheme borrows it and moves the two
// slots a light palette must flip, which is enough to prove both are carried.
const DARK = {
  base: '#1e1e2e', mantle: '#181825', crust: '#11111b',
  surface0: '#313244', surface1: '#45475a', surface2: '#585b70',
  overlay: '#6c7086', text: '#cdd6f4', subtext1: '#bac2de',
  subtext0: '#a6adc8', accent: '#f38ba8', accentHover: '#eba0ac',
};
const LIGHT = { ...DARK, base: '#eff1f5', text: '#4c4f69' };

/** A dark scheme with one slot removed, for the missing-slot cases. */
function darkWithout(slot: string): Record<string, unknown> {
  const scheme: Record<string, unknown> = { ...DARK };
  delete scheme[slot];
  return scheme;
}

describe('parseCustomTheme', () => {
  it('accepts a full dark and light theme', () => {
    const result = parseCustomTheme(JSON.stringify({ dark: DARK, light: LIGHT }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.name).toBe('custom-theme');
    expect(result.theme.label).toBe('Custom Theme');
    expect(result.theme.dark.base).toBe('#1e1e2e');
    expect(result.theme.light.base).toBe('#eff1f5');
  });

  it('defaults light to dark when light is omitted', () => {
    const result = parseCustomTheme(JSON.stringify({ dark: DARK }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.light).toEqual(result.theme.dark);
  });

  it('lowercases hex colours', () => {
    const result = parseCustomTheme(JSON.stringify({ dark: { ...DARK, accent: '#F38BA8' } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.dark.accent).toBe('#f38ba8');
  });

  it('ignores unknown top-level keys', () => {
    expect(parseCustomTheme(JSON.stringify({ label: 'Mine', note: 'hi', dark: DARK })).ok).toBe(true);
  });

  it('rejects invalid JSON', () => {
    expect(parseCustomTheme('{ not json')).toEqual({
      ok: false,
      error: expect.stringContaining('not valid JSON'),
    });
  });

  it('rejects a non-object top level', () => {
    expect(parseCustomTheme('[]').ok).toBe(false);
    expect(parseCustomTheme('"nope"').ok).toBe(false);
    expect(parseCustomTheme('null').ok).toBe(false);
  });

  it('rejects a theme with no dark scheme', () => {
    expect(parseCustomTheme(JSON.stringify({ light: LIGHT }))).toEqual({
      ok: false,
      error: expect.stringContaining('"dark"'),
    });
  });

  it('rejects a scheme missing a slot, naming it', () => {
    expect(parseCustomTheme(JSON.stringify({ dark: darkWithout('accent') }))).toEqual({
      ok: false,
      error: expect.stringContaining('dark.accent'),
    });
  });

  it('reports the offending slot in the light scheme too', () => {
    expect(parseCustomTheme(JSON.stringify({ dark: DARK, light: darkWithout('base') }))).toEqual({
      ok: false,
      error: expect.stringContaining('light.base'),
    });
  });

  it('rejects a non-hex colour', () => {
    expect(parseCustomTheme(JSON.stringify({ dark: { ...DARK, accent: 'red' } })).ok).toBe(false);
  });

  it('rejects a three-digit hex colour', () => {
    expect(parseCustomTheme(JSON.stringify({ dark: { ...DARK, base: '#fff' } })).ok).toBe(false);
  });

  it('rejects a non-string colour', () => {
    expect(parseCustomTheme(JSON.stringify({ dark: { ...DARK, base: 123 } })).ok).toBe(false);
  });

  it('rejects a non-object dark scheme', () => {
    expect(parseCustomTheme(JSON.stringify({ dark: 'nope' }))).toEqual({
      ok: false,
      error: expect.stringContaining('"dark" must be an object'),
    });
  });
});
