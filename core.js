/* PitchMeter web trial — analysis core (port of iOS 1.3.3 working copy: pitch_core.c, RegisterClassifier.swift,
   LocalAudioPipeline.attachRegister, LivePitchStream, GaugeRange / GaugeTimeline / GaugeBandRule).
   Pure JS, no network, no dependencies. Works in window, Web Worker and Node. */
(function (root) {
'use strict';
const log10 = Math.log10, log2 = Math.log2;
function roundHalfEven(x) { const r = Math.round(x); return (Math.abs(x % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r; }

// ---------------- pitch_core.c (16 kHz) ----------------
function pitchDetect(x, n, center) {
  const r = { hz: 0, confidence: 0, db: -160 };
  if (!x || !n || center < 0 || center >= n) return r;
  const c = center | 0;
  const s = (i) => (i < 0 || i >= n) ? 0 : x[i];
  let e = 0;
  for (let j = 0; j < 640; j++) { const a = s(c - 320 + j); if (!isFinite(a)) return r; e += a * a; }
  r.db = 10 * log10(e / 640 + 1e-16); if (r.db < -48) return r;
  const q = new Float64Array(291); let sum = 0;
  // fast path when the 930-sample window is inside the buffer
  const inside = c - 320 >= 0 && c - 320 + 639 + 290 < n;
  for (let t = 1; t <= 290; t++) {
    let d = 0;
    if (inside) { const b = c - 320; for (let j = 0; j < 640; j++) { const a = x[b + j] - x[b + j + t]; d += a * a; } }
    else for (let j = 0; j < 640; j++) { const a = s(c - 320 + j) - s(c - 320 + j + t); d += a * a; }
    if (!isFinite(d)) return { hz: 0, confidence: 0, db: -160 };
    sum += d; q[t] = sum ? d * t / sum : 1;
  }
  let k = 0;
  for (let t = 14; t < 290; t++) { if (q[t] < 0.15) { while (t + 1 <= 290 && q[t + 1] < q[t]) t++; k = t; break; } }
  if (!k) return r;
  let tau = k;
  if (k < 290) { const den = q[k - 1] - 2 * q[k] + q[k + 1]; if (Math.abs(den) > 1e-12) tau += 0.5 * (q[k - 1] - q[k + 1]) / den; }
  const hz = 16000 / tau; r.confidence = 1 - q[k];
  if (r.confidence >= 0.85 && hz >= 60 && hz <= 1100) r.hz = hz;
  return r;
}
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
function pitchNote(hz) {
  if (!(hz > 0) || !isFinite(hz)) return '--';
  const m = Math.round(69 + 12 * log2(hz / 440)); // C round(): half away from zero; positive here
  if (m < -10000 || m > 10000) return '--';
  const prefix = m < 33 ? 'low×2' : m < 45 ? 'low' : m < 57 ? 'mid1' : m < 69 ? 'mid2' : m < 81 ? 'hi' : m < 93 ? 'hihi' : 'hihihi';
  return prefix + NOTE_NAMES[((m % 12) + 12) % 12];
}
function noteLabel(hz) { return hz > 0 ? pitchNote(hz) : '—'; } // GaugeArtwork.note

// ---------------- streaming windowed-sinc resampler ----------------
class Resampler {
  constructor(inRate, outRate, halfTaps) {
    this.inRate = inRate; this.outRate = outRate; this.step = inRate / outRate;
    this.cut = Math.min(1, outRate / inRate) * 0.97; this.half = halfTaps || 24;
    this.buf = new Float64Array(0); this.base = 0; this.pos = 0; this.ident = inRate === outRate;
  }
  kernel(d) { // Blackman-windowed sinc (tabulated, linear interpolation), d in input samples
    const half = this.half; const a = Math.abs(d); if (a >= half) return 0;
    if (!this.table) { const R = this.res = 512, T = this.table = new Float64Array(half * R + 2); for (let i = 0; i < T.length; i++) T[i] = this.kernelExact(i / R); }
    const pos = a * this.res, i = Math.floor(pos), u = pos - i; return this.table[i] + (this.table[i + 1] - this.table[i]) * u;
  }
  kernelExact(d) {
    const half = this.half; if (Math.abs(d) >= half) return 0;
    const x = d * this.cut; const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const w = 0.42 + 0.5 * Math.cos(Math.PI * d / half) + 0.08 * Math.cos(2 * Math.PI * d / half);
    return this.cut * sinc * w;
  }
  push(input, end) {
    if (this.ident) return Float32Array.from(input);
    const nb = new Float64Array(this.buf.length + input.length); nb.set(this.buf); nb.set(input, this.buf.length); this.buf = nb;
    const out = []; const half = this.half; const avail = this.base + this.buf.length;
    while (true) {
      const p = this.pos; const ip = Math.floor(p);
      if (!end && ip + half >= avail) break;
      if (end && p >= avail) break;
      let acc = 0;
      for (let i = ip - half + 1; i <= ip + half; i++) { const li = i - this.base; const v = (li >= 0 && li < this.buf.length) ? this.buf[li] : 0; acc += v * this.kernel(p - i); }
      out.push(acc); this.pos += this.step;
    }
    const keep = Math.floor(this.pos) - half - 1 - this.base;
    if (keep > 4096) { this.buf = this.buf.slice(keep); this.base += keep; }
    return Float32Array.from(out);
  }
}
function resampleAll(x, inRate, outRate) { const r = new Resampler(inRate, outRate); const out = r.push(x, true); const want = Math.floor(x.length * outRate / inRate); return out.length > want ? out.subarray(0, want) : out; }

// ---------------- FFT (radix-2, in place, float64) ----------------
const fftCache = {};
function fftTables(n) {
  if (fftCache[n]) return fftCache[n];
  const rev = new Uint32Array(n), bits = Math.round(log2(n));
  for (let i = 0; i < n; i++) { let r = 0, v = i; for (let b = 0; b < bits; b++) { r = (r << 1) | (v & 1); v >>= 1; } rev[i] = r; }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
  return (fftCache[n] = { rev, cos, sin });
}
function fft(re, im) {
  const n = re.length, { rev, cos, sin } = fftTables(n);
  for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= n; size <<= 1) {
    const h = size >> 1, stp = n / size;
    for (let i = 0; i < n; i += size) for (let j = 0, k = 0; j < h; j++, k += stp) {
      const a = i + j, b = a + h, wr = cos[k], wi = sin[k];
      const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
}

// ---------------- RegisterClassifier (register-v1-20261117) ----------------
const RC = {
  weightHrich: -0.9218837323090514, weightCpp: -0.24418134655320295, bias: 7.689149848060506,
  f0Min: 150.0, f0Max: 1400.0, yinThreshold: 0.15, subRelDb: -30.0, maxHarmonicHz: 5000.0,
  cppFmax: 8000.0, cppBins: 512, cppFloorDb: 80.0,
  gateMinRmsDbfs: -50.0, gateMaxAperiodicity: 0.20, gateMinF0: 440.0, gateMaxF0: 1000.0,
  medianFrames: 17, pFalsetto: 0.65, pMix: 0.35, stableFrames: 6, minValidFraction: 0.5,
  fallbackMinHz: 150.0, fallbackMaxHz: 1100.0, fallbackMaxAperiodicity: 0.15, fallbackMinCpp: 2.0,
  fallbackHalfWindowSeconds: 0.035, fallbackMinFrames: 5, fallbackMaxCents: 100.0,
};
const REG = { none: 0, mix: 1, falsetto: 2 };
const REG_LABEL = { 0: null, 1: 'ミックス', 2: '裏声' };

class RegisterClassifier {
  constructor(sampleRate) {
    this.sampleRate = sampleRate || 44100;
    const n = 1 << roundHalfEven(log2(0.0464 * this.sampleRate));
    this.frameLength = n; this.hop = n / 4;
    this.window = new Float64Array(n); for (let i = 0; i < n; i++) this.window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    const m = 2 * RC.cppBins; let lo = 1e9, hi = -1;
    for (let j = 0; j < m; j++) { const q = j / (2 * RC.cppFmax); if (q >= 1 / RC.f0Max && q <= 1 / RC.f0Min) { lo = Math.min(lo, j); hi = Math.max(hi, j); } }
    this.cepLo = lo; this.cepHi = hi;
    const B = RC.cppBins; this.cosTable = new Float64Array((hi - lo + 1) * (B + 1)); let p = 0;
    for (let j = lo; j <= hi; j++) for (let k = 0; k <= B; k++) { const w = (k === 0 || k === B) ? 1 : 2; this.cosTable[p++] = w * Math.cos(2 * Math.PI * k * j / m) / m; }
    this.re = new Float64Array(n); this.im = new Float64Array(n); this.L = new Float64Array(n / 2 + 1);
    const tmax = Math.min(Math.floor(this.sampleRate / RC.f0Min), n / 2 - 1);
    this.d = new Float64Array(tmax + 2); this.cm = new Float64Array(tmax + 2);
  }
  // frame: array-like of length frameLength starting at offset
  features(x, off, skipBelowGate) {
    const n = this.frameLength;
    const out = { rmsDb: -240, f0: 0, aperiodicity: 1, hrichDb: NaN, cpp8k: NaN };
    let ms = 0; for (let i = 0; i < n; i++) { const v = x[off + i]; ms += v * v; } ms /= n;
    out.rmsDb = 20 * log10(Math.sqrt(ms) + 1e-12);
    if (skipBelowGate && out.rmsDb <= RC.gateMinRmsDbfs) return out;
    const [f0yin, ap] = this.yin(x, off);
    out.aperiodicity = ap;
    if (!(f0yin > 0)) return out;
    const re = this.re, im = this.im, w = this.window;
    for (let i = 0; i < n; i++) { re[i] = x[off + i] * w[i]; im[i] = 0; }
    fft(re, im);
    const L = this.L; for (let k = 0; k <= n / 2; k++) L[k] = 20 * log10(Math.sqrt(re[k] * re[k] + im[k] * im[k]) + 1e-12);
    const binHz = this.sampleRate / n;
    const f0 = this.octaveCheck(L, f0yin, binHz);
    out.f0 = f0;
    const H = [];
    for (let k = 1; k * f0 < RC.maxHarmonicHz && k * f0 < this.sampleRate / 2 - binHz * 2; k++) H.push(this.peak(L, k * f0, binHz));
    if (H.length > 1) { let rich = 0; for (let i = 1; i < H.length; i++) rich += Math.pow(10, (H[i] - H[0]) / 10); out.hrichDb = 10 * log10(rich + 1e-6); }
    out.cpp8k = this.cpp(L, binHz);
    return out;
  }
  yin(x, off) {
    const n = this.frameLength, W = n / 2, sr = this.sampleRate;
    const tmin = Math.floor(sr / RC.f0Max), tmax = Math.min(Math.floor(sr / RC.f0Min), W - 1);
    const d = this.d, cm = this.cm;
    for (let t = 1; t <= tmax + 1; t++) { let v = 0; const b = off + t; for (let j = 0; j < W; j++) { const a = x[off + j] - x[b + j]; v += a * a; } d[t] = v; }
    cm[0] = 1; let cs = 0;
    for (let t = 1; t <= tmax + 1; t++) { cs += d[t]; cm[t] = d[t] * t / Math.max(cs, 1e-12); }
    let tau = -1;
    for (let t = tmin; t <= tmax; t++) { if (cm[t] < RC.yinThreshold) { while (t + 1 <= tmax && cm[t + 1] < cm[t]) t++; tau = t; break; } }
    if (tau < 0) { let best = tmin; for (let i = tmin; i <= tmax; i++) if (cm[i] < cm[best]) best = i; return [0, cm[best]]; }
    const a = cm[tau - 1], b = cm[tau], c = cm[tau + 1], den = a - 2 * b + c;
    const shift = Math.abs(den) > 1e-12 ? 0.5 * (a - c) / den : 0;
    return [sr / (tau + shift), b];
  }
  peak(L, hz, binHz) {
    const c = hz / binHz, w = Math.max(1.5, 0.03 * c);
    const lo = Math.max(0, Math.floor(c - w)), hi = Math.min(L.length, Math.ceil(c + w) + 1);
    if (lo >= hi) return -1e9;
    let m = -Infinity; for (let i = lo; i < hi; i++) if (L[i] > m) m = L[i]; return m;
  }
  at(L, hz, binHz) { const i = roundHalfEven(hz / binHz); return L[Math.min(Math.max(i, 0), L.length - 1)]; }
  octaveCheck(L, f0in, binHz) {
    let f0 = f0in;
    for (let it = 0; it < 2; it++) {
      const h = f0 / 2; if (h < RC.f0Min) break;
      const ref = Math.max(this.peak(L, f0, binHz), 2 * f0 < this.sampleRate / 2 - 2 * binHz ? this.peak(L, 2 * f0, binHz) : -1e9);
      const a = this.peak(L, h, binHz), b = this.peak(L, 3 * h, binHz);
      if (a > ref + RC.subRelDb && b > ref + RC.subRelDb && a > this.at(L, 0.75 * f0, binHz) + 10 && b > this.at(L, 1.25 * f0, binHz) + 10) f0 = h; else break;
    }
    return f0;
  }
  cpp(L, binHz) {
    const B = RC.cppBins, g = new Float64Array(B + 1), last = (L.length - 1) * binHz;
    for (let i = 0; i <= B; i++) {
      const f = i * RC.cppFmax / B;
      if (f >= last) { g[i] = L[L.length - 1]; continue; }
      const pos = f / binHz, k = Math.floor(pos), u = pos - k; g[i] = L[k] + (L[k + 1] - L[k]) * u;
    }
    let gmax = -Infinity; for (let i = 0; i <= B; i++) if (g[i] > gmax) gmax = g[i];
    for (let i = 0; i <= B; i++) g[i] = Math.max(g[i], gmax - RC.cppFloorDb);
    const rows = this.cepHi - this.cepLo + 1, c = new Float64Array(rows), T = this.cosTable;
    for (let r = 0, p = 0; r < rows; r++) { let s = 0; for (let k = 0; k <= B; k++) s += T[p++] * g[k]; c[r] = s; }
    const q = new Float64Array(rows); let mq = 0, mc = 0;
    for (let r = 0; r < rows; r++) { q[r] = (this.cepLo + r) / (2 * RC.cppFmax); mq += q[r]; mc += c[r]; }
    mq /= rows; mc /= rows; let sxy = 0, sxx = 0;
    for (let r = 0; r < rows; r++) { sxy += (q[r] - mq) * (c[r] - mc); sxx += (q[r] - mq) * (q[r] - mq); }
    const slope = sxy / sxx, icpt = mc - slope * mq;
    let best = 0; for (let r = 1; r < rows; r++) if (c[r] > c[best]) best = r;
    return c[best] - (slope * q[best] + icpt);
  }
  static hasHarmonics(f) { return f.f0 > 0 && isFinite(f.hrichDb) && isFinite(f.cpp8k); }
  static isValid(f) { return f.f0 > 0 && f.aperiodicity < RC.gateMaxAperiodicity && f.rmsDb > RC.gateMinRmsDbfs && f.f0 >= RC.gateMinF0 && f.f0 <= RC.gateMaxF0 && RegisterClassifier.hasHarmonics(f); }
  static probabilityFalsetto(f) { return 1 / (1 + Math.exp(-(RC.bias + RC.weightHrich * f.hrichDb + RC.weightCpp * f.cpp8k))); }
  static fallbackCandidate(f) {
    if (!(f.f0 >= RC.fallbackMinHz && f.f0 <= RC.fallbackMaxHz && f.aperiodicity < RC.fallbackMaxAperiodicity && f.rmsDb > RC.gateMinRmsDbfs && RegisterClassifier.hasHarmonics(f) && f.cpp8k >= RC.fallbackMinCpp)) return 0;
    return f.f0;
  }
  analyze(mono, opts) {
    opts = opts || {}; const keep = !!opts.keepFeatures, onProgress = opts.onProgress;
    const n = this.frameLength, centers = [], states = [], feats = [], pitch = [], probs = [];
    const sm = new Smoother();
    if (mono.length <= n) return { frameCenters: centers, states, features: feats, pitch, probs };
    let cnt = 0;
    for (let s = 0; s < mono.length - n; s += this.hop) {
      const f = this.features(mono, s, !keep);
      const p = RegisterClassifier.isValid(f) ? RegisterClassifier.probabilityFalsetto(f) : null;
      states.push(sm.push(p)); probs.push(p); pitch.push(RegisterClassifier.fallbackCandidate(f));
      centers.push((s + n / 2) / this.sampleRate); if (keep) feats.push(f);
      if (onProgress && (++cnt % 200 === 0)) onProgress(s / mono.length);
    }
    return { frameCenters: centers, states, features: feats, pitch, probs };
  }
  static fallbackPitch(track, seconds) {
    if (!track.pitch.length) return null;
    const c = track.frameCenters, first = c[0], hop = c.length > 1 ? c[1] - c[0] : 1;
    const lo = Math.max(0, Math.ceil((seconds - RC.fallbackHalfWindowSeconds - first) / hop - 1e-9));
    const hi = Math.min(c.length - 1, Math.floor((seconds + RC.fallbackHalfWindowSeconds - first) / hop + 1e-9));
    if (lo > hi) return null;
    return medianFallback(track.pitch, lo, hi);
  }
  static stateAt(track, seconds, hopSeconds, firstCenter) {
    if (!track.states.length || seconds < firstCenter) return REG.none;
    const i = Math.min(track.states.length - 1, Math.floor((seconds - firstCenter) / hopSeconds + 1e-9));
    return track.states[i];
  }
}
function medianFallback(pitch, lo, hi) {
  const vals = []; for (let i = lo; i <= hi; i++) if (pitch[i] > 0) vals.push(pitch[i]);
  if (vals.length < RC.fallbackMinFrames) return null;
  vals.sort((a, b) => a - b);
  const m = vals.length % 2 ? vals[vals.length >> 1] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
  for (const v of vals) if (Math.abs(1200 * log2(v / m)) > RC.fallbackMaxCents) return null;
  return m;
}
class Smoother {
  constructor() { this.history = []; this.candidate = REG.none; this.count = 0; this.state = REG.none; }
  push(p) {
    this.history.push(p); if (this.history.length > RC.medianFrames) this.history.shift();
    const vals = this.history.filter(v => v !== null).sort((a, b) => a - b);
    let c = REG.none;
    if (p !== null && vals.length >= RC.minValidFraction * RC.medianFrames) {
      const m = vals.length % 2 ? vals[vals.length >> 1] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
      c = m >= RC.pFalsetto ? REG.falsetto : (m <= RC.pMix ? REG.mix : REG.none);
    }
    if (c === this.candidate) this.count++; else { this.candidate = c; this.count = 1; }
    if (this.count >= RC.stableFrames) this.state = c;
    return this.state;
  }
}

// ---------------- LocalAudioPipeline (原音 path) ----------------
function analyzePitch16k(pcm16, onProgress) {
  const frames = [];
  for (let c = 0, k = 0; c < pcm16.length; c += 320, k++) {
    const f = pitchDetect(pcm16, pcm16.length, c);
    frames.push({ seconds: c / 16000, hz: f.hz, confidence: f.confidence, db: f.db, register: 0, fallback: false });
    if (onProgress && k % 250 === 0) onProgress(c / pcm16.length);
  }
  return frames;
}
function attachRegister(frames, mono44100, onProgress) {
  if (!frames.length) return frames;
  const cl = new RegisterClassifier(44100);
  const track = cl.analyze(mono44100, { onProgress });
  if (!track.frameCenters.length) return frames;
  const first = track.frameCenters[0], hopS = cl.hop / cl.sampleRate;
  return frames.map(f => {
    const g = Object.assign({}, f);
    if (!(f.hz > 0)) { const fb = RegisterClassifier.fallbackPitch(track, f.seconds); if (fb !== null) { g.hz = fb; g.fallback = true; } }
    g.register = RegisterClassifier.stateAt(track, f.seconds, hopS, first);
    return g;
  });
}
/** Full offline pipeline: mono at any rate -> 20 ms frames with hz (+fallback) and register. */
function analyzeMono(mono, rate, onProgress) {
  const prog = (a, b) => (u) => onProgress && onProgress(a + (b - a) * u);
  prog(0, 0.05)(0);
  const m44 = rate === 44100 ? mono : resampleAll(mono, rate, 44100);
  prog(0, 0.08)(1);
  const m16 = resampleAll(m44, 44100, 16000);
  prog(0.08, 0.12)(1);
  const frames = analyzePitch16k(m16, prog(0.12, 0.45));
  const out = attachRegister(frames, m44, prog(0.45, 0.99));
  onProgress && onProgress(1);
  return out;
}

// ---------------- LivePitchStream (streaming, same frames as offline) ----------------
class LivePitchStream {
  constructor(inputRate) { this.reset(inputRate || 44100); }
  reset(inputRate) {
    if (inputRate) this.inputRate = inputRate;
    this.to44 = new Resampler(this.inputRate, 44100); this.to16 = new Resampler(44100, 16000);
    this.cl = this.cl || new RegisterClassifier(44100);
    this.pcm16 = new Float32Array(0); this.base16 = 0; this.nextCenter = 0;
    this.pcm44 = new Float64Array(0); this.base44 = 0; this.nextStart = 0; this.total44 = 0;
    this.sm = new Smoother(); this.states = []; this.cands = []; this.pending = []; this.emitted = 0;
  }
  get lagSeconds() { return this.total44 / 44100 - Math.max(0, this.emitted - 1) * 320 / 16000; }
  push(samples) {
    if (!samples.length) return [];
    const s44 = this.to44.push(samples, false);
    if (s44.length) {
      this.total44 += s44.length;
      const nb = new Float64Array(this.pcm44.length + s44.length); nb.set(this.pcm44); nb.set(s44, this.pcm44.length); this.pcm44 = nb;
      const s16 = this.to16.push(s44, false);
      if (s16.length) { const b = new Float32Array(this.pcm16.length + s16.length); b.set(this.pcm16); b.set(s16, this.pcm16.length); this.pcm16 = b; }
    }
    this.runClassifier(); this.runPitch(false); return this.drain(false);
  }
  runClassifier() {
    const n = this.cl.frameLength;
    while (this.nextStart + n < this.total44) {
      const f = this.cl.features(this.pcm44, this.nextStart - this.base44, true);
      this.states.push(this.sm.push(RegisterClassifier.isValid(f) ? RegisterClassifier.probabilityFalsetto(f) : null));
      this.cands.push(RegisterClassifier.fallbackCandidate(f));
      this.nextStart += this.cl.hop;
    }
    const drop = this.nextStart - this.base44;
    if (drop > 8192) { this.pcm44 = this.pcm44.slice(drop); this.base44 = this.nextStart; }
  }
  runPitch(final) {
    const avail = this.base16 + this.pcm16.length;
    while (this.nextCenter < avail && (final || this.nextCenter + 610 <= avail)) {
      const f = pitchDetectWindow(this.pcm16, this.nextCenter - this.base16);
      this.pending.push({ seconds: this.nextCenter / 16000, hz: f.hz, confidence: f.confidence, db: f.db, register: 0, fallback: false });
      this.nextCenter += 320;
      const keepFrom = Math.max(0, this.nextCenter - 320);
      if (keepFrom - this.base16 > 16000) { this.pcm16 = this.pcm16.slice(keepFrom - this.base16); this.base16 = keepFrom; }
    }
  }
  get firstCenter() { return (this.cl.frameLength / 2) / 44100; }
  get stateHop() { return this.cl.hop / 44100; }
  neededIndex(t) {
    const a = Math.floor((t - this.firstCenter) / this.stateHop + 1e-9);
    const b = Math.floor((t + RC.fallbackHalfWindowSeconds - this.firstCenter) / this.stateHop + 1e-9);
    return Math.max(a, b);
  }
  drain(final) {
    const out = []; let k = 0;
    while (k < this.pending.length) { const f = this.pending[k]; if (!final && this.neededIndex(f.seconds) >= this.states.length) break; out.push(this.finalize(f)); k++; }
    this.pending.splice(0, k); this.emitted += out.length; return out;
  }
  finalize(f) {
    if (!this.states.length) return f;
    const g = Object.assign({}, f);
    if (!(f.hz > 0)) {
      const first = this.firstCenter, hop = this.states.length > 1 ? this.stateHop : 1;
      const lo = Math.max(0, Math.ceil((f.seconds - RC.fallbackHalfWindowSeconds - first) / hop - 1e-9));
      const hi = Math.min(this.states.length - 1, Math.floor((f.seconds + RC.fallbackHalfWindowSeconds - first) / hop + 1e-9));
      if (lo <= hi) { const m = medianFallback(this.cands, lo, hi); if (m !== null) { g.hz = m; g.fallback = true; } }
    }
    if (f.seconds >= this.firstCenter) g.register = this.states[Math.min(this.states.length - 1, Math.floor((f.seconds - this.firstCenter) / this.stateHop + 1e-9))];
    return g;
  }
}
// pitch_detect on a buffer whose index 0 is base16 (values before the buffer were trimmed only when unneeded)
function pitchDetectWindow(buf, center) { return pitchDetect(buf, buf.length, center); }

// ---------------- GaugeRange / GaugeBandRule / timelines ----------------
function defaultRange() { return { low: 52, high: 74, split1: 64, split2: 74, acceptedLow: 0, acceptedHigh: 0 }; }
function makeRange(frames) {
  if (frames.length < 5) return defaultRange();
  const adopted = new Uint8Array(frames.length); let any = false;
  for (let i = 0; i <= frames.length - 5; i++) {
    let lo = Infinity, hi = -Infinity, ok = true;
    for (let j = i; j < i + 5; j++) { const h = frames[j].hz; if (!(isFinite(h) && h >= 60 && h <= 1100)) { ok = false; break; } lo = Math.min(lo, h); hi = Math.max(hi, h); }
    if (ok && 1200 * log2(hi / lo) <= 100 + 1e-7) { for (let j = i; j < i + 5; j++) adopted[j] = 1; any = true; }
  }
  if (!any) return defaultRange();
  let lo = Infinity, hi = -Infinity; for (let i = 0; i < frames.length; i++) if (adopted[i]) { lo = Math.min(lo, frames[i].hz); hi = Math.max(hi, frames[i].hz); }
  let l = 69 + 12 * log2(lo / 440), h = 69 + 12 * log2(hi / 440);
  if (h - l < 1 - 1e-7) { const c = (l + h) / 2; l = c - 6; h = c + 6; }
  return { low: l, high: h, split1: l + (h - l) / 3, split2: l + 2 * (h - l) / 3, acceptedLow: lo, acceptedHigh: hi };
}
const BandRule = {
  /** Hide thresholds in gauge position (0…1, pointer scale), same as iOS GaugeBandRule.labelPositions:
   *  "on" a label = the pointer dot overlaps the label's extent (label edge ± dot radius).
   *  Horizontal: labels centred at 1/2 and 5/6, ~1em per glyph (0.026·gw), dot radius 0.019·gw.
   *  Vertical (9:16 canvas): stacked glyph columns, dot radius 0.022·w. */
  labelPositions(vertical, aspect) {
    if (!vertical) { const glyph = 0.026, dot = 0.019; return { mix: 0.5 + 2 * glyph + dot, ura: 5 / 6 - 1 * glyph - dot }; }
    const a = aspect || 9 / 16, sp = 0.034 * a, f = 0.027 * a, dot = 0.022 * a / 0.5;
    const pos = (y) => (0.68 - y) / 0.5;
    const mixTop = 0.405 - 0.88 * f, uraBottom = 0.195 + 1 * sp + 0.12 * f;
    return { mix: pos(mixTop) + dot, ura: pos(uraBottom) - dot };
  },
  // 裏声 judgment at/left (vertical: at/below) of fixed ミックス -> hide ミックス; ミックス judgment at/right (vertical: at/above) of fixed 裏声 -> hide 裏声
  targets(register, judgmentVisible, position, vertical) {
    if (!judgmentVisible) return { mix: 1, ura: 1 };
    const at = BandRule.labelPositions(vertical);
    if (register === REG.falsetto) return { mix: position <= at.mix ? 0 : 1, ura: 1 };
    if (register === REG.mix) return { mix: 1, ura: position >= at.ura ? 0 : 1 };
    return { mix: 1, ura: 1 };
  },
  fadeSeconds: 0.05,
  fade(v, t, dt) { return v + (t - v) * (1 - Math.exp(-dt / BandRule.fadeSeconds)); },
  position(midi, range) { return Math.min(1, Math.max(0, (midi - range.low) / (range.high - range.low))); },
};
/** Incremental timeline (GaugeTimeline at 30 fps / LiveGaugeTimeline). */
class GaugeTimeline {
  constructor(frames, range, vertical) { this.vertical = !!vertical; this.frames = frames || []; this.range = range || makeRange(this.frames); this.fixedRange = !!range || !!frames;
    this.valid = false; this.from = 0; this.to = 0; this.start = 0; this.lastPitch = -99; this.index = -1; this.opacity = 0;
    this.lastVoiced = -99; this.readoutHz = 0; this.readoutTime = -99; this.readoutRegister = 0; this.mixBand = 1; this.uraBand = 1; this.lastTick = 0; this.lastRangeUpdate = -99; }
  value(t) { const u = Math.min(1, Math.max(0, (t - this.start) / 0.12)); return this.from + (this.to - this.from) * u * u * (3 - 2 * u); }
  append(fr) { for (const f of fr) this.frames.push(f); }
  tick(t, dt, live) {
    if (live && t - this.lastRangeUpdate >= 1) { this.range = makeRange(this.frames.slice(-1500)); this.lastRangeUpdate = t; }
    const fr = this.frames, end = Math.min(fr.length - 1, Math.round(t / 0.02));
    if (end > this.index) { for (let i = this.index + 1; i <= end; i++) {
      const hz = fr[i].hz, ft = i * 0.02;
      if (hz > 0 && isFinite(hz)) { const target = Math.round(69 + 12 * log2(hz / 440));
        if (!this.valid || ft - this.lastPitch > 0.8) { this.valid = true; this.from = target; this.to = target; this.start = ft; }
        else if (target !== this.to) { this.from = this.value(ft); this.to = target; this.start = ft; }
        this.lastPitch = ft; }
    } this.index = end; }
    const hz = end >= 0 ? fr[end].hz : 0;
    if (hz > 0) { this.lastVoiced = t; this.readoutHz = hz; this.readoutTime = t; this.readoutRegister = fr[end].register; }
    const target = hz > 0 ? 1 : Math.max(0, 1 - Math.max(0, t - this.lastVoiced - 0.14) / 0.35);
    this.opacity += (target - this.opacity) * (1 - Math.exp(-(1 / 30) / 0.10));
    const fade = Math.min(1, Math.max(0, (t - this.readoutTime) / 0.8));
    const range = this.range;
    const midi = this.valid ? this.value(t) : (range.low + range.high) / 2, readoutAlpha = this.readoutHz > 0 ? 1 - fade * fade * (3 - 2 * fade) : 0;
    const band = BandRule.targets(this.readoutRegister, readoutAlpha > 0.01, BandRule.position(midi, range), this.vertical);
    const d = dt !== undefined ? dt : 1 / 30;
    this.mixBand = BandRule.fade(this.mixBand, band.mix, d); this.uraBand = BandRule.fade(this.uraBand, band.ura, d);
    return { midi, opacity: this.opacity, hz: this.readoutHz, readoutAlpha, register: this.readoutRegister, mixBandAlpha: this.mixBand, uraBandAlpha: this.uraBand };
  }
}
/** Precomputed 30 fps states for file playback (GaugeTimeline.init). */
function buildStates(frames, vertical) {
  const tl = new GaugeTimeline(frames, makeRange(frames), vertical); const states = [];
  const count = Math.max(1, Math.ceil(frames.length * 0.02 * 30));
  for (let k = 0; k < count; k++) states.push(tl.tick(k / 30, 1 / 30, false));
  return { range: tl.range, states };
}

const api = { roundHalfEven, pitchDetect, pitchNote, noteLabel, Resampler, resampleAll, fft, RC, REG, REG_LABEL, RegisterClassifier, Smoother,
  analyzePitch16k, attachRegister, analyzeMono, LivePitchStream, makeRange, defaultRange, BandRule, GaugeTimeline, buildStates };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PMCore = api;
})(typeof self !== 'undefined' ? self : this);
