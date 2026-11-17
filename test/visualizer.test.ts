import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';

import { getVisualizerStripEnabled } from '../src/config';
import {
  VISUALIZER_CONFIG_TOKEN,
  buildVisualizerScript,
  openVisualizer,
  setVisualizerStrip,
  setVisualizerTarget,
} from '../src/visualizer';

const source = fs.readFileSync(path.join(__dirname, '..', 'assets', 'visualizer.js'), 'utf-8');

describe('buildVisualizerScript', () => {
  it('replaces the config token with the settings as JSON', () => {
    const script = buildVisualizerScript(source, { strip: false, label: 'Visualisierung' });
    expect(script).not.toContain(VISUALIZER_CONFIG_TOKEN);
    expect(script).toContain('{"strip":false,"label":"Visualisierung"}');
    expect(() => new vm.Script(script)).not.toThrow();
  });

  it('keeps a $ in a translated label literal', () => {
    const script = buildVisualizerScript(source, { strip: true, label: "$& $' $1" });
    expect(script).toContain(JSON.stringify("$& $' $1"));
  });

  it('defaults to the stored strip setting, which starts on', () => {
    expect(getVisualizerStripEnabled()).toBe(true);
    expect(buildVisualizerScript(source)).toContain('"strip":true');
  });
});

// The page the script lands in, reduced to what it touches when Apple's player
// bar is absent: no media element, no bar, nothing playing.
function createPage() {
  const windowListeners: string[] = [];
  const intervals: (() => void)[] = [];
  const document = {
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    getElementById: vi.fn(() => null),
  };
  const window: Record<string, unknown> = {
    addEventListener: (type: string) => windowListeners.push(type),
  };
  const context = vm.createContext({
    console: { log: vi.fn(), warn: vi.fn() },
    document,
    window,
    setInterval: (fn: () => void) => { intervals.push(fn); return intervals.length; },
    setTimeout: vi.fn(),
    clearTimeout: vi.fn(),
    requestAnimationFrame: vi.fn(),
    performance: { now: () => 0 },
  });
  return {
    window,
    windowListeners,
    intervals,
    run: (config: { strip: boolean; label: string }) =>
      vm.runInContext(buildVisualizerScript(source, config), context),
  };
}

describe('assets/visualizer.js', () => {
  it('exposes the control object the main process calls into', () => {
    const page = createPage();
    page.run({ strip: true, label: 'Visualizer' });
    const api = page.window.__sidraVisualizer as Record<string, unknown>;
    expect(Object.keys(api).sort()).toEqual(['close', 'configure', 'open', 'toggle']);
  });

  it('reconfigures the running copy on re-injection instead of starting a second one', () => {
    const page = createPage();
    page.run({ strip: true, label: 'Visualizer' });
    const api = page.window.__sidraVisualizer as { configure: (c: unknown) => void };
    const configure = vi.spyOn(api, 'configure');
    page.run({ strip: false, label: 'Visualizer' });
    expect(configure).toHaveBeenCalledWith({ strip: false, label: 'Visualizer' });
    expect(page.windowListeners).toEqual(['keydown']);
    expect(page.intervals).toHaveLength(1);
  });

  it('survives a page with no player bar and no media element', () => {
    const page = createPage();
    page.run({ strip: true, label: 'Visualizer' });
    expect(() => page.intervals[0]()).not.toThrow();
  });
});

describe('page calls', () => {
  it('persists the strip setting and hands the page the new config', () => {
    const executeJavaScript = vi.fn(() => Promise.resolve());
    setVisualizerTarget(() => ({ isDestroyed: () => false, executeJavaScript }) as unknown as WebContents);
    setVisualizerStrip(false);
    expect(getVisualizerStripEnabled()).toBe(false);
    expect(executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('configure({"strip":false'));
    setVisualizerStrip(true);
  });

  it('does nothing without a window', () => {
    setVisualizerTarget(() => null);
    expect(() => openVisualizer()).not.toThrow();
  });
});
