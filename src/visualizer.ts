/**
 * Main-process side of the audio visualizer. The visualizer itself is
 * assets/visualizer.js, which runs in the page; this module builds the script
 * with the current settings and forwards tray actions to the running copy.
 */
import type { WebContents } from 'electron';
import log from 'electron-log/main';
import { getVisualizerStripEnabled, getVisualizerStyle, setVisualizerStripEnabled, setVisualizerStyle } from './config';
import { getTrayStrings } from './i18n';
import type { VisualizerStyle } from './visualizerStyle';

const visualizerLog = log.scope('visualizer');

/**
 * The bare identifier in assets/visualizer.js that carries its settings. The
 * script is injected with executeJavaScript() and cannot take parameters, the
 * same constraint as NAV_LABELS_TOKEN in src/i18n.ts.
 */
export const VISUALIZER_CONFIG_TOKEN = '__SIDRA_VISUALIZER_CONFIG__';

export interface VisualizerConfig {
  strip: boolean;
  style: VisualizerStyle;
  label: string;
}

let getTarget: (() => WebContents | null) | null = null;

export function setVisualizerTarget(callback: () => WebContents | null): void {
  getTarget = callback;
}

export function currentVisualizerConfig(): VisualizerConfig {
  return { strip: getVisualizerStripEnabled(), style: getVisualizerStyle(), label: getTrayStrings().visualizer };
}

/**
 * The page script as injected: the Retro 3D renderer first, because the
 * visualizer looks it up on `window` when the overlay opens, then the
 * visualizer itself. Read once at startup by loadAssets() in src/main.ts.
 */
export function joinVisualizerSources(retro: string, visualizer: string): string {
  return `${retro}\n${visualizer}`;
}

/**
 * The script with the settings substituted, built per injection rather than
 * once at startup: a full reload re-runs it from scratch, so a token resolved
 * at launch would bring back the strip setting from before any tray change.
 * The replacement is a function so a `$` in a translated label stays literal.
 */
export function buildVisualizerScript(source: string, config: VisualizerConfig = currentVisualizerConfig()): string {
  return source.replace(VISUALIZER_CONFIG_TOKEN, () => JSON.stringify(config));
}

type VisualizerCall = 'open()' | `configure(${string})`;

function callInPage(call: VisualizerCall): void {
  const wc = getTarget?.();
  if (!wc || wc.isDestroyed()) {
    visualizerLog.warn(`no window to run ${call} in`);
    return;
  }
  wc.executeJavaScript(`window.__sidraVisualizer && window.__sidraVisualizer.${call}`)
    .catch((err: unknown) => visualizerLog.warn(`${call} failed:`, err));
}

export function setVisualizerStrip(enabled: boolean): void {
  setVisualizerStripEnabled(enabled);
  callInPage(`configure(${JSON.stringify(currentVisualizerConfig())})`);
}

// An open full-window view switches style in place.
export function setVisualizerFullWindowStyle(style: VisualizerStyle): void {
  setVisualizerStyle(style);
  callInPage(`configure(${JSON.stringify(currentVisualizerConfig())})`);
}

export function openVisualizer(): void {
  callInPage('open()');
}
