/* PitchMeter web trial — UI. Everything runs on this device; nothing is uploaded, no analytics, no external requests. */
(function () {
'use strict';
const C = window.PMCore, G = window.PMGauge;
const $ = (id) => document.getElementById(id);
const MAX_SECONDS = 300, MAX_BYTES = 600 * 1024 * 1024;

// ---------- iOS audio session (Safari 16.4+ navigator.audioSession; feature-detected, best effort) ----------
function setAudioSession(type) { try { if (navigator.audioSession && navigator.audioSession.type !== type) navigator.audioSession.type = type; } catch (e) { /* unsupported */ } }

// ---------- tab glyphs (TabGlyphs.swift, 24x24 grid, 2pt round stroke) ----------
function arcPts(cx, cy, r, a0, a1) { const p = []; for (let i = 0; i <= 12; i++) { const a = (a0 + (a1 - a0) * i / 12) * Math.PI / 180; p.push((cx + r * Math.cos(a)).toFixed(3) + ',' + (cy + r * Math.sin(a)).toFixed(3)); } return p.join(' '); }
const GLYPHS = {
  analysis: `<rect class="s" x="2.5" y="5" width="19" height="15" rx="3.5"/><polyline class="s" points="5.5,12.5 7,12.5 8.5,10 10,15.5 11.5,10.5 13,14.5 15,8 16.5,15 18.5,12.5"/><path class="f" d="M12.6 0.6L17.4 0.6L15 4Z"/>`,
  live: `<circle class="s" cx="12" cy="9" r="5"/><path class="s" d="M12 9L14.6 5.9M12 14V19.5M8.5 20.5H15.5"/><polyline class="s" points="${arcPts(12, 9, 9, -32, 32)}"/><polyline class="s" points="${arcPts(12, 9, 9, 148, 212)}"/><circle class="f" cx="12" cy="9" r="1.4"/>`,
  profile: `<circle class="s" cx="9.5" cy="7.5" r="4"/><path class="s" d="M2.5 21C2.5 13.5 16.5 13.5 16.5 21M21 15.5V7Q22.8 7.6 23 10"/><ellipse class="f" cx="19.55" cy="15.75" rx="1.95" ry="1.45"/>`,
};
document.querySelectorAll('svg[data-glyph]').forEach(s => { s.innerHTML = GLYPHS[s.dataset.glyph]; s.setAttribute('aria-hidden', 'true'); });

// ---------- tabs (fresh load always starts on 素材分析; panes are hidden, never rebuilt) ----------
let tab = null;
const tabs = Array.from(document.querySelectorAll('.tab'));
function placePill() { const b = tabs.find(t => t.dataset.tab === tab); const pill = $('pill'); pill.style.width = b.offsetWidth + 'px'; pill.style.transform = `translateX(${b.offsetLeft - 5}px)`; }
function selectTab(t) {
  if (t === tab && !$('tab-' + t).hidden) { placePill(); return; }
  if (tab === 'live' && t !== 'live') live.stop();
  if (tab === 'file' && t !== 'file') rec.cancel();
  tab = t;
  for (const id of ['file', 'live', 'profile']) $('tab-' + id).hidden = id !== t;
  tabs.forEach(b => { const on = b.dataset.tab === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
  placePill(); if (t === 'live') live.draw(); if (t === 'file') file.resize();
}
tabs.forEach(b => b.addEventListener('click', () => selectTab(b.dataset.tab)));
window.addEventListener('resize', () => { placePill(); file.resize(); });

// ---------- sheets ----------
let infoSheet = null;
function openSheet(title, tpl) { $('sheetTitle').textContent = title; const c = $('sheetContent'); c.innerHTML = ''; c.appendChild($(tpl).content.cloneNode(true)); (infoSheet = infoSheet || modal($('sheet'))).open('sheetClose'); }
$('sheetClose').onclick = () => { if (infoSheet) infoSheet.close(); else $('sheet').hidden = true; };
document.querySelectorAll('[data-sheet]').forEach(b => b.addEventListener('click', () => {
  const k = b.dataset.sheet; openSheet({ support: 'サポート', feedback: 'ご意見・ご要望', license: 'ライセンス' }[k], 't-' + k);
}));
$('guideBtn').onclick = () => openSheet('使い方', 't-guide');

function canvasFit(cv, cssW, cssH) { const dpr = Math.min(3, window.devicePixelRatio || 1); const w = Math.max(2, Math.round(cssW * dpr)), h = Math.max(2, Math.round(cssH * dpr)); if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; } return [w, h]; }
const fmt = (s) => { s = isFinite(s) ? Math.max(0, s || 0) : 0; const m = Math.floor(s / 60), r = Math.floor(s % 60); return m + ':' + String(r).padStart(2, '0'); };

// ---------- モーダルシート共通（フォーカス移動・Tab の閉じ込め・Escape で閉じる・閉じたら元の場所へ戻す） ----------
const modals = new Map();
function modal(el, onClose) {
  let back = null;
  const focusables = () => Array.from(el.querySelectorAll('button:not([disabled]),[href],input:not([hidden]),[tabindex]:not([tabindex="-1"])')).filter(x => x.offsetParent !== null);
  const api = {
    open(first) { back = document.activeElement; el.hidden = false; requestAnimationFrame(() => { const f = first ? $(first) : focusables()[0]; if (f) f.focus(); }); },
    close(restore = true) { if (el.hidden) return; el.hidden = true; if (restore && back && back.focus) back.focus(); back = null; },
    requestClose() { onClose ? onClose() : api.close(); },
  };
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); api.requestClose(); return; }
    if (e.key === 'Tab') { const f = focusables(); if (!f.length) return; const i = f.indexOf(document.activeElement);
      if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); } }
  });
  el.addEventListener('click', (e) => { if (e.target === el) api.requestClose(); });
  modals.set(el.id, api); return api;
}
document.addEventListener('keydown', (e) => { if (e.key !== 'Escape') return; for (const [id, m] of modals) if (!$(id).hidden) { e.preventDefault(); m.requestClose(); break; } });

