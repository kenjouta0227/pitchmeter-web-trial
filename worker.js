/* Analysis worker: runs entirely on this device. Nothing is uploaded.
   process() = iOS LocalAudioPipeline.process (原音 / 歌声 / 歌声＋保守的補完, 出力音声 原音 / 歌声のみ / 伴奏のみ). */
importScripts('core.js?v=20261120lbl', 'sep.js?v=20261120lbl');
let live = null, sessions = null, ortReady = null, cancelled = false;
function loadOrt() {
  if (ortReady) return ortReady;
  ortReady = (async () => {
    importScripts('ort/ort.wasm.min.js');
    const ort = self.ort;
    ort.env.wasm.wasmPaths = new URL('ort/', self.location.href).href;
    ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
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
        const frames = C.attachRegister(original, mono, prog(0.45, 1, '解析'), m.personal || null);
        const p = pack(frames); self.postMessage({ type: 'result', id: m.id, ...p }, [p.hz.buffer, p.reg.buffer, p.fb.buffer]); return;
      }
      self.postMessage({ type: 'progress', value: 0.15, label: '分離モデル' });
      const ort = await loadOrt();
      const sep = await S.separatedAudio(ort, sessions, L, R, m.audio, prog(0.18, 0.75, '伴奏分離'), () => cancelled);
      let frames;
      if (m.analysis === 'original') frames = C.attachRegister(original, mono, prog(0.75, 1, '解析'), m.personal || null);
      else {
        const v16 = C.resampleAll(sep.mono, 44100, 16000);
        const vocal = C.analyzePitch16k(v16, prog(0.75, 0.85, '解析'));
        frames = C.attachRegister(m.analysis === 'vocal' ? vocal : S.conservativeFusion(vocal, original), sep.mono, prog(0.85, 1, '解析'), m.personal || null);
      }
      const p = pack(frames), tr = [p.hz.buffer, p.reg.buffer, p.fb.buffer];
      const out = { type: 'result', id: m.id, ...p };
      if (sep.stereo) { out.stemL = sep.stereo[0]; out.stemR = sep.stereo[1]; tr.push(out.stemL.buffer, out.stemR.buffer); }
      self.postMessage(out, tr);
    } else if (m.type === 'cancel') { cancelled = true;
    } else if (m.type === 'liveStart') {
      live = new self.PMCore.LivePitchStream(m.rate, m.personal || null); self.postMessage({ type: 'liveReady' });
    } else if (m.type === 'livePush' && live) {
      const fr = live.push(m.samples);
      if (fr.length) self.postMessage({ type: 'liveFrames', gen: m.gen, frames: fr.map(f => [f.hz, f.register]) });
    } else if (m.type === 'liveStop') { live = null; }
  } catch (err) { self.postMessage({ type: 'error', message: String(err && err.message || err) }); }
};
