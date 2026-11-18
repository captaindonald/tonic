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

/**
 * How long the visualizer holds the audio back before analysing it, so the
 * picture lands with the sound rather than ahead of it. captureStream() taps
 * the audio before Chromium's output buffer and the PipeWire graph, and a
 * click track measured through that path reached the analyser 46 ms before
 * Chromium's own audible clock, on the virtual surround sink behind
 * EasyEffects. The default takes that lead, adds what lies past the point
 * Chromium can see (EasyEffects' limiter lookahead, the DAC buffer) and takes
 * off the display pipeline, about two frames. The [ and ] keys in the full
 * window view nudge it from there by VISUALIZER_DELAY_STEP_MS.
 */
export const VISUALIZER_DELAY_DEFAULT_MS = 50;
export const VISUALIZER_DELAY_MAX_MS = 500;
export const VISUALIZER_DELAY_STEP_MS = 10;

/**
 * A delay from the renderer or the store, as a whole number of milliseconds
 * in 0..VISUALIZER_DELAY_MAX_MS, or null for anything that is not a number.
 */
export function clampVisualizerDelay(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(VISUALIZER_DELAY_MAX_MS, Math.max(0, Math.round(value)));
}
