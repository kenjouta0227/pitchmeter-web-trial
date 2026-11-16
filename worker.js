/* Analysis worker: runs entirely on this device. No network. */
importScripts('core.js');
let live = null;
self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'analyze') {
      let last = -1;
      const frames = PMCore.analyzeMono(m.mono, m.rate, (u) => { const p = Math.floor(u * 100); if (p !== last) { last = p; self.postMessage({ type: 'progress', value: u }); } });
      const n = frames.length, hz = new Float64Array(n), reg = new Uint8Array(n), fb = new Uint8Array(n);
      frames.forEach((f, i) => { hz[i] = f.hz; reg[i] = f.register; fb[i] = f.fallback ? 1 : 0; });
      self.postMessage({ type: 'result', id: m.id, hz, reg, fb }, [hz.buffer, reg.buffer, fb.buffer]);
    } else if (m.type === 'liveStart') {
      live = new PMCore.LivePitchStream(m.rate); self.postMessage({ type: 'liveReady' });
    } else if (m.type === 'livePush' && live) {
      const fr = live.push(m.samples);
      if (fr.length) self.postMessage({ type: 'liveFrames', gen: m.gen, frames: fr.map(f => [f.hz, f.register]) });
    } else if (m.type === 'liveStop') { live = null; }
  } catch (err) { self.postMessage({ type: 'error', message: String(err && err.message || err) }); }
};
