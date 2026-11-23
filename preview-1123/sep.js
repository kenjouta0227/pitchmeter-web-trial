/* Spleeter 2-stem separation (port of sherpa-onnx OfflineSourceSeparationSpleeter + iOS LocalAudioPipeline chunking).
   Runs only on this device (onnxruntime-web, WebAssembly). No network except loading the bundled model files from this site. */
(function (root) {
'use strict';
const NFFT = 4096, HOP = 1024, BINS = 1024, SPLIT = 512, HALF = NFFT / 2 + 1;
let WIN = null;
function hann() { if (WIN) return WIN; WIN = new Float32Array(NFFT); for (let i = 0; i < NFFT; i++) WIN[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NFFT); return WIN; }
const fft = (re, im) => root.PMCore.fft(re, im);

function stft(x) { // x: Float32Array (already padded). returns {F, re, im} bins 0..BINS-1 per frame
  const w = hann(), F = x.length < NFFT ? 1 : 1 + Math.floor((x.length - NFFT) / HOP);
  const re = new Float32Array(F * BINS), im = new Float32Array(F * BINS);
  const fr = new Float64Array(NFFT), fi = new Float64Array(NFFT);
  for (let t = 0; t < F; t++) {
    const o = t * HOP;
    for (let k = 0; k < NFFT; k++) { const v = o + k < x.length ? x[o + k] : 0; fr[k] = v * w[k]; fi[k] = 0; }
    fft(fr, fi);
    for (let b = 0; b < BINS; b++) { re[t * BINS + b] = fr[b]; im[t * BINS + b] = fi[b]; }
  }
  return { F, re, im };
}
function istft(re, im, F, mask, outLen) { // masked bins 0..BINS-1, others zero; overlap-add / sum(w^2)
  const w = hann(), len = (F - 1) * HOP + NFFT, y = new Float32Array(len), den = new Float32Array(len); // float32 like knf::IStft
  const fr = new Float64Array(NFFT), fi = new Float64Array(NFFT);
  for (let t = 0; t < F; t++) {
    fr.fill(0); fi.fill(0);
    for (let b = 0; b < BINS; b++) { const m = mask[t * BINS + b]; fr[b] = re[t * BINS + b] * m; fi[b] = im[t * BINS + b] * m; }
    for (let b = 1; b < HALF - 1; b++) { fr[NFFT - b] = fr[b]; fi[NFFT - b] = -fi[b]; }
    for (let k = 0; k < NFFT; k++) fi[k] = -fi[k];
    fft(fr, fi);
    const o = t * HOP;
    for (let k = 0; k < NFFT; k++) { y[o + k] += Math.fround(Math.fround(fr[k] / NFFT) * w[k]); den[o + k] += Math.fround(w[k] * w[k]); }
  }
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen && i < len; i++) out[i] = den[i] !== 0 ? y[i] / den[i] : 0;
  return out;
}

/** One chunk. L/R: Float32Array (n samples, 44.1 kHz). want: {vocal:true, acc:false} stems to return as [L,R]. */
async function separateChunk(ort, sessions, L, R, want) {
  const n = L.length, padLen = Math.max(NFFT, n + 2048);
  const pl = new Float32Array(padLen), pr = new Float32Array(padLen); pl.set(L); pr.set(R);
  const sl = stft(pl), sr = stft(pr), F = sl.F, S = Math.ceil(F / SPLIT);
  const mag = new Float32Array(2 * S * SPLIT * BINS);
  [sl, sr].forEach((s, ch) => { const base = ch * S * SPLIT * BINS; for (let i = 0; i < F * BINS; i++) mag[base + i] = Math.hypot(s.re[i], s.im[i]); });
  const dims = [2, S, SPLIT, BINS];
  const run = async (sess) => { const feeds = {}; feeds[sess.inputNames[0]] = new ort.Tensor('float32', mag, dims); const o = await sess.run(feeds); return o[sess.outputNames[0]].data; };
  const v = await run(sessions.vocals), a = await run(sessions.accompaniment);
  const out = {};
  for (const stem of ['vocal', 'acc']) {
    if (!want[stem]) continue;
    out[stem] = [sl, sr].map((s, ch) => {
      const base = ch * S * SPLIT * BINS, m = new Float32Array(F * BINS);
      for (let i = 0; i < F * BINS; i++) { const vv = v[base + i] * v[base + i], aa = a[base + i] * a[base + i];
        m[i] = ((stem === 'vocal' ? vv : aa) + 1e-10 / 2) / (vv + aa + 1e-10); }
      return istft(s.re, s.im, F, m, n);
    });
  }
  return out;
}

/** LocalAudioPipeline.separatedAudio: 8 s windows, 22050-sample linear crossfade.
    output: 'original' | 'vocal' | 'accompaniment'. Returns {mono, stereo:[L,R]|null}. */
async function separatedAudio(ort, sessions, L, R, output, onProgress, isCancelled) {
  const count = L.length, window = 8 * 44100, overlap = 22050;
  const mono = new Float32Array(count), selL = output === 'original' ? null : new Float32Array(count), selR = selL ? new Float32Array(count) : null;
  let start = 0;
  while (start < count) {
    if (isCancelled && isCancelled()) throw new Error('cancelled');
    const length = Math.min(window, count - start);
    const r = await separateChunk(ort, sessions, L.subarray(start, start + length), R.subarray(start, start + length),
      { vocal: true, acc: output === 'accompaniment' });
    const vm = r.vocal, stem = output === 'vocal' ? r.vocal : output === 'accompaniment' ? r.acc : null;
    for (let i = 0; i < length; i++) {
      const w = start > 0 && i < overlap ? i / overlap : 1, c = (vm[0][i] + vm[1][i]) / 2;
      mono[start + i] = mono[start + i] * (1 - w) + c * w;
      if (stem) { selL[start + i] = selL[start + i] * (1 - w) + stem[0][i] * w; selR[start + i] = selR[start + i] * (1 - w) + stem[1][i] * w; }
    }
    if (onProgress) onProgress(Math.min(1, (start + length) / count));
    if (start + length === count) break;
    start += window - overlap;
  }
  return { mono, stereo: selL ? [selL, selR] : null };
}

/** LocalAudioPipeline.conservativeFusion (Mac port): only bracketed <=200 ms gaps. */
function conservativeFusion(vocal, original) {
  const result = vocal.slice();
  const cents = (a, b) => Math.abs(1200 * Math.log2(a / b));
  const strong = (f) => isFinite(f.hz) && f.hz >= 60 && f.hz <= 1100 && f.confidence >= 0.9 && isFinite(f.db) && f.db >= -48;
  let i = 0;
  while (i < vocal.length) {
    if (vocal[i].hz > 0) { i++; continue; }
    const start = i; while (i < vocal.length && !(vocal[i].hz > 0)) i++;
    const end = i, length = end - start;
    if (!(Math.abs(vocal.length - original.length) <= 2 && length <= 10 && start > 0 && end < vocal.length &&
      strong(vocal[start - 1]) && strong(vocal[end]) && cents(vocal[start - 1].hz, vocal[end].hz) <= 150)) continue;
    let previous = vocal[start - 1].hz, accepted = true;
    for (let j = start; j < end; j++) {
      if (j >= original.length) { accepted = false; break; }
      const c = original[j], expected = vocal[start - 1].hz * Math.pow(vocal[end].hz / vocal[start - 1].hz, (j - start + 1) / (length + 1));
      if (!strong(c) || cents(c.hz, expected) > 80 || cents(c.hz, previous) > 80) { accepted = false; break; }
      previous = c.hz;
    }
    if (accepted && cents(previous, vocal[end].hz) <= 80) for (let j = start; j < end; j++) result[j] = original[j];
  }
  return result;
}
root.PMSep = { separateChunk, separatedAudio, conservativeFusion, stft, istft };
})(typeof self !== 'undefined' ? self : this);
