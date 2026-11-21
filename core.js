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
  f0Min: 150.0, f0Max: 1400.0, yinThreshold: 0.15, subRelDb: -30.0, subRelOddDb: -40.0, octFixMaxCents: 80.0,
  // 2026-11-21 けんじょうさん「前後を見て、いきなり倍音を拾ってポインターがぶっ飛ぶのはなし」: 表示の高さのつながり（PitchContinuity）。
  //  直前の高さの 2倍・3倍・1.5倍・半分・1/3・2/3（±tolCents）へ急に飛んだら、判定側の高さ（窓の中央値）で確かめる。判定側が飛んだ先と同じなら本当の跳躍、
  //  前の高さのままなら倍音の拾い間違いとして前の高さに直す。飛んだ先が holdFrames（140 ms、判定側も同じ高さなら holdFramesConfirmed 120 ms）続いたら本当の跳躍として受け入れる（それより短い飛びは表示しない）。
  //  音の出だしで判定側の高さと倍音の関係でずれている時は、判定側の高さに合わせる。
  pitchCont: { ratios: [2, 3, 1.5, 0.5, 1 / 3, 2 / 3, 4, 0.25], tolCents: 60, minJumpCents: 300, cfTolCents: 70, holdFrames: 7, holdFramesConfirmed: 6, gapFrames: 15, fifths: [1.5, 2 / 3] },
  // 2026-11-21 判定の表示が一瞬だけ切り替わらないように: 表示中の判定から別の判定へ移るのは switchFrames 続いた時だけ（判定なしから出る時は今までどおり stableFrames）。
  switchFrames: 13, maxHarmonicHz: 5000.0,
  // 2026-11-21 音で聞き分けるAI（EfficientAT mn10、端末の中だけで動く）の 裏声らしさ q（0〜1、前後 halfWin 秒の中央値）。
  //  ① q が uraP 以上（声が出ている所）→ 裏声で固定（ミックスに置き換えない）。一度 裏声 になったら q が uraP−offHyst を下回るまで 裏声。
  //  ② q が vetoP 以下＝はっきり地声 で、同じ音の中に今までの基準でも地声らしいフレームがある（noteChest）（または q が vetoHard 以下＝とてもはっきり地声）→ 今までの判定が 裏声 でも 地声。ミックス系（ミックス・裏声orミックス）は今までの基準のまま。
  //  ③ その間 → 今までの判定のまま（ほかの歌手の裏声を弱くしないため）。AIが読み込めない時も今までの判定のまま。
  soundModel: { uraP: 0.9, vetoP: 0.02, vetoHard: 0.003, offHyst: 0.1, halfWin: 0.2, liveBack: 0.45, vetoHardAge: 0.3, rawListen: true, upInside: 0.2, upGap: 0.05, upSemis: 0.8, upChestWin: 2 }, // vetoHardAge: 2026-11-21 リアルタイムで 始まって vetoHardAge 秒未満の音は q だけ（vetoHard）では地声にしない（窓に前の音が混ざる。禁止項目「裏声→地声」）
  // 2026-11-21 けんじょうさん指示（通話）: 裏声を2つに分ける。息が多くて薄い完全なファルセット → 裏声（2）、芯があって密度の高いヘッドボイス（裏声寄りのミックス）→ ヘッドボイス（4、表示は「ミックス」）。
  //  裏声と決まった所（AIの裏声・今までの判定の裏声）で、前後 halfWin 秒のうち 声が出ているフレームの frac 以上が「芯がある」（倍音が豊か hrich 以上・2倍音が強い h1h2 以下・
  //  響きがはっきり cpp 以上・息のノイズが少ない breath 以下）か、AIの裏声らしさ q が headQ 未満（AIは完全なファルセットと聞いていない）なら ヘッドボイス。
  //  2026-11-21 けんじょうさん回答A: 迷う所だけ「裏声orミックス」（5）。芯が frac 以上 → 4（表示「ミックス」）。芯がはっきりしない時は AIの裏声らしさ q で:
  //   q < headQ（AIははっきり裏声ではない: 地声・ミックスの取り違え、9秒の所）→ 4（「ミックス」）／ headQ ≤ q < orQ（AIが中間＝迷う）→ 5（「裏声orミックス」）／ q ≥ orQ → 裏声（2）。
  //   さらに 針が真ん中より右で q < soundModel.uraP の 裏声 は uraRight で 5（「裏声orミックス」）。完全なファルセット（q ≥ uraP）は 裏声 のまま。
  headSplit: { headQ: 0.1, orQ: 0.5, hrich: 8, h1h2: -3, cpp: 3.4, breath: -35, halfWin: 0.25, frac: 0.5, sureKeep: true, sureBack: 0.6, sureFrac: 0.5, onsetSec: 0.3, onsetGap: 0.3, clearQ: 0.04, blipSec: 0.2, blipSemis: 1.5, denseRun: true, chestUp: true, sure2: true, sure2P: 0.85 },
  //  sure2: 2026-11-21 再生で 今までの判定が裏声・元の音のAIが uraP 以上・前後の窓（halfWin）に芯（dense）も地声のフレームも1つも無く・フレームの裏声確率の中央値が sure2P 以上 → はっきりした裏声「裏声」（歌声だけの音のAIが低くても）。
  //  denseRun: 2026-11-21 上に upSemis 半音以上 跳んで始まった音では、芯（dense）を数えるのは その音が始まってからのフレームだけ（跳ぶ前の別の音の芯で 短い裏声をミックスにしない）。blip は 地声 が挟まった時も同じ。
  //  chestUp: 再生で 今までの判定が地声のままでも、その瞬間の音が はっきり裏声の形（フレームの裏声確率 pHead 以上）で 元の音のAIも orQ 以上なら「裏声orミックス」（判定の遅れで 短い裏声が地声になるのを防ぐ）。
  //  upInside/upGap/upSemis（soundModel）: 2026-11-21 今までの判定が裏声でない所を AIだけで「裏声」にするのは、今の音（upGap 秒以上の無音か upSemis 半音以上の跳びで区切る）が始まって upInside 秒より後を中心にした AIの窓だけで決める。
  //   リアルタイムは先の窓が無いので、前の音や無音を聞いた窓で 地声の出だしが「裏声」になっていた（vid1121c 16.7・17.9・20.3・22.1・26.5秒）。新しい音では 前の音の裏声も引き継がない。今までの判定が地声の所は 今の音の中の窓が upChestWin 個以上ある時だけ。
  //  rawListen（soundModel）: 再生で 歌声だけの音に加えて 元の音でもAIを聞く（worker.js、p2）。false で 今まで通り1回だけ。
  //  2026-11-21 けんじょうさん報告（hiC#・556Hz の裏声が前半「ミックス」、同じ音程の後半は「裏声orミックス」）: 再生は 歌声だけを取り出した音でAIを聞くので、取り出しで裏声らしさが消える事がある。
  //   再生では AIを元の音でも聞き（p2）、歌声だけでは headQ 未満でも 元の音で clearQ より上なら 迷う所「裏声orミックス」（AIだけで地声にするのも 元の音で clearQ 以下の時だけ）。clearQ 0.04 = けんじょうさんの地声（vid1121b 9秒、元の音で最大0.026）と この裏声（最小0.049）の間。
  //   blipSec = 裏声側の同じ音（blipSemis 半音以内）の途中に挟まった blipSec 秒以下の「ミックス」は「裏声orミックス」（再生は前後を見て、リアルタイムは 裏声側の音から切り替わって blipSec 秒まで）。
  //  2026-11-21 けんじょうさん指示「禁止の4項目（ファルセット→ミックス など）を0コマに」: sureKeep = AIがはっきり完全なファルセット（q ≥ soundModel.uraP）と聞いていて、芯が一瞬だけ（前 sureBack 秒から今までで 芯のあるフレームが sureFrac 未満）の所は「ミックス」にしない。ずっと芯がある（ミックス３など）は今までどおり「ミックス」。
  //   onsetSec = 無音のあと onsetSec 秒以内（AIの窓の半分 0.25 秒より長い onsetGap 秒以上 声が切れた後の 出だし）は、AIの窓に無音が混ざって q が低く出るので、q だけで「ミックス」にしない（今までの判定の 裏声 のまま）。
  // 2026-11-21 けんじょうさん指示: メーターの針が真ん中（ミックス）より右で「裏声」と出る所は コード4（表示「ミックス」）。完全なファルセット（keepSure）は 裏声 のまま（リアルタイム・再生・書き出し 共通、GaugeTimeline）。
  //  minPos: 針の位置（0〜1、0.5 が真ん中）。mode 'all' = 全部 / 'keepSure' = AIがはっきり裏声（q ≥ soundModel.uraP）で芯のない所は 裏声 のまま。
  uraRight: { on: true, minPos: 0.5, mode: 'keepSure' }, // 2026-11-21 けんじょうさん回答: 完全なファルセットだけ右側でも「裏声」
  noteChest: { semis: 1.5, gapFrames: 13, frac: 0.15, minChest: 3 }, // 2026-11-21 同じ音の中に 地声らしいフレームが frac 以上（minChest 以上）
  cppFmax: 8000.0, cppBins: 512, cppFloorDb: 80.0, breathLoHz: 1000.0,
  // 2026-11-17 uraMix / 息漏れ: see Smoother.push
  pHead: 0.85, breathyDb: -30.0, cleanDb: -38.0, relaxedYinThreshold: 0.35, relaxedBreathMin: -30.0, relaxedBreathMax: -6.0,
  gateMinRmsDbfs: -50.0, gateMaxAperiodicity: 0.20, gateMinF0: 387.0, gateMaxF0: 1000.0,
  medianFrames: 17, pFalsetto: 0.70, pMix: 0.35, stableFrames: 6, minValidFraction: 0.5,
  fallbackMinHz: 150.0, fallbackMaxHz: 1100.0, fallbackMaxAperiodicity: 0.15, fallbackMinCpp: 2.0,
  fallbackHalfWindowSeconds: 0.035, fallbackMinFrames: 5, fallbackMaxCents: 100.0,
  // 2026-11-18 裏声 / ミックスの既定サンプル（ura1–3, mix1–3）をリセット → 2026-11-19 既定の表示を次の条件で再開:
  //  ミックス: 既定の判定を再開（mixFloorHz 以上・裏声でない高い音）。サンプル音声を適用中は個人の校正どおり。
  //  2026-11-20 「そう」の決まり（既定の裏声は 466 Hz 以上だけ＝「そうしたいんだ」の「そう」だけ裏声）は、けんじょうさんの指示で削除。
  defaultFalsetto: true,
  defaultMix: true,
  // 2026-11-20 「裏声orミックス」（既定の判定だけ）: 窓の p(裏声) の中央値が 0.45〜0.50（ミックスと裏声の境目）なら 裏声orミックス。
  //  息漏れ（breathyDb 以上）の所は 裏声 寄り: 裏声はそのまま、裏声orミックスになる所も 裏声。42区間＋けんじょうさんの6サンプルで選んだ。
  uraOrMix: { lo: 0.47, hi: 0.50, keepBreathy: true, breathyUra: true }, // 2026-11-20 hi は pFalsetto に合わせて 0.50
  // 2026-11-20 既定の 地声（けんじょうさん C案）: 地声テイク31本＋ラベルの地声区間（300 Hz 以上のフレーム）の平均と共分散の逆行列（数字だけ）。
  //  ミックスの基準（ミックス区間＋ミックス1〜3）も持ち、地声の基準からの距離が cutoff 以下かつ ミックスの基準の mixRatio 倍以下の所だけ 地声。
  //  cutoff・mixRatio・holdFrac は歌手を1人ずつ抜いた確認（LOSO）で選んだ。
  // 2026-11-21 音色の基準 spotRef（けんじょうさん指示「ヘルツだけでなく音色で」）: けんじょうさんの動画 36.3〜38.0秒（地声、本当の高さ約338 Hz）の
  //  音色＝倍音の並び方（1倍音−2倍音 h1h2・倍音の多さ hEff・声の澄み具合 CPP）の平均と共分散の逆行列（数字だけ。音声は同梱しない）。
  //  この音色からの距離（マハラノビス、次元数で割る）が cutoff 以下のフレームは「同じ音色」＝地声の票。窓の holdFrac 以上が同じ音色なら 地声 と出す。
  //  cutoff 2.2: 裏声のフレーム（裏1〜3・集めた裏声テイク30本・藤原/石原/竹中の裏声区間）はどれも 2.67 以上離れている（1フレームも入らない）。
  //  フォルマント（F1/F2）・明るさ（高い帯域の量）も調べたが、歌手や録り方で向きが逆になり 裏声/地声 を分けられなかったので使わない。
  spotRef: {feats: ['h1h2', 'hEff', 'cpp'], mu: [-29.4629, 23.4932, 4.8797], inv: [[13.937823, 15.546224, 1.964663], [15.546224, 17.416133, 2.284182], [1.964663, 2.284182, 2.343785]], cutoff: 2.2, holdFrac: 0.2},
  chestRef: {feats: ['hEff', 'cpp', 'h1h2', 'st'], mu: [7.5989, 5.224, -10.0142, -3.4154], inv: [[0.107012, -0.044468, 0.096082, -0.037387], [-0.044468, 0.546931, -0.024708, -0.019839], [0.096082, -0.024708, 0.09566, -0.036766], [-0.037387, -0.019839, -0.036766, 0.185272]], holdFrac: 0.2, mix: {mu: [8.7667, 5.631, -8.6917, 1.5338], inv: [[0.116069, -0.005543, 0.106705, -0.011658], [-0.005543, 0.378544, -0.001667, 0.005536], [0.106705, -0.001667, 0.105101, -0.01356], [-0.011658, 0.005536, -0.01356, 0.056121]]}, mixRatio: 1.3, cutoff: 1.1},
  // 2026-11-20 既定（サンプル音声なし）の判定基準 labelRef: けんじょうさんのラベル42区間（藤原・石原・竹中、歌から分離した声）＋
  //  けんじょうさんの6サンプル（裏1–3・ミックス1–3）の ミックス／裏声 フレーム（387 Hz 以上）を集計して、同じ式（倍音の比 hrich ＋ CPP）の係数を引き直した。
  //  音声は同梱しない（ここにある数字だけ）。サンプル音声の個人校正は今までどおり上の weight*/bias から始める。
  //  1人ずつ外した検証のフレーム正解率（ミックス vs 裏声）: 藤原 63→71%, 石原 61→74%, 竹中 59→76%, けんじょう 99→98%。
  //  区間ごとの一致（判定）62→71%、（表示）54→65%。閾値 pF/pM/pHead は全データで選んだ。
  labelRef: { bias: 3.460066776914001, weightHrich: -0.1391899095963697, weightCpp: -0.6025507640698841, weightH1H2: 0, pFalsetto: 0.50, pMix: 0.45, pHead: 0.50, mixFloorHz: 0 }, // 2026-11-20 裏声を最優先（けんじょうさん）: pFalsetto・pHead 0.60→0.50（0.45 以下は 地声テイク chest_010 が崩れる） // 2026-11-20 ミックスの下限（430 Hz 以上だけミックス＝「そう」の決まり）は削除
};
const REG = { none: 0, mix: 1, falsetto: 2, chest: 3, uraMix: 4, uraOrMix: 5 };
const REG_LABEL = { 0: null, 1: 'ミックス', 2: '裏声', 3: '地声', 4: 'ミックス', 5: '裏声orミックス' }; // 2026-11-21 けんじょうさん指示（通話）: 表示は4つ「地声」「ミックス」「裏声」「裏声orミックス（本当に迷う境目だけ）」。4（芯のあるヘッドボイス）は「ミックス」。判定のコードは変えない。
// 2026-11-19（けんじょうさん指示「割合が裏声が多い時は全部ミックスってポインターに出して」）:
// 裏声寄りの判定（裏声・uraMix）は、表示ではすべて「ミックス」にする。判定そのもの（frames の register）は変えない。
// 2026-11-20 けんじょうさん指示で元に戻した: 裏声は裏声、uraMixはuraMixのまま表示する。
function displayRegister(r) { return r; } // 3 (地声) is only produced with a personal calibration that includes 地声

