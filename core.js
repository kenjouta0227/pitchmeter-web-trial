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

// ---------------- RegisterClassifier (register-v1.1-20261117) ----------------
const RC = {
  weightHrich: -0.9218837323090514, weightCpp: -0.4883626931064059, bias: 8.665875234273317,
  kOct: 6.0, fRefHz: 698.0, mixFloorHz: 440.0,
  f0Min: 150.0, f0Max: 1400.0, yinThreshold: 0.15, subRelDb: -30.0, maxHarmonicHz: 5000.0,
  cppFmax: 8000.0, cppBins: 512, cppFloorDb: 80.0, breathLoHz: 1000.0,
  // 2026-11-17 裏声ミックス / 息漏れ: see Smoother.push
  pHead: 0.85, breathyDb: -30.0, cleanDb: -38.0, relaxedYinThreshold: 0.35, relaxedBreathMin: -30.0, relaxedBreathMax: -6.0,
  gateMinRmsDbfs: -50.0, gateMaxAperiodicity: 0.20, gateMinF0: 387.0, gateMaxF0: 1000.0,
  medianFrames: 17, pFalsetto: 0.70, pMix: 0.35, stableFrames: 6, minValidFraction: 0.5,
  fallbackMinHz: 150.0, fallbackMaxHz: 1100.0, fallbackMaxAperiodicity: 0.15, fallbackMinCpp: 2.0,
  fallbackHalfWindowSeconds: 0.035, fallbackMinFrames: 5, fallbackMaxCents: 100.0,
  // 2026-11-18 低音域の地声/裏声 (default, no calibration): below the ミックス floor (100–440 Hz) a separate 2-class model
  // fitted on the owner's labelled takes (31 地声 / 30 裏声, leave-one-take-out CV) decides 地声 vs 裏声:
  //   z = b + wh·hrichDb + wc·cpp8k + wf·log2(f0/440); q = σ(z) = P(裏声); q ≥ conf → 裏声 vote, q ≤ 1−conf → 地声 vote, else not judged.
  //   no 裏声 vote below uraMinHz (lowest 裏声 in the data ≈ 200 Hz; also cpp is unreliable below 150 Hz) → only 地声 or not judged there.
  low: { minHz: 100.0, maxHz: 440.0, uraMinHz: 185.0, b: 13.3831, wh: -0.5016, wc: -1.1122, wf: 9.6975, conf: 0.85 },
  yinMinHz: 95.0, // default YIN floor (was f0Min 150) so 地声 down to ~ラ2 gets an f0; personal calibration keeps its own floors
};
const REG = { none: 0, mix: 1, falsetto: 2, chest: 3, uraMix: 4 };
const REG_LABEL = { 0: null, 1: 'ミックス', 2: '裏声', 3: '地声', 4: '裏声ミックス' }; // 3 (地声): default below 440 Hz (RC.low) or a personal 地声 calibration

