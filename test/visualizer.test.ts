import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';

import { getVisualizerStripEnabled, getVisualizerStyle, setVisualizerStyle } from '../src/config';
import { isVisualizerStyle } from '../src/visualizerStyle';
import {
  VISUALIZER_CONFIG_TOKEN,
  buildVisualizerScript,
  joinVisualizerSources,
  openVisualizer,
  setVisualizerFullWindowStyle,
  setVisualizerStrip,
  setVisualizerTarget,
} from '../src/visualizer';

const asset = (name: string) => fs.readFileSync(path.join(__dirname, '..', 'assets', name), 'utf-8');
const source = joinVisualizerSources(asset('visualizerRetro.js'), asset('visualizer.js'));

describe('buildVisualizerScript', () => {
  it('replaces the config token with the settings as JSON', () => {
    const script = buildVisualizerScript(source, { strip: false, style: 'retro', label: 'Visualisierung' });
    expect(script).not.toContain(VISUALIZER_CONFIG_TOKEN);
    expect(script).toContain('{"strip":false,"style":"retro","label":"Visualisierung"}');
    expect(() => new vm.Script(script)).not.toThrow();
  });

  it('keeps a $ in a translated label literal', () => {
    const script = buildVisualizerScript(source, { strip: true, style: 'spectrum', label: "$& $' $1" });
    expect(script).toContain(JSON.stringify("$& $' $1"));
  });

  it('defaults to the stored settings: strip on, spectrum style', () => {
    expect(getVisualizerStripEnabled()).toBe(true);
    expect(getVisualizerStyle()).toBe('spectrum');
    expect(buildVisualizerScript(source)).toContain('"strip":true,"style":"spectrum"');
  });

  it('puts the retro renderer ahead of the visualizer that looks it up', () => {
    expect(source.indexOf('__sidraVisualizerRetro = {')).toBeLessThan(source.indexOf('__sidraVisualizer = {'));
  });
});

describe('visualizer style setting', () => {
  it('reads an unknown stored style as spectrum', () => {
    setVisualizerStyle('bogus' as never);
    expect(getVisualizerStyle()).toBe('spectrum');
    setVisualizerStyle('spectrum');
  });

  it('accepts exactly the known styles', () => {
    expect(isVisualizerStyle('spectrum')).toBe(true);
    expect(isVisualizerStyle('retro')).toBe(true);
    expect(isVisualizerStyle('bars')).toBe(false);
    expect(isVisualizerStyle(1)).toBe(false);
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
    run: (config: { strip: boolean; style: 'spectrum' | 'retro'; label: string }) =>
      vm.runInContext(buildVisualizerScript(source, config), context),
  };
}

describe('assets/visualizer.js', () => {
  it('exposes the control object the main process calls into', () => {
    const page = createPage();
    page.run({ strip: true, style: 'spectrum', label: 'Visualizer' });
    const api = page.window.__sidraVisualizer as Record<string, unknown>;
    expect(Object.keys(api).sort()).toEqual(['close', 'configure', 'open', 'toggle']);
  });

  it('reconfigures the running copy on re-injection instead of starting a second one', () => {
    const page = createPage();
    page.run({ strip: true, style: 'spectrum', label: 'Visualizer' });
    const api = page.window.__sidraVisualizer as { configure: (c: unknown) => void };
    const configure = vi.spyOn(api, 'configure');
    page.run({ strip: false, style: 'spectrum', label: 'Visualizer' });
    expect(configure).toHaveBeenCalledWith({ strip: false, style: 'spectrum', label: 'Visualizer' });
    expect(page.windowListeners).toEqual(['keydown']);
    expect(page.intervals).toHaveLength(1);
  });

  it('survives a page with no player bar and no media element', () => {
    const page = createPage();
    page.run({ strip: true, style: 'spectrum', label: 'Visualizer' });
    expect(() => page.intervals[0]()).not.toThrow();
  });
});

describe('choosing the media element', () => {
  // Apple's Home page puts muted, autoplaying tile videos ahead of the player's
  // <audio> in document order, and they play only while the window has focus.
  function mediaElement(tag: string, muted: boolean) {
    return { tagName: tag, paused: false, ended: false, muted, captureStream: vi.fn(() => ({ getAudioTracks: () => [], addEventListener: vi.fn() })) };
  }

  it('reads the unmuted player, not a muted tile video playing ahead of it', () => {
    const tile = mediaElement('VIDEO', true);
    const player = mediaElement('AUDIO', false);
    const context = vm.createContext({
      console: { log: vi.fn(), warn: vi.fn() },
      document: { querySelector: () => null, querySelectorAll: () => [tile, player], getElementById: () => null },
      window: { addEventListener: vi.fn() },
      setInterval: vi.fn(), setTimeout: vi.fn(), clearTimeout: vi.fn(), requestAnimationFrame: vi.fn(),
      performance: { now: () => 0 },
    });
    vm.runInContext(buildVisualizerScript(source, { strip: true, style: 'spectrum', label: 'Visualizer' }), context);
    expect(tile.captureStream).not.toHaveBeenCalled();
    expect(player.captureStream).toHaveBeenCalled();
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

  it('persists the full-window style and switches an open view in place', () => {
    const executeJavaScript = vi.fn(() => Promise.resolve());
    setVisualizerTarget(() => ({ isDestroyed: () => false, executeJavaScript }) as unknown as WebContents);
    setVisualizerFullWindowStyle('retro');
    expect(getVisualizerStyle()).toBe('retro');
    expect(executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('"style":"retro"'));
    setVisualizerFullWindowStyle('spectrum');
  });

  it('does nothing without a window', () => {
    setVisualizerTarget(() => null);
    expect(() => openVisualizer()).not.toThrow();
  });
});
