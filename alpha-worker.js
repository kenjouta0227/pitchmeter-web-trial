/* 透過メーター（iPhone の Safari など WebKit 用）: ProRes 4444（透過あり）を端末の中だけでエンコードする。何も送信しない。
   ffmpeg.wasm（ffmpeg/ffmpeg-core.js + ffmpeg-core.wasm.part0/1, GPL-2.0-or-later, ThirdPartyNotices.txt 参照）をこのサイトから読み込む。 */
let core = null;
async function init() {
  if (core) return;
  const parts = [];
  for (const p of ['ffmpeg/ffmpeg-core.wasm.part0', 'ffmpeg/ffmpeg-core.wasm.part1']) {
    const r = await fetch(p + '?v=0.12.10', { credentials: 'same-origin' }); if (!r.ok) throw new Error('ffmpeg ' + r.status); parts.push(await r.blob());
  }
  const wasmURL = URL.createObjectURL(new Blob(parts, { type: 'application/wasm' }));
  const coreURL = new URL('ffmpeg/ffmpeg-core.js?v=0.12.10', self.location.href).href;
  importScripts(coreURL);
  core = await self.createFFmpegCore({ mainScriptUrlOrBlob: coreURL + '#' + btoa(JSON.stringify({ wasmURL, workerURL: '' })) });
  core.setLogger(() => {}); core.setProgress(() => {});
}
function run(args) { core.setTimeout(-1); core.exec(...args); const r = core.ret; core.reset(); return r; }
self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') { await init(); self.postMessage({ id: m.id, ok: true }); }
    else if (m.type === 'encode') { // m.rgba: n 枚ぶんの RGBA（非プリマルチ）
      core.FS.writeFile('in.raw', new Uint8Array(m.rgba));
      const r = run(['-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', m.w + 'x' + m.h, '-r', '30', '-i', 'in.raw',
        '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', '-vendor', 'apl0', '-qscale:v', String(m.q || 9),
        '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-f', 'rawvideo', '-y', 'out.prores']);
      try { core.FS.unlink('in.raw'); } catch (x) {}
      if (r !== 0) throw new Error('ProRes エンコードに失敗しました (' + r + ')');
      const out = core.FS.readFile('out.prores'); core.FS.unlink('out.prores');
      self.postMessage({ id: m.id, ok: true, data: out.buffer }, [out.buffer]);
    }
  } catch (err) { self.postMessage({ id: m.id, ok: false, error: String(err && err.message || err) }); }
};
