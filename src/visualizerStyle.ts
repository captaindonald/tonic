/**
 * The full-window visualizer styles. Kept apart from src/visualizer.ts, which
 * imports src/config.ts, so config can validate a stored value without a cycle.
 */
export const VISUALIZER_STYLES = ['spectrum', 'retro'] as const;

export type VisualizerStyle = typeof VISUALIZER_STYLES[number];

const STYLE_LOOKUP: ReadonlySet<string> = new Set(VISUALIZER_STYLES);

export function isVisualizerStyle(value: unknown): value is VisualizerStyle {
  return typeof value === 'string' && STYLE_LOOKUP.has(value);
}