class RegisterClassifier {
  constructor(sampleRate, opts) {
    this.sampleRate = sampleRate || 44100;
    // yinMinHz < RC.f0Min only when a personal 地声 calibration exists (80 Hz); default path is unchanged.
    this.yinMinHz = (opts && opts.yinMinHz > 0) ? opts.yinMinHz : RC.f0Min;
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
    out.f0 = f0; out.octHalved = f0 < 0.75 * f0yin; // 2026-11-21 1オクターブ下に直した（高さの表示も合わせる）
    const H = [];
    for (let k = 1; k * f0 < RC.maxHarmonicHz && k * f0 < this.sampleRate / 2 - binHz * 2; k++) H.push(this.peak(L, k * f0, binHz));
    if (H.length > 1) { let rich = 0; for (let i = 1; i < H.length; i++) rich += Math.pow(10, (H[i] - H[0]) / 10); out.hrichDb = 10 * log10(rich + 1e-6); }
    out.h1h2 = H.length > 1 ? H[0] - H[1] : NaN; // 2026-11-20 倍音の比（1倍音−2倍音, dB）
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
      // 2026-11-20 1倍音がとても弱い地声（けんじょうさんの動画 36〜38秒: 約338 Hz、1倍音が2倍音より約32 dB 小さい）は 2倍の高さ（約677 Hz）と見誤って
      //  倍音が少なく見え 裏声 になっていた。3倍音（3h）がはっきりある時だけ、1倍音（h）の条件を subRelOddDb まで弱める。
      const aMin = (b > ref + RC.subRelDb && b > this.at(L, 1.25 * f0, binHz) + 10) ? Math.min(RC.subRelDb, RC.subRelOddDb) : RC.subRelDb;
      if (a > ref + aMin && b > ref + RC.subRelDb && a > this.at(L, 0.75 * f0, binHz) + 10 && b > this.at(L, 1.25 * f0, binHz) + 10) f0 = h; else break;
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
  /** 既定（サンプル音声なし）の p(裏声): RC.labelRef（2026-11-20 ラベル区間の集計）。labelRef が無ければ従来の式。 */
  static probabilityDefault(f) {
    const R = RC.labelRef; if (!R) return RegisterClassifier.probabilityFalsetto(f);
    let z = R.bias + R.weightHrich * RegisterClassifier.hrichEffective(f) + R.weightCpp * f.cpp8k;
    if (R.weightH1H2 && isFinite(f.h1h2)) z += R.weightH1H2 * f.h1h2;
    return 1 / (1 + Math.exp(-z));
  }
  static fallbackCandidate(f) {
    if (!(f.f0 >= RC.fallbackMinHz && f.f0 <= RC.fallbackMaxHz && f.aperiodicity < RC.fallbackMaxAperiodicity && f.rmsDb > RC.gateMinRmsDbfs && RegisterClassifier.hasHarmonics(f) && f.cpp8k >= RC.fallbackMinCpp)) return 0;
    return f.f0;
  }
  analyze(mono, opts) {
    opts = opts || {}; const keep = !!opts.keepFeatures, onProgress = opts.onProgress;
    const n = this.frameLength, centers = [], states = [], feats = [], pitch = [], probs = [], octs = [], f0s = [], nch = [], dense = [];
    const P = opts.personal || null, sm = new Smoother(P);
    if (mono.length <= n) return { frameCenters: centers, states, features: feats, pitch, probs, octs, f0s, nch, dense };
    let cnt = 0;
    for (let s = 0; s < mono.length - n; s += this.hop) {
      const f = this.features(mono, s, !keep);
      const p = frameValue(P, f);
      states.push(sm.push(p, f.f0, f.breathDb, f.relaxedF0)); nch.push(!!sm.noteChest); probs.push(p); pitch.push(RegisterClassifier.fallbackCandidate(f)); octs.push(f.octHalved ? f.f0 : 0); f0s.push(f.f0 > 0 && f.aperiodicity < RC.gateMaxAperiodicity ? f.f0 : 0); dense.push(headDense(f));
      centers.push((s + n / 2) / this.sampleRate); if (keep) feats.push(f);
      if (onProgress && (++cnt % 200 === 0)) onProgress(s / mono.length);
    }
    return { frameCenters: centers, states, features: feats, pitch, probs, octs, f0s, nch, dense };
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
/** 2026-11-21 高さの表示（16 kHz の pitchDetect）を、判定側が1オクターブ下に直した高さに合わせる。けんじょうさんの動画 36〜38秒:
 *  表示 676.9 Hz・hiE → 本当は約338 Hz（mid2E）の地声。窓（±fallbackHalfWindowSeconds）の判定フレームの過半数が「1オクターブ下に直した」で、
 *  その中央値が 表示の高さの半分から octFixMaxCents 以内の時だけ、表示を半分にする。それ以外（本物の高い音）はそのまま。 */
/** 2026-11-21 ヘッドボイス（芯があって密度の高い裏声寄りの声）らしいフレームか: 1 = 芯がある, 0 = 声はあるが芯がない, -1 = 声なし。RC.headSplit */
function headDense(f) {
  const H = RC.headSplit; if (!H || !(f.f0 > 0) || !RegisterClassifier.hasHarmonics(f)) return -1;
  return f.hrichDb >= H.hrich && isFinite(f.h1h2) && f.h1h2 <= H.h1h2 && f.cpp8k >= H.cpp && !(isFinite(f.breathDb) && f.breathDb > H.breath) ? 1 : 0;
}
/** 2026-11-21 裏声（2）を 完全なファルセット（2）とヘッドボイス（4）に分ける。dense[lo..hi] は headDense、q は AIの裏声らしさ（無ければ NaN）。 */
function headSplitRegister(reg, dense, lo, hi, q, onsetAge, hop, q2, runLo) {
  const H = RC.headSplit; if (!H || reg !== REG.falsetto) return reg;
  if (H.sureKeep && isFinite(q) && RC.soundModel && q >= RC.soundModel.uraP && hop > 0) { // AIがはっきり完全なファルセットで 芯は一瞬だけ → 裏声 のまま
    let n = 0, d = 0; for (let i = Math.max(0, lo - Math.round(H.sureBack / hop)); i <= Math.min(dense.length - 1, hi); i++) if (dense[i] >= 0) { n++; if (dense[i] > 0) d++; }
    if (n > 0 && d < H.sureFrac * n) return reg;
  }
  if (H.onsetSec && onsetAge < H.onsetSec) return reg; // 無音のあとの出だし: AIの窓に無音が混ざり 芯の判定もフレームが少ないので、今までの判定の 裏声 のまま
  let n = 0, d = 0; for (let i = Math.max(0, lo, H.denseRun && isFinite(runLo) ? runLo : 0); i <= Math.min(dense.length - 1, hi); i++) if (dense[i] >= 0) { n++; if (dense[i] > 0) d++; }
  if (n > 0 && d >= H.frac * n) return REG.uraMix; // 芯のあるヘッドボイス →「ミックス」
  if (isFinite(q) && q < H.headQ) return !(H.clearQ > 0) || !isFinite(q2) || q2 <= H.clearQ ? REG.uraMix : REG.uraOrMix; // AIははっきり裏声ではない →「ミックス」。再生で 元の音で聞いたAI（q2）が clearQ より上（2回の聞き取りが食い違う）→ 迷う所
  if (isFinite(q) && q < H.orQ) return REG.uraOrMix; // AIが中間で 芯もはっきりしない → 迷う所「裏声orミックス」
  return reg;
}
/** 2026-11-21 表示: 針が真ん中より右の「裏声」は コード4＝表示「ミックス」（RC.uraRight）。sure = AIがはっきり裏声で芯のない所（mode 'keepSure' の時だけ使う）。 */
function uraRightRegister(reg, position, sure) {
  const U = RC.uraRight; if (!U || !U.on || reg !== REG.falsetto || !(position >= U.minPos)) return reg;
  return U.mode === 'keepSure' && sure ? reg : REG.uraOrMix; // 2026-11-21 右側: 完全なファルセットは 裏声、はっきりしない裏声は 迷う所「裏声orミックス」（芯のある所・AIがはっきり裏声でない所は headSplit で もう「ミックス」）
}
/** 2026-11-21 音で聞き分けるAIの結果（track: { hop, t0, p: 窓の中心ごとの 裏声らしさ }）。t の前後 halfWin 秒の中央値。無ければ NaN。 */
function soundQ(track, t, from) {
  if (!track || !track.p || !track.p.length || !RC.soundModel) return NaN;
  const h = RC.soundModel.halfWin, a = Math.max(0, Math.ceil((t - h - track.t0) / track.hop - 1e-9)), b = Math.min(track.p.length - 1, Math.floor((t + h - track.t0) / track.hop + 1e-9));
  const v = [], fr = isFinite(from) ? from : -Infinity; for (let i = a; i <= b; i++) if (isFinite(track.p[i]) && track.t0 + i * track.hop >= fr - 1e-9) v.push(track.p[i]);
  soundQ.stale = false;
  if (!v.length && track.live) { soundQ.stale = true; // リアルタイム: その時刻の窓がまだ無い時は 直近 liveBack 秒以内の窓（最大2つ）
    for (let i = Math.min(b, track.p.length - 1); i >= 0 && v.length < 2 && track.t0 + i * track.hop >= Math.max(t - RC.soundModel.liveBack, fr - 1e-9); i--) if (isFinite(track.p[i])) { v.push(track.p[i]); soundQ.staleFrom = track.t0 + i * track.hop; } }
  soundQ.n = v.length; if (!v.length) return NaN; v.sort((x, y) => x - y);
  return v.length % 2 ? v[v.length >> 1] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
}
/** 2026-11-21 2段階: AIで 地声か裏声か → 裏声はそのまま固定、地声側だけ今までの基準（ミックス・裏声orミックス）。st = { ura } を前の状態として持ち回る。 */
/** 2026-11-21 声の出だしからの秒数（onsetGap 秒以上 切れた後を 出だしとする）。 */
function onsetTrack(o, t, voiced) {
  if (!voiced) return t - o.on; const gap = RC.headSplit && RC.headSplit.onsetGap || 0.1;
  if (t - o.last > gap) o.on = t; o.last = t; return t - o.on;
}
/** 2026-11-21 今の音の始まり（upGap 秒以上の無音か upSemis 半音以上の跳び）。o = { t, hz, start }。 */
function runTrack(o, t, hz) {
  const SM = RC.soundModel; if (!(hz > 0)) return o.start;
  const j = o.hz > 0 ? 12 * log2(hz / o.hz) : 0, us = SM && SM.upSemis || 0.8;
  if (!(o.hz > 0) || t - o.t > (SM && SM.upGap || 0.05) + 1e-9 || Math.abs(j) >= us) { o.start = t; o.up = o.hz > 0 && j >= us && t - o.t <= 0.1; } // up: 上に跳んで始まった音
  o.t = t; o.hz = hz; return o.start;
}
function soundRegister(state, q, voiced, st, noteChest, stale, q2, qUp, newRun, qUpN) {
  const SM = RC.soundModel;
  if (newRun) st.ura = false;
  if (!SM || !isFinite(q)) { st.ura = false; return state; }
  const up = state === REG.falsetto || qUp === undefined ? q : state === REG.chest && !(qUpN >= (SM.upChestWin || 1)) ? NaN : qUp; // 今までの判定が裏声でない所は 今の音の中の窓（qUp）だけで
  st.ura = voiced && ((isFinite(up) && up >= SM.uraP) || (st.ura && q >= SM.uraP - SM.offHyst));
  if (st.ura) return REG.falsetto;
  if (state === REG.falsetto && q <= SM.vetoP && (noteChest || (!stale && q <= SM.vetoHard))) return RC.headSplit && q2 > RC.headSplit.clearQ ? REG.uraOrMix : REG.chest; // 再生: 元の音で聞いたAI（q2）が clearQ より上（はっきり地声でない）時は 迷う所「裏声orミックス」（裏声にはしない） // 少し前の窓（stale）だけの時は 同じ音の地声らしさも要る
  return state;
}
function octaveFixedHz(hz, octs, lo, hi) {
  if (!(hz > 0) || !octs || lo > hi) return 0;
  const v = []; for (let i = lo; i <= hi; i++) if (octs[i] > 0) v.push(octs[i]);
  if (!(v.length * 2 > hi - lo + 1)) return 0;
  v.sort((a, b) => a - b); const m = v[v.length >> 1];
  return Math.abs(1200 * log2(m / (hz / 2))) <= RC.octFixMaxCents ? hz / 2 : 0;
}
class PitchContinuity {
  constructor() { this.ref = 0; this.gap = 0; this.pk = 0; this.pn = 0; }
  // hz: 表示の高さ（20 ms ごと）, cf: 判定側の高さ（窓の中央値、無ければ 0）。戻り値: 表示する高さ
  ratioOf(a, b) { // a が b の 2倍・3倍・1.5倍・半分… なら その倍率、違えば 0
    const K = RC.pitchCont, c = 1200 * log2(a / b);
    if (Math.abs(c) < K.minJumpCents) return 0;
    for (const q of K.ratios) if (Math.abs(c - 1200 * log2(q)) <= K.tolCents) return q;
    return 0;
  }
  push(hz, cf, sure) { // sure: 判定側がはっきり1オクターブ下に直した高さ（octaveFixedHz）→ そのまま受け入れる
    const K = RC.pitchCont;
    if (!K) return hz;
    if (!(hz > 0)) { if (++this.gap > K.gapFrames) { this.ref = 0; this.pn = 0; } return hz; }
    this.gap = 0;
    const near = (a, b) => a > 0 && b > 0 && Math.abs(1200 * log2(a / b)) <= K.cfTolCents;
    const set = (h) => { this.ref = h; return h; };
    if (!(this.ref > 0)) { // 音の出だし: 判定側の高さと倍音の関係でずれていたら、判定側に合わせる
      const q = cf > 0 ? this.ratioOf(hz, cf) : 0; this.pn = 0; return set(q ? hz / q : hz);
    }
    if (sure || !(Math.abs(1200 * log2(hz / this.ref)) >= K.minJumpCents)) { this.pn = 0; return set(hz); } // ふつうの上がり下がり
    const k = this.ratioOf(hz, this.ref);
    if (!k) { // 倍音の倍率ではない大きな飛び: 判定側が違う高さなら判定側の高さ（続いたら受け入れる）
      if (cf > 0 && !near(cf, hz) && this.pn + 1 < K.holdFrames) { this.pk = -1; this.pn++; return set(cf); }
      this.pn = 0; return set(hz);
    }
    const cand = hz / k;
    if (near(cf, cand)) { this.pn = 0; return set(cand); } // 判定側は前の高さのまま → 倍音の拾い間違い
    if (near(cf, hz) && K.fifths.includes(k)) { this.pn = 0; return set(hz); } // 5度の跳躍（1.5倍・2/3）は歌でよくあるので、判定側も同じならすぐ受け入れる
    if (this.pk === k) this.pn++; else { this.pk = k; this.pn = 1; }
    if (this.pn >= (near(cf, hz) ? K.holdFramesConfirmed : K.holdFrames)) { this.pn = 0; return set(hz); } // 続いたら本当の跳躍
    this.ref = cand; return cand;
  }
}
function cfMedian(f0s, lo, hi) {
  if (!f0s || lo > hi) return 0; const v = [];
  for (let i = lo; i <= hi; i++) if (f0s[i] > 0) v.push(f0s[i]);
  if (!(v.length * 2 > hi - lo + 1)) return 0;
  v.sort((a, b) => a - b); return v[v.length >> 1];
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
 *  Frame values: p(裏声) 0…1, CAL.CHEST (地声 frame, personal only), CAL.BREATHY (relaxed-gate breathy frame: votes 裏声 only), or null.
 *  Thresholds T = personal calibration or the defaults in RC:
 *   median p ≥ pF → 裏声, ≤ pM → ミックス, between → uraMix (2026-11-17; was: no judgment)
 *   息漏れ (median breathDb of the window): uraMix in the 裏声-side half of the zone (m ≥ (pF+pM)/2) with breath ≥ breathyDb → 裏声;
 *     裏声 with p < pHead (just above pF) and breath ≤ cleanDb (little breath) → uraMix
 *   ミックス / uraMix are not shown below mixFloorHz; a breathy relaxed frame can never yield ミックス / uraMix. */
class Smoother {
  constructor(personal) { this.history = []; this.bhist = []; this.candidate = REG.none; this.count = 0; this.state = REG.none; this.T = thresholdsOf(personal); this.personal = !!personal; this.falsettoOn = !!personal || RC.defaultFalsetto; this.mixOn = !!personal || RC.defaultMix; }
  push(p, f0, breath, relaxedF0) {
    const spot = p === CAL.SPOT; if (spot) p = CAL.CHEST; // 2026-11-21 spotRef と同じ音色（地声の票として数える）
    this.shist = this.shist || []; this.shist.push(spot); if (this.shist.length > RC.medianFrames) this.shist.shift();
    const T = this.T, med = (a) => a.length % 2 ? a[a.length >> 1] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
    { const NC = RC.noteChest; // 2026-11-21 同じ音（高さがほぼ同じで途切れていない間）の中の 地声らしいフレーム（今までの基準）を数える。AIの「地声」と両方そろった時だけ 裏声を取り消す
      if (NC) { if (p === null || !(f0 > 0)) { this.nGap = (this.nGap || 0) + 1; if (this.nGap > NC.gapFrames) { this.nF = 0; this.nN = 0; this.nC = 0; } }
        else { this.nGap = 0; const st = 12 * log2(f0 / 440);
          if (!this.nN || Math.abs(st - this.nF) > NC.semis) { this.nF = st; this.nN = 0; this.nC = 0; } else this.nF += 0.1 * (st - this.nF);
          this.nN++; if (p === CAL.CHEST) this.nC++; }
        this.noteChest = this.nN > 0 && this.nC >= NC.minChest && this.nC >= NC.frac * this.nN; this.noteFrames = this.nN || 0; } }
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
          const m = med(ps); let breathy = false;
          c = m >= T.pF ? REG.falsetto : (m <= T.pM ? REG.mix : REG.uraMix);
          const bs = this.bhist.filter(isFinite).sort((a, b) => a - b);
          if (bs.length) { const mb = med(bs); breathy = mb >= T.breathyDb;
            if (c === REG.uraMix && mb >= T.breathyDb && m >= (T.pF + T.pM) / 2) c = REG.falsetto;
            else if (c === REG.falsetto && m < T.pHead && mb <= T.cleanDb) c = REG.uraMix; }
          if (p === CAL.BREATHY && c !== REG.falsetto) c = REG.none;
          if ((c === REG.mix || c === REG.uraMix) && f0 > 0 && f0 < T.mixFloorHz) c = REG.none;
          if ((c === REG.mix || c === REG.uraMix) && !(f0 > 0)) c = REG.none;
          // 2026-11-20 「裏声orミックス」: 既定の判定（サンプル音声なし）で、裏声とミックスの境目に近い所（窓の p(裏声) の中央値が U.lo〜U.hi）。
          //  判定の閾値は変えない。息漏れ（breathyDb 以上）の裏声はそのまま 裏声。
          // 2026-11-20 既定の 地声: 窓の中に 地声に近いフレームが holdFrac 以上ある間は、ミックス系（ミックス・uraMix・裏声orミックス）を出さない（判定なし）。
          const H = RC.chestRef;
          if (H && H.holdFrac && !this.personal && chestN >= H.holdFrac * vals.length && (c === REG.mix || c === REG.uraMix)) c = REG.none;
          const U = RC.uraOrMix;
          if (U && !this.personal && f0 > 0 && m >= U.lo && m <= U.hi && (c === REG.mix || c === REG.uraMix || (c === REG.falsetto && !(U.keepBreathy && breathy)))) c = REG.uraOrMix;
          if (U && U.breathyUra && !this.personal && c === REG.uraOrMix && breathy) c = REG.falsetto;
          // 2026-11-21 窓の holdFrac 以上が 動画 36〜38秒と同じ音色なら、裏声・ミックス系ではなく 地声。
          const S = RC.spotRef, spotN = this.shist.filter((x, i) => x && this.history[i] !== null).length;
          if (S && !this.personal && spotN > 0 && spotN >= S.holdFrac * vals.length && c !== REG.none) c = REG.chest;
        }
      }
    }
    if (c === REG.falsetto && !this.falsettoOn) c = REG.none; // 既定の裏声サンプルなし（2026-11-18）
    if (c === REG.mix && !this.mixOn) c = REG.none; // 既定のミックスサンプルなし（2026-11-18）
    if (c === this.candidate) this.count++; else { this.candidate = c; this.count = 1; }
    const need = (RC.switchFrames && this.state !== REG.none && c !== REG.none && c !== REG.chest && c !== this.state) ? RC.switchFrames : RC.stableFrames; // 地声へ戻るのは今までどおり（地声が裏声のまま残らないように）
    if (this.count >= need) this.state = c;
    return this.state;
  }
}
function thresholdsOf(P) {
  const T = { pF: RC.pFalsetto, pM: RC.pMix, pHead: RC.pHead, breathyDb: RC.breathyDb, cleanDb: RC.cleanDb, mixFloorHz: RC.mixFloorHz, gateMinF0: RC.gateMinF0 };
  if (P) { for (const k in T) if (typeof P[k] === 'number' && isFinite(P[k])) T[k] = P[k]; }
  else if (RC.labelRef) { const R = RC.labelRef; T.pF = R.pFalsetto; T.pM = R.pMix; T.mixFloorHz = R.mixFloorHz; if (isFinite(R.pHead)) T.pHead = R.pHead; } // 2026-11-20 既定の判定基準
  return T;
}
/** 2026-11-20 既定の 地声（サンプル音声なし）: RC.chestRef（地声テイク・地声区間の平均と共分散＝数字だけ）からの距離（マハラノビス、次元数で割る）が cutoff 以下、
 *  かつ 裏声らしさ p が pFalsetto 未満のフレームだけ 地声。それ以外は今までどおり（null を返す）。高さの下限・上限（「〜Hz 以上は」）は使わない。 */
function chestRefFeature(name, f) {
  switch (name) { case 'hEff': return RegisterClassifier.hrichEffective(f); case 'cpp': return f.cpp8k; case 'h1h2': return f.h1h2; case 'breath': return f.breathDb; case 'st': return 12 * log2(f.f0 / 440); }
  return NaN;
}
function spotLike(f) {
  const K = RC.spotRef;
  if (!K || !(f.f0 > 0 && f.aperiodicity < RC.gateMaxAperiodicity && f.rmsDb > RC.gateMinRmsDbfs && RegisterClassifier.hasHarmonics(f))) return false;
  const v = K.feats.map(k => k === 'hEff' ? RegisterClassifier.hrichEffective(f) : k === 'cpp' ? f.cpp8k : f.h1h2);
  if (!v.every(isFinite)) return false;
  let q = 0; for (let i = 0; i < v.length; i++) for (let j = 0; j < v.length; j++) q += (v[i] - K.mu[i]) * K.inv[i][j] * (v[j] - K.mu[j]);
  return Math.sqrt(Math.max(0, q) / v.length) <= K.cutoff;
}
function defaultChest(f) {
  const K = RC.chestRef;
  if (!K || !(f.f0 > 0 && f.aperiodicity < RC.gateMaxAperiodicity && f.rmsDb > RC.gateMinRmsDbfs && f.f0 <= RC.gateMaxF0 && RegisterClassifier.hasHarmonics(f))) return null;
  const n = K.feats.length, z = new Array(n);
  for (let i = 0; i < n; i++) { const v = chestRefFeature(K.feats[i], f); if (!isFinite(v)) return null; z[i] = v - K.mu[i]; }
  const dist = (mu, inv) => { let s = 0; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) s += (z[i] + K.mu[i] - mu[i]) * inv[i][j] * (z[j] + K.mu[j] - mu[j]); return Math.sqrt(Math.max(0, s) / n); };
  const dc = dist(K.mu, K.inv);
  if (!(dc <= K.cutoff)) return null;
  if (K.mix && !(dc <= K.mixRatio * dist(K.mix.mu, K.mix.inv))) return null; // ミックスの基準の方が近い所は 地声にしない
  const pF = RC.labelRef ? RC.labelRef.pFalsetto : RC.pFalsetto;
  if (RegisterClassifier.probabilityDefault(f) >= pF) return null;
  return CAL.CHEST;
}
/** Per-frame smoother value (default or personal). */
function frameValue(P, f) {
  const gateMin = P ? P.gateMinF0 : RC.gateMinF0;
  if (!(f.f0 > 0)) { // relaxed breathy frame → 裏声 vote only
    const fr = f.relaxedF0;
    if (fr >= gateMin && fr <= RC.gateMaxF0 && f.rmsDb > RC.gateMinRmsDbfs && f.breathDb >= (P && isFinite(P.breathyDb) ? Math.max(RC.relaxedBreathMin, P.breathyDb) : RC.relaxedBreathMin) && f.breathDb <= RC.relaxedBreathMax) return CAL.BREATHY;
    return null;
  }
  if (!P) {
    if (spotLike(f)) return CAL.SPOT; // 2026-11-21 動画 36〜38秒と同じ音色 → 地声の票
    const c = defaultChest(f); if (c !== null) return c;
    return RegisterClassifier.isValid(f) ? RegisterClassifier.probabilityDefault(f) : null;
  }
  return personalValue(P, f);
}