// ======================= 素材分析 =======================
const file = (() => {
  let worker = null, job = 0, media = null, isVideo = false, url = null, frames = null, timeline = null, vertical = false, raf = 0, meterCanvas = null, name = '';
  const status = (s) => { $('fileStatus').textContent = s; };
  const progress = (u) => { $('progressWrap').hidden = u === null; if (u !== null) { $('progressBar').style.setProperty('--p', (u * 100).toFixed(0) + '%'); $('progressText').textContent = Math.round(u * 100) + '%'; } };
  function resetMedia() {
    cancelAnimationFrame(raf); raf = 0;
    for (const el of [$('video'), $('audio')]) { try { el.pause(); } catch (e) {} el.removeAttribute('src'); el.load(); }
    if (url) { URL.revokeObjectURL(url); url = null; }
    media = null; frames = null; timeline = null;
    $('stage').hidden = true; $('controls').hidden = true; $('settings').hidden = true; $('reBtn').hidden = true;
    if (meterCanvas) { meterCanvas.remove(); meterCanvas = null; }
  }
  let lastFile = null;
  async function choose(f) {
    if (!f) return;
    lastFile = f; name = f.name || '素材';
    if (worker) { worker.terminate(); worker = null; }
    resetMedia(); $('editCard').hidden = false; $('fileName').textContent = name;
    const looksVideo = /^video\//.test(f.type) || /\.(mp4|mov|m4v|webm|3gp)$/i.test(f.name || '');
    const looksAudio = /^audio\//.test(f.type) || /\.(mp3|m4a|wav|aac|caf|aif|aiff|flac|ogg|opus)$/i.test(f.name || '');
    if (!looksVideo && !looksAudio) { status('この素材には対応していません。動画（mp4 / mov）か音声（mp3 / m4a / wav / aac）を選んでください。'); progress(null); return; }
    if (f.size > MAX_BYTES) { status('ファイルが大きすぎます（600MBまで）。短く書き出した素材を選んでください。'); progress(null); return; }
    isVideo = looksVideo; const my = ++job;
    status('素材を読み込んでいます…（端末の中だけで処理します）'); progress(0);
    let mono, rate;
    try {
      const buf = await f.arrayBuffer(); if (my !== job) return;
      const decoded = await decode(buf); if (my !== job) return;
      rate = decoded.sampleRate; const n = Math.min(decoded.length, Math.floor(MAX_SECONDS * rate));
      mono = new Float32Array(n); const chs = decoded.numberOfChannels;
      for (let c = 0; c < chs; c++) { const d = decoded.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / chs; }
      if (decoded.length > n) status(`最初の${MAX_SECONDS}秒を解析します…`);
    } catch (e) {
      if (my !== job) return;
      progress(null); status('この素材は読み込めませんでした。音声トラックがない動画や、対応していない形式の可能性があります（対応: mp3 / m4a / wav / aac / mp4 / mov など）。'); return;
    }
    url = URL.createObjectURL(f);
    status('解析中です…'); progress(0.02);
    const t0 = performance.now();
    worker = new Worker('worker.js');
    worker.onmessage = (e) => {
      const m = e.data; if (my !== job) return;
      if (m.type === 'progress') progress(0.02 + 0.98 * m.value);
      else if (m.type === 'result') {
        worker.terminate(); worker = null;
        frames = Array.from(m.hz, (hz, i) => ({ hz, register: m.reg[i], fallback: !!m.fb[i] }));
        const sec = ((performance.now() - t0) / 1000).toFixed(1);
        progress(null); status(`解析が完了しました（${sec}秒）。再生するとメーターが動きます。`);
        buildTimeline(); showMedia();
      } else if (m.type === 'error') { progress(null); status('解析できませんでした：' + m.message); }
    };
    worker.onerror = () => { if (my === job) { progress(null); status('解析できませんでした。端末のメモリが足りない可能性があります。短い素材でお試しください。'); } };
    worker.postMessage({ type: 'analyze', mono, rate, id: my }, [mono.buffer]);
  }
  async function decode(buf) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new OAC(1, 1, 44100);
    return await new Promise((res, rej) => { const p = ctx.decodeAudioData(buf, res, rej); if (p && p.then) p.then(res, rej); });
  }
  function buildTimeline() {
    timeline = C.buildStates(frames, vertical);
    const voiced = frames.filter(f => f.hz > 0).length, fb = frames.filter(f => f.fallback).length;
    const r = timeline.range;
    $('rangeText').textContent = `音域（自動）: 最低音 ${C.noteLabel(r.acceptedLow)} 〜 最高音 ${C.noteLabel(r.acceptedHigh)}`;
    const cnt = { 2: 0, 1: 0 }; frames.forEach(f => { if (f.hz > 0 && f.register) cnt[f.register]++; });
    $('statsText').textContent = voiced ? `ポインター表示 ${(100 * voiced / frames.length).toFixed(0)}%（うち補完 ${fb}フレーム）・裏声 ${(100 * cnt[2] / voiced).toFixed(0)}% / ミックス ${(100 * cnt[1] / voiced).toFixed(0)}%` : '音の高さが検出できませんでした。';
  }
  function showMedia() {
    media = isVideo ? $('video') : $('audio');
    media.src = url; media.load();
    $('stage').hidden = false; $('controls').hidden = false; $('settings').hidden = false; $('reBtn').hidden = false;
    $('video').hidden = !isVideo;
    if (!isVideo) { meterCanvas = document.createElement('canvas'); meterCanvas.className = 'meterOnly'; $('stage').insertBefore(meterCanvas, $('overlay')); $('overlay').hidden = true; }
    else $('overlay').hidden = false;
    media.onloadedmetadata = () => {
      const ready = () => { $('seek').max = Math.min(MAX_SECONDS, isFinite(media.duration) ? media.duration : (frames ? frames.length * 0.02 : 0)) || 1; resize(); draw(); updateTime(); };
      if (media.duration === Infinity) { // MediaRecorder の webm は長さが未記録 → 末尾へシークして長さを確定させる
        const fix = () => { if (isFinite(media.duration)) { media.removeEventListener('durationchange', fix); media.currentTime = 0; ready(); } };
        media.addEventListener('durationchange', fix); try { media.currentTime = 1e9; } catch (e) {} setTimeout(() => { media.removeEventListener('durationchange', fix); ready(); }, 1500);
      } else ready();
    };
    media.ontimeupdate = updateTime;
    media.onplay = () => { setAudioSession('playback'); $('playBtn').textContent = '一時停止'; $('playState').textContent = '再生中'; loop(); };
    media.onpause = () => { $('playBtn').textContent = '再生'; $('playState').textContent = '停止中'; draw(); };
    media.onended = media.onpause;
    media.onerror = () => { status('この素材は再生できませんでした（解析結果は保持しています）。'); };
    resize(); draw();
  }
  function resize() {
    if (!media || $('stage').hidden) return;
    const stage = $('stage');
    let aspect;
    if (isVideo) { const vw = media.videoWidth || 16, vh = media.videoHeight || 9; aspect = vw / vh; }
    else aspect = vertical ? 9 / 16 : 1080 / 330;
    const maxH = isVideo ? (aspect < 1 ? 420 : 300) : (vertical ? 460 : 9999);
    stage.style.width = `min(100%, ${(maxH * aspect).toFixed(1)}px)`; stage.style.height = 'auto'; stage.style.aspectRatio = String(aspect);
    stage.style.background = isVideo ? '#000' : 'rgb(23,23,28)';
    draw();
  }
  function stateAt(t) { const s = timeline.states; return s[Math.min(s.length - 1, Math.max(0, Math.round(t * 30)))]; }
  function draw() {
    if (!timeline || !media) return;
    const cv = isVideo ? $('overlay') : meterCanvas; if (!cv) return;
    const [w, h] = canvasFit(cv, cv.clientWidth || 1, cv.clientHeight || 1);
    G.render(cv.getContext('2d'), w, h, stateAt(media.currentTime || 0), timeline.range, vertical);
  }
  function loop() { cancelAnimationFrame(raf); const step = () => { draw(); if (media && media.currentTime >= MAX_SECONDS) media.pause(); if (media && !media.paused) raf = requestAnimationFrame(step); }; raf = requestAnimationFrame(step); }
  function updateTime() { if (!media) return; const d = Math.min(MAX_SECONDS, media.duration || 0); $('seek').value = media.currentTime || 0; $('timeText').textContent = `${fmt(media.currentTime)} / ${fmt(d)}`; }
  $('pickBtn').onclick = () => $('fileInput').click(); // iOS は標準メニュー（写真ライブラリ / ビデオを撮る / ファイルを選択）を直接表示
  for (const id of ['fileInput']) $(id).addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; choose(f); });
  $('playBtn').onclick = () => { if (!media) return; setAudioSession('playback'); if (media.paused) { if (media.currentTime >= Math.min(MAX_SECONDS, media.duration || Infinity) - 0.05) media.currentTime = 0; media.play().catch(() => status('再生を開始できませんでした。もう一度押してください。')); } else media.pause(); };
  $('stopBtn').onclick = () => { if (!media) return; media.pause(); media.currentTime = 0; updateTime(); draw(); };
  $('seek').oninput = () => { if (!media) return; media.currentTime = +$('seek').value; draw(); updateTime(); };
  $('cancelBtn').onclick = () => { job++; if (worker) { worker.terminate(); worker = null; } progress(null); status('解析を中止しました。'); };
  $('reBtn').onclick = () => { if (lastFile) choose(lastFile); };
  for (const b of [$('orientH'), $('orientV')]) b.onclick = () => { vertical = b.dataset.v === '1'; $('orientH').classList.toggle('on', !vertical); $('orientV').classList.toggle('on', vertical); if (frames) buildTimeline(); resize(); };
  document.addEventListener('visibilitychange', () => { if (document.hidden && media) media.pause(); });
  return { resize, choose };
})();

