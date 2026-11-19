/* 透過メーター（iPhone の Safari など WebKit 用）: ProRes 4444（透過あり）を端末の中だけでエンコードする。何も送信しない。
   ffmpeg.wasm（ffmpeg/ffmpeg-core.js + ffmpeg-core.wasm.part0/1, GPL-2.0-or-later, ThirdPartyNotices.txt 参照）をこのサイトから読み込む。
   2026-11-19: ffmpeg.wasm は 1 つの実体で exec を約 165 回繰り返すと壊れる（memory access out of bounds）。
   縦長の動画（590x1280 など）で 40 秒を超えると必ず失敗していた → RECYCLE 回ごとに新しい実体に作り直す（コンパイル済みの wasm を使い回すので速い）。 */
const RECYCLE = 40;
let wasmModule = null, coreURL = '', core = null, uses = 0, stage = '';
function tag(e, why) { const x = new Error(String(e && e.message || e)); x.why = why; return x; }
async function loadWasm() {
  stage = 'load';
  const parts = [];
  for (const p of ['ffmpeg/ffmpeg-core.wasm.part0', 'ffmpeg/ffmpeg-core.wasm.part1']) {
    let r;
    try { r = await fetch(p + '?v=0.12.10', { credentials: 'same-origin' }); } catch (e) { throw tag(e, 'load'); }
    if (!r.ok) throw tag('ffmpeg ' + r.status, 'load');
    try { parts.push(await r.arrayBuffer()); } catch (e) { throw tag(e, 'load'); }
  }
  const all = new Uint8Array(parts[0].byteLength + parts[1].byteLength); all.set(new Uint8Array(parts[0]), 0); all.set(new Uint8Array(parts[1]), parts[0].byteLength);
  parts.length = 0;
  stage = 'compile';
  try { wasmModule = await WebAssembly.compile(all); } catch (e) { throw tag(e, /memory/i.test(String(e && e.message)) || e instanceof RangeError ? 'memory' : 'compile'); }
  coreURL = new URL('ffmpeg/ffmpeg-core.js?v=0.12.10', self.location.href).href;
  try { importScripts(coreURL); } catch (e) { throw tag(e, 'load'); }
  if (typeof self.createFFmpegCore !== 'function') throw tag('createFFmpegCore missing', 'load');
}
async function newCore() {
  stage = 'instantiate';
  core = null; uses = 0;
  try {
    core = await self.createFFmpegCore({
      mainScriptUrlOrBlob: coreURL + '#' + btoa(JSON.stringify({ wasmURL: 'unused', workerURL: '' })),
      instantiateWasm(imports, done) { WebAssembly.instantiate(wasmModule, imports).then((inst) => done(inst, wasmModule)); return {}; },
    });
  } catch (e) { throw tag(e, 'memory'); }
  core.setLogger(() => {}); core.setProgress(() => {});
}
function run(args) { core.setTimeout(-1); core.exec(...args); const r = core.ret; core.reset(); return r; }
function why(e) {
  if (e && e.why) return e.why;
  const s = String(e && e.message || e);
  if (e instanceof RangeError || /out of memory|allocation|cannot enlarge|memory\b.*(grow|limit)|OOM/i.test(s)) return 'memory';
  if (/out of bounds/i.test(s)) return 'encode';
  return stage === 'encode' ? 'encode' : stage || 'other';
}
self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') { if (!wasmModule) await loadWasm(); await newCore(); self.postMessage({ id: m.id, ok: true }); }
    else if (m.type === 'encode') { // m.rgba: n 枚ぶんの RGBA（非プリマルチ）
      if (!core || uses >= RECYCLE) await newCore();
      stage = 'encode'; uses++;
      const args = ['-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', m.w + 'x' + m.h, '-r', '30', '-i', 'in.raw',
        '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', '-vendor', 'apl0', '-qscale:v', String(m.q || 9),
        '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-f', 'rawvideo', '-y', 'out.prores'];
      let r, out = null;
      for (let attempt = 0; attempt < 2 && !out; attempt++) { // 失敗したら新しい実体でもう 1 回だけやり直す
        try {
          core.FS.writeFile('in.raw', new Uint8Array(m.rgba));
          r = run(args);
          try { core.FS.unlink('in.raw'); } catch (x) {}
          if (r !== 0) throw tag('ProRes エンコードに失敗しました (' + r + ')', 'encode');
          out = core.FS.readFile('out.prores'); try { core.FS.unlink('out.prores'); } catch (x) {}
        } catch (err) { if (attempt) throw err; await newCore(); uses = 1; }
      }
      self.postMessage({ id: m.id, ok: true, data: out.buffer }, [out.buffer]);
    }
  } catch (err) { self.postMessage({ id: m.id, ok: false, why: why(err), error: String(err && err.message || err) + ' [' + stage + ']' }); }
};