// ---------------- Personal calibration (「地声を録る」「ミックスを録る」「ミックス（裏声寄り）を録る」「裏声を録る」) ----------------
// Recordings are reduced on the device to per-frame features [f0 Hz, hrichDb, cpp8k, breathDb, targetHz]; no raw audio is kept.
const CAL = {
  // enabled (2026-11-17): app.js passes buildCalibration(samples) only when samples exist AND 「サンプル音声を適用」 is on;
  // otherwise personal = null and judging is exactly the published default.
  enabled: true, version: 2, CHEST: 2, BREATHY: 3, SPOT: 4, // smoother markers (p values are 0…1)
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
  const cl = new RegisterClassifier(44100, { yinMinHz: chest ? CAL.chestMinHz : 0, noRelaxed: true }), n = cl.frameLength;
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
 *  Order on the 裏声-logit axis z: 裏声 (high) > uraMix > ミックス (low). Frames are mapped per pitch so that
 *  the 裏声|uraMix edge lands on p = pFalsetto and the uraMix|ミックス edge on p = pMix (see personalValue). */
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
  // label; uraMix stays the narrow, ambiguous zone (「あいまいなところだけ」): without a uraMix recording it is the
  // middle third of the 裏声|ミックス gap, with one its ミックス-side edge stays near that recording's low tail.
  const tLo = (a) => quantile(a, CAL.tailLow), tHi = (a) => quantile(a, CAL.tailHigh);
  const edgesFor = (u, h, m) => { // u/h/m: z arrays (or null) of 裏声 / uraMix / ミックス
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
      if (!h) { /* no uraMix on this note: keep the global band width around this note's 裏声|ミックス centre */ }
      if (!u && h) up = Math.max(up, gUp); if (!m && h) lo = Math.min(lo, gLo);
      table.push([log2(440 * Math.pow(2, n / 12)), up, lo]);
    } }
  // ---- 息漏れ split (裏声 vs uraMix recordings) ----
  let breathyDb = RC.breathyDb, cleanDb = RC.cleanDb;
  const bmed = (F) => { const b = F.map(r => r[3]).filter(v => v !== null && isFinite(v)); return b.length ? med(b) : NaN; };
  let split = false;
  if (U && H) { const bu = bmed(U), bh = bmed(H); if (bu - bh >= CAL.breathSplitMinDb) { const t = Math.min(CAL.splitMaxDb, Math.max(CAL.splitMinDb, (bu + bh) / 2));
      // a recorded ミックス as breathy as the threshold would be pushed to 裏声 by it: then breath does not separate this voice
      if (!(M && bmed(M) >= t - CAL.breathSplitMinDb / 2)) { breathyDb = t; cleanDb = t; split = true; } } }
  const pHead = U ? RC.pFalsetto : RC.pHead; // a recorded 裏声 is 裏声: no 'clean → uraMix' nudge on top of it
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
const classifierOpts = (P) => (P && P.yinMinHz) ? { yinMinHz: P.yinMinHz } : null; // relaxed gate stays on for judging

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
function attachRegister(frames, mono44100, onProgress, personal, sound) {
  if (!frames.length) return frames;
  const P = personal || null, cl = new RegisterClassifier(44100, classifierOpts(P));
  const track = cl.analyze(mono44100, { onProgress, personal: P });
  if (!track.frameCenters.length) return frames;
  const first = track.frameCenters[0], hopS = cl.hop / cl.sampleRate, pc = new PitchContinuity(), sst = {}, ons = { last: -99, on: -99 }, run = { t: -99, hz: 0, start: -99 };
  const out = frames.map(f => {
    const g = Object.assign({}, f);
    const c = track.frameCenters, lo = Math.max(0, Math.ceil((f.seconds - RC.fallbackHalfWindowSeconds - first) / hopS - 1e-9)), hi = Math.min(c.length - 1, Math.floor((f.seconds + RC.fallbackHalfWindowSeconds - first) / hopS + 1e-9));
    if (!(f.hz > 0)) { const fb = RegisterClassifier.fallbackPitch(track, f.seconds); if (fb !== null) { g.hz = fb; g.fallback = true; } }
    else { const h2 = octaveFixedHz(f.hz, track.octs, lo, hi); if (h2 > 0) { g.hz = h2; g.octaveFixed = true; } }
    { const h3 = pc.push(g.hz, cfMedian(track.f0s, lo, hi), !!g.octaveFixed); if (h3 !== g.hz) { g.hz = h3; g.continuityFixed = true; } }
    g.register = RegisterClassifier.stateAt(track, f.seconds, hopS, first);
    const onsetAge = onsetTrack(ons, f.seconds, g.hz > 0);
    const q = sound ? soundQ(sound, f.seconds) : NaN, q2 = sound && sound.p2 ? soundQ({ t0: sound.t0, hop: sound.hop, p: sound.p2 }, f.seconds) : NaN; // q2: 2026-11-21 元の音（分離前）で聞いたAI
    const rs = runTrack(run, f.seconds, g.hz), qUp = sound && g.register !== REG.falsetto && RC.soundModel && RC.soundModel.upInside >= 0 ? soundQ(sound, f.seconds, rs + RC.soundModel.upInside) : undefined, qUpN = soundQ.n;
    if (sound) g.register = soundRegister(g.register, q, g.hz > 0, sst, f.seconds >= first && track.nch[Math.min(track.nch.length - 1, Math.floor((f.seconds - first) / hopS + 1e-9))], false, q2, qUp, g.hz > 0 && rs === f.seconds, qUpN);
    if (g.register === REG.chest && RC.headSplit && RC.headSplit.chestUp && RC.soundModel && q2 >= RC.headSplit.orQ && f.seconds >= first) { const pf = track.probs[Math.max(0, Math.min(track.probs.length - 1, Math.round((f.seconds - first) / hopS)))]; if (pf >= RC.pHead && pf <= 1) g.register = REG.uraOrMix; }
    if (g.register === REG.falsetto && RC.headSplit) { const hw = RC.headSplit.halfWin, a = Math.ceil((f.seconds - hw - first) / hopS - 1e-9), b = Math.floor((f.seconds + RC.fallbackHalfWindowSeconds - first) / hopS + 1e-9); // リアルタイムと同じ: 前 halfWin 秒〜少し先
      let sure2 = false;
      if (RC.headSplit.sure2 && RC.soundModel && q2 >= RC.soundModel.uraP) { let n = 0, d = 0, ch = 0; const ps = [];
        for (let i = Math.max(0, a); i <= Math.min(track.dense.length - 1, b); i++) { if (track.dense[i] >= 0) { n++; if (track.dense[i] > 0) d++; } const pv = track.probs[i]; if (pv > 1) ch++; else if (pv >= 0 && pv <= 1) ps.push(pv); }
        ps.sort((x, y) => x - y); sure2 = n > 0 && d === 0 && ch === 0 && ps.length > 0 && ps[ps.length >> 1] >= RC.headSplit.sure2P; }
      if (sure2) g.uraSure = true;
      else { g.register = headSplitRegister(g.register, track.dense, a, b, q, onsetAge, hopS, q2, run.up ? Math.ceil((rs - first) / hopS - 1e-9) : NaN); if (g.register === REG.falsetto) g.uraSure = isFinite(q) && RC.soundModel && q >= RC.soundModel.uraP; } }
    return g;
  });
  return blipFill(out);
}
/** 2026-11-21 リアルタイム版: 裏声側の音から 同じ音のまま「ミックス」に変わって blipSec 秒までは「裏声orミックス」。 */
function liveBlip(o, g) {
  const H = RC.headSplit; if (!H || !(H.blipSec > 0)) return;
  const mix = g.register === REG.mix || g.register === REG.uraMix || g.register === REG.chest, v = g.hz > 0;
  if (mix && v && o.sideHz > 0 && Math.abs(12 * log2(g.hz / o.sideHz)) <= H.blipSemis) { if (o.from < 0) o.from = g.seconds; if (g.seconds - o.from <= H.blipSec) g.register = REG.uraOrMix; return; }
  o.from = -1; o.sideHz = v && (g.register === REG.falsetto || g.register === REG.uraOrMix) ? g.hz : 0;
}
/** 2026-11-21 再生: 裏声側（裏声・裏声orミックス）の同じ音の途中に挟まった 短い「ミックス」（blipSec 秒以下・blipSemis 半音以内・声が途切れない）は「裏声orミックス」。 */
function blipFill(fr) {
  const H = RC.headSplit; if (!H || !(H.blipSec > 0)) return fr;
  const side = (r) => r === REG.falsetto || r === REG.uraOrMix, isMix = (r) => r === REG.mix || r === REG.uraMix || r === REG.chest, semi = (a, b) => Math.abs(12 * log2(a / b));
  for (let i = 1; i < fr.length; i++) {
    if (!isMix(fr[i].register) || !(fr[i].hz > 0) || !(side(fr[i - 1].register) || fr[i - 1].register === REG.none) || !(fr[i - 1].hz > 0)) continue;
    let j = i; while (j < fr.length && isMix(fr[j].register) && fr[j].hz > 0) j++;
    if (j >= fr.length || !side(fr[j].register) || !(fr[j].hz > 0) || fr[j].seconds - fr[i].seconds > H.blipSec) { i = j; continue; }
    const ref = fr[i - 1].hz; let ok = semi(fr[j].hz, ref) <= H.blipSemis; for (let k = i; k < j && ok; k++) ok = semi(fr[k].hz, ref) <= H.blipSemis;
    if (ok) for (let k = i; k < j; k++) fr[k].register = REG.uraOrMix;
    i = j;
  }
  return fr;
}
/** Full offline pipeline: mono at any rate -> 20 ms frames with hz (+fallback) and register. */
function analyzeMono(mono, rate, onProgress, personal, sound) {
  const prog = (a, b) => (u) => onProgress && onProgress(a + (b - a) * u);
  prog(0, 0.05)(0);
  const m44 = rate === 44100 ? mono : resampleAll(mono, rate, 44100);
  prog(0, 0.08)(1);
  const m16 = resampleAll(m44, 44100, 16000);
  prog(0.08, 0.12)(1);
  const frames = analyzePitch16k(m16, prog(0.12, 0.45));
  const out = attachRegister(frames, m44, prog(0.45, 0.99), personal, sound);
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
    this.sm = new Smoother(this.P); this.states = []; this.nch = []; this.nage = []; this.dense = []; this.cands = []; this.octs = []; this.f0s = []; this.pc = new PitchContinuity(); this.ons = { last: -99, on: -99 }; this.pending = []; this.emitted = 0; this.sound = null; this.sst = {};
  }
  /** 2026-11-21 音で聞き分けるAIの結果を足す（窓の中心 center 秒、裏声らしさ p）。worker が順番に入れる。 */
  addSound(center, p, hop) { if (!this.sound) this.sound = { t0: center, hop: hop || 0.1, p: [], live: true }; const i = Math.round((center - this.sound.t0) / this.sound.hop); while (this.sound.p.length < i) this.sound.p.push(NaN); if (i >= 0) this.sound.p[i] = p; }
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
      this.states.push(this.sm.push(frameValue(this.P, f), f.f0, f.breathDb, f.relaxedF0)); this.nch.push(!!this.sm.noteChest); this.nage.push(this.sm.noteFrames || 0); this.dense.push(headDense(f));
      this.cands.push(RegisterClassifier.fallbackCandidate(f)); this.octs.push(f.octHalved ? f.f0 : 0); this.f0s.push(f.f0 > 0 && f.aperiodicity < RC.gateMaxAperiodicity ? f.f0 : 0);
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
    if (!this.states.length) { const h = this.pc.push(f.hz, 0); return h === f.hz ? f : Object.assign({}, f, { hz: h, continuityFixed: true }); }
    const g = Object.assign({}, f);
    if (!(f.hz > 0)) {
      const first = this.firstCenter, hop = this.states.length > 1 ? this.stateHop : 1;
      const lo = Math.max(0, Math.ceil((f.seconds - RC.fallbackHalfWindowSeconds - first) / hop - 1e-9));
      const hi = Math.min(this.states.length - 1, Math.floor((f.seconds + RC.fallbackHalfWindowSeconds - first) / hop + 1e-9));
      if (lo <= hi) { const m = medianFallback(this.cands, lo, hi); if (m !== null) { g.hz = m; g.fallback = true; } }
    } else { // 2026-11-21 ファイル解析（attachRegister）と同じ: 1オクターブ下に直した高さに表示を合わせる
      const first = this.firstCenter, hop = this.states.length > 1 ? this.stateHop : 1;
      const lo = Math.max(0, Math.ceil((f.seconds - RC.fallbackHalfWindowSeconds - first) / hop - 1e-9));
      const hi = Math.min(this.states.length - 1, Math.floor((f.seconds + RC.fallbackHalfWindowSeconds - first) / hop + 1e-9));
      const h2 = octaveFixedHz(f.hz, this.octs, lo, hi); if (h2 > 0) { g.hz = h2; g.octaveFixed = true; }
    }
    { // 2026-11-21 表示の高さのつながり（ファイル解析と同じ）
      const first = this.firstCenter, hop = this.states.length > 1 ? this.stateHop : 1;
      const lo = Math.max(0, Math.ceil((f.seconds - RC.fallbackHalfWindowSeconds - first) / hop - 1e-9));
      const hi = Math.min(this.states.length - 1, Math.floor((f.seconds + RC.fallbackHalfWindowSeconds - first) / hop + 1e-9));
      const h3 = this.pc.push(g.hz, cfMedian(this.f0s, lo, hi), !!g.octaveFixed); if (h3 !== g.hz) { g.hz = h3; g.continuityFixed = true; }
    }
    const onsetAge = onsetTrack(this.ons, f.seconds, g.hz > 0);
    if (f.seconds >= this.firstCenter) g.register = this.states[Math.min(this.states.length - 1, Math.floor((f.seconds - this.firstCenter) / this.stateHop + 1e-9))];
    const rs = runTrack(this.run || (this.run = { t: -99, hz: 0, start: -99 }), f.seconds, g.hz); // 2026-11-21 今の音の始まり
    if (this.sound) { // 少し前の窓（stale）は、同じ音がその窓の時刻から続いている時だけ使う（前の音の地声で 次の音の裏声を消さない）
      const q = soundQ(this.sound, f.seconds), si = f.seconds >= this.firstCenter ? Math.min(this.nch.length - 1, Math.floor((f.seconds - this.firstCenter) / this.stateHop + 1e-9)) : -1;
      const sameNote = si >= 0 && this.nage[si] * this.stateHop >= f.seconds - (soundQ.staleFrom - 0.25);
      const young = RC.soundModel && RC.soundModel.vetoHardAge > 0 && !(si >= 0 && this.nage[si] * this.stateHop >= RC.soundModel.vetoHardAge); // 2026-11-21 リアルタイム: 始まったばかりの音は AIの窓に前の音が混ざるので、q だけ（vetoHard）では 地声にしない（同じ音の地声らしさ noteChest は要る）
      const stale0 = soundQ.stale, qUp = g.register !== REG.falsetto && RC.soundModel && RC.soundModel.upInside >= 0 ? soundQ(this.sound, f.seconds, rs + RC.soundModel.upInside) : undefined, qUpN = soundQ.n;
      g.register = soundRegister(g.register, q, g.hz > 0, this.sst, si >= 0 && this.nch[si], (stale0 && !sameNote) || young, undefined, qUp, g.hz > 0 && rs === f.seconds, qUpN); g.q = q; }
    if (g.register === REG.falsetto && RC.headSplit && f.seconds >= this.firstCenter) { // リアルタイム: 前 halfWin 秒〜少し先（ファイル解析と同じ窓）
      const q = this.sound ? g.q : NaN, a = Math.ceil((f.seconds - RC.headSplit.halfWin - this.firstCenter) / this.stateHop - 1e-9), b = Math.min(this.states.length - 1, Math.floor((f.seconds + RC.fallbackHalfWindowSeconds - this.firstCenter) / this.stateHop + 1e-9));
      g.register = headSplitRegister(g.register, this.dense, a, b, q, onsetAge, this.stateHop, undefined, this.run.up ? Math.ceil((rs - this.firstCenter) / this.stateHop - 1e-9) : NaN); if (g.register === REG.falsetto) g.uraSure = isFinite(q) && q >= RC.soundModel.uraP; }
    liveBlip(this.blip || (this.blip = { from: -1, sideHz: 0 }), g);
    delete g.q;
    return g;
  }
}
// pitch_detect on a buffer whose index 0 is base16 (values before the buffer were trimmed only when unneeded)
function pitchDetectWindow(buf, center) { return pitchDetect(buf, buf.length, center); }