// ======================= リアルタイム =======================
const live = (() => {
  const cv = $('liveCanvas'); let running = false, ctx = null, stream = null, node = null, src = null, worker = null, gen = 0, tl = null, raf = 0, lastT = 0, devHandler = null, lastRange = C.defaultRange();
  const setStatus = (s, on) => { $('liveStatus').textContent = s; $('liveDot').classList.toggle('on', !!on); };
  const notice = (s) => { $('liveNotice').hidden = !s; $('liveNotice').textContent = s || ''; };
  function setButton() { const b = $('liveToggle'); b.classList.toggle('running', running); $('liveToggleText').textContent = running ? '停止' : '開始'; $('liveToggleIco').textContent = running ? '■' : '●'; b.setAttribute('aria-label', running ? 'リアルタイム表示を停止' : 'リアルタイム表示を開始'); }
  function draw(state) { const [w, h] = [cv.width, cv.height]; G.render(cv.getContext('2d'), w, h, state || G.emptyState(), tl ? tl.range : lastRange, false); }
  const isIOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const MIC = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
  function help(text) { $('liveHelp').hidden = !text; $('liveHelpText').textContent = text || ''; $('liveReload').hidden = false; }
  async function permState() { try { if (navigator.permissions && navigator.permissions.query) return (await navigator.permissions.query({ name: 'microphone' })).state; } catch (e) {} return 'unknown'; }
  async function openMic() {
    // 1回目の getUserMedia はタップの処理中に同期で呼ぶ（ここより前に await を置かない）。既定のマイクを使う。
    const first = navigator.mediaDevices.getUserMedia({ audio: MIC, video: false });
    try { return await first; }
    catch (e) { if (e && (e.name === 'OverconstrainedError' || e.name === 'TypeError')) return await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); throw e; }
  }
  async function start() {
    if (running) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.isSecureContext) { notice(''); help(''); running = true; fail('このブラウザではマイクを使えません（https で開いてください）'); return; }
    setAudioSession('play-and-record');
    const pending = openMic(); // ← タップ直後・最初の処理で許可の確認を出す（この前に await なし）
    notice(''); help(''); setStatus('マイクの許可を確認中…'); running = true; setButton(); const my = ++gen;
    try {
      const AC = window.AudioContext || window.webkitAudioContext; ctx = new AC();
      stream = await pending;
      if (my !== gen) { stream.getTracks().forEach(t => t.stop()); return; }
      if (ctx.state === 'suspended') await ctx.resume();
      const track = stream.getAudioTracks()[0];
      $('liveInput').textContent = '入力: ' + (track && track.label ? track.label : 'マイク');
      track.onended = () => stop('マイクが外れたので停止しました。つなぎ直してから「開始」を押してください。');
      devHandler = () => stop('マイクの接続が変わったので停止しました。もう一度「開始」を押してください。');
      if (navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', devHandler);
      worker = new Worker('worker.js'); tl = new C.GaugeTimeline([], C.defaultRange(), false); tl.frames = [];
      worker.onmessage = (e) => { const m = e.data; if (m.type === 'liveFrames' && m.gen === my && running) tl.append(m.frames.map(([hz, register]) => ({ hz, register }))); };
      worker.postMessage({ type: 'liveStart', rate: ctx.sampleRate });
      src = ctx.createMediaStreamSource(stream);
      const sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination);
      const send = (buf) => { if (running && my === gen) worker.postMessage({ type: 'livePush', samples: buf, gen: my }, [buf.buffer]); };
      if (ctx.audioWorklet && window.AudioWorkletNode) {
        await ctx.audioWorklet.addModule('capture-worklet.js');
        if (my !== gen) return;
        node = new AudioWorkletNode(ctx, 'pm-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
        node.port.onmessage = (e) => send(e.data);
      } else {
        node = ctx.createScriptProcessor(2048, 1, 1);
        node.onaudioprocess = (e) => send(new Float32Array(e.inputBuffer.getChannelData(0)));
      }
      src.connect(node); node.connect(sink);
      ctx.onstatechange = () => { if (running && ctx && ctx.state === 'interrupted') stop('ほかの音声で中断されたので停止しました。'); };
      setStatus('聞き取り中', true); lastT = performance.now(); loop();
    } catch (e) {
      if (my !== gen) return;
      const n = e && e.name;
      if (n === 'NotAllowedError' || n === 'SecurityError') {
        const st = await permState();
        if (my !== gen) return;
        if (st === 'denied' || st === 'unknown') {
          fail('マイクが許可されていません');
          help(isIOS() ? 'マイクがブロックされています。アドレスバーの「ぁあ」→「Webサイトの設定」→「マイク」→「許可」にして、ページを再読み込みしてください。'
            : 'マイクがブロックされています。アドレスバー左のアイコン →「権限」→「マイク」を許可して、ページを再読み込みしてください。');
        } else { fail('マイクの許可が必要です'); help('もう一度「開始」を押して、確認画面で「許可」を選んでください。'); $('liveReload').hidden = true; }
        return;
      }
      if (n === 'NotFoundError' || n === 'DevicesNotFoundError') { fail('マイクが見つかりませんでした'); help('マイクがつながっているか確認して、もう一度「開始」を押してください。'); $('liveReload').hidden = true; return; }
      if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError') { fail('マイクを使えませんでした'); help('ほかのアプリやタブがマイクを使っている可能性があります。閉じてから、もう一度「開始」を押してください。'); $('liveReload').hidden = true; return; }
      fail('マイクを開始できませんでした'); help('もう一度「開始」を押してください。'); $('liveReload').hidden = true;
    }
  }
  function fail(msg) { teardown(); running = false; setButton(); setStatus(msg); }
  function loop() { cancelAnimationFrame(raf); let acc = 0; const step = (now) => { if (!running) return; acc += now - lastT; const dt = Math.min(0.2, (now - lastT) / 1000); lastT = now;
      if (acc >= 1000 / 30 - 2) { acc = 0; const t = Math.max(0, tl.frames.length - 1) * 0.02; draw(tl.tick(t, dt * 1, true)); }
      raf = requestAnimationFrame(step); }; raf = requestAnimationFrame(step); }
  function teardown() {
    gen++; cancelAnimationFrame(raf);
    if (devHandler && navigator.mediaDevices && navigator.mediaDevices.removeEventListener) navigator.mediaDevices.removeEventListener('devicechange', devHandler); devHandler = null;
    try { if (src) src.disconnect(); if (node) { node.disconnect(); if (node.port) node.port.onmessage = null; } } catch (e) {}
    if (stream) stream.getTracks().forEach(t => { t.onended = null; t.stop(); });
    if (ctx) { try { ctx.close(); } catch (e) {} }
    if (worker) { worker.terminate(); }
    stream = null; node = null; src = null; ctx = null; worker = null;
    setAudioSession('playback');
  }
  function stop(message) {
    if (!running && !message) return;
    if (tl) lastRange = tl.range;
    teardown(); running = false; setButton(); setStatus('停止中'); $('liveInput').textContent = 'マイク未使用';
    if (message) notice(message);
    draw();
  }
  $('liveToggle').onclick = () => running ? stop() : start();
  $('liveReload').onclick = () => location.reload();
  document.addEventListener('visibilitychange', () => { if (document.hidden && running) stop(); });
  draw();
  return { stop, draw: () => { if (!running) draw(); } };
})();

