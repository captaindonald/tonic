// Audio visualizer: a spectrum strip behind the player bar controls and a
// full-window view on demand. Injected into the main world on every load and
// SPA navigation, like assets/navigationBar.js.
//
// The audio is read with HTMLMediaElement.captureStream(), which works on the
// Widevine stream Apple Music plays, taps the signal before the element's
// volume (so the bars do not shrink when the volume is turned down), and never
// re-routes playback. createMediaElementSource() also reads it, but takes over
// the element's output, so a fault in the graph would silence the music.
(function () {
  // Not standalone-executable JavaScript: buildVisualizerScript() in
  // src/visualizer.ts replaces this bare token with the current settings as
  // JSON on every injection, and exports the spelling as VISUALIZER_CONFIG_TOKEN.
  /** @type {{ strip: boolean, style: string, label: string }} */
  var CONFIG = __SIDRA_VISUALIZER_CONFIG__;

  // A re-injection on SPA navigation hands the running instance the current
  // settings instead of starting a second one.
  if (window.__sidraVisualizer) {
    window.__sidraVisualizer.configure(CONFIG);
    return;
  }

  var LOG = 'Sidra visualizer:';
  var STRIP_ID = 'sidra-visualizer-strip';
  var BUTTON_ID = 'sidra-visualizer-button';
  var OVERLAY_ID = 'sidra-visualizer-overlay';
  var MIN_HZ = 32;
  var MAX_HZ = 16000;
  // Music falls off roughly 3 dB per octave; tilting by the same amount around
  // 1 kHz keeps the treble bars from sitting flat along the bottom.
  var TILT_DB_PER_OCTAVE = 3;
  var FLOOR_DB = -78;
  var CEIL_DB = -18;
  // Bars rise immediately and fall at this rate (full height per second).
  var FALL_PER_SECOND = 2.2;
  var PEAK_HOLD_MS = 600;
  var PEAK_FALL_PER_SECOND = 0.9;
  var POLL_MS = 500;

  var state = {
    strip: false,
    style: 'spectrum',
    label: 'Visualizer',
    overlayOpen: false,
  };

  // --- Audio --------------------------------------------------------------

  /** @type {AudioContext | null} */
  var ctx = null;
  /** @type {AnalyserNode | null} */
  var analyser = null;
  /** @type {Float32Array | null} */
  var spectrum = null;
  /** @type {MediaStreamAudioSourceNode | null} */
  var source = null;
  /** @type {HTMLMediaElement | null} */
  var boundElement = null;
  /** @type {MediaStreamTrack | null} */
  var boundTrack = null;
  /** @type {WeakMap<HTMLMediaElement, MediaStream>} */
  var streams = new WeakMap();
  var captureFailureLogged = false;
  // Polls in a row that read digital silence from an element that is playing.
  var silentPolls = 0;
  var SILENT_POLLS_BEFORE_RECAPTURE = 3;
  /** @type {Float32Array | null} */
  var probe = null;

  /**
   * The element playing the music. Muted elements are skipped: Apple's
   * animated tiles and artwork are muted <video> elements (browsers autoplay
   * only muted video) that play only while the window has focus, and they come
   * before the player's <audio> in document order. Picking one captured a
   * stream with no audio track, so a focused window on the Home page read
   * silence and Retro 3D drew its idle loops (confirmed over CDP: 16 muted
   * videos ahead of the player). Music videos play unmuted, so they still match.
   *
   * @returns {HTMLMediaElement | null}
   */
  function playingElement() {
    var elements = document.querySelectorAll('audio, video');
    for (var i = 0; i < elements.length; i++) {
      var el = /** @type {HTMLMediaElement} */ (elements[i]);
      if (!el.paused && !el.ended && !el.muted) return el;
    }
    return null;
  }

  function createContext() {
    // sinkId 'none' renders the graph without an output device, so the
    // analyser adds no second stream to PipeWire. Chromium has supported it
    // since 110; the fallback keeps the visualizer working without it.
    try {
      ctx = new AudioContext({ sinkId: { type: 'none' } });
    } catch (e) {
      ctx = new AudioContext();
    }
    analyser = ctx.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0.55;
    spectrum = new Float32Array(analyser.frequencyBinCount);
    bandCache = {};
  }

  /** @returns {MediaStream | null} the element's captured stream, made once */
  function streamFor(el) {
    var stream = streams.get(el);
    if (stream) return stream;
    try {
      stream = el.captureStream();
    } catch (e) {
      if (!captureFailureLogged) {
        console.warn(LOG, 'captureStream failed:', e);
        captureFailureLogged = true;
      }
      return null;
    }
    // A new source on the element adds a track; the next poll re-binds to it.
    stream.addEventListener('addtrack', function () {
      if (boundElement === el) boundTrack = null;
    });
    streams.set(el, stream);
    return stream;
  }

  /**
   * Bind the analyser to whatever is playing now. MusicKit swaps the media
   * element's source on every track change, and Chromium answers by appending
   * a new track to the captured stream while the old one stays `live` and in
   * the stream but carries no more audio (confirmed over CDP). So the newest
   * track is the one to read, and the stale ones are stopped and dropped, or a
   * long session would hold one per song played.
   *
   * @returns {boolean} true when the analyser has a live input
   */
  function ensureInput() {
    var el = playingElement();
    if (!el) return false;
    if (el === boundElement && boundTrack && boundTrack.readyState === 'live') return true;

    var stream = streamFor(el);
    if (!stream) return false;
    var tracks = stream.getAudioTracks();
    var track = tracks[tracks.length - 1];
    if (!track || track.readyState !== 'live') return false;

    if (!ctx) createContext();
    if (source) source.disconnect();
    source = ctx.createMediaStreamSource(new MediaStream([track]));
    source.connect(analyser);
    for (var i = 0; i < tracks.length - 1; i++) {
      stream.removeTrack(tracks[i]);
      tracks[i].stop();
    }
    boundElement = el;
    boundTrack = track;
    if (ctx.state !== 'running') ctx.resume().catch(function () {});
    return true;
  }

  /**
   * A bound input that reads nothing but zeros while the element plays has
   * gone stale in some way the addtrack listener did not catch, which leaves
   * the bars flat and Retro 3D drawing its idle loops. After about 1.5 s of
   * that, drop the element's captured stream so the next poll captures afresh.
   * A genuinely silent gap in a track costs one cheap re-capture per 1.5 s.
   */
  function checkForStaleInput() {
    if (!analyser || !boundElement || boundElement.muted) {
      silentPolls = 0;
      return;
    }
    if (!probe) probe = new Float32Array(2048);
    analyser.getFloatTimeDomainData(probe);
    var peak = 0;
    for (var i = 0; i < probe.length; i++) {
      var v = probe[i] < 0 ? -probe[i] : probe[i];
      if (v > peak) peak = v;
    }
    if (peak > 1e-6) {
      silentPolls = 0;
      return;
    }
    if (++silentPolls < SILENT_POLLS_BEFORE_RECAPTURE) return;
    silentPolls = 0;
    var stream = streams.get(boundElement);
    if (stream) stream.getAudioTracks().forEach(function (t) { t.stop(); });
    streams.delete(boundElement);
    boundTrack = null;
  }

  // Releases the input and parks the audio thread while nothing is shown.
  function releaseInput() {
    if (source) source.disconnect();
    source = null;
    boundElement = null;
    boundTrack = null;
    if (ctx && ctx.state === 'running') ctx.suspend().catch(function () {});
  }

  // --- Bands ----------------------------------------------------------------

  /** @type {Record<number, { lo: number, hi: number, tilt: number }[]>} */
  var bandCache = {};

  /** Log-spaced bands over MIN_HZ..MAX_HZ, as fractional FFT bin ranges. */
  function bandsFor(count) {
    if (bandCache[count]) return bandCache[count];
    var binHz = ctx.sampleRate / analyser.fftSize;
    var bands = [];
    var ratio = Math.log(MAX_HZ / MIN_HZ);
    for (var i = 0; i < count; i++) {
      var f0 = MIN_HZ * Math.exp(ratio * i / count);
      var f1 = MIN_HZ * Math.exp(ratio * (i + 1) / count);
      var centre = Math.sqrt(f0 * f1);
      bands.push({
        lo: f0 / binHz,
        hi: f1 / binHz,
        tilt: TILT_DB_PER_OCTAVE * Math.log2(centre / 1000),
      });
    }
    bandCache[count] = bands;
    return bands;
  }

  /**
   * Fill `out` with band levels in 0..1. A band narrower than one bin (the
   * bass, at this FFT size) interpolates between its neighbours instead of
   * repeating one bin across several bars.
   */
  function readBands(out) {
    analyser.getFloatFrequencyData(spectrum);
    var bands = bandsFor(out.length);
    var last = spectrum.length - 1;
    for (var i = 0; i < out.length; i++) {
      var b = bands[i];
      var db;
      if (b.hi - b.lo < 1) {
        var x = (b.lo + b.hi) / 2;
        var k = Math.min(Math.floor(x), last - 1);
        var t = x - k;
        db = spectrum[k] * (1 - t) + spectrum[k + 1] * t;
      } else {
        db = -Infinity;
        var end = Math.min(Math.ceil(b.hi), last);
        for (var j = Math.floor(b.lo); j <= end; j++) {
          if (spectrum[j] > db) db = spectrum[j];
        }
      }
      var v = (db + b.tilt - FLOOR_DB) / (CEIL_DB - FLOOR_DB);
      out[i] = v > 1 ? 1 : v > 0 ? v : 0;
    }
  }

  /**
   * A view's bar levels: rise at once, fall at FALL_PER_SECOND, with peak caps.
   * @param {number} count
   */
  function createMeter(count) {
    return {
      raw: new Float32Array(count),
      level: new Float32Array(count),
      peak: new Float32Array(count),
      peakAt: new Float64Array(count),
    };
  }

  /** @returns {boolean} true while anything is still above zero */
  function stepMeter(meter, live, dt, now) {
    if (live) readBands(meter.raw);
    else meter.raw.fill(0);
    var moving = false;
    for (var i = 0; i < meter.level.length; i++) {
      var target = meter.raw[i];
      var cur = meter.level[i];
      cur = target > cur ? target : Math.max(target, cur - FALL_PER_SECOND * dt);
      meter.level[i] = cur;
      if (cur >= meter.peak[i]) {
        meter.peak[i] = cur;
        meter.peakAt[i] = now;
      } else if (now - meter.peakAt[i] > PEAK_HOLD_MS) {
        meter.peak[i] = Math.max(cur, meter.peak[i] - PEAK_FALL_PER_SECOND * dt);
      }
      if (cur > 0.002 || meter.peak[i] > 0.002) moving = true;
    }
    return moving;
  }

  // --- Colour ---------------------------------------------------------------

  /** @returns {string} the theme accent, read live so a theme switch follows */
  function accentColour() {
    var v = getComputedStyle(document.documentElement).getPropertyValue('--keyColor').trim();
    return v || '#fa586a';
  }

  /** @returns {{ id: string, title: string, subtitle: string, artwork: string, colours: string[] } | null} */
  function nowPlaying() {
    var mk = window.MusicKit && window.MusicKit.getInstance && window.MusicKit.getInstance();
    var item = mk && mk.nowPlayingItem;
    if (!item) return null;
    var a = item.attributes || {};
    var art = a.artwork || {};
    var colours = [art.textColor1, art.textColor2, art.textColor3]
      .filter(function (c) { return typeof c === 'string' && /^[0-9a-f]{6}$/i.test(c); })
      .map(function (c) { return '#' + c; });
    var subtitle = [a.artistName, a.albumName].filter(Boolean).join(' — ');
    return {
      id: String(item.id),
      title: a.name || '',
      subtitle: subtitle,
      artwork: typeof art.url === 'string' ? art.url.replace('{w}', '1200').replace('{h}', '1200') : '',
      colours: colours,
    };
  }

  // --- Canvas helpers -------------------------------------------------------

  /** Keep a canvas backing store at device resolution. */
  function fitCanvas(canvas) {
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    var h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return dpr;
  }

  function roundedBar(g, x, y, w, h, r) {
    if (h <= 0) return;
    r = Math.min(r, w / 2, h);
    g.beginPath();
    g.moveTo(x, y + h);
    g.lineTo(x, y + r);
    g.arcTo(x, y, x + r, y, r);
    g.arcTo(x + w, y, x + w, y + r, r);
    g.lineTo(x + w, y + h);
    g.closePath();
    g.fill();
  }

  // --- Player bar strip ------------------------------------------------------

  /** @type {HTMLCanvasElement | null} */
  var stripCanvas = null;
  var stripMeter = null;

  // The pill's background is .chrome-player::before at z-index 1 and its
  // controls are flex items at z-index 2, so a positioned layer at 1 placed
  // first in the bar paints between them.
  function attachStrip() {
    var bar = document.querySelector('.chrome-player');
    if (!bar) return;
    var wrap = document.getElementById(STRIP_ID);
    if (wrap && wrap.parentElement === bar) return;
    if (wrap) wrap.remove();
    wrap = document.createElement('div');
    wrap.id = STRIP_ID;
    wrap.setAttribute('aria-hidden', 'true');
    wrap.setAttribute('style', [
      'position: absolute !important',
      'inset: 0 !important',
      'z-index: 1 !important',
      'border-radius: inherit !important',
      'overflow: hidden !important',
      'pointer-events: none !important',
    ].join('; '));
    var bg = getComputedStyle(bar, '::before').borderRadius;
    if (bg) wrap.style.setProperty('border-radius', bg, 'important');
    stripCanvas = document.createElement('canvas');
    stripCanvas.setAttribute('style', 'width: 100% !important; height: 100% !important; display: block !important;');
    wrap.appendChild(stripCanvas);
    bar.insertBefore(wrap, bar.firstChild);
  }

  function detachStrip() {
    var wrap = document.getElementById(STRIP_ID);
    if (wrap) wrap.remove();
    stripCanvas = null;
  }

  function drawStrip(dt, now, live) {
    if (!stripCanvas || !stripCanvas.isConnected) return false;
    var dpr = fitCanvas(stripCanvas);
    var w = stripCanvas.width;
    var h = stripCanvas.height;
    var gap = 2 * dpr;
    var count = Math.max(16, Math.min(160, Math.floor(w / (7 * dpr))));
    if (!stripMeter || stripMeter.level.length !== count) stripMeter = createMeter(count);
    var moving = stepMeter(stripMeter, live, dt, now);
    var g = stripCanvas.getContext('2d');
    g.clearRect(0, 0, w, h);
    g.globalAlpha = 0.32;
    g.fillStyle = accentColour();
    var barW = (w - gap * (count - 1)) / count;
    for (var i = 0; i < count; i++) {
      var bh = stripMeter.level[i] * h;
      roundedBar(g, i * (barW + gap), h - bh, barW, bh, barW / 2);
    }
    g.globalAlpha = 1;
    return moving;
  }

  // --- Player bar button -------------------------------------------------------

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function attachButton() {
    var actions = document.querySelector('.chrome-player__actions .action-buttons')
      || document.querySelector('.chrome-player__actions');
    if (!actions) return;
    var existing = document.getElementById(BUTTON_ID);
    if (existing && existing.parentElement === actions) {
      existing.title = state.label;
      existing.setAttribute('aria-label', state.label);
      return;
    }
    if (existing) existing.remove();

    var button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.title = state.label;
    button.setAttribute('aria-label', state.label);
    button.setAttribute('style', [
      'display: inline-flex !important',
      'align-items: center !important',
      'justify-content: center !important',
      'width: 28px !important',
      'height: 28px !important',
      'padding: 0 !important',
      'margin: 0 4px 0 0 !important',
      'border: 0 !important',
      'background: transparent !important',
      'color: var(--systemSecondary, rgba(255, 255, 255, 0.64)) !important',
      'cursor: pointer !important',
      'flex: none !important',
    ].join('; '));
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 640 640');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    [[96, 304, 208], [200, 176, 336], [304, 96, 416], [408, 240, 272], [512, 336, 176]].forEach(function (r) {
      var rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', String(r[0]));
      rect.setAttribute('y', String(r[1]));
      rect.setAttribute('width', '64');
      rect.setAttribute('height', String(r[2]));
      rect.setAttribute('rx', '32');
      svg.appendChild(rect);
    });
    button.appendChild(svg);
    button.addEventListener('mouseenter', function () {
      button.style.setProperty('color', 'var(--systemPrimary, #ffffff)', 'important');
    });
    button.addEventListener('mouseleave', function () {
      button.style.setProperty('color', 'var(--systemSecondary, rgba(255, 255, 255, 0.64))', 'important');
    });
    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      openOverlay();
    });
    actions.insertBefore(button, actions.firstChild);
  }

  // --- Full-window overlay ----------------------------------------------------

  /** @type {{ root: HTMLElement, backdrop: HTMLElement, content: HTMLElement, art: HTMLImageElement, title: HTMLElement, subtitle: HTMLElement, canvas: HTMLCanvasElement, retroCanvas: HTMLCanvasElement, info: HTMLElement, infoTitle: HTMLElement, infoSubtitle: HTMLElement } | null} */
  var overlay = null;
  var overlayMeter = null;
  /** @type {{ frame: (input: object) => void, destroy: () => void } | null} */
  var retro = null;
  var retroMeter = null;
  /** @type {Float32Array | null} */
  var waveform = null;
  var retroFailureLogged = false;
  var infoTimer = 0;
  var INFO_MS = 6000;
  var overlayTrackId = '';
  var overlayColours = [];
  var cursorTimer = 0;
  var OVERLAY_BARS = 72;

  function buildOverlay() {
    var root = document.createElement('div');
    root.id = OVERLAY_ID;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', state.label);
    root.setAttribute('style', [
      'position: fixed !important',
      'inset: 0 !important',
      'z-index: 2147483647 !important',
      'background: #000 !important',
      'overflow: hidden !important',
      'opacity: 0',
      'transition: opacity 220ms ease',
      'font-family: var(--defaultFontFamily, system-ui, sans-serif) !important',
      'color: #fff !important',
      'user-select: none !important',
    ].join('; '));

    var backdrop = document.createElement('div');
    backdrop.setAttribute('style', [
      'position: absolute',
      'inset: -10%',
      'background-size: cover',
      'background-position: center',
      'filter: blur(72px) saturate(1.5) brightness(0.42)',
      'transform: scale(1.1)',
      'transition: background-image 600ms ease',
    ].join('; '));

    var content = document.createElement('div');
    content.setAttribute('style', [
      'position: absolute',
      'inset: 0',
      'display: flex',
      'flex-direction: column',
      'align-items: center',
      'justify-content: flex-end',
      'padding: 6vh 6vw 0',
      'box-sizing: border-box',
    ].join('; '));

    var art = document.createElement('img');
    art.alt = '';
    art.setAttribute('style', [
      'width: min(34vh, 34vw)',
      'height: min(34vh, 34vw)',
      'object-fit: cover',
      'border-radius: 12px',
      'box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55)',
      'margin-bottom: 3vh',
      'flex: none',
    ].join('; '));

    var title = document.createElement('div');
    title.setAttribute('style', [
      'font-size: clamp(18px, 3.2vh, 40px)',
      'font-weight: 700',
      'text-align: center',
      'max-width: 80vw',
      'white-space: nowrap',
      'overflow: hidden',
      'text-overflow: ellipsis',
      'text-shadow: 0 2px 12px rgba(0, 0, 0, 0.5)',
    ].join('; '));

    var subtitle = document.createElement('div');
    subtitle.setAttribute('style', [
      'font-size: clamp(13px, 2vh, 24px)',
      'opacity: 0.72',
      'margin-top: 0.6vh',
      'text-align: center',
      'max-width: 80vw',
      'white-space: nowrap',
      'overflow: hidden',
      'text-overflow: ellipsis',
    ].join('; '));

    var canvas = document.createElement('canvas');
    canvas.setAttribute('style', 'width: 100%; height: 38vh; display: block; margin-top: 3vh; flex: none;');

    content.appendChild(art);
    content.appendChild(title);
    content.appendChild(subtitle);
    content.appendChild(canvas);

    // Retro 3D: a full-bleed WebGL canvas, with the track shown in a corner
    // for a few seconds when it changes, in the Verdana of the era.
    var retroCanvas = document.createElement('canvas');
    retroCanvas.setAttribute('style', 'position: absolute; inset: 0; width: 100%; height: 100%; display: none;');

    var info = document.createElement('div');
    info.setAttribute('style', [
      'position: absolute',
      'left: 4vw',
      'bottom: 5vh',
      'max-width: 70vw',
      'display: none',
      'opacity: 0',
      'transition: opacity 900ms ease',
      'font-family: Verdana, "DejaVu Sans", Tahoma, sans-serif',
      'text-shadow: 0 0 8px rgba(0, 0, 0, 0.9), 0 0 2px rgba(0, 0, 0, 0.9)',
    ].join('; '));
    var infoTitle = document.createElement('div');
    infoTitle.setAttribute('style', 'font-size: clamp(16px, 2.6vh, 34px); font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;');
    var infoSubtitle = document.createElement('div');
    infoSubtitle.setAttribute('style', 'font-size: clamp(12px, 1.8vh, 22px); opacity: 0.8; margin-top: 0.5vh; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;');
    info.appendChild(infoTitle);
    info.appendChild(infoSubtitle);

    root.appendChild(backdrop);
    root.appendChild(content);
    root.appendChild(retroCanvas);
    root.appendChild(info);

    root.addEventListener('click', closeOverlay);
    root.addEventListener('mousemove', function () {
      showCursorBriefly();
      showInfoBriefly();
    });
    return {
      root: root, backdrop: backdrop, content: content, art: art, title: title, subtitle: subtitle, canvas: canvas,
      retroCanvas: retroCanvas, info: info, infoTitle: infoTitle, infoSubtitle: infoSubtitle,
    };
  }

  function showInfoBriefly() {
    if (!overlay || !retro) return;
    overlay.info.style.opacity = '1';
    clearTimeout(infoTimer);
    infoTimer = setTimeout(function () {
      if (overlay) overlay.info.style.opacity = '0';
    }, INFO_MS);
  }

  // destroy() loses the WebGL context, and a canvas hands a lost context back
  // to every later getContext() call, so a switch back to Retro 3D in the same
  // open overlay needs a fresh canvas or it falls back to the spectrum.
  function destroyRetro() {
    if (retro) {
      retro.destroy();
      if (overlay) {
        var fresh = /** @type {HTMLCanvasElement} */ (overlay.retroCanvas.cloneNode(false));
        overlay.retroCanvas.replaceWith(fresh);
        overlay.retroCanvas = fresh;
      }
    }
    retro = null;
    retroMeter = null;
    clearTimeout(infoTimer);
  }

  /**
   * Show the chosen style in the open overlay. Retro 3D needs WebGL2 and
   * assets/visualizerRetro.js; without either it falls back to the spectrum
   * rather than opening onto a black screen.
   */
  function applyOverlayStyle() {
    if (!overlay) return;
    var wantRetro = state.style === 'retro';
    if (wantRetro && !retro) {
      var factory = window.__sidraVisualizerRetro;
      try {
        retro = factory ? factory.create(overlay.retroCanvas) : null;
      } catch (e) {
        retro = null;
        if (!retroFailureLogged) {
          console.warn(LOG, 'retro renderer failed:', e);
          retroFailureLogged = true;
        }
      }
    } else if (!wantRetro && retro) {
      destroyRetro();
    }
    var showRetro = !!retro;
    overlay.retroCanvas.style.display = showRetro ? 'block' : 'none';
    overlay.info.style.display = showRetro ? 'block' : 'none';
    overlay.backdrop.style.display = showRetro ? 'none' : 'block';
    overlay.content.style.display = showRetro ? 'none' : 'flex';
    if (showRetro) showInfoBriefly();
  }

  function showCursorBriefly() {
    if (!overlay) return;
    overlay.root.style.cursor = 'default';
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(function () {
      if (overlay) overlay.root.style.cursor = 'none';
    }, 2000);
  }

  function refreshOverlayMeta() {
    if (!overlay) return;
    var np = nowPlaying();
    var id = np ? np.id : '';
    if (id === overlayTrackId) return;
    overlayTrackId = id;
    overlay.title.textContent = np ? np.title : '';
    overlay.subtitle.textContent = np ? np.subtitle : '';
    overlay.infoTitle.textContent = np ? np.title : '';
    overlay.infoSubtitle.textContent = np ? np.subtitle : '';
    showInfoBriefly();
    overlayColours = np ? np.colours : [];
    if (np && np.artwork) {
      overlay.art.src = np.artwork;
      overlay.art.style.visibility = 'visible';
      overlay.backdrop.style.backgroundImage = 'url("' + np.artwork.replace(/"/g, '%22') + '")';
    } else {
      overlay.art.removeAttribute('src');
      overlay.art.style.visibility = 'hidden';
      overlay.backdrop.style.backgroundImage = 'none';
    }
  }

  function openOverlay() {
    if (state.overlayOpen) return;
    state.overlayOpen = true;
    overlay = buildOverlay();
    overlayTrackId = '\u0000';
    document.body.appendChild(overlay.root);
    applyOverlayStyle();
    refreshOverlayMeta();
    requestAnimationFrame(function () {
      if (overlay) overlay.root.style.opacity = '1';
    });
    showCursorBriefly();
    wake();
  }

  function closeOverlay() {
    if (!state.overlayOpen) return;
    state.overlayOpen = false;
    clearTimeout(cursorTimer);
    var root = overlay && overlay.root;
    destroyRetro();
    overlay = null;
    overlayMeter = null;
    if (root) {
      root.style.opacity = '0';
      setTimeout(function () { root.remove(); }, 240);
    }
    if (!state.strip) releaseInput();
  }

  function toggleOverlay() {
    if (state.overlayOpen) closeOverlay();
    else openOverlay();
  }

  // Retro 3D keeps animating while paused: its idle drift is part of the look,
  // and it only runs while the overlay is open in the foreground.
  function drawRetro(dt, now, live) {
    if (!retroMeter) retroMeter = createMeter(3);
    stepMeter(retroMeter, live, dt, now);
    var wave = null;
    if (live) {
      if (!waveform || waveform.length !== analyser.fftSize) waveform = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(waveform);
      wave = waveform;
    }
    retro.frame({
      dt: dt,
      wave: wave,
      bass: retroMeter.level[0],
      mid: retroMeter.level[1],
      treble: retroMeter.level[2],
    });
    return true;
  }

  function drawOverlay(dt, now, live) {
    if (!overlay) return false;
    if (retro) return drawRetro(dt, now, live);
    var canvas = overlay.canvas;
    var dpr = fitCanvas(canvas);
    var w = canvas.width;
    var h = canvas.height;
    if (!overlayMeter) overlayMeter = createMeter(OVERLAY_BARS);
    var moving = stepMeter(overlayMeter, live, dt, now);

    var g = canvas.getContext('2d');
    g.clearRect(0, 0, w, h);
    // Bars stand on a baseline two thirds down, with a faded reflection below.
    var base = h * 0.68;
    var maxH = base - 8 * dpr;
    var gap = Math.max(2 * dpr, (w / OVERLAY_BARS) * 0.28);
    var barW = (w - gap * (OVERLAY_BARS - 1)) / OVERLAY_BARS;

    var c0 = overlayColours[0] || accentColour();
    var c1 = overlayColours[1] || overlayColours[0] || '#ffffff';
    var grad = g.createLinearGradient(0, base - maxH, 0, base);
    grad.addColorStop(0, c0);
    grad.addColorStop(1, c1);

    for (var i = 0; i < OVERLAY_BARS; i++) {
      var x = i * (barW + gap);
      var bh = overlayMeter.level[i] * maxH;
      g.fillStyle = grad;
      g.globalAlpha = 0.95;
      roundedBar(g, x, base - bh, barW, bh, barW / 2);
      // Reflection
      g.globalAlpha = 0.18;
      g.fillRect(x, base + 3 * dpr, barW, bh * 0.45);
      // Peak cap
      var py = base - overlayMeter.peak[i] * maxH - 5 * dpr;
      if (overlayMeter.peak[i] > 0.01) {
        g.globalAlpha = 0.85;
        g.fillStyle = c0;
        g.fillRect(x, py, barW, 2.5 * dpr);
      }
    }
    // Fade the reflection out towards the bottom edge.
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'destination-out';
    var fade = g.createLinearGradient(0, base, 0, h);
    fade.addColorStop(0, 'rgba(0, 0, 0, 0)');
    fade.addColorStop(1, 'rgba(0, 0, 0, 1)');
    g.fillStyle = fade;
    g.fillRect(0, base + 2 * dpr, w, h - base);
    g.globalCompositeOperation = 'source-over';
    return moving;
  }

  // --- Loop -----------------------------------------------------------------

  var frame = 0;
  var lastFrame = 0;
  var live = false;

  function active() {
    return state.strip || state.overlayOpen;
  }

  function wake() {
    if (frame || !active()) return;
    lastFrame = performance.now();
    frame = requestAnimationFrame(tick);
  }

  // Draws while there is audio or bars still falling, then stops; the poll
  // wakes it again when playback resumes. rAF itself stops while the window
  // is hidden, so a window closed to the tray costs nothing.
  function tick(now) {
    frame = 0;
    var dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    var moving = false;
    if (state.strip && drawStrip(dt, now, live)) moving = true;
    if (state.overlayOpen && drawOverlay(dt, now, live)) moving = true;
    if (active() && (live || moving)) frame = requestAnimationFrame(tick);
  }

  function poll() {
    if (!active()) return;
    try {
      if (state.strip) attachStrip();
      attachButton();
      live = ensureInput();
      if (live) checkForStaleInput();
      refreshOverlayMeta();
      if (live) wake();
    } catch (e) {
      console.warn(LOG, 'poll failed:', e);
    }
  }

  function configure(config) {
    state.label = typeof config.label === 'string' && config.label ? config.label : state.label;
    state.strip = !!config.strip;
    state.style = config.style === 'retro' ? 'retro' : 'spectrum';
    applyOverlayStyle();
    if (state.strip) {
      attachStrip();
    } else {
      detachStrip();
      stripMeter = null;
      if (!state.overlayOpen) releaseInput();
    }
    attachButton();
    poll();
    wake();
  }

  window.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && state.overlayOpen) {
      event.preventDefault();
      event.stopPropagation();
      closeOverlay();
      return;
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.code === 'KeyV') {
      event.preventDefault();
      toggleOverlay();
    }
  }, true);

  // The button lives in Apple's player bar, which re-renders on its own, so the
  // poll re-attaches it even while the visualizer is otherwise idle.
  setInterval(function () {
    if (active()) poll();
    else attachButton();
  }, POLL_MS);

  window.__sidraVisualizer = {
    configure: configure,
    open: openOverlay,
    close: closeOverlay,
    toggle: toggleOverlay,
  };

  configure(CONFIG);
})();
