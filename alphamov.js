/* 2026-11-19 透過メーターのみ（iPhone の Safari など）: ProRes 4444（透過あり）+ 16bit PCM 音声の .mov を端末の中だけで作る。
   iOS アプリは HEVC（透過あり）の .mov。Safari の WebCodecs は透過つきのエンコードに未対応のため、透過を残せる ProRes 4444 を使う。 */
(function (root) {
  'use strict';
  const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255], u16 = (v) => [(v >> 8) & 255, v & 255];
  const u64 = (v) => [...u32(Math.floor(v / 4294967296)), ...u32(v >>> 0)];
  const str = (s) => Array.from(s, c => c.charCodeAt(0) & 255);
  const bytes = (a) => a instanceof Uint8Array ? a : new Uint8Array(a);
  function box(type, ...parts) {
    const ps = parts.map(p => bytes(p)), n = 8 + ps.reduce((s, p) => s + p.length, 0), out = new Uint8Array(n);
    out.set([...u32(n), ...str(type)], 0); let o = 8; for (const p of ps) { out.set(p, o); o += p.length; } return out;
  }
  const full = (type, vf, ...parts) => box(type, u32(vf), ...parts);
  const matrix = [...u32(0x10000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x10000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];
  const pascal32 = (s) => { const a = new Array(32).fill(0); a[0] = s.length; str(s).forEach((c, i) => { a[i + 1] = c; }); return a; };
  /** ProRes の生ストリーム（[4バイト長]'icpf'…の連続）をフレームごとの長さに分ける */
  function splitProRes(buf) {
    const b = bytes(buf), sizes = []; let o = 0;
    while (o + 8 <= b.length) { const n = ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
      if (n < 8 || o + n > b.length || b[o + 4] !== 0x69 || b[o + 5] !== 0x63 || b[o + 6] !== 0x70 || b[o + 7] !== 0x66) throw new Error('ProRes frame'); sizes.push(n); o += n; }
    if (o !== b.length) throw new Error('ProRes tail'); return sizes;
  }
  /** Annex-B（00 00 01 区切り）→ NAL の配列 */
  function splitAnnexB(buf) {
    const b = bytes(buf), out = []; let i = 0, start = -1;
    while (i + 2 < b.length) {
      if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) { if (start >= 0) { let e = i; while (e > start && b[e - 1] === 0) e--; out.push(b.subarray(start, e)); } i += 3; start = i; }
      else i++;
    }
    if (start >= 0 && start < b.length) out.push(b.subarray(start));
    return out;
  }
  const nalType = (n) => (n[0] >> 1) & 63;
  /** 1 フレーム（Annex-B）→ 4 バイト長つきのサンプル（VPS/SPS/PPS は hvcC に入れるので除く） */
  function hevcSample(au) {
    const nals = splitAnnexB(au).filter(n => { const t = nalType(n); return t < 32 || t > 34; });
    const out = new Uint8Array(nals.reduce((s, n) => s + 4 + n.length, 0)); let o = 0;
    for (const n of nals) { out.set(u32(n.length), o); out.set(n, o + 4); o += 4 + n.length; } return out;
  }
  /** HEVC の hvcC（VPS / SPS / PPS / SEI を全レイヤー分。透過レイヤーの SPS・PPS も入れる: Apple の HEVC with Alpha の決まり） */
  function hvcC(headers) {
    const nals = splitAnnexB(headers), sps = nals.find(n => nalType(n) === 33 && ((n[0] & 1) << 5 | n[1] >> 3) === 0);
    if (!sps) throw new Error('SPS がありません');
    const rb = []; for (let i = 2; i < sps.length && rb.length < 16; i++) { if (i >= 4 && sps[i] === 3 && sps[i - 1] === 0 && sps[i - 2] === 0) continue; rb.push(sps[i]); }
    const ptl = rb.slice(1, 13); // general_profile_space/tier/idc(1) + compat(4) + constraint(6) + level(1)
    const groups = []; for (const t of [32, 33, 34, 39]) { const list = nals.filter(n => nalType(n) === t); if (list.length) groups.push([t, list]); }
    const arr = []; for (const [t, list] of groups) { arr.push(0x80 | t, ...u16(list.length)); for (const n of list) arr.push(...u16(n.length), ...n); }
    return box('hvcC', [1, ...ptl.slice(0, 11), ptl[11], 0xf0, 0x00, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0, 0x0f, groups.length], arr);
  }
  /** .mov を組み立てる。video: { width, height, fps, chunks: [Blob|Uint8Array], sizes: [各フレームのバイト数] }（chunks は sizes の順に連続）
   *  audio: { rate, channels, pcm: Blob|Uint8Array（16bit little-endian 交互）} | null → Blob（video/quicktime） */
  function buildMov(video, audio) {
    const fps = video.fps || 30, TS = 600, dv = TS / fps, nV = video.sizes.length, vDur = nV * dv;
    const ftyp = box('ftyp', str('qt  '), u32(0x200), str('qt  ')), wide = box('wide');
    const vBytes = video.sizes.reduce((s, n) => s + n, 0);
    const aFrameBytes = audio ? 2 * audio.channels : 0, aBytes = audio ? (audio.pcm.size !== undefined ? audio.pcm.size : audio.pcm.length) : 0, nA = audio ? Math.floor(aBytes / aFrameBytes) : 0;
    const mdatHdr = new Uint8Array([...u32(1), ...str('mdat'), ...u64(16 + vBytes + aBytes)]);
    const base = ftyp.length + wide.length + mdatHdr.length;
    const vOff = []; { let o = base; for (const n of video.sizes) { vOff.push(o); o += n; } }
    const aChunkFrames = audio ? audio.rate : 0, aChunks = []; { let o = base + vBytes; for (let f = 0; f < nA; f += aChunkFrames) { aChunks.push([o, Math.min(aChunkFrames, nA - f)]); o += Math.min(aChunkFrames, nA - f) * aFrameBytes; } }
    const aDurMovie = audio ? Math.round(nA / audio.rate * TS) : 0, movieDur = Math.max(vDur, aDurMovie);
    const mvhd = full('mvhd', 0, u32(0), u32(0), u32(TS), u32(movieDur), u32(0x10000), u16(0x100), new Array(10).fill(0), matrix, new Array(24).fill(0), u32(audio ? 3 : 2));
    const hdlr = (pre, sub, name) => full('hdlr', 0, str(pre), str(sub), u32(0), u32(0), u32(0), [name.length, ...str(name)]);
    const dinf = box('dinf', full('dref', 0, u32(1), full('url ', 1)));
    const co64 = (offs) => full('co64', 0, u32(offs.length), ...offs.map(o => u64(o)));
    // video
    const W = video.width, H = video.height;
    const entry = video.codec === 'hvc1'
      ? box('hvc1', new Array(6).fill(0), u16(1), u16(0), u16(0), u32(0), u32(0), u32(0), u16(W), u16(H), u32(72 << 16), u32(72 << 16), u32(0), u16(1),
        pascal32('HEVC'), u16(32), u16(0xffff), video.hvcC, box('colr', str('nclc'), u16(1), u16(1), u16(1)), box('pasp', u32(1), u32(1)))
      : box('ap4h', new Array(6).fill(0), u16(1), u16(0), u16(0), str('appl'), u32(0x200), u32(0x200), u16(W), u16(H), u32(72 << 16), u32(72 << 16), u32(0), u16(1),
      pascal32('Apple ProRes 4444'), u16(32), u16(0xffff), box('colr', str('nclc'), u16(1), u16(1), u16(1)), box('fiel', [1, 0]), box('pasp', u32(1), u32(1)));
    const sizesBox = full('stsz', 0, u32(0), u32(nV), ...video.sizes.map(n => u32(n)));
    const stss = video.keys && video.keys.length < nV ? full('stss', 0, u32(video.keys.length), ...video.keys.map(k => u32(k))) : new Uint8Array(0);
    const vstbl = box('stbl', full('stsd', 0, u32(1), entry), full('stts', 0, u32(1), u32(nV), u32(dv)), stss, full('stsc', 0, u32(1), u32(1), u32(1), u32(1)), sizesBox, co64(vOff));
    const vtrak = box('trak', full('tkhd', 3, u32(0), u32(0), u32(1), u32(0), u32(vDur), u32(0), u32(0), u16(0), u16(0), u16(0), u16(0), matrix, u32(W << 16), u32(H << 16)),
      box('mdia', full('mdhd', 0, u32(0), u32(0), u32(TS), u32(vDur), u16(0x7fff), u16(0)), hdlr('mhlr', 'vide', 'VideoHandler'),
        box('minf', full('vmhd', 1, u16(0), u16(0), u16(0), u16(0)), hdlr('dhlr', 'url ', 'DataHandler'), dinf, vstbl)));
    let atrak = new Uint8Array(0);
    if (audio) {
      const sowt = box('sowt', new Array(6).fill(0), u16(1), u16(0), u16(0), u32(0), u16(audio.channels), u16(16), u16(0), u16(0), u32(audio.rate << 16),
        audio.channels === 2 ? full('chan', 0, u32(0x00650002), u32(0), u32(0)) : []);
      const stsc = []; { let prev = -1; aChunks.forEach(([, n], i) => { if (n !== prev) { stsc.push([i + 1, n]); prev = n; } }); }
      const astbl = box('stbl', full('stsd', 0, u32(1), sowt), full('stts', 0, u32(1), u32(nA), u32(1)),
        full('stsc', 0, u32(stsc.length), ...stsc.map(([c, n]) => [...u32(c), ...u32(n), ...u32(1)])), full('stsz', 0, u32(aFrameBytes), u32(nA)), co64(aChunks.map(c => c[0])));
      atrak = box('trak', full('tkhd', 3, u32(0), u32(0), u32(2), u32(0), u32(aDurMovie), u32(0), u32(0), u16(0), u16(1), u16(0x100), u16(0), matrix, u32(0), u32(0)),
        box('mdia', full('mdhd', 0, u32(0), u32(0), u32(audio.rate), u32(nA), u16(0x7fff), u16(0)), hdlr('mhlr', 'soun', 'SoundHandler'),
          box('minf', full('smhd', 0, u16(0), u16(0)), hdlr('dhlr', 'url ', 'DataHandler'), dinf, astbl)));
    }
    const moov = box('moov', mvhd, vtrak, atrak);
    const parts = [ftyp, wide, mdatHdr, ...video.chunks]; if (audio) parts.push(audio.pcm); parts.push(moov);
    return new Blob(parts, { type: 'video/quicktime' });
  }
  /** 32bit float の L/R → 16bit PCM（little-endian 交互） */
  function pcm16(l, r) {
    const n = l.length, out = new Int16Array(n * 2);
    for (let i = 0; i < n; i++) { const a = Math.max(-1, Math.min(1, l[i])), b = Math.max(-1, Math.min(1, r[i])); out[2 * i] = a < 0 ? a * 32768 : a * 32767; out[2 * i + 1] = b < 0 ? b * 32768 : b * 32767; }
    const u = new Uint8Array(out.buffer); // little-endian 端末前提（iPhone / Mac / PC はすべて LE）
    return u;
  }
  /** ブラウザ: 透過 .mov を書き出す。renderFrame(t, ctx) で 1 フレーム描く。 */
  function encoder() {
    let w = null, seq = 0; const pending = new Map();
    const fail = (p, msg, why) => { clearTimeout(p.t); const e = new Error(msg); e.why = why; p.rej(e); };
    // ms: 応答がない時間の上限。iPhone はメモリが足りないと worker を黙って止めることがあるため、待ち続けずに理由つきで失敗させる。
    const call = (msg, tr, ms) => new Promise((res, rej) => {
      const id = ++seq, p = { res, rej, t: 0 }; pending.set(id, p);
      p.t = setTimeout(() => { if (pending.delete(id)) fail(p, 'timeout ' + msg.type, msg.type === 'init' ? 'timeout-load' : 'timeout'); }, ms);
      w.postMessage(Object.assign({ id }, msg), tr || []);
    });
    return {
      async init() {
        w = new Worker('alpha-worker.js?v=' + (root.PM_ALPHA_V || '20261119hevc'));
        w.onmessage = (e) => { const p = pending.get(e.data.id); if (!p) return; pending.delete(e.data.id); clearTimeout(p.t); if (e.data.ok) p.res(e.data); else fail(p, e.data.error, e.data.why || 'other'); };
        w.onerror = (e) => { const m = String(e && e.message || 'error'); for (const p of pending.values()) fail(p, 'worker: ' + m, /memory/i.test(m) ? 'memory' : 'crash'); pending.clear(); };
        await call({ type: 'init' }, null, 180000);
      },
      async encode(rgba, width, height, q) { const r = await call({ type: 'encode', rgba, w: width, h: height, q }, [rgba], 120000); return new Uint8Array(r.data); },
      close() { if (w) w.terminate(); w = null; for (const p of pending.values()) { clearTimeout(p.t); p.rej(new Error('cancel')); } pending.clear(); },
    };
  }
  /** HEVC（透過あり）エンコーダー（hevc-worker.js） */
  function hevcEncoder() {
    let w = null, seq = 0; const pending = new Map();
    const fail = (p, msg, why) => { clearTimeout(p.t); const e = new Error(msg); e.why = why; p.rej(e); };
    const call = (msg, tr, ms) => new Promise((res, rej) => {
      const id = ++seq, p = { res, rej, t: 0 }; pending.set(id, p);
      p.t = setTimeout(() => { if (pending.delete(id)) fail(p, 'timeout ' + msg.type, msg.type === 'init' ? 'timeout-load' : 'timeout'); }, ms);
      w.postMessage(Object.assign({ id }, msg), tr || []);
    });
    return {
      async init(width, height, fps, crf) {
        w = new Worker('hevc-worker.js?v=' + (root.PM_ALPHA_V || '20261119hevc'));
        w.onmessage = (e) => { const p = pending.get(e.data.id); if (!p) return; pending.delete(e.data.id); clearTimeout(p.t); if (e.data.ok) p.res(e.data); else fail(p, e.data.error, e.data.why || 'other'); };
        w.onerror = (e) => { const m = String(e && e.message || 'error'); for (const p of pending.values()) fail(p, 'worker: ' + m, /memory/i.test(m) ? 'memory' : 'crash'); pending.clear(); };
        const r = await call({ type: 'init', w: width, h: height, fps, crf }, null, 120000); return new Uint8Array(r.headers);
      },
      async encode(rgba, pts) { const r = await call({ type: 'encode', rgba, pts }, rgba ? [rgba] : [], 180000); return r; },
      async flush() { return await call({ type: 'flush' }, [], 180000); },
      close() { if (w) w.terminate(); w = null; for (const p of pending.values()) { clearTimeout(p.t); p.rej(new Error('cancel')); } pending.clear(); },
    };
  }
  /** 失敗理由（why）を短い日本語に */
  function reasonText(e) {
    const why = e && e.why, m = String(e && e.message || e || '');
    if (why === 'load' || why === 'timeout-load') return '読み込み失敗';
    if (why === 'compile') return '読み込み失敗（準備できず）';
    if (why === 'memory' || e instanceof RangeError || /out of memory|allocation/i.test(m)) return 'メモリ不足';
    if (why === 'crash') return '処理が止まりました（メモリ不足の可能性）';
    if (why === 'timeout') return '時間切れ（メモリ不足の可能性）';
    if (why === 'encode') return 'エンコード失敗';
    if (/canvas|getImageData|frame|フレーム/i.test(m)) return '画像の作成に失敗';
    return 'その他のエラー';
  }
  const api = { buildMov, splitProRes, pcm16, encoder, hevcEncoder, hevcSample, hvcC, splitAnnexB, reasonText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PMAlphaMov = api;
})(typeof self !== 'undefined' ? self : this);
