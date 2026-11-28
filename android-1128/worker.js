/* Analysis worker: runs entirely on this device. Nothing is uploaded.
   process() = iOS LocalAudioPipeline.process (原音 / 歌声 / 歌声＋保守的補完, 出力音声 原音 / 歌声のみ / 伴奏のみ). */
importScripts('core.js?v=20261128and1128', '../preview-1123/sep.js?v=20261122tl4', 'sound.js?v=20261128and1128');
let live = null, sessions = null, ortReady = null, cancelled = false, ortLib = null, soundReady = null, soundSession = null, liveSound = null, soundChain = Promise.resolve(), soundBusy = 0;
function loadOrtLib() {
  if (ortLib) return ortLib;
  importScripts('../preview-1123/ort/ort.wasm.min.js');
  ortLib = self.ort; ortLib.env.wasm.wasmPaths = new URL('../preview-1123/ort/', self.location.href).href;
  ortLib.env.wasm.numThreads = 1; ortLib.env.wasm.proxy = false;
  return ortLib;
}
// 2026-11-21 音で聞き分けるAI（地声か裏声か）。この端末の中だけで動く。読み込めない時は今までの判定のまま。
function loadSound() {
  if (soundReady) return soundReady;
  soundReady = (async () => {
    const ort = loadOrtLib(), t0 = Date.now();
    const r = await fetch(self.PMSound.MODEL + '?v=20261122tl4snd', { credentials: 'same-origin' }); if (!r.ok) throw new Error('sound model ' + r.status);
    soundSession = await ort.InferenceSession.create(new Uint8Array(await r.arrayBuffer()), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    self.postMessage({ type: 'soundReady', ms: Date.now() - t0 });
    return soundSession;
  })();
  soundReady.catch((e) => { soundReady = null; soundSession = null; self.postMessage({ type: 'soundError', message: String(e && e.message || e) }); });
  return soundReady;
}
async function soundTrack(mono, prog) { // ファイル解析: 失敗したら null（今までの判定のまま）
  try { await loadSound(); return await self.PMSound.track(loadOrtLib(), soundSession, mono, prog, () => cancelled); }
  catch (e) { if (cancelled) throw e; return null; }
}
function loadOrt() {
  if (ortReady) return ortReady;
  ortReady = (async () => {
    const ort = loadOrtLib();
    const load = async (name) => { const r = await fetch('../preview-1123/models/' + name, { credentials: 'same-origin' }); if (!r.ok) throw new Error('model ' + r.status); return new Uint8Array(await r.arrayBuffer()); };
    const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    sessions = { vocals: await ort.InferenceSession.create(await load('vocals.fp16.onnx'), opts),
      accompaniment: await ort.InferenceSession.create(await load('accompaniment.fp16.onnx'), opts) };
    return ort;
  })();
  ortReady.catch(() => { ortReady = null; });
  return ortReady;
}
const pack = (frames) => {
  const n = frames.length, hz = new Float64Array(n), reg = new Uint8Array(n), fb = new Uint8Array(n), su = new Uint8Array(n);
  frames.forEach((f, i) => { hz[i] = f.hz; reg[i] = f.register; fb[i] = f.fallback ? 1 : 0; su[i] = f.uraSure ? 1 : 0; }); // su: 2026-11-21 はっきりした裏声（右側でも「裏声」のまま）を画面に渡す
  return { hz, reg, fb, su };
};
// Compare original and separated analyses only when both track the same note.
function markRawFalsettoConflict(C, frames, rawFrames, rawSound, combined, original, pcm16) {
  const { mix, uraMix, falsetto, uraOrMix } = C.REG, limit = C.RC.soundModel.uraP;
  const sameNote = (a, b) => a > 0 && b > 0 && Math.abs(12 * Math.log2(a / b)) <= 1 + 1e-9;
  let direct = -2;
  for (let i = 0; i < frames.length && i < rawFrames.length; i++) {
    // An original-only fill is not independent evidence from the separated signal.
    if (combined[i] === original[i]) continue;
    const f = frames[i], r = rawFrames[i];
    if ((f.register !== mix && f.register !== uraMix) || r.register !== falsetto) continue;
    if (!(f.hz > 0) || r.seconds !== f.seconds || !(C.soundQ(rawSound, f.seconds) >= limit)) continue;
    if (sameNote(f.hz, r.hz)) {
      f.register = uraOrMix;
      direct = i;
    } else if (pcm16 && r.hz === 0 && direct === i - 1 &&
        Math.abs(f.seconds - frames[direct].seconds - 0.02) < 1e-8 &&
        sameNote(f.hz, frames[direct].hz) && sameNote(f.hz, rawFrames[direct].hz)) {
      // Re-run the same detector 5 ms either side within this frame. Do not
      // interpolate pitch or allow a recovered frame to seed another recovery.
      const center = Math.round(f.seconds * 16000);
      for (const offset of [-80, 80]) {
        const h = C.pitchDetect(pcm16, pcm16.length, center + offset).hz;
        if (sameNote(h, f.hz) && sameNote(h, rawFrames[direct].hz)) {
          f.register = uraOrMix;
          break;
        }
      }
    }
  }
}
// Preserve original-side uncertainty only when it was measured before gap filling
// and two adjacent frames independently follow the same voiced note in both paths.
function preserveRawUncertainty(C, frames, rawFrames, combined, original, rawBeforeGap) {
  const { mix, uraMix, uraOrMix } = C.REG;
  const sameNote = (a, b) => a > 0 && b > 0 && Math.abs(12 * Math.log2(a / b)) <= 1 + 1e-9;
  const agrees = (i) => {
    const f = frames[i], r = rawFrames[i];
    return !!(f && r && combined[i] !== original[i] &&
      (f.register === mix || f.register === uraMix) && r.register === uraOrMix &&
      rawBeforeGap[i] === uraOrMix && r.seconds === f.seconds && sameNote(f.hz, r.hz));
  };
  const marks = [];
  for (let i = 0; i < frames.length; i++) {
    if (!agrees(i)) continue;
    for (const j of [i - 1, i + 1]) {
      if (!agrees(j) || Math.abs(Math.abs(frames[i].seconds - frames[j].seconds) - 0.02) > 1e-8 ||
          !sameNote(frames[i].hz, frames[j].hz) || !sameNote(rawFrames[i].hz, rawFrames[j].hz)) continue;
      marks.push(i);
      break;
    }
  }
  for (const i of marks) frames[i].register = uraOrMix;
}
// A missing fundamental in the stem can make a matched note look like a mix.
// Keep the original-side ambiguity in that case. This is a stem quality check,
// not a new register threshold or a rule tied to an absolute note.
function preserveMissingFundamental(C, frames, rawFrames, combined, original, rawBeforeGap, mono, stem) {
  const { mix, uraMix, uraOrMix } = C.REG;
  const ffts = [new Float64Array(4096), new Float64Array(4096)];
  const window = Float64Array.from({ length: 2048 }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / 2047));
  const binHz = 44100 / ffts[0].length;
  const same = (a, b) => a > 0 && b > 0 && Math.abs(12 * Math.log2(a / b)) <= 1 + 1e-9;
  const eligible = (f) => f && f.hz > 0 && (f.register === mix || f.register === uraMix || f.register === uraOrMix);
  const matches = (f, j) => {
    const r = rawFrames[j];
    return r && !r.fallback && r.register === uraOrMix && rawBeforeGap[j] === uraOrMix && same(f.hz, r.hz);
  };
  const measure = (x, at, hz) => {
    if (at < 1024 || at + 1024 > x.length || 2.09 * hz >= 44100 / 2) return null;
    const [re, im] = ffts; re.fill(0); im.fill(0);
    for (let k = 0; k < window.length; k++) re[k] = x[at - 1024 + k] * window[k];
    C.fft(re, im);
    const peak = (frequency, span) => {
      const left = Math.max(1, Math.floor((1 - span) * frequency / binHz));
      const right = Math.min(re.length / 2 - 1, Math.ceil((1 + span) * frequency / binHz));
      let p = 0;
      for (let k = left; k <= right; k++) p = Math.max(p, re[k] ** 2 + im[k] ** 2);
      return p;
    };
    const fund = peak(hz, 0.026), second = peak(2 * hz, 0.033);
    const local = Math.max(peak(hz / 1.10, 0.019), peak(hz * 1.10, 0.019));
    if (!Number.isFinite(fund + second + local)) return null;
    return { ratio: 10 * Math.log10((fund + 1e-18) / (second + 1e-18)),
      contrast: 10 * Math.log10((fund + 1e-18) / (local + 1e-18)),
      level: 10 * Math.log10(fund + 1e-18) - 20 * Math.log10(512) };
  };
  const marks = [];
  for (let i = 1; i + 1 < frames.length; i++) {
    const f = frames[i], r = rawFrames[i];
    if (!eligible(f) || f.register === uraOrMix || !r || r.register !== uraOrMix ||
        rawBeforeGap[i] !== uraOrMix || combined[i] === original[i] || f.fallback ||
        r.seconds !== f.seconds || !eligible(frames[i - 1]) || !eligible(frames[i + 1]) ||
        !same(f.hz, frames[i - 1].hz) || !same(f.hz, frames[i + 1].hz)) continue;
    // Require two independently measured pitch anchors nearby. If the
    // original detector dropped a frame, the spectrum at that exact frame
    // still has to independently show the fundamental; do not fill by time.
    let anchors = 0, distance = Infinity;
    for (let j = Math.max(0, i - 7); j <= Math.min(i + 7, rawFrames.length - 1); j++) {
      if (!matches(f, j) || !same(f.hz, frames[j].hz)) continue;
      anchors++;
      distance = Math.min(distance, Math.abs(i - j));
    }
    if (anchors < 2 || distance > 4) continue;
    const at = Math.round(f.seconds * 44100);
    const a = measure(mono, at, f.hz);
    if (!a || a.ratio < 3 || a.contrast < 4 || a.level < -42) continue;
    const b = measure(stem, at, f.hz);
    if (!b || b.ratio > -35 || a.ratio - b.ratio < 50 || a.level - b.level < 35) continue;
    marks.push(i);
  }
  for (const i of marks) frames[i].register = uraOrMix;
}
self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'process') {
      cancelled = false;
      const C = self.PMCore, S = self.PMSep, L = m.L, R = m.R, n = L.length;
      let last = -1; const prog = (a, b, label) => (u) => { const v = a + (b - a) * u, p = Math.floor(v * 100); if (p !== last) { last = p; self.postMessage({ type: 'progress', value: v, label }); } };
      const mono = new Float32Array(n); for (let i = 0; i < n; i++) mono[i] = (L[i] + R[i]) / 2;
      const needSep = !(m.analysis === 'original' && m.audio === 'original');
      const m16 = C.resampleAll(mono, 44100, 16000);
      const original = C.analyzePitch16k(m16, prog(0, needSep ? 0.15 : 0.45, '解析'));
      if (!needSep) {
        const snd = await soundTrack(mono, prog(0.45, 0.7, '声の聞き分け'));
        const frames = C.attachRegister(original, mono, prog(0.7, 1, '解析'), m.personal || null, snd);
        const p = pack(frames); self.postMessage({ type: 'result', id: m.id, ...p }, [p.hz.buffer, p.reg.buffer, p.fb.buffer, p.su.buffer]); return;
      }
      self.postMessage({ type: 'progress', value: 0.15, label: '分離モデル' });
      const ort = await loadOrt();
      const sep = await S.separatedAudio(ort, sessions, L, R, m.audio, prog(0.18, 0.75, '伴奏分離'), () => cancelled);
      let frames;
      if (m.analysis === 'original') { const snd = await soundTrack(mono, prog(0.75, 0.85, '声の聞き分け')); frames = C.attachRegister(original, mono, prog(0.85, 1, '解析'), m.personal || null, snd); }
      else {
        const v16 = C.resampleAll(sep.mono, 44100, 16000);
        const vocal = C.analyzePitch16k(v16, prog(0.75, 0.8, '解析'));
        const snd = await soundTrack(sep.mono, prog(0.8, C.RC.soundModel && C.RC.soundModel.rawListen ? 0.85 : 0.9, '声の聞き分け'));
        let raw = null;
        if (snd && C.RC.soundModel && C.RC.soundModel.rawListen) {
          raw = await soundTrack(mono, prog(0.85, 0.9, '声の聞き分け'));
          if (raw && raw.p.length === snd.p.length) snd.p2 = raw.p;
          else raw = null;
        }
        const personal = m.personal || null;
        const combined = m.analysis === 'vocal' ? vocal : S.conservativeFusion(vocal, original);
        frames = C.attachRegister(combined, sep.mono, prog(0.9, raw ? 0.96 : 1, '解析'), personal, snd);
        if (raw && frames.some(f => f.hz > 0 && (f.register === C.REG.mix || f.register === C.REG.uraMix))) {
          let rawBeforeGap = null;
          const rawFrames = C.attachRegister(original, mono, prog(0.96, 1, '解析'), personal, raw,
            (beforeGap) => { rawBeforeGap = Uint8Array.from(beforeGap, f => f.register); });
          markRawFalsettoConflict(C, frames, rawFrames, raw, combined, original, m16);
          if (rawBeforeGap) {
            preserveRawUncertainty(C, frames, rawFrames, combined, original, rawBeforeGap);
            if (m.analysis === 'assisted') preserveMissingFundamental(C, frames, rawFrames, combined, original, rawBeforeGap, mono, sep.mono);
          }
        }
        prog(0, 1, '解析')(1);
      }
      const p = pack(frames), tr = [p.hz.buffer, p.reg.buffer, p.fb.buffer, p.su.buffer];
      const out = { type: 'result', id: m.id, ...p };
      if (sep.stereo) { out.stemL = sep.stereo[0]; out.stemR = sep.stereo[1]; tr.push(out.stemL.buffer, out.stemR.buffer); }
      self.postMessage(out, tr);
    } else if (m.type === 'cancel') { cancelled = true;
    } else if (m.type === 'liveStart') {
      live = new self.PMCore.LivePitchStream(m.rate, m.personal || null); liveSound = new self.PMSound.LiveSound(m.rate); soundBusy = 0;
      loadSound().catch(() => {}); self.postMessage({ type: 'liveReady' });
    } else if (m.type === 'livePush' && live) {
      if (liveSound) { // 2026-11-21 音で聞き分けるAI: 0.1秒ごとの窓を順番に判定（追いつかない時は古い窓を飛ばす。飛ばした所は今までの判定のまま）
        liveSound.push(m.samples); const wins = liveSound.take(), lv = live, ls = liveSound;
        for (const w of wins) {
          if (!soundSession || soundBusy > 3) continue;
          soundBusy++;
          soundChain = soundChain.then(async () => { try { if (live === lv && liveSound === ls) { const p = await self.PMSound.run(loadOrtLib(), soundSession, w.x); if (live === lv) lv.addSound(w.center, p, self.PMSound.STEP); } } catch (e) {} finally { soundBusy--; } });
        }
      }
      const fr = live.push(m.samples);
      if (fr.length) self.postMessage({ type: 'liveFrames', gen: m.gen, frames: fr.map(f => [f.hz, f.register, f.uraSure ? 1 : 0]) }); // 3つ目: 2026-11-21 はっきりした裏声（右側でも「裏声」）
    } else if (m.type === 'liveStop') { live = null; liveSound = null; }
  } catch (err) { self.postMessage({ type: 'error', message: String(err && err.message || err) }); }
};
