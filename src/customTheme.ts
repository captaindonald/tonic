// Pure module: no electron imports so tests can exercise it directly.
//
// Parses a user's custom-theme.json into a ThemeDefinition that the pure
// buildThemeCss() in src/themeTemplate.ts renders, so a hand-authored theme
// gets the same full Apple Music treatment a bundled palette does. The file
// carries the same 12 semantic slots per colour scheme that src/palettes.ts
// fills. Unlike a bundled palette it is not held to the WCAG contrast floor
// test/themes.test.ts enforces: the colours are the user's own choice, and
// rejecting them would be Sidra overruling it.

import type { SchemeColours, ThemeDefinition } from './themeTemplate';

const CUSTOM_THEME_NAME = 'custom-theme';
const CUSTOM_THEME_LABEL = 'Custom Theme';

// A Record over every slot, so dropping one is a compile error here rather than
// a slot the parser silently never checks; SLOTS is the runtime list built off
// it. This is the same completeness trick channelSet() uses in src/preload.ts.
const SLOT_PRESENCE: Record<keyof SchemeColours, true> = {
  base: true, mantle: true, crust: true, surface0: true, surface1: true, surface2: true,
  overlay: true, text: true, subtext1: true, subtext0: true, accent: true, accentHover: true,
};
const SLOTS = Object.keys(SLOT_PRESENCE) as (keyof SchemeColours)[];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Outcome of parsing custom-theme.json: a theme to render, or why it was rejected. */
export type CustomThemeResult =
  | { ok: true; theme: ThemeDefinition }
  | { ok: false; error: string };

// Returns the parsed scheme, or an error string naming the first slot that
// failed. The string arm is what the caller branches on, so the two cannot be
// confused: a SchemeColours is an object and the failure is a string.
function parseScheme(value: unknown, scheme: string): SchemeColours | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `"${scheme}" must be an object of colour slots`;
  }
  const record = value as Record<string, unknown>;
  const result = {} as Record<keyof SchemeColours, string>;
  for (const slot of SLOTS) {
    const colour = record[slot];
    if (typeof colour !== 'string' || !HEX_RE.test(colour)) {
      return `"${scheme}.${slot}" must be a six-digit hex colour like #1e1e2e`;
    }
    result[slot] = colour.toLowerCase();
  }
  return result as SchemeColours;
}

/**
 * Parses the raw contents of custom-theme.json. On success the theme carries
 * both colour schemes; "light" defaults to "dark" when the file omits it, so a
 * single-scheme theme is one block short rather than a duplicated one. Unknown
 * top-level keys are ignored, so a file may annotate itself freely.
 */
export function parseCustomTheme(raw: string): CustomThemeResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `not valid JSON: ${(error as Error).message}` };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, error: 'top level must be a JSON object' };
  }
  const record = data as Record<string, unknown>;

  if (record.dark === undefined) {
    return { ok: false, error: '"dark" colour scheme is required' };
  }
  const dark = parseScheme(record.dark, 'dark');
  if (typeof dark === 'string') return { ok: false, error: dark };

  let light: SchemeColours = dark;
  if (record.light !== undefined) {
    const parsedLight = parseScheme(record.light, 'light');
    if (typeof parsedLight === 'string') return { ok: false, error: parsedLight };
    light = parsedLight;
  }

  return {
    ok: true,
    theme: { name: CUSTOM_THEME_NAME, label: CUSTOM_THEME_LABEL, dark, light },
  };
}