class RegisterClassifier {
  constructor(sampleRate, opts) {
    this.sampleRate = sampleRate || 44100;
    // default YIN floor RC.yinMinHz (95 Hz, 2026-11-18); a personal calibration passes its own (80 Hz with 地声, else 150 Hz).
    this.yinMinHz = (opts && opts.yinMinHz > 0) ? opts.yinMinHz : RC.yinMinHz;
    this.relaxed = !(opts && opts.noRelaxed); // calibration recordings use strict frames only
    const n = 1 << roundHalfEven(log2(0.0464 * this.sampleRate));
    this.frameLength = n; this.hop = n / 4;
    this.window = new Float64Array(n); for (let i = 0; i < n; i++) this.window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    const m = 2 * RC.cppBins; let lo = 1e9, hi = -1;
    for (let j = 0; j < m; j++) { const q = j / (2 * RC.cppFmax); if (q >= 1 / RC.f0Max && q <= 1 / RC.f0Min) { lo = Math.min(lo, j); hi = Math.max(hi, j); } }
    this.cepLo = lo; this.cepHi = hi;
    const B = RC.cppBins; this.cosTable = new Float64Array((hi - lo + 1) * (B + 1)); let p = 0;
    for (let j = lo; j <= hi; j++) for (let k = 0; k <= B; k++) { const w = (k === 0 || k === B) ? 1 : 2; this.cosTable[p++] = w * Math.cos(2 * Math.PI * k * j / m) / m; }
    this.re = new Float64Array(n); this.im = new Float64Array(n); this.L = new Float64Array(n / 2 + 1);
    const tmax = Math.min(Math.floor(this.sampleRate / this.yinMinHz), n / 2 - 1);
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
    // relaxed gate (very breathy falsetto): YIN found no dip < 0.15 but one < 0.35. Kept out of f0/hrich/cpp; may only vote 裏声.
    let relaxed = 0;
    if (!(f0yin > 0)) { if (!this.relaxed || !(ap < RC.relaxedYinThreshold)) return out; relaxed = this.yinRelaxed(); if (!(relaxed > 0)) return out; }
    const re = this.re, im = this.im, w = this.window;
    for (let i = 0; i < n; i++) { re[i] = x[off + i] * w[i]; im[i] = 0; }
    fft(re, im);
    const L = this.L; for (let k = 0; k <= n / 2; k++) L[k] = 20 * log10(Math.sqrt(re[k] * re[k] + im[k] * im[k]) + 1e-12);
    const binHz = this.sampleRate / n;
    if (relaxed) { const fr = this.octaveCheck(L, relaxed, binHz); out.relaxedF0 = fr; out.breathDb = this.breath(L, fr, binHz); return out; }
    const f0 = this.octaveCheck(L, f0yin, binHz);
    out.f0 = f0;
    const H = [];
    for (let k = 1; k * f0 < RC.maxHarmonicHz && k * f0 < this.sampleRate / 2 - binHz * 2; k++) H.push(this.peak(L, k * f0, binHz));
    if (H.length > 1) { let rich = 0; for (let i = 1; i < H.length; i++) rich += Math.pow(10, (H[i] - H[0]) / 10); out.hrichDb = 10 * log10(rich + 1e-6); }
    out.cpp8k = this.cpp(L, binHz);
    out.breathDb = this.breath(L, f0, binHz);
    return out;
  }
  yin(x, off) {
    const n = this.frameLength, W = n / 2, sr = this.sampleRate;
    const tmin = Math.floor(sr / RC.f0Max), tmax = Math.min(Math.floor(sr / this.yinMinHz), W - 1);
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
  yinRelaxed() { // re-scan the last YIN curve with the relaxed threshold
    const n = this.frameLength, W = n / 2, sr = this.sampleRate, cm = this.cm;
    const tmin = Math.floor(sr / RC.f0Max), tmax = Math.min(Math.floor(sr / this.yinMinHz), W - 1);
    for (let t = tmin; t <= tmax; t++) if (cm[t] < RC.relaxedYinThreshold) { while (t + 1 <= tmax && cm[t + 1] < cm[t]) t++;
      const a = cm[t - 1], b = cm[t], c = cm[t + 1], den = a - 2 * b + c; return sr / (t + (Math.abs(den) > 1e-12 ? 0.5 * (a - c) / den : 0)); }
    return 0;
  }
  peak(L, hz, binHz) {
    const c = hz / binHz, w = Math.max(1.5, 0.03 * c);
    const lo = Math.max(0, Math.floor(c - w)), hi = Math.min(L.length, Math.ceil(c + w) + 1);
    if (lo >= hi) return -1e9;
    let m = -Infinity; for (let i = lo; i < hi; i++) if (L[i] > m) m = L[i]; return m;
  }
  /** Breathiness (息漏れ): mean inter-harmonic valley power relative to mean harmonic peak power, harmonics in 1–5 kHz (dB; closer to 0 = noisier). */
  breath(L, f0, binHz) {
    let pk = 0, va = 0, n = 0;
    for (let k = Math.max(1, Math.ceil(RC.breathLoHz / f0)); (k + 1) * f0 <= RC.maxHarmonicHz && (k + 1) * f0 < this.sampleRate / 2 - 2 * binHz; k++) {
      pk += Math.pow(10, this.peak(L, k * f0, binHz) / 10); va += Math.pow(10, this.at(L, (k + 0.5) * f0, binHz) / 10); n++; }
    return n >= 2 ? 10 * log10(va / pk + 1e-12) : NaN;
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
  static hrichEffective(f) {
    let h = f.hrichDb;
    if (f.f0 > 0) h -= RC.kOct * Math.max(0, Math.log2(RC.fRefHz / f.f0));
    return h;
  }
  static probabilityFalsetto(f) { return 1 / (1 + Math.exp(-(RC.bias + RC.weightHrich * RegisterClassifier.hrichEffective(f) + RC.weightCpp * f.cpp8k))); }
  static fallbackCandidate(f) {
    if (!(f.f0 >= RC.fallbackMinHz && f.f0 <= RC.fallbackMaxHz && f.aperiodicity < RC.fallbackMaxAperiodicity && f.rmsDb > RC.gateMinRmsDbfs && RegisterClassifier.hasHarmonics(f) && f.cpp8k >= RC.fallbackMinCpp)) return 0;
    return f.f0;
  }
  analyze(mono, opts) {
    opts = opts || {}; const keep = !!opts.keepFeatures, onProgress = opts.onProgress;
    const n = this.frameLength, centers = [], states = [], feats = [], pitch = [], probs = [];
    const P = opts.personal || null, sm = new Smoother(P);
    if (mono.length <= n) return { frameCenters: centers, states, features: feats, pitch, probs };
    let cnt = 0;
    for (let s = 0; s < mono.length - n; s += this.hop) {
      const f = this.features(mono, s, !keep);
      const p = frameValue(P, f);
      states.push(sm.push(p, f.f0, f.breathDb)); probs.push(p); pitch.push(RegisterClassifier.fallbackCandidate(f));
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
/** Display smoothing over 17 frames (~0.2 s), switches after 6 identical candidates.
 *  Frame values: p(裏声) 0…1, CAL.CHEST (地声 frame: personal, or default below 440 Hz via lowValue), CAL.BREATHY (relaxed-gate breathy frame: votes 裏声 only), or null.
 *  Thresholds T = personal calibration or the defaults in RC:
 *   median p ≥ pF → 裏声, ≤ pM → ミックス, between → 裏声ミックス (2026-11-17; was: no judgment)
 *   息漏れ (median breathDb of the window): 裏声ミックス in the 裏声-side half of the zone (m ≥ (pF+pM)/2) with breath ≥ breathyDb → 裏声;
 *     裏声 with p < pHead (just above pF) and breath ≤ cleanDb (little breath) → 裏声ミックス
 *   ミックス / 裏声ミックス are not shown below mixFloorHz; a breathy relaxed frame can never yield ミックス / 裏声ミックス. */
class Smoother {
  constructor(personal) { this.history = []; this.bhist = []; this.candidate = REG.none; this.count = 0; this.state = REG.none; this.T = thresholdsOf(personal); }
  push(p, f0, breath) {
    const T = this.T, med = (a) => a.length % 2 ? a[a.length >> 1] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
    this.history.push(p); this.bhist.push(p === null || p === CAL.CHEST ? NaN : breath);
    if (this.history.length > RC.medianFrames) { this.history.shift(); this.bhist.shift(); }
    const vals = this.history.filter(v => v !== null);
    let c = REG.none;
    if (p !== null && vals.length >= RC.minValidFraction * RC.medianFrames) {
      const chestN = vals.filter(v => v === CAL.CHEST).length;
      if (chestN * 2 > vals.length) c = REG.chest;
      else {
        const ps = vals.filter(v => v !== CAL.CHEST).map(v => v === CAL.BREATHY ? 1 : v).sort((a, b) => a - b);
        if (ps.length) {
          const m = med(ps);
          c = m >= T.pF ? REG.falsetto : (m <= T.pM ? REG.mix : REG.uraMix);
          const bs = this.bhist.filter(isFinite).sort((a, b) => a - b);
          if (bs.length) { const mb = med(bs);
            if (c === REG.uraMix && mb >= T.breathyDb && m >= (T.pF + T.pM) / 2) c = REG.falsetto;
            else if (c === REG.falsetto && m < T.pHead && mb <= T.cleanDb) c = REG.uraMix; }
          if (p === CAL.BREATHY && c !== REG.falsetto) c = REG.none;
          if ((c === REG.mix || c === REG.uraMix) && f0 > 0 && f0 < T.mixFloorHz) c = REG.none;
          if ((c === REG.mix || c === REG.uraMix) && !(f0 > 0)) c = REG.none;
        }
      }
    }
    if (c === this.candidate) this.count++; else { this.candidate = c; this.count = 1; }
    if (this.count >= RC.stableFrames) this.state = c;
    return this.state;
  }
}
function thresholdsOf(P) {
  const T = { pF: RC.pFalsetto, pM: RC.pMix, pHead: RC.pHead, breathyDb: RC.breathyDb, cleanDb: RC.cleanDb, mixFloorHz: RC.mixFloorHz, gateMinF0: RC.gateMinF0 };
  if (P) for (const k in T) if (typeof P[k] === 'number' && isFinite(P[k])) T[k] = P[k];
  return T;
}
/** Default 低音域 (RC.low.minHz ≤ f0 < maxHz): 1 (裏声 vote, f0 ≥ uraMinHz only), CAL.CHEST (地声 vote) or null; undefined = outside the region. */
function lowValue(f) {
  const L = RC.low;
  if (!(f.f0 >= L.minHz && f.f0 < L.maxHz)) return undefined;
  if (!(f.aperiodicity < RC.gateMaxAperiodicity && f.rmsDb > RC.gateMinRmsDbfs && RegisterClassifier.hasHarmonics(f))) return null;
  const q = 1 / (1 + Math.exp(-(L.b + L.wh * f.hrichDb + L.wc * f.cpp8k + L.wf * log2(f.f0 / 440))));
  return q >= L.conf ? (f.f0 >= L.uraMinHz ? 1 : null) : (q <= 1 - L.conf ? CAL.CHEST : null);
}
/** Per-frame smoother value (default or personal). */
function frameValue(P, f) {
  const gateMin = P ? P.gateMinF0 : RC.gateMinF0;
  if (!(f.f0 > 0)) { // relaxed breathy frame → 裏声 vote only
    const fr = f.relaxedF0;
    if (fr >= gateMin && fr <= RC.gateMaxF0 && f.rmsDb > RC.gateMinRmsDbfs && f.breathDb >= (P && isFinite(P.breathyDb) ? Math.max(RC.relaxedBreathMin, P.breathyDb) : RC.relaxedBreathMin) && f.breathDb <= RC.relaxedBreathMax) return CAL.BREATHY;
    return null;
  }
  if (!P) { const lv = lowValue(f); if (lv !== undefined) return lv; return RegisterClassifier.isValid(f) ? RegisterClassifier.probabilityFalsetto(f) : null; }
  return personalValue(P, f);
}

// ---------------- Personal calibration (「地声を録る」「ミックスを録る」「裏声ミックスを録る」「裏声を録る」) ----------------
// Recordings are reduced on the device to per-frame features [f0 Hz, hrichDb, cpp8k, breathDb, targetHz]; no raw audio is kept.
const CAL = {
  // enabled (2026-11-17): app.js passes buildCalibration(samples) only when samples exist AND 「サンプル音声を適用」 is on;
  // otherwise personal = null and judging is exactly the published default.
  enabled: true, version: 2, CHEST: 2, BREATHY: 3, // smoother markers (p values are 0…1)
  chestMinHz: 80, sampleMinHz: 150, sampleMaxHz: 1000, minVoicedSeconds: 2.0, maxFrames: 900, targetToleranceSemis: 3,
  margin: 1.0, maxShift: 8.0, lambda: 0.01, fitIters: 40, quantLow: 0.1, quantHigh: 0.9, headMargin: 0.5, tailLow: 0.02, tailHigh: 0.98, uramixLowMargin: 0.0, minNoteFrames: 10, minBand: 0.4,
  splitMinDb: -45.0, splitMaxDb: -25.0, floorRatio: 0.94, floorQuantile: 0.05, minGateHz: 150, breathSplitMinDb: 3.0,
  scaleFloor: [3.0, 0.5, 6.0], chestMaxDistAlone: 2.0, chestMaxDist: 3.0,
  categories: ['chest', 'mix', 'uramix', 'ura'],
};
// Guide staircases (whole tones, key 0 = male default). The overlaps レ4–ミ4 and ソ4–ファ5 are intentional.
const GUIDE = { chest: [45, 64], mix: [62, 77], uramix: [64, 81], ura: [67, 83] }; // MIDI: ラ2 110 Hz→ミ4 330, レ4 294→ファ5 698, ミ4 330→ラ5 880, ソ4 392→シ5 988
const DOREMI = ['ド', 'ド♯', 'レ', 'レ♯', 'ミ', 'ファ', 'ファ♯', 'ソ', 'ソ♯', 'ラ', 'ラ♯', 'シ'];
const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const doremi = (m) => DOREMI[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);
function guideNotes(category, keyShift) {
  const g = GUIDE[category]; if (!g) return []; const k = Math.round(keyShift || 0), out = [];
  for (let m = g[0]; m <= g[1]; m += 2) out.push(m + k);
  if (out[out.length - 1] !== g[1] + k) out.push(g[1] + k);
  return out.map(m => ({ midi: m, hz: midiHz(m), name: doremi(m) }));
}
const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const quantile = (a, q) => { if (!a.length) return NaN; const s = Float64Array.from(a).sort(); const pos = q * (s.length - 1), i = Math.floor(pos), u = pos - i; return i + 1 < s.length ? s[i] + (s[i + 1] - s[i]) * u : s[i]; };
const hEffOf = (f0, hrich) => hrich - RC.kOct * Math.max(0, log2(RC.fRefHz / f0));
/** Features of a calibration recording (mono at any rate). category: 'chest'|'mix'|'uramix'|'ura'.
 *  opts.targetHz: frames further than ±3 semitones from the target are dropped (octave errors, slides). */
function calibrationFrames(mono, rate, category, opts) {
  opts = opts || {};
  const m44 = rate === 44100 ? mono : resampleAll(mono, rate, 44100);
  const chest = category === 'chest', lo = chest ? CAL.chestMinHz : CAL.sampleMinHz, t = opts.targetHz || 0;
  const cl = new RegisterClassifier(44100, { yinMinHz: chest ? CAL.chestMinHz : RC.f0Min, noRelaxed: true }), n = cl.frameLength;
  let out = [];
  for (let s = 0; s < m44.length - n; s += cl.hop) {
    const f = cl.features(m44, s, true);
    if (!(f.f0 >= lo && f.f0 <= CAL.sampleMaxHz && f.aperiodicity < RC.gateMaxAperiodicity && f.rmsDb > RC.gateMinRmsDbfs && RegisterClassifier.hasHarmonics(f))) continue;
    if (t && Math.abs(12 * log2(f.f0 / t)) > CAL.targetToleranceSemis) continue;
    out.push([Math.round(f.f0 * 100) / 100, Math.round(f.hrichDb * 1000) / 1000, Math.round(f.cpp8k * 10000) / 10000, isFinite(f.breathDb) ? Math.round(f.breathDb * 100) / 100 : null, t ? Math.round(t * 100) / 100 : 0]);
  }
  const voicedSeconds = out.length * cl.hop / 44100;
  if (out.length > CAL.maxFrames) { const k = out.length / CAL.maxFrames, d = []; for (let i = 0; i < CAL.maxFrames; i++) d.push(out[Math.floor(i * k)]); out = d; }
  return { frames: out, voicedSeconds, medianF0: out.length ? quantile(out.map(r => r[0]), 0.5) : 0, ok: voicedSeconds >= CAL.minVoicedSeconds };
}
function solve3(A, b) {
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 3; c++) { let p = c; for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) return null; for (let r = 0; r < 3; r++) if (r !== c) { const k = M[r][c] / M[c][c]; for (let j = c; j < 4; j++) M[r][j] -= k * M[c][j]; } }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}
/** Class-balanced logistic regression on (1, hrichEff, cpp8k), y=1 for 裏声, L2 prior toward the default weights. */
function fitLogistic(ura, mix, theta0) {
  let th = theta0.slice(); const data = [];
  for (const x of ura) data.push([x, 1, 0.5 / ura.length]); for (const x of mix) data.push([x, 0, 0.5 / mix.length]);
  for (let it = 0; it < CAL.fitIters; it++) {
    const g = th.map((v, i) => CAL.lambda * (v - theta0[i])), H = [[CAL.lambda, 0, 0], [0, CAL.lambda, 0], [0, 0, CAL.lambda]];
    for (const [x, y, w] of data) { const v = [1, x[0], x[1]], z = th[0] + th[1] * v[1] + th[2] * v[2], s = sigmoid(z), r = w * s * (1 - s);
      for (let i = 0; i < 3; i++) { g[i] += w * (s - y) * v[i]; for (let j = 0; j < 3; j++) H[i][j] += r * v[i] * v[j]; } }
    const d = solve3(H, g); if (!d) break; th = th.map((v, i) => v - d[i]);
    if (Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]) < 1e-9) break;
  }
  return th;
}
const noteKey = (r) => Math.round(12 * log2((r[4] || r[0]) / 440)); // semitone index of the guide note (or of f0)
/** Personal classifier parameters from the stored samples ({chest, mix, uramix, ura}: {frames}). null when nothing is registered.
 *  Order on the 裏声-logit axis z: 裏声 (high) > 裏声ミックス > ミックス (low). Frames are mapped per pitch so that
 *  the 裏声|裏声ミックス edge lands on p = pFalsetto and the 裏声ミックス|ミックス edge on p = pMix (see personalValue). */
function buildCalibration(samples) {
  samples = samples || {};
  const fr = (k) => (samples[k] && samples[k].frames && samples[k].frames.length) ? samples[k].frames : null;
  const U = fr('ura'), M = fr('mix'), H = fr('uramix'), K = fr('chest');
  if (!U && !M && !H && !K) return null;
  const Lf = logit(RC.pFalsetto), Lm = logit(RC.pMix), mg = CAL.margin;
  const xs = (F) => F.map(r => [hEffOf(r[0], r[1]), r[2]]);
  let th = [RC.bias, RC.weightHrich, RC.weightCpp], method = 'default', quality = 'ok';
  const zs = (F, t) => xs(F).map(x => t[0] + t[1] * x[0] + t[2] * x[1]);
  if (U && M) {
    const fit = fitLogistic(xs(U), xs(M), th);
    const zU = zs(U, fit), zM = zs(M, fit), qU = quantile(zU, CAL.quantLow), qM = quantile(zM, CAL.quantHigh);
    let lo = null, hi = null;
    if (qU > qM) { lo = [qM, Lm - mg]; hi = [qU, Lf + mg]; method = 'fit'; }
    else { const mU = quantile(zU, 0.5), mM = quantile(zM, 0.5); if (mU > mM) { lo = [mM, Lm]; hi = [mU, Lf]; method = 'fit-median'; quality = 'overlap'; } }
    if (lo) { const a = Math.min(20, Math.max(0.05, (hi[1] - lo[1]) / (hi[0] - lo[0]))); th = [a * (fit[0] - lo[0]) + lo[1], a * fit[1], a * fit[2]]; }
    else { method = 'default'; quality = 'inseparable'; }
  } else if (U) { const q = quantile(zs(U, th), CAL.quantLow); th[0] += Math.min(CAL.maxShift, Math.max(0, Lf + mg - q)); method = 'shift-ura'; }
  else if (M) { const q = quantile(zs(M, th), CAL.quantHigh); th[0] -= Math.min(CAL.maxShift, Math.max(0, q - (Lm - mg))); method = 'shift-mix'; }
  // ---- edges on the z axis (global, then per guide note) ----
  const zOf = (F) => zs(F, th), med = (a) => quantile(a, 0.5);
  // Edges between recorded categories sit in the gap between their tails (2 % / 98 %), so each recording keeps its own
  // label; 裏声ミックス stays the narrow, ambiguous zone (「あいまいなところだけ」): without a 裏声ミックス recording it is the
  // middle third of the 裏声|ミックス gap, with one its ミックス-side edge stays near that recording's low tail.
  const tLo = (a) => quantile(a, CAL.tailLow), tHi = (a) => quantile(a, CAL.tailHigh);
  const edgesFor = (u, h, m) => { // u/h/m: z arrays (or null) of 裏声 / 裏声ミックス / ミックス
    let up = Lf, lo = Lm;
    if (h) {
      const mh = med(h);
      if (u) { const a = tLo(u), b = tHi(h); if (a > b) up = (a + b) / 2; else if (med(u) > mh) up = (med(u) + mh) / 2; }
      else up = Math.max(Lf, quantile(h, 0.9) + CAL.headMargin);
      if (m) { const a = tLo(h), b = tHi(m); if (a > b) lo = Math.max((a + b) / 2, quantile(h, 0.05) - CAL.uramixLowMargin); else if (mh > med(m)) lo = (mh + med(m)) / 2; }
      else lo = Math.min(Lm, quantile(h, 0.1) - CAL.headMargin);
    } else if (u && m) {
      const a = tLo(u), b = tHi(m);
      if (a > b) { lo = b + (a - b) / 3; up = a - (a - b) / 3; }
      else { const c = (med(u) + med(m)) / 2, mid = (Lf + Lm) / 2; up = Lf + (c - mid); lo = Lm + (c - mid); }
    }
    if (up - lo < CAL.minBand) { const c = (up + lo) / 2; up = c + CAL.minBand / 2; lo = c - CAL.minBand / 2; }
    return [up, lo];
  };
  const order = (h, u, m) => !h || ((!u || med(u) > med(h)) && (!m || med(h) > med(m)));
  if (H && !order(zOf(H), U && zOf(U), M && zOf(M))) quality = 'uramix-order';
  const [gUp, gLo] = (H && quality === 'uramix-order') ? edgesFor(null, null, null) : edgesFor(U && zOf(U), H && zOf(H), M && zOf(M));
  const table = []; // [log2 Hz, up, lo] where ≥2 categories were recorded on the same guide note
  { const by = {}; const add = (F, k) => { if (F) for (const r of F) { if (!r[4]) continue; /* guide-note recordings only */ const n = noteKey(r); (by[n] = by[n] || { ura: [], uramix: [], mix: [] })[k].push(r); } };
    add(U, 'ura'); add(H, 'uramix'); add(M, 'mix');
    for (const n of Object.keys(by).map(Number).sort((a, b) => a - b)) {
      const g = by[n], ok = (k) => g[k].length >= CAL.minNoteFrames ? zOf(g[k]) : null, u = ok('ura'), h = ok('uramix'), m = ok('mix');
      if ([u, h, m].filter(Boolean).length < 2 || !order(h, u, m)) continue;
      let [up, lo] = edgesFor(u, h, m);
      if (!h) { /* no 裏声ミックス on this note: keep the global band width around this note's 裏声|ミックス centre */ }
      if (!u && h) up = Math.max(up, gUp); if (!m && h) lo = Math.min(lo, gLo);
      table.push([log2(440 * Math.pow(2, n / 12)), up, lo]);
    } }
  // ---- 息漏れ split (裏声 vs 裏声ミックス recordings) ----
  let breathyDb = RC.breathyDb, cleanDb = RC.cleanDb;
  const bmed = (F) => { const b = F.map(r => r[3]).filter(v => v !== null && isFinite(v)); return b.length ? med(b) : NaN; };
  let split = false;
  if (U && H) { const bu = bmed(U), bh = bmed(H); if (bu - bh >= CAL.breathSplitMinDb) { const t = Math.min(CAL.splitMaxDb, Math.max(CAL.splitMinDb, (bu + bh) / 2));
      // a recorded ミックス as breathy as the threshold would be pushed to 裏声 by it: then breath does not separate this voice
      if (!(M && bmed(M) >= t - CAL.breathSplitMinDb / 2)) { breathyDb = t; cleanDb = t; split = true; } } }
  const pHead = U ? RC.pFalsetto : RC.pHead; // a recorded 裏声 is 裏声: no 'clean → 裏声ミックス' nudge on top of it
  // ---- pitch floors: lowered to the lowest recorded pitch only when 地声 is recorded too ----
  const floorOf = (F) => CAL.floorRatio * quantile(F.map(r => r[0]), CAL.floorQuantile);
  const nonChest = [...(U || []), ...(H || []), ...(M || [])], mixLike = [...(M || []), ...(H || [])];
  const gateMinF0 = (K && nonChest.length) ? Math.min(RC.gateMinF0, Math.max(CAL.minGateHz, floorOf(nonChest))) : RC.gateMinF0;
  const mixFloorHz = (K && mixLike.length) ? Math.min(RC.mixFloorHz, Math.max(CAL.minGateHz, floorOf(mixLike))) : RC.mixFloorHz;
  let chest = null;
  if (K) {
    const ref = quantile(K.map(r => r[0]), 0.5);
    const vec = (F) => F.map(r => [hEffOf(r[0], r[1]), r[2], 12 * log2(r[0] / ref)]);
    const cls = { chest: vec(K) }; if (U) cls.ura = vec(U); if (M) cls.mix = vec(M); if (H) cls.uramix = vec(H);
    const centers = {}, scale = [0, 0, 0]; let nc = 0;
    for (const k in cls) { const V = cls[k]; const c = [0, 1, 2].map(d => quantile(V.map(v => v[d]), 0.5)); centers[k] = c; nc++;
      for (let d = 0; d < 3; d++) { const mad = quantile(V.map(v => Math.abs(v[d] - c[d])), 0.5) * 1.4826; scale[d] += mad * mad; } }
    for (let d = 0; d < 3; d++) scale[d] = Math.max(CAL.scaleFloor[d], Math.sqrt(scale[d] / nc));
    chest = { refF0: ref, cppValid: ref >= RC.f0Min, centers, scale, maxDist: nonChest.length ? CAL.chestMaxDist : CAL.chestMaxDistAlone };
  }
  return { v: CAL.version, bias: th[0], wh: th[1], wc: th[2], up: gUp, lo: gLo, edges: table, gateMinF0, mixFloorHz, breathyDb, cleanDb, pHead,
    chest, yinMinHz: K ? CAL.chestMinHz : 0, method, quality, has: { ura: !!U, mix: !!M, uramix: !!H, chest: !!K } };
}
function edgesAt(P, f0) {
  const T = P.edges; if (!T || !T.length || !(f0 > 0)) return [P.up, P.lo];
  const x = log2(f0); if (x <= T[0][0]) return [T[0][1], T[0][2]]; const L = T[T.length - 1]; if (x >= L[0]) return [L[1], L[2]];
  for (let i = 1; i < T.length; i++) if (x <= T[i][0]) { const a = T[i - 1], b = T[i], u = (x - a[0]) / (b[0] - a[0]); return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]; }
  return [P.up, P.lo];
}
/** Per-frame value with a personal calibration: p (edge-normalised), CAL.CHEST, or null (not judged). */
function personalValue(P, f) {
  if (!(f.f0 > 0 && f.aperiodicity < RC.gateMaxAperiodicity && f.rmsDb > RC.gateMinRmsDbfs && f.f0 <= RC.gateMaxF0 && RegisterClassifier.hasHarmonics(f))) return null;
  const he = RegisterClassifier.hrichEffective(f);
  if (P.chest && f.f0 >= CAL.chestMinHz) {
    const K = P.chest, x = [he, f.cpp8k, 12 * log2(f.f0 / K.refF0)];
    const dims = (K.cppValid && f.f0 >= RC.f0Min) ? [0, 1, 2] : [0, 2]; // cpp8k only inside its 150–1400 Hz search range
    let best = null, bd = Infinity, dc = Infinity;
    for (const k in K.centers) { const c = K.centers[k]; let s = 0; for (const d of dims) { const z = (x[d] - c[d]) / K.scale[d]; s += z * z; } const dist = Math.sqrt(s / dims.length);
      if (dist < bd) { bd = dist; best = k; } if (k === 'chest') dc = dist; }
    if (best === 'chest' && dc <= K.maxDist) return CAL.CHEST;
  }
  if (f.f0 < P.gateMinF0) return null;
  const z = P.bias + P.wh * he + P.wc * f.cpp8k, [up, lo] = edgesAt(P, f.f0), Lf = logit(RC.pFalsetto), Lm = logit(RC.pMix);
  return sigmoid(Lm + (z - lo) * (Lf - Lm) / (up - lo));
}
const classifierOpts = (P) => P ? { yinMinHz: P.yinMinHz || RC.f0Min } : null; // personal: unchanged floors; relaxed gate stays on for judging

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
function attachRegister(frames, mono44100, onProgress, personal) {
  if (!frames.length) return frames;
  const P = personal || null, cl = new RegisterClassifier(44100, classifierOpts(P));
  const track = cl.analyze(mono44100, { onProgress, personal: P });
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
function analyzeMono(mono, rate, onProgress, personal) {
  const prog = (a, b) => (u) => onProgress && onProgress(a + (b - a) * u);
  prog(0, 0.05)(0);
  const m44 = rate === 44100 ? mono : resampleAll(mono, rate, 44100);
  prog(0, 0.08)(1);
  const m16 = resampleAll(m44, 44100, 16000);
  prog(0.08, 0.12)(1);
  const frames = analyzePitch16k(m16, prog(0.12, 0.45));
  const out = attachRegister(frames, m44, prog(0.45, 0.99), personal);
  onProgress && onProgress(1);
  return out;
}

// ---------------- LivePitchStream (streaming, same frames as offline) ----------------
class LivePitchStream {
  constructor(inputRate, personal) { this.P = personal || null; this.reset(inputRate || 44100); }
  reset(inputRate) {
    if (inputRate) this.inputRate = inputRate;
    this.to44 = new Resampler(this.inputRate, 44100); this.to16 = new Resampler(44100, 16000);
    this.cl = this.cl || new RegisterClassifier(44100, classifierOpts(this.P));
    this.pcm16 = new Float32Array(0); this.base16 = 0; this.nextCenter = 0;
    this.pcm44 = new Float64Array(0); this.base44 = 0; this.nextStart = 0; this.total44 = 0;
    this.sm = new Smoother(this.P); this.states = []; this.cands = []; this.pending = []; this.emitted = 0;
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
      this.states.push(this.sm.push(frameValue(this.P, f), f.f0, f.breathDb));
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
    if (!vertical) { const glyph = 0.026, dot = 0.019; return { chest: 1 / 6 + 1 * glyph + dot, mix: 0.5 + 2 * glyph + dot, ura: 5 / 6 - 1 * glyph - dot }; }
    const a = aspect || 9 / 16, sp = 0.034 * a, f = 0.027 * a, dot = 0.022 * a / 0.5;
    const pos = (y) => (0.68 - y) / 0.5;
    const chestTop = 0.64 - 0.88 * f, mixTop = 0.405 - 0.88 * f, uraBottom = 0.195 + 1 * sp + 0.12 * f;
    return { chest: pos(chestTop) + dot, mix: pos(mixTop) + dot, ura: pos(uraBottom) - dot };
  },
  // 裏声 judgment at/left (vertical: at/below) of fixed ミックス -> hide ミックス, same for fixed 地声 -> hide 地声; ミックス judgment at/right (vertical: at/above) of fixed 裏声 -> hide 裏声
  targets(register, judgmentVisible, position, vertical) {
    if (!judgmentVisible) return { chest: 1, mix: 1, ura: 1 };
    const at = BandRule.labelPositions(vertical);
    // 2026-11-17 23:13: 地声・裏声・ミックス・裏声ミックスのどの判定中も、固定表示（地声・ミックス・裏声）をすべて消す。判定が外れたら元に戻る
    if (register === REG.falsetto || register === REG.mix || register === REG.uraMix || register === REG.chest) return { chest: 0, mix: 0, ura: 0 };
    return { chest: 1, mix: 1, ura: 1 };
  },
  fadeSeconds: 0.05,
  fade(v, t, dt) { return v + (t - v) * (1 - Math.exp(-dt / BandRule.fadeSeconds)); },
  position(midi, range) { return Math.min(1, Math.max(0, (midi - range.low) / (range.high - range.low))); },
};
/** Incremental timeline (GaugeTimeline at 30 fps / LiveGaugeTimeline). */
class GaugeTimeline {
  constructor(frames, range, vertical) { this.vertical = !!vertical; this.frames = frames || []; this.range = range || makeRange(this.frames); this.fixedRange = !!range || !!frames;
    this.valid = false; this.from = 0; this.to = 0; this.start = 0; this.lastPitch = -99; this.index = -1; this.opacity = 0;
    this.lastVoiced = -99; this.readoutHz = 0; this.readoutTime = -99; this.readoutRegister = 0; this.chestBand = 1; this.mixBand = 1; this.uraBand = 1; this.lastTick = 0; this.lastRangeUpdate = -99; }
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
    this.chestBand = BandRule.fade(this.chestBand, band.chest, d); this.mixBand = BandRule.fade(this.mixBand, band.mix, d); this.uraBand = BandRule.fade(this.uraBand, band.ura, d);
    return { midi, opacity: this.opacity, hz: this.readoutHz, readoutAlpha, register: this.readoutRegister, chestBandAlpha: this.chestBand, mixBandAlpha: this.mixBand, uraBandAlpha: this.uraBand };
  }
}
/** Precomputed 30 fps states for file playback (GaugeTimeline.init). */
function buildStates(frames, vertical, selectedRange) {
  const tl = new GaugeTimeline(frames, selectedRange || makeRange(frames), vertical); const states = [];
  const count = Math.max(1, Math.ceil(frames.length * 0.02 * 30));
  for (let k = 0; k < count; k++) states.push(tl.tick(k / 30, 1 / 30, false));
  return { range: tl.range, states };
}

const api = { roundHalfEven, pitchDetect, pitchNote, noteLabel, Resampler, resampleAll, fft, RC, REG, REG_LABEL, RegisterClassifier, Smoother,
  analyzePitch16k, attachRegister, CAL, GUIDE, guideNotes, doremi, midiHz, calibrationFrames, buildCalibration, personalValue, frameValue, lowValue, thresholdsOf, analyzeMono, LivePitchStream, makeRange, defaultRange, BandRule, GaugeTimeline, buildStates };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PMCore = api;
})(typeof self !== 'undefined' ? self : this);
