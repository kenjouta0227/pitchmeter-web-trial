/* Analysis worker: runs entirely on this device. Nothing is uploaded.
   process() = iOS LocalAudioPipeline.process (原音 / 歌声 / 歌声＋保守的補完, 出力音声 原音 / 歌声のみ / 伴奏のみ). */
importScripts('core.js?v=20261121tl1', 'sep.js?v=20261121tl1', 'sound.js?v=20261121tl1');
let live = null, sessions = null, ortReady = null, cancelled = false, ortLib = null, soundReady = null, soundSession = null, liveSound = null, soundChain = Promise.resolve(), soundBusy = 0;
function loadOrtLib() {
  if (ortLib) return ortLib;
  importScripts('ort/ort.wasm.min.js');
  ortLib = self.ort; ortLib.env.wasm.wasmPaths = new URL('ort/', self.location.href).href;
  ortLib.env.wasm.numThreads = 1; ortLib.env.wasm.proxy = false;
  return ortLib;
}
// 2026-11-21 音で聞き分けるAI（地声か裏声か）。この端末の中だけで動く。読み込めない時は今までの判定のまま。
function loadSound() {
  if (soundReady) return soundReady;
  soundReady = (async () => {
    const ort = loadOrtLib(), t0 = Date.now();
    const r = await fetch(self.PMSound.MODEL + '?v=20261121snd', { credentials: 'same-origin' }); if (!r.ok) throw new Error('sound model ' + r.status);
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
    const load = async (name) => { const r = await fetch('models/' + name, { credentials: 'same-origin' }); if (!r.ok) throw new Error('model ' + r.status); return new Uint8Array(await r.arrayBuffer()); };
    const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    sessions = { vocals: await ort.InferenceSession.create(await load('vocals.fp16.onnx'), opts),
      accompaniment: await ort.InferenceSession.create(await load('accompaniment.fp16.onnx'), opts) };
    return ort;
  })();
  ortReady.catch(() => { ortReady = null; });
  return ortReady;
}
const pack = (frames) => {
  const n = frames.length, hz = new Float64Array(n), reg = new Uint8Array(n), fb = new Uint8Array(n);
  frames.forEach((f, i) => { hz[i] = f.hz; reg[i] = f.register; fb[i] = f.fallback ? 1 : 0; });
  return { hz, reg, fb };
};
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
        const p = pack(frames); self.postMessage({ type: 'result', id: m.id, ...p }, [p.hz.buffer, p.reg.buffer, p.fb.buffer]); return;
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
        if (snd && C.RC.soundModel && C.RC.soundModel.rawListen) { const raw = await soundTrack(mono, prog(0.85, 0.9, '声の聞き分け')); if (raw && raw.p.length === snd.p.length) snd.p2 = raw.p; } // 2026-11-21 元の音でも聞く（歌声の取り出しで裏声らしさが消えた所の確認）
        frames = C.attachRegister(m.analysis === 'vocal' ? vocal : S.conservativeFusion(vocal, original), sep.mono, prog(0.9, 1, '解析'), m.personal || null, snd);
      }
      const p = pack(frames), tr = [p.hz.buffer, p.reg.buffer, p.fb.buffer];
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
      if (fr.length) self.postMessage({ type: 'liveFrames', gen: m.gen, frames: fr.map(f => [f.hz, f.register]) });
    } else if (m.type === 'liveStop') { live = null; liveSound = null; }
  } catch (err) { self.postMessage({ type: 'error', message: String(err && err.message || err) }); }
};