// ---------------- GaugeRange / GaugeBandRule / timelines ----------------
function defaultRange() { return { low: 52, high: 74, split1: 64, split2: 74, acceptedLow: 0, acceptedHigh: 0 }; }
// 2026-11-20: ポインターの位置 = 声の高さの目安（男性の声）。真ん中（50%）がファ♯4 付近（約373 Hz）、1半音で約2.8%。
//  0% ≈ 131 Hz、100% ≈ 1000 Hz。歌った範囲（最低音・最高音）には合わせない（範囲の端の音が外れ値だと全体がずれるため）。
//  けんじょうさんの動画（地声:裏声 のテロップ）にウェブ版の解析（歌声＋補完）で合わせた: 5:5 → 50〜52%、4:6 → 58〜64%、3:7 → 69%（平均のずれ 1.5%）。
//  2026-11-19 版（最低音〜最高音を 14%〜86%）は、ウェブ版の解析では 5:5 が 25%、3:7 が 49% になっていた。
const POINTER_CENTER_MIDI = 66.15, POINTER_SEMITONES = 35.4;
function pointerPosition(midi, range) { return Math.min(1, Math.max(0, 0.5 + (midi - POINTER_CENTER_MIDI) / POINTER_SEMITONES)); }
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
    // 2026-11-17 23:13: 地声・裏声・ミックス・uraMixのどの判定中も、固定表示（地声・ミックス・裏声）をすべて消す。判定が外れたら元に戻る
    if (register === REG.falsetto || register === REG.mix || register === REG.uraMix || register === REG.uraOrMix || register === REG.chest) return { chest: 0, mix: 0, ura: 0 };
    return { chest: 1, mix: 1, ura: 1 };
  },
  fadeSeconds: 0.05,
  fade(v, t, dt) { return v + (t - v) * (1 - Math.exp(-dt / BandRule.fadeSeconds)); },
  position(midi, range) { return pointerPosition(midi, range); },
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
    if (hz > 0) { this.lastVoiced = t; this.readoutHz = hz; this.readoutTime = t; this.readoutRegister = displayRegister(fr[end].register); this.readoutSure = !!fr[end].uraSure; }
    const target = hz > 0 ? 1 : Math.max(0, 1 - Math.max(0, t - this.lastVoiced - 0.14) / 0.35);
    this.opacity += (target - this.opacity) * (1 - Math.exp(-(1 / 30) / 0.10));
    const fade = Math.min(1, Math.max(0, (t - this.readoutTime) / 0.8));
    const range = this.range;
    const midi = this.valid ? this.value(t) : (range.low + range.high) / 2, readoutAlpha = this.readoutHz > 0 ? 1 - fade * fade * (3 - 2 * fade) : 0;
    const shown = uraRightRegister(this.readoutRegister, BandRule.position(midi, range), this.readoutSure); // 2026-11-21 針が真ん中より右の 完全なファルセットでない裏声 → コード4（表示「ミックス」）
    const band = BandRule.targets(shown, readoutAlpha > 0.01, BandRule.position(midi, range), this.vertical);
    const d = dt !== undefined ? dt : 1 / 30;
    this.chestBand = BandRule.fade(this.chestBand, band.chest, d); this.mixBand = BandRule.fade(this.mixBand, band.mix, d); this.uraBand = BandRule.fade(this.uraBand, band.ura, d);
    return { midi, opacity: this.opacity, hz: this.readoutHz, readoutAlpha, register: shown, chestBandAlpha: this.chestBand, mixBandAlpha: this.mixBand, uraBandAlpha: this.uraBand };
  }
}
/** Precomputed 30 fps states for file playback (GaugeTimeline.init). */
function buildStates(frames, vertical, selectedRange) {
  const tl = new GaugeTimeline(frames, selectedRange || makeRange(frames), vertical); const states = [];
  const count = Math.max(1, Math.ceil(frames.length * 0.02 * 30));
  for (let k = 0; k < count; k++) states.push(tl.tick(k / 30, 1 / 30, false));
  return { range: tl.range, states };
}

