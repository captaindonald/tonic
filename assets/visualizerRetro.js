// Retro 3D renderer for the full-window visualizer: glowing ribbons traced
// from the waveform, carried outwards by a zooming, swirling feedback buffer,
// in the additive-glow style of early-2000s desktop music visualizers.
// assets/visualizer.js owns the audio and the overlay; this file only draws.
//
// Each frame: (1) the previous frame is redrawn into the other buffer, slightly
// zoomed, rotated, warped and faded, which turns everything into trails;
// (2) the ribbons and any beat sparks are added on top with additive blending;
// (3) the buffer is tone-mapped onto the canvas. Every per-frame constant is
// scaled by the frame time, so the trails look the same at 60 Hz and 165 Hz.
(function () {
  if (window.__sidraVisualizerRetro) return;

  // The feedback buffer starts at the window's native resolution, so a 5K
  // screen gets 5K detail; every size below is in buffer pixels, so the look
  // is the same at any resolution, only sharper. A GPU that cannot hold
  // MIN_FPS steps the buffer down towards FLOOR_PIXELS (about 1080p, where it
  // was capped before) and stretches it to fit.
  var FLOOR_PIXELS = 2200000;
  var MIN_FPS = 45;
  var STEP_DOWN = 0.7;
  // Frames are timed over this window, starting this long after a resize.
  var MEASURE_S = 2;
  var SETTLE_S = 1;
  var RIBBONS = 4;
  var POINTS = 1100;
  // Samples averaged into one ribbon point, and the extra points blended into
  // the start so a closed ribbon has no seam where its ends meet.
  var STEP = 4;
  var SEAM = 64;
  var RIBBON_OFFSET = 256;
  var SPARKS = 260;
  // The share of the trails kept per 60th of a second.
  var FADE = 0.9;
  var CAMERA = 2.6;
  var FOCAL = 2.2;

  var QUAD_VS = [
    '#version 300 es',
    'layout(location = 0) in vec2 aPos;',
    'out vec2 vUv;',
    'void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }',
  ].join('\n');

  var FEEDBACK_FS = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vUv;',
    'out vec4 outColor;',
    'uniform sampler2D uPrev;',
    'uniform vec2 uAspect;',
    'uniform float uZoom;',
    'uniform float uRot;',
    'uniform float uFade;',
    'uniform float uTime;',
    'uniform float uWarp;',
    'uniform float uDrift;',
    // Catmull-Rom in 9 bilinear taps. The buffer is resampled every frame, and
    // a plain bilinear fetch blurs it a little each time, which adds up to a
    // visible softness at 165 Hz; Catmull-Rom keeps the trails crisp.
    'vec3 sharpSample(vec2 uv) {',
    '  vec2 size = vec2(textureSize(uPrev, 0));',
    '  vec2 pos = uv * size;',
    '  vec2 t1 = floor(pos - 0.5) + 0.5;',
    '  vec2 f = pos - t1;',
    '  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));',
    '  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);',
    '  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));',
    '  vec2 w3 = f * f * (-0.5 + 0.5 * f);',
    '  vec2 w12 = w1 + w2;',
    '  vec2 a = (t1 - 1.0) / size;',
    '  vec2 b = (t1 + w2 / w12) / size;',
    '  vec2 c = (t1 + 2.0) / size;',
    '  vec3 r = texture(uPrev, vec2(a.x, a.y)).rgb * w0.x * w0.y',
    '    + texture(uPrev, vec2(b.x, a.y)).rgb * w12.x * w0.y',
    '    + texture(uPrev, vec2(c.x, a.y)).rgb * w3.x * w0.y',
    '    + texture(uPrev, vec2(a.x, b.y)).rgb * w0.x * w12.y',
    '    + texture(uPrev, vec2(b.x, b.y)).rgb * w12.x * w12.y',
    '    + texture(uPrev, vec2(c.x, b.y)).rgb * w3.x * w12.y',
    '    + texture(uPrev, vec2(a.x, c.y)).rgb * w0.x * w3.y',
    '    + texture(uPrev, vec2(b.x, c.y)).rgb * w12.x * w3.y',
    '    + texture(uPrev, vec2(c.x, c.y)).rgb * w3.x * w3.y;',
    // The negative lobes can undershoot next to a bright edge.
    '  return max(r, 0.0);',
    '}',
    'void main() {',
    '  vec2 p = (vUv - 0.5) * uAspect;',
    '  float c = cos(uRot), s = sin(uRot);',
    '  p = mat2(c, s, -s, c) * p / uZoom;',
    '  p += uWarp * vec2(sin(p.y * 7.0 + uTime * 0.9), sin(p.x * 7.0 - uTime * 1.1));',
    '  vec2 uv = p / uAspect + 0.5;',
    '  vec3 col = sharpSample(uv);',
    '  col = mix(col, col.gbr, uDrift);',
    '  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);',
    '  outColor = vec4(col * uFade * inside, 1.0);',
    '}',
  ].join('\n');

  var HSV = 'vec3 hsv(float h, float s, float v) {'
    + ' vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);'
    + ' return v * mix(vec3(1.0), k, s); }';

  var RIBBON_VS = [
    '#version 300 es',
    'layout(location = 0) in float aT;',
    'layout(location = 1) in float aSample;',
    'uniform float uTime;',
    'uniform float uRibbon;',
    'uniform float uAspectInv;',
    'uniform float uPointBase;',
    'uniform float uLevel;',
    'uniform float uTreble;',
    'uniform float uHue;',
    'uniform mat3 uRotM;',
    'out vec3 vColor;',
    'out float vAlpha;',
    HSV,
    'void main() {',
    '  float th = aT * 6.2831853;',
    '  float r = uRibbon;',
    '  float radius = 0.5 + aSample * 0.6;',
    '  vec3 pos = vec3(cos(th) * radius, sin(th) * radius,',
    '    sin(th * (2.0 + r) + uTime * (0.6 + 0.2 * r)) * (0.22 + 0.12 * r));',
    '  float a = r * 0.785398;',
    '  pos = vec3(pos.x, pos.y * cos(a) - pos.z * sin(a), pos.y * sin(a) + pos.z * cos(a));',
    '  pos = uRotM * pos;',
    '  float z = pos.z + ' + CAMERA.toFixed(2) + ';',
    '  gl_Position = vec4(pos.x / z * ' + FOCAL.toFixed(2) + ' * uAspectInv, pos.y / z * ' + FOCAL.toFixed(2) + ', 0.0, 1.0);',
    '  gl_PointSize = uPointBase * (' + CAMERA.toFixed(2) + ' / z) * (1.0 + uTreble * 0.8);',
    '  vColor = hsv(uHue + r * 0.16 + aT * 0.18, 0.85, 1.0);',
    '  vAlpha = 0.045 + uLevel * 0.3;',
    '}',
  ].join('\n');

  var SPARK_VS = [
    '#version 300 es',
    'layout(location = 0) in float aId;',
    'uniform float uSeed;',
    'uniform float uAspectInv;',
    'uniform float uPointBase;',
    'uniform float uPulse;',
    'uniform float uHue;',
    'uniform mat3 uRotM;',
    'out vec3 vColor;',
    'out float vAlpha;',
    HSV,
    'float hash(float n) { return fract(sin(n) * 43758.5453); }',
    'void main() {',
    '  float u = hash(aId * 1.7 + uSeed);',
    '  float v = hash(aId * 3.1 + uSeed * 1.3);',
    '  float w = hash(aId * 5.3 + uSeed * 0.7);',
    '  float th = u * 6.2831853;',
    '  float ph = acos(2.0 * v - 1.0);',
    '  vec3 pos = vec3(sin(ph) * cos(th), sin(ph) * sin(th), cos(ph)) * (0.3 + w * 1.1);',
    '  pos = uRotM * pos;',
    '  float z = pos.z + ' + CAMERA.toFixed(2) + ';',
    '  gl_Position = vec4(pos.x / z * ' + FOCAL.toFixed(2) + ' * uAspectInv, pos.y / z * ' + FOCAL.toFixed(2) + ', 0.0, 1.0);',
    '  gl_PointSize = uPointBase * 0.55 * (' + CAMERA.toFixed(2) + ' / z);',
    '  vColor = mix(vec3(1.0), hsv(uHue + w * 0.5, 0.7, 1.0), 0.55);',
    '  vAlpha = uPulse * 0.9;',
    '}',
  ].join('\n');

  var POINT_FS = [
    '#version 300 es',
    'precision mediump float;',
    'in vec3 vColor;',
    'in float vAlpha;',
    'out vec4 outColor;',
    'void main() {',
    '  vec2 d = gl_PointCoord - 0.5;',
    // A tight core for a crisp line, with a faint halo for the glow.
    '  float r2 = dot(d, d);',
    '  float f = exp(-r2 * 60.0) + 0.35 * exp(-r2 * 14.0);',
    '  outColor = vec4(vColor * f * vAlpha, 1.0);',
    '}',
  ].join('\n');

  var PRESENT_FS = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vUv;',
    'out vec4 outColor;',
    'uniform sampler2D uTex;',
    'uniform float uExposure;',
    'void main() {',
    '  vec3 c = texture(uTex, vUv).rgb;',
    // Tone-map on luminance so a bright overlap keeps its hue instead of clipping to white.
    '  float l = max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-4);',
    '  c *= (1.0 - exp(-l * uExposure)) / l;',
    '  c = mix(vec3(dot(c, vec3(0.333))), c, 1.25);',
    '  vec2 q = vUv - 0.5;',
    '  c *= 1.0 - dot(q, q) * 0.8;',
    '  outColor = vec4(c, 1.0);',
    '}',
  ].join('\n');

  function compile(gl, type, src) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error('shader: ' + gl.getShaderInfoLog(shader));
    }
    return shader;
  }

  function program(gl, vs, fs, uniforms) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('program: ' + gl.getProgramInfoLog(p));
    }
    var u = {};
    uniforms.forEach(function (name) { u[name] = gl.getUniformLocation(p, name); });
    return { id: p, u: u };
  }

  /** Rotation from yaw, pitch and roll, column-major for uniformMatrix3fv. */
  function rotation(yaw, pitch, roll, out) {
    var cy = Math.cos(yaw), sy = Math.sin(yaw);
    var cp = Math.cos(pitch), sp = Math.sin(pitch);
    var cr = Math.cos(roll), sr = Math.sin(roll);
    out[0] = cy * cr + sy * sp * sr; out[1] = cp * sr; out[2] = -sy * cr + cy * sp * sr;
    out[3] = -cy * sr + sy * sp * cr; out[4] = cp * cr; out[5] = sr * sy + cy * sp * cr;
    out[6] = sy * cp; out[7] = -sp; out[8] = cy * cp;
    return out;
  }

  /**
   * @param {HTMLCanvasElement} canvas
   * @returns {{ frame: (input: { dt: number, wave: Float32Array | null, bass: number, mid: number, treble: number }) => void, destroy: () => void } | null}
   */
  function create(canvas) {
    var gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, premultipliedAlpha: false });
    if (!gl) return null;

    var hdr = !!gl.getExtension('EXT_color_buffer_float');
    var internalFormat = hdr ? gl.RGBA16F : gl.RGBA8;
    var texType = hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

    var feedback = program(gl, QUAD_VS, FEEDBACK_FS, ['uPrev', 'uAspect', 'uZoom', 'uRot', 'uFade', 'uTime', 'uWarp', 'uDrift']);
    var ribbon = program(gl, RIBBON_VS, POINT_FS, ['uTime', 'uRibbon', 'uAspectInv', 'uPointBase', 'uLevel', 'uTreble', 'uHue', 'uRotM']);
    var spark = program(gl, SPARK_VS, POINT_FS, ['uSeed', 'uAspectInv', 'uPointBase', 'uPulse', 'uHue', 'uRotM']);
    var present = program(gl, QUAD_VS, PRESENT_FS, ['uTex', 'uExposure']);

    var quadVao = gl.createVertexArray();
    gl.bindVertexArray(quadVao);
    var quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    var ribbonVao = gl.createVertexArray();
    gl.bindVertexArray(ribbonVao);
    var tData = new Float32Array(RIBBONS * POINTS);
    for (var i = 0; i < tData.length; i++) tData[i] = (i % POINTS) / POINTS;
    var tBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, tBuf);
    gl.bufferData(gl.ARRAY_BUFFER, tData, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 0, 0);
    var samples = new Float32Array(RIBBONS * POINTS);
    var sampleBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, sampleBuf);
    gl.bufferData(gl.ARRAY_BUFFER, samples, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);

    var sparkVao = gl.createVertexArray();
    gl.bindVertexArray(sparkVao);
    var ids = new Float32Array(SPARKS);
    for (var j = 0; j < SPARKS; j++) ids[j] = j;
    var idBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, idBuf);
    gl.bufferData(gl.ARRAY_BUFFER, ids, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    var targets = [null, null];
    var width = 0;
    var height = 0;

    function makeTarget(w, h) {
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, gl.RGBA, texType, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      var fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return { tex: tex, fbo: fbo };
    }

    function freeTargets() {
      targets.forEach(function (t) {
        if (!t) return;
        gl.deleteTexture(t.tex);
        gl.deleteFramebuffer(t.fbo);
      });
      targets = [null, null];
    }

    var maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    var maxViewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    var maxW = Math.min(maxTexture, maxViewport[0]);
    var maxH = Math.min(maxTexture, maxViewport[1]);
    // The pixel budget the GPU has kept up with; Infinity means native.
    var budget = Infinity;
    var sinceResize = 0;
    var measured = 0;
    var frames = 0;

    function fit() {
      var dpr = window.devicePixelRatio || 1;
      var cw = Math.max(1, canvas.clientWidth * dpr);
      var ch = Math.max(1, canvas.clientHeight * dpr);
      var scale = Math.min(1, Math.sqrt(budget / (cw * ch)), maxW / cw, maxH / ch);
      var w = Math.max(1, Math.round(cw * scale));
      var h = Math.max(1, Math.round(ch * scale));
      if (w === width && h === height) return;
      width = w;
      height = h;
      canvas.width = w;
      canvas.height = h;
      freeTargets();
      targets = [makeTarget(w, h), makeTarget(w, h)];
      sinceResize = 0;
      measured = 0;
      frames = 0;
    }

    /**
     * Step the buffer down when the frame rate stays under MIN_FPS for a whole
     * measuring window. It never steps back up within one opening of the
     * overlay; the next opening starts at native again.
     * @param {number} dt the frame time, before frame() clamps it
     */
    function adaptResolution(dt) {
      sinceResize += dt;
      if (sinceResize < SETTLE_S || width * height <= FLOOR_PIXELS) return;
      measured += dt;
      frames++;
      if (measured < MEASURE_S) return;
      var fps = frames / measured;
      measured = 0;
      frames = 0;
      if (fps >= MIN_FPS) return;
      budget = Math.max(FLOOR_PIXELS, width * height * STEP_DOWN);
      console.info('Sidra visualizer: Retro 3D at ' + fps.toFixed(0) + ' fps, stepping down to '
        + (budget / 1e6).toFixed(1) + ' MP');
    }

    var time = 0;
    var hue = Math.random();
    var pulse = 0;
    var bassAvg = 0;
    var sinceBeat = 1;
    var beats = 0;
    var spin = 1;
    var gain = 2;
    var rot = new Float32Array(9);

    /** Downsample the newest audio into one closed ribbon per slot. */
    function fillSamples(wave) {
      if (!wave) {
        samples.fill(0);
        return;
      }
      var span = (POINTS + SEAM) * STEP;
      var peak = 0;
      for (var r = 0; r < RIBBONS; r++) {
        var start = wave.length - span - r * RIBBON_OFFSET;
        if (start < 0) start = 0;
        var base = r * POINTS;
        for (var i = 0; i < POINTS + SEAM; i++) {
          var sum = 0;
          var o = start + i * STEP;
          for (var k = 0; k < STEP; k++) sum += wave[o + k] || 0;
          var v = sum / STEP;
          if (Math.abs(v) > peak) peak = Math.abs(v);
          if (i < POINTS) {
            samples[base + i] = v;
          } else {
            // Crossfade the overflow into the start, so point 0 follows the last point.
            var s = i - POINTS;
            var t = s / SEAM;
            samples[base + s] = samples[base + s] * t + v * (1 - t);
          }
        }
      }
      // A slow automatic gain, so a quiet intro or master still breaks the
      // ribbons up; only true silence leaves them as clean loops.
      var target = Math.min(10, Math.max(0.8, 0.45 / Math.max(peak, 0.01)));
      gain += (target - gain) * 0.05;
      for (var n = 0; n < samples.length; n++) samples[n] *= gain;
    }

    function frame(input) {
      adaptResolution(input.dt);
      fit();
      var dt = Math.min(0.1, Math.max(0.001, input.dt));
      var f = dt * 60;
      time += dt;

      // Beat: bass well above its own running average, at most every 0.22 s.
      var bass = input.bass;
      bassAvg += (bass - bassAvg) * Math.min(1, dt * 1.8);
      sinceBeat += dt;
      if (bass > 0.3 && bass > bassAvg * 1.3 && sinceBeat > 0.22) {
        pulse = 1;
        sinceBeat = 0;
        beats++;
        hue += 0.06 + Math.random() * 0.05;
        if (beats % 16 === 0) spin = -spin;
      }
      pulse *= Math.exp(-dt * 5);
      hue += dt * 0.025;
      var level = (input.bass + input.mid + input.treble) / 3;

      fillSamples(input.wave);
      rotation(time * 0.23 * spin, Math.sin(time * 0.17) * 0.7, time * 0.11, rot);

      var src = targets[0];
      var dst = targets[1];
      var aspect = width / height;

      // 1. Feedback
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, width, height);
      gl.disable(gl.BLEND);
      gl.useProgram(feedback.id);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(feedback.u.uPrev, 0);
      gl.uniform2f(feedback.u.uAspect, aspect, 1);
      gl.uniform1f(feedback.u.uZoom, Math.pow(1.006 + input.bass * 0.012 + pulse * 0.02, f));
      gl.uniform1f(feedback.u.uRot, (0.0025 + input.mid * 0.004) * f * spin);
      gl.uniform1f(feedback.u.uFade, Math.pow(FADE, f));
      gl.uniform1f(feedback.u.uTime, time);
      gl.uniform1f(feedback.u.uWarp, (0.001 + input.mid * 0.003) * Math.min(f, 3));
      gl.uniform1f(feedback.u.uDrift, Math.min(0.5, 0.012 * f));
      gl.bindVertexArray(quadVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // 2. Ribbons and sparks, added on top
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      var pointBase = height / 140;
      var energy = hdr ? 1 : 0.6;

      gl.useProgram(ribbon.id);
      gl.bindVertexArray(ribbonVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, sampleBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, samples);
      gl.uniform1f(ribbon.u.uTime, time);
      gl.uniform1f(ribbon.u.uAspectInv, 1 / aspect);
      gl.uniform1f(ribbon.u.uPointBase, pointBase);
      gl.uniform1f(ribbon.u.uLevel, Math.min(1, level * 1.4 + pulse * 0.3) * energy);
      gl.uniform1f(ribbon.u.uTreble, input.treble);
      gl.uniform1f(ribbon.u.uHue, hue);
      gl.uniformMatrix3fv(ribbon.u.uRotM, false, rot);
      for (var r = 0; r < RIBBONS; r++) {
        gl.uniform1f(ribbon.u.uRibbon, r);
        gl.drawArrays(gl.POINTS, r * POINTS, POINTS);
      }

      if (pulse > 0.25) {
        gl.useProgram(spark.id);
        gl.bindVertexArray(sparkVao);
        gl.uniform1f(spark.u.uSeed, (beats * 17.0 + time * 3.0) % 1000);
        gl.uniform1f(spark.u.uAspectInv, 1 / aspect);
        gl.uniform1f(spark.u.uPointBase, pointBase);
        gl.uniform1f(spark.u.uPulse, pulse * energy);
        gl.uniform1f(spark.u.uHue, hue);
        gl.uniformMatrix3fv(spark.u.uRotM, false, rot);
        gl.drawArrays(gl.POINTS, 0, SPARKS);
      }

      // 3. Present
      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      gl.useProgram(present.id);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, dst.tex);
      gl.uniform1i(present.u.uTex, 0);
      gl.uniform1f(present.u.uExposure, 1.3 + pulse * 0.5);
      gl.bindVertexArray(quadVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);

      targets[0] = dst;
      targets[1] = src;
    }

    // Releases the GPU memory now rather than whenever the canvas is collected.
    function destroy() {
      freeTargets();
      var lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    }

    return { frame: frame, destroy: destroy };
  }

  window.__sidraVisualizerRetro = { create: create };
})();
