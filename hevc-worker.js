/* 透過メーター（iPhone の Safari など WebKit 用）: 配信中の iOS アプリと同じ「HEVC（透過あり）」をこの端末の中だけで作る。何も送信しない。
   エンコーダーは x265 4.1（GPL-2.0-or-later、ThirdPartyNotices.txt 参照）を WebAssembly にしたもの（hevca/hevca.js + hevca.wasm、約1.7MB）。
   RGBA（非プリマルチ）→ YUVA 4:2:0（BT.709・映像はビデオレンジ、透過はフルレンジ）に変換して渡す。 */
let M = null, W = 0, H = 0, buf = 0, stage = '';
function tag(e, why) { const x = new Error(String(e && e.message || e)); x.why = why; return x; }
async function load() {
  stage = 'load';
  try { importScripts('hevca/hevca.js?v=x265-4.1b'); } catch (e) { throw tag(e, 'load'); }
  let mod;
  try { const r = await fetch('hevca/hevca.wasm?v=x265-4.1b', { credentials: 'same-origin' }); if (!r.ok) throw new Error('hevca ' + r.status); mod = await WebAssembly.compile(await r.arrayBuffer()); } catch (e) { throw tag(e, e instanceof WebAssembly.CompileError ? 'compile' : 'load'); }
  stage = 'compile';
  try { M = await self.createHevcA({ instantiateWasm(imports, done) { WebAssembly.instantiate(mod, imports).then((inst) => done(inst, mod)); return {}; } }); } catch (e) { throw tag(e, /memory/i.test(String(e && e.message)) || e instanceof RangeError ? 'memory' : 'compile'); }
}
// RGBA → Y, U, V, A（U/V は 2x2 を透過の重みで平均: 透明な黒が縁の色に混ざらないように）
function toYUVA(rgba, dst) {
  const w = W, h = H, cw = w >> 1, ch = h >> 1, Y = 0, U = w * h, V = U + cw * ch, A = V + cw * ch;
  for (let i = 0, n = w * h; i < n; i++) {
    const p = i * 4, r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
    dst[Y + i] = (16 + (0.2126 * r + 0.7152 * g + 0.0722 * b) * 219 / 255 + 0.5) | 0;
    dst[A + i] = rgba[p + 3];
  }
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    let sr = 0, sg = 0, sb = 0, sa = 0, tr = 0, tg = 0, tb = 0;
    for (let k = 0; k < 4; k++) { const p = (((y * 2 + (k >> 1)) * w) + x * 2 + (k & 1)) * 4, a = rgba[p + 3];
      sr += rgba[p] * a; sg += rgba[p + 1] * a; sb += rgba[p + 2] * a; sa += a; tr += rgba[p]; tg += rgba[p + 1]; tb += rgba[p + 2]; }
    let r, g, b; if (sa > 0) { r = sr / sa; g = sg / sa; b = sb / sa; } else { r = tr / 4; g = tg / 4; b = tb / 4; }
    const j = y * cw + x;
    dst[U + j] = Math.max(16, Math.min(240, (128 + (-0.1146 * r - 0.3854 * g + 0.5 * b) * 224 / 255 + 0.5) | 0));
    dst[V + j] = Math.max(16, Math.min(240, (128 + (0.5 * r - 0.4542 * g - 0.0458 * b) * 224 / 255 + 0.5) | 0));
  }
}
const outBytes = () => M.HEAPU8.slice(M._hv_out(), M._hv_out() + M._hv_outn());
self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      if (!M) await load();
      stage = 'open'; W = m.w; H = m.h;
      const p = M.stringToNewUTF8(m.preset || 'ultrafast'), n = M._hv_open(W, H, m.fps || 30, m.crf || 18, p); M._free(p);
      if (n < 0) throw tag('x265 open ' + n, 'encode');
      const headers = outBytes(); buf = M._hv_malloc(W * H * 5 / 2); if (!buf) throw tag('malloc', 'memory');
      self.postMessage({ id: m.id, ok: true, headers: headers.buffer }, [headers.buffer]);
    } else if (m.type === 'encode' || m.type === 'flush') { // encode: n 枚ぶんの RGBA。戻り: 出てきたフレーム（Annex-B）と キーフレームか
      stage = 'encode';
      const aus = [], keys = [], fb = W * H * 4, rgba = m.rgba ? new Uint8Array(m.rgba) : null, n = rgba ? rgba.length / fb : 0;
      const take = () => { aus.push(outBytes()); keys.push(M._hv_lastkey()); };
      for (let k = 0; k < n; k++) {
        toYUVA(rgba.subarray(k * fb, (k + 1) * fb), M.HEAPU8.subarray(buf, buf + W * H * 5 / 2));
        const r = M._hv_encode(buf, m.pts + k); if (r < 0) throw tag('x265 encode', 'encode'); if (r > 0) take();
      }
      if (m.type === 'flush') { let r; while ((r = M._hv_encode(0, 0)) > 0) take(); if (r < 0) throw tag('x265 flush', 'encode'); M._hv_close(); }
      const total = aus.reduce((s, a) => s + a.length, 0), data = new Uint8Array(total), sizes = []; let o = 0;
      for (const a of aus) { data.set(a, o); o += a.length; sizes.push(a.length); }
      const back = m.rgba || null; // 使い終わった RGBA の入れ物を返して使い回す（iPhone のメモリを節約）
      self.postMessage({ id: m.id, ok: true, data: data.buffer, sizes, keys, back }, back ? [data.buffer, back] : [data.buffer]);
    }
  } catch (err) {
    const s = String(err && err.message || err), why = err && err.why || (err instanceof RangeError || /out of memory|allocation|Cannot enlarge/i.test(s) ? 'memory' : stage === 'encode' ? 'encode' : 'other');
    self.postMessage({ id: m.id, ok: false, why, error: s + ' [' + stage + ']' });
  }
};
