/* 2026-11-21 音で聞き分けるAI（地声か裏声か）。EfficientAT mn10（MIT License, (c) 2022 Florian Schmid）＋けんじょうさんのラベルで合わせた最後の1層。
   この端末の中だけで動きます（onnxruntime-web, WebAssembly）。声はどこにも送りません。
   0.5秒の音 → メル周波数の強さ（EfficientAT と同じ前処理）→ AI → 裏声らしさ（0〜1）。0.1秒ごと。 */
(function (root) {
'use strict';
const SR = 32000, WIN = 16000, NFFT = 1024, HOP = 320, WLEN = 800, NMEL = 128, FMAX = 15000, STEP = 0.1;
let BANK = null, HANN = null;
function mel(f) { return 1127 * Math.log(1 + f / 700); }
function bank() { // torchaudio.compliance.kaldi.get_mel_banks(128, 1024, 32000, 0, 15000)（VTLN なし）＋ 513 列目は 0
  if (BANK) return BANK;
  const nb = NFFT / 2, w = SR / NFFT, ml = mel(0), mh = mel(FMAX), d = (mh - ml) / (NMEL + 1);
  BANK = []; for (let b = 0; b < NMEL; b++) { const L = ml + b * d, C = ml + (b + 1) * d, R = ml + (b + 2) * d, row = new Float32Array(nb + 1); let lo = -1, hi = -1;
    for (let i = 0; i < nb; i++) { const m = mel(w * i), v = Math.max(0, Math.min((m - L) / (C - L), (R - m) / (R - C))); row[i] = v; if (v > 0) { if (lo < 0) lo = i; hi = i; } }
    BANK.push({ row, lo: Math.max(lo, 0), hi }); }
  return BANK;
}
function hann() { if (HANN) return HANN; HANN = new Float64Array(NFFT); const off = (NFFT - WLEN) / 2; for (let i = 0; i < WLEN; i++) HANN[off + i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (WLEN - 1)); return HANN; }
/** x: Float32Array(16000) at 32 kHz → Float32Array(128*T)（[1,1,128,T] の並び）, T = 50 */
function melInput(x) {
  const n = x.length - 1, y = new Float64Array(n); for (let i = 0; i < n; i++) y[i] = x[i + 1] - 0.97 * x[i]; // pre-emphasis（conv1d [-0.97, 1]）
  const T = 1 + Math.floor(n / HOP), pad = NFFT / 2, B = bank(), w = hann(), out = new Float32Array(NMEL * T);
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT), pw = new Float64Array(NFFT / 2 + 1);
  const at = (j) => { let k = j; while (k < 0 || k >= n) { if (k < 0) k = -k; if (k >= n) k = 2 * (n - 1) - k; } return y[k]; }; // reflect padding（torch.stft center=True）
  for (let t = 0; t < T; t++) {
    const o = t * HOP - pad; for (let i = 0; i < NFFT; i++) { re[i] = at(o + i) * w[i]; im[i] = 0; }
    root.PMCore.fft(re, im); for (let k = 0; k <= NFFT / 2; k++) pw[k] = re[k] * re[k] + im[k] * im[k];
    for (let b = 0; b < NMEL; b++) { const { row, lo, hi } = B[b]; let s = 0; for (let k = lo; k <= hi; k++) s += row[k] * pw[k]; out[b * T + t] = (Math.log(s + 1e-5) + 4.5) / 5; }
  }
  return { data: out, T };
}
async function run(ort, session, x32) { const { data, T } = melInput(x32); const r = await session.run({ mel: new ort.Tensor('float32', data, [1, 1, NMEL, T]) }); return r.p.data[0]; }
/** ファイル全体: mono44100 → { t0, hop, p } */
async function track(ort, session, mono44100, onProgress, cancelled) {
  const x = root.PMCore.resampleAll(mono44100, 44100, SR), n = Math.floor(x.length / SR / STEP) + 1, p = new Float32Array(n), buf = new Float32Array(WIN);
  for (let i = 0; i < n; i++) {
    if (cancelled && cancelled()) throw new Error('cancelled');
    const c = Math.round(i * STEP * SR); buf.fill(0); for (let j = 0; j < WIN; j++) { const k = c - WIN / 2 + j; if (k >= 0 && k < x.length) buf[j] = x[k]; }
    p[i] = await run(ort, session, buf); if (onProgress && i % 20 === 0) onProgress(i / n);
  }
  return { t0: 0, hop: STEP, p };
}
/** リアルタイム: マイクの音を足していき、0.1秒ごとに 直近0.5秒（中心＝今−0.25秒）を判定 */
class LiveSound {
  constructor(inputRate) { this.rs = new root.PMCore.Resampler(inputRate || 44100, SR); this.buf = new Float32Array(0); this.base = 0; this.next = WIN; }
  push(samples) { const s = this.rs.push(samples, false); if (!s.length) return; const b = new Float32Array(this.buf.length + s.length); b.set(this.buf); b.set(s, this.buf.length); this.buf = b; }
  /** 判定できる窓を全部: [{center, x}] */
  take() { const out = []; while (this.next <= this.base + this.buf.length) { const e = this.next - this.base; out.push({ center: (this.next - WIN / 2) / SR, x: this.buf.slice(e - WIN, e) }); this.next += Math.round(STEP * SR); }
    const keep = this.next - WIN - this.base; if (keep > SR) { this.buf = this.buf.slice(keep); this.base += keep; } return out; }
}
root.PMSound = { melInput, run, track, LiveSound, SR, STEP, MODEL: 'models/register-mn10.onnx' };
})(typeof self !== 'undefined' ? self : this);