// ---------------- MovAudio (2026-11-18): AAC audio track out of .mov / .mp4 / .m4v, on-device only ----------------
// Used when the browser's decodeAudioData cannot open a video container (e.g. iPhone screen recordings in Safari).
// demux(ArrayBuffer) → { asc, sampleRate, channels, aot, frames: [Uint8Array], timescale, skip (media units), leadSec }
const MovAudio = (() => {
  const CONT = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf']);
  const fourcc = (u, o) => String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]);
  function boxes(dv, u, start, end, cb) {
    let o = start;
    while (o + 8 <= end) {
      let size = dv.getUint32(o), hdr = 8; const type = fourcc(u, o + 4);
      if (size === 1) { size = Number(dv.getBigUint64(o + 8)); hdr = 16; } else if (size === 0) size = end - o;
      if (size < hdr || o + size > end) break;
      cb(type, o + hdr, o + size); o += size;
    }
  }
  function find(dv, u, start, end, path) { // first box along path, e.g. ['mdia','hdlr']
    let res = null;
    boxes(dv, u, start, end, (t, s, e) => { if (res || t !== path[0]) return; res = path.length === 1 ? [s, e] : find(dv, u, s, e, path.slice(1)); });
    return res;
  }
  function esdsASC(u, s, e) { // scan the sample entry for 'esds' → DecoderSpecificInfo
    for (let i = s; i + 8 < e; i++) {
      if (u[i] !== 0x65 || fourcc(u, i) !== 'esds') continue;
      let p = i + 8; const end = Math.min(e, i - 4 + ((u[i - 4] << 24) | (u[i - 3] << 16) | (u[i - 2] << 8) | u[i - 1]));
      const desc = () => { const tag = u[p++]; let len = 0; for (let k = 0; k < 4; k++) { const b = u[p++]; len = (len << 7) | (b & 0x7f); if (!(b & 0x80)) break; } return [tag, len]; };
      while (p < end) {
        const [tag, len] = desc();
        if (tag === 0x03) { p += 2; const fl = u[p++]; if (fl & 0x80) p += 2; if (fl & 0x40) p += 1 + u[p]; if (fl & 0x20) p += 2; }
        else if (tag === 0x04) { const ot = u[p]; p += 13; if (ot !== 0x40 && ot !== 0x66 && ot !== 0x67 && ot !== 0x68) return null; }
        else if (tag === 0x05) return u.slice(p, p + len);
        else p += len;
      }
    }
    return null;
  }
  function parseASC(a) {
    let bit = 0; const rd = (n) => { let v = 0; for (let k = 0; k < n; k++, bit++) v = (v << 1) | ((a[bit >> 3] >> (7 - (bit & 7))) & 1); return v; };
    let aot = rd(5); if (aot === 31) aot = 32 + rd(6);
    const SR = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    let fi = rd(4), sr = fi === 15 ? rd(24) : SR[fi]; const ch = rd(4);
    if (aot === 5 || aot === 29) { const efi = rd(4); if (efi === 15) rd(24); aot = rd(5); } // HE-AAC: ADTS carries the core (implicit SBR)
    return { aot, fi: fi === 15 ? SR.indexOf(sr) : fi, sampleRate: sr, channels: ch };
  }
  function demux(buf) {
    const u = new Uint8Array(buf), dv = new DataView(buf);
    const moov = find(dv, u, 0, u.length, ['moov']); if (!moov) throw new Error('mov: no moov');
    const mvhd = find(dv, u, moov[0], moov[1], ['mvhd']); const movieScale = mvhd ? dv.getUint32(mvhd[0] + (u[mvhd[0]] === 1 ? 20 : 12)) : 0;
    let out = null;
    boxes(dv, u, moov[0], moov[1], (t, s, e) => {
      if (out || t !== 'trak') return;
      const hdlr = find(dv, u, s, e, ['mdia', 'hdlr']); if (!hdlr || fourcc(u, hdlr[0] + 8) !== 'soun') return;
      const mdhd = find(dv, u, s, e, ['mdia', 'mdhd']); const timescale = dv.getUint32(mdhd[0] + (u[mdhd[0]] === 1 ? 20 : 12));
      const stbl = find(dv, u, s, e, ['mdia', 'minf', 'stbl']); if (!stbl) return;
      const stsd = find(dv, u, stbl[0], stbl[1], ['stsd']); if (!stsd) return;
      const es = stsd[0] + 8, esEnd = es + dv.getUint32(es); if (fourcc(u, es + 4) !== 'mp4a') return;
      const asc = esdsASC(u, es + 8, esEnd); if (!asc) return;
      const stsz = find(dv, u, stbl[0], stbl[1], ['stsz']), stsc = find(dv, u, stbl[0], stbl[1], ['stsc']);
      const stco = find(dv, u, stbl[0], stbl[1], ['stco']), co64 = find(dv, u, stbl[0], stbl[1], ['co64']);
      if (!stsz || !stsc || !(stco || co64)) return;
      const fixed = dv.getUint32(stsz[0] + 4), n = dv.getUint32(stsz[0] + 8), sizes = new Array(n);
      for (let i = 0; i < n; i++) sizes[i] = fixed || dv.getUint32(stsz[0] + 12 + 4 * i);
      const co = stco || co64, nc = dv.getUint32(co[0] + 4), offs = new Array(nc);
      for (let i = 0; i < nc; i++) offs[i] = stco ? dv.getUint32(co[0] + 8 + 4 * i) : Number(dv.getBigUint64(co[0] + 8 + 8 * i));
      const ns = dv.getUint32(stsc[0] + 4), sc = []; for (let i = 0; i < ns; i++) { const b = stsc[0] + 8 + 12 * i; sc.push([dv.getUint32(b), dv.getUint32(b + 4)]); }
      const frames = []; let k = 0;
      for (let c = 0; c < nc && k < n; c++) {
        let per = 0; for (const [first, spc] of sc) { if (first - 1 <= c) per = spc; else break; }
        let o = offs[c]; for (let j = 0; j < per && k < n; j++, k++) { if (o + sizes[k] > u.length) { k = n; break; } frames.push(u.subarray(o, o + sizes[k])); o += sizes[k]; }
      }
      let skip = 0, leadSec = 0; const elst = find(dv, u, s, e, ['edts', 'elst']);
      if (elst) { const v1 = u[elst[0]] === 1, cnt = dv.getUint32(elst[0] + 4); let p = elst[0] + 8;
        for (let i = 0; i < cnt; i++) { const dur = v1 ? Number(dv.getBigUint64(p)) : dv.getUint32(p), mt = v1 ? Number(dv.getBigInt64(p + 8)) : dv.getInt32(p + 4); p += v1 ? 20 : 12;
          if (mt === -1) { if (movieScale) leadSec += dur / movieScale; } else { skip = mt; break; } } }
      out = Object.assign(parseASC(asc), { asc, frames, timescale, skip, leadSec });
    });
    if (!out || !out.frames.length) throw new Error('mov: no AAC audio track');
    return out;
  }
  function toADTS(d) { // raw AAC frames → ADTS stream (decodable by decodeAudioData as audio/aac)
    const prof = Math.min(Math.max(d.aot, 1), 4) - 1; let total = 0; for (const f of d.frames) total += f.length + 7;
    const o = new Uint8Array(total); let p = 0;
    for (const f of d.frames) { const L = f.length + 7;
      o[p] = 0xff; o[p + 1] = 0xf1; o[p + 2] = (prof << 6) | (d.fi << 2) | ((d.channels >> 2) & 1); o[p + 3] = ((d.channels & 3) << 6) | (L >> 11);
      o[p + 4] = (L >> 3) & 0xff; o[p + 5] = ((L & 7) << 5) | 0x1f; o[p + 6] = 0xfc; o.set(f, p + 7); p += L; }
    return o;
  }
  return { demux, toADTS, parseASC };
})();

const api = { displayRegister, pointerPosition, MovAudio, roundHalfEven, pitchDetect, pitchNote, noteLabel, Resampler, resampleAll, fft, RC, REG, REG_LABEL, RegisterClassifier, Smoother,
  analyzePitch16k, attachRegister, soundQ, soundRegister, headDense, headSplitRegister, uraRightRegister, CAL, GUIDE, guideNotes, doremi, midiHz, calibrationFrames, buildCalibration, personalValue, frameValue, thresholdsOf, analyzeMono, LivePitchStream, makeRange, defaultRange, BandRule, GaugeTimeline, buildStates };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PMCore = api;
})(typeof self !== 'undefined' ? self : this);