// ======================= サンプル音声を追加（録音シート） =======================
// マイク音声はこの端末のメモリだけ。WAVにして素材分析（file.choose）と同じ解析経路へ渡す。送信・保存はしない。
const rec = (() => {
  const SECONDS = 5, COUNT = 3;
  let phase = 'idle', ctx = null, stream = null, node = null, src = null, gen = 0, chunks = [], got = 0, timer = 0, startAt = 0, peak = 0;
  const btn = $('recBtn');
  const msg = (s) => { $('recMsg').textContent = s || ''; };
  const count = (s) => { $('recCount').textContent = s; };
  const state = (s) => { $('recState').textContent = s; };
  function ui() {
    btn.classList.toggle('recording', phase !== 'idle');
    $('recBtnText').textContent = phase === 'idle' ? '録音する' : phase === 'rec' ? '停止' : 'やめる';
    btn.setAttribute('aria-label', phase === 'idle' ? '録音する' : phase === 'rec' ? '録音を停止して解析' : '録音をやめる');
    if (phase === 'idle') { count(String(SECONDS)); state('約5秒で自動で止まります'); $('recLevelBar').style.width = '0%'; }
  }
  function teardown() {
    gen++; clearInterval(timer); timer = 0;
    try { if (src) src.disconnect(); if (node) { node.disconnect(); if (node.port) node.port.onmessage = null; node.onaudioprocess = null; } } catch (e) {}
    if (stream) stream.getTracks().forEach(t => { t.onended = null; t.stop(); });
    if (ctx) { try { ctx.close(); } catch (e) {} }
    stream = null; node = null; src = null; ctx = null; setAudioSession('playback');
  }
  function fail(m) { teardown(); chunks = []; phase = 'idle'; ui(); msg(m); }
  function cancel() { if (phase === 'idle') return; teardown(); chunks = []; phase = 'idle'; ui(); }
  const m = modal($('recSheet'), () => close());
  function open() { msg(''); phase = 'idle'; ui(); m.open('recBtn'); }
  function close() { cancel(); m.close(); }
  function wav(samples, rate) {
    const n = samples.length, b = new ArrayBuffer(44 + n * 2), v = new DataView(b); const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) { const x = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
    return new Blob([b], { type: 'audio/wav' });
  }
  function finish() {
    if (phase !== 'rec') return;
    const rate = ctx ? ctx.sampleRate : 48000; teardown(); phase = 'idle'; ui();
    const all = new Float32Array(got); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; } chunks = [];
    if (all.length < rate * 0.5) { msg('録音が短すぎました。もう一度「録音する」を押してください。'); return; }
    let sq = 0, pk = 0; for (let i = 0; i < all.length; i++) { const x = all[i]; sq += x * x; if (Math.abs(x) > pk) pk = Math.abs(x); }
    if (pk < 0.01 || 10 * Math.log10(sq / all.length + 1e-20) < -55) { msg('声が小さくて聞き取れませんでした。マイクに近づいて、もう少し大きめに録ってください。'); return; }
    const d = new Date(), name = `サンプル音声 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}.wav`;
    let f; try { f = new File([wav(all, rate)], name, { type: 'audio/wav' }); } catch (e) { f = wav(all, rate); f.name = name; }
    m.close(false);
    file.choose(f);
    requestAnimationFrame(() => { const ec = $('editCard'); if (ec && ec.scrollIntoView) ec.scrollIntoView({ block: 'start', behavior: 'smooth' }); });
  }
  async function start() {
    msg(''); phase = 'prep'; ui(); count('…'); state('マイクを準備しています'); const my = ++gen;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.isSecureContext) { fail('このブラウザではマイクを使えません（https で開いてください）。'); return; }
    try { live.stop(); } catch (e) {}
    try {
      setAudioSession('play-and-record');
      const AC = window.AudioContext || window.webkitAudioContext; ctx = new AC();
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }, video: false });
      if (my !== gen) { stream.getTracks().forEach(t => t.stop()); return; }
      if (ctx.state === 'suspended') await ctx.resume();
      const track = stream.getAudioTracks()[0]; if (track) track.onended = () => { if (phase === 'rec') finish(); else fail('マイクが外れたので録音をやめました。'); };
      src = ctx.createMediaStreamSource(stream);
      const sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination);
      const onChunk = (buf) => { if (my !== gen) return; let p = 0; for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > p) p = a; } peak = Math.max(p, peak * 0.85);
        $('recLevelBar').style.width = Math.min(100, Math.round(Math.sqrt(peak) * 140)) + '%';
        if (phase === 'rec') { chunks.push(buf); got += buf.length; if (got >= SECONDS * ctx.sampleRate) finish(); } };
      if (ctx.audioWorklet && window.AudioWorkletNode) {
        await ctx.audioWorklet.addModule('capture-worklet.js'); if (my !== gen) return;
        node = new AudioWorkletNode(ctx, 'pm-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
        node.port.onmessage = (e) => onChunk(e.data);
      } else { node = ctx.createScriptProcessor(2048, 1, 1); node.onaudioprocess = (e) => onChunk(new Float32Array(e.inputBuffer.getChannelData(0))); }
      src.connect(node); node.connect(sink);
      ctx.onstatechange = () => { if (ctx && ctx.state === 'interrupted') fail('ほかの音声で中断されたので録音をやめました。'); };
      phase = 'count'; ui(); let left = COUNT; count(String(left)); state('まもなく録音が始まります。低い裏声から準備してください');
      timer = setInterval(() => { if (my !== gen) return;
        if (phase === 'count') { left--; if (left > 0) { count(String(left)); return; }
          phase = 'rec'; chunks = []; got = 0; startAt = performance.now(); ui(); count(String(SECONDS)); state('録音中… 低い裏声 → 高い裏声へ'); return; }
        if (phase === 'rec') { count(String(Math.max(0, SECONDS - Math.floor((performance.now() - startAt) / 1000))));
          if (performance.now() - startAt > SECONDS * 1000 + 1500) finish(); } }, 1000);
    } catch (e) {
      if (my !== gen) return;
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      fail(denied ? 'マイクが許可されていません。ブラウザの設定でマイクを許可してから、もう一度押してください。' : (e && e.name === 'NotFoundError' ? 'マイクが見つかりませんでした。' : '録音を開始できませんでした。もう一度試してください。'));
    }
  }
  btn.onclick = () => { if (phase === 'idle') start(); else if (phase === 'rec') finish(); else cancel(); };
  $('sampleBtn').onclick = open;
  $('recClose').onclick = close;
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  return { cancel: close };
})();

selectTab('file');
})();
