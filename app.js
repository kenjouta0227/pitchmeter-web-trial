/* PitchMeter web trial — UI (iOS MobileHome parity). Everything runs on this device; nothing is uploaded, no analytics.
   Network: only this site's own files (app, analysis models). Ads: placeholders only (ads-config.js), no ad requests. */
(function () {
'use strict';
const C = window.PMCore, G = window.PMGauge, ADS = window.PM_ADS;
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
function placePill() { const b = tabs.find(t => t.dataset.tab === tab); if (!b) return; const pill = $('pill'); pill.style.width = b.offsetWidth + 'px'; pill.style.transform = `translateX(${b.offsetLeft - 5}px)`; }
function selectTab(t) {
  if (t === tab && !$('tab-' + t).hidden) { placePill(); return; }
  if (tab === 'live' && t !== 'live') live.stop();
  if (tab === 'file' && t !== 'file') { rec.cancel(); try { col.cancel(); } catch (e) {} }
  tab = t;
  for (const id of ['file', 'live', 'profile']) $('tab-' + id).hidden = id !== t;
  tabs.forEach(b => { const on = b.dataset.tab === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
  placePill(); if (t === 'live') live.draw(); if (t === 'file') file.resize();
}
tabs.forEach(b => b.addEventListener('click', () => selectTab(b.dataset.tab)));
window.addEventListener('resize', () => { placePill(); file.resize(); });

function canvasFit(cv, cssW, cssH) { const dpr = Math.min(3, window.devicePixelRatio || 1); const w = Math.max(2, Math.round(cssW * dpr)), h = Math.max(2, Math.round(cssH * dpr)); if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; } return [w, h]; }
const fmt = (s) => { s = isFinite(s) ? Math.max(0, s || 0) : 0; const m = Math.floor(s / 60), r = Math.floor(s % 60); return m + ':' + String(r).padStart(2, '0'); };
const fmt2 = (t) => { const s = Math.max(0, Math.floor(isFinite(t) ? t : 0)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }; // MobilePlayback.time

// ---------- モーダル共通（フォーカス移動・Tab の閉じ込め・Escape で閉じる・閉じたら元の場所へ戻す） ----------
const modals = new Map();
function modal(el, onClose) {
  let back = null;
  const focusables = () => Array.from(el.querySelectorAll('button:not([disabled]),[href],input:not([hidden]),select,textarea,[tabindex]:not([tabindex="-1"])')).filter(x => x.offsetParent !== null);
  const api = {
    open(first) { back = document.activeElement; el.hidden = false; requestAnimationFrame(() => { const f = first ? $(first) : focusables()[0]; if (f) f.focus({ preventScroll: true }); }); ads.update(); },
    close(restore = true) { if (el.hidden) return; el.hidden = true; if (restore && back && back.focus) back.focus({ preventScroll: true }); back = null; ads.update(); },
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
document.addEventListener('keydown', (e) => { if (e.key !== 'Escape') return; for (const [id, m] of Array.from(modals).reverse()) if (!$(id).hidden) { e.preventDefault(); m.requestClose(); break; } });

// ---------- サンプル音声（声の種類ごとの判定基準）: この端末の localStorage にだけ保存。音声そのものは保存も送信もしない ----------
// 保存するのは特徴量（f0・hrich・cpp8k・息漏れ）だけ。適用スイッチがオフ、またはサンプルが無いときは判定は公開中の既定と完全に同じ。
const samples = (() => {
  const KEY = 'pm.voiceSamples.v1', APPLY = 'pm.voiceSamples.apply';
  const CATS = [
    { k: 'chest', name: '地声', guideNote: '地声でいちばん低い音から、ミックスに変わる直前まで' },
    { k: 'mix', name: 'ミックス', guideNote: 'ミックスボイスに変わったところから、裏声に変わる直前まで' },
    { k: 'ura', name: '裏声', guideNote: '裏声に変わったところから上（息まじりの裏声もここ）' },
    { k: 'uramix', name: 'ミックス（裏声寄り）', guideNote: '芯があって息もれの少ない、裏声寄りの高い声' },
  ];
  let data = {}, apply = true, cache = null, cacheSig = '';
  try { data = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { data = {}; }
  try { const a = localStorage.getItem(APPLY); apply = a === null ? true : a === '1'; } catch (e) {}
  for (const k of Object.keys(data)) if (!CATS.some(c => c.k === k) || !data[k] || !Array.isArray(data[k].frames) || !data[k].frames.length) delete data[k];
  const listeners = [];
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(data)); return true; } catch (e) { return false; } };
  const changed = () => { cache = null; cacheSig = ''; listeners.forEach(f => { try { f(); } catch (e) {} }); };
  const api = {
    CATS, nameOf: (k) => (CATS.find(c => c.k === k) || {}).name || k,
    get: (k) => data[k] || null,
    any: () => Object.keys(data).length > 0,
    applied: () => apply && Object.keys(data).length > 0,
    applyOn: () => apply,
    setApply(v) { apply = !!v; try { localStorage.setItem(APPLY, apply ? '1' : '0'); } catch (e) {} changed(); },
    put(k, rec) { const first = !api.any(); data[k] = rec; if (!save()) { delete data[k]; return false; } if (first) { apply = true; try { localStorage.setItem(APPLY, '1'); } catch (e) {} } changed(); return true; },
    remove(k) { delete data[k]; save(); changed(); },
    clear() { data = {}; try { localStorage.removeItem(KEY); localStorage.removeItem(APPLY); } catch (e) {} apply = true; changed(); },
    /** 判定に渡す個人パラメータ。適用オフ・サンプル無しのときは null（＝既定の判定）。 */
    personal() {
      if (!api.applied()) return null;
      const sig = api.signature(); if (cache && cacheSig === sig) return cache;
      try { cache = C.buildCalibration(data); } catch (e) { cache = null; } cacheSig = sig; return cache;
    },
    signature: () => api.applied() ? Object.keys(data).sort().map(k => k + ':' + data[k].at).join(',') : 'default',
    onChange: (f) => listeners.push(f),
  };
  return api;
})();

// ---------- ⓘ 説明（StudioInformationModal / operationDetails） ----------
const INFO = {
  '利用回数': '解析は消費なし。月次試用は新しいファイルの書き出し成功時に1回消費します。\n（ウェブ試作版は回数を消費しません。）',
  'Fullでできること': '最大300秒、自動・手動音域、縦メーター、出力音声の選択が利用できます。購入条件はプラン・購入で確認できます。',
  '歌声補正': '原音・歌声・保守的補完から解析方法を選びます。変更後は再解析で確認してください。',
  '音声': '動画に含める音声を選びます。抽出歌声・伴奏は対応する分離結果が必要です。',
  'メーターの向き': 'メーターの向きを選びます。素材の縦横とプレビュー枠は自動判定します。縦メーターはFullで利用できます。',
  '開発者アイコンの表示切替': 'メーター内に開発者のアイコンと名前を表示します。無料プランでは常に表示されます。Full・Plusは表示を切り替えられます。',
  '音域設定': '自動は安定した解析音高から設定します。手動値は自動値とは別に保持し、切替時も残ります。',
  '全画面': 'メーターの表示を広げる、または元の表示へ戻します。\n表示のみの操作です。解析は開始しません。',
  '再生・試聴': '選択中の素材・解析音を再生、停止、移動します。\n試聴する音声は画面の選択状態を確認してください。原本は変更しません。',
};
const infoM = modal($('infoModal'));
function showInfo(title, text) { const host = !$('fs').hidden ? $('fs') : document.body; if ($('infoModal').parentNode !== host) host.appendChild($('infoModal')); $('infoTitle').textContent = title; $('infoText').textContent = text; infoM.open('infoClose'); }
$('infoClose').onclick = () => infoM.close();
document.addEventListener('click', (e) => {
  const b = e.target.closest('.info'); if (!b) return;
  e.preventDefault(); e.stopPropagation();
  if (b.dataset.info) showInfo(b.dataset.info, INFO[b.dataset.info] || ''); else showInfo(b.dataset.infoTitle || '', b.dataset.infoText || '');
}, true);
$('fullWhatBtn').onclick = () => showInfo('Fullでできること', INFO['Fullでできること']);

// ---------- 広告枠（ads-config.js の1か所で管理。枠だけ・通信なし。表示条件は iOS と同じ） ----------
const ads = (() => {
  const S = (ADS && ADS.slots) || {}, label = (ADS && ADS.label) || '広告';
  let presenting = false, rewardBusy = false, actionsSinceAd = 0;
  const covered = () => !$('fs').hidden || !$('plan').hidden || !$('guide').hidden || presenting;
  function build() {
    const b = $('adBanner');
    if (S.banner && S.banner.enabled) { b.innerHTML = `<div class="ad-banner"><span class="ad-badge">${label}</span><span class="ad-ph">広告枠 ${S.banner.width}×${S.banner.height}</span></div>`; Object.assign(b.firstChild.style, { width: S.banner.width + 'px', height: S.banner.height + 'px' }); }
    const n = $('adNative');
    if (S.native && S.native.enabled) n.innerHTML = `<div class="ad-native"><span class="ad-attr">${label}</span><div class="ad-row"><i class="ad-icon"></i><div><div class="ad-title">広告枠（ネイティブ広告）</div><div class="ad-body">ここに広告が表示されます。ウェブ版は枠のみで、広告は読み込みません。</div></div></div><div class="ad-media">広告の画像・動画</div><div class="ad-cta">詳しく見る</div></div>`;
  }
  function update() {
    const visible = document.visibilityState === 'visible';
    $('adBanner').hidden = !(S.banner && S.banner.enabled && visible && !covered());
    document.body.classList.toggle('has-banner', !$('adBanner').hidden || (S.banner && S.banner.enabled && covered()));
    $('adNative').hidden = !(S.native && S.native.enabled && !rewardBusy && !presenting);
    $('adReward').hidden = !(S.reward && S.reward.enabled);
    $('rewardBtn').disabled = !file.rewardEligible() || rewardBusy;
  }
  $('rewardBtn').onclick = () => { const m = $('rewardMsg'); m.hidden = false; m.textContent = 'ウェブ版は広告の枠だけです（広告は表示しません）。Fullの機能はそのまま使えます。'; };
  const inter = modal($('adInterstitial'), () => closeInter());
  function closeInter() { presenting = false; inter.close(); update(); }
  $('adInterClose').onclick = closeInter;
  return {
    build, update, noteAction() { actionsSinceAd++; },
    // presentAtExportCompletion: 再生中は出さない・前回から minActions 回以上の操作があったときだけ
    atExportCompletion(playing) {
      const s = S.interstitial; if (!s || !s.enabled || playing || presenting || actionsSinceAd < (s.minActions || 2)) return false;
      actionsSinceAd = 0; presenting = true; inter.open('adInterClose'); update(); return true;
    },
    get presenting() { return presenting; },
  };
})();
document.addEventListener('visibilitychange', () => ads.update());

// ---------- プラン・購入（PlanGuideScreen：表示のみ、購入なし） ----------
const plan = (() => {
  const m = modal($('plan'), () => close());
  function open() { m.open('planClose'); }
  function close() { m.close(); }
  $('planClose').onclick = close; $('planContinue').onclick = close; $('planBtn').onclick = open;
  document.querySelectorAll('[data-review]').forEach(b => b.onclick = () => showInfo('プランの確認', `${b.dataset.review}：ウェブ試作版では購入できません（表示のみ）。購入はiPhoneアプリの「プラン・購入」から行えます。`));
  return { open, close };
})();

// ---------- 使い方（LocalUsageGuide） ----------
const guideM = modal($('guide'));
$('guideBtn').onclick = () => guideM.open('guideClose');
$('guideClose').onclick = () => guideM.close();

// ---------- シート（サポート・ライセンス） ----------
const sheetM = modal($('sheet'));
function openSheet(title, tpl, init) { $('sheetTitle').textContent = title; const c = $('sheetContent'); c.innerHTML = ''; c.appendChild($(tpl).content.cloneNode(true)); sheetM.open('sheetClose'); if (init) init(); }
$('sheetClose').onclick = () => sheetM.close();
const LEGAL = { terms: 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/', privacy: 'https://pitch-meter-support.kenjouta0227.workers.dev/privacy' };
document.querySelectorAll('[data-legal]').forEach(b => b.onclick = () => { window.open(LEGAL[b.dataset.legal], '_blank', 'noopener,noreferrer'); });
// FeedbackPanel: 入力はこの端末（localStorage）にだけ保存。送信はしない（メールアプリで本人が送る）。
const FB_KEY = 'pm.feedback.v1', SUPPORT = 'kenjouta0227@gmail.com';
$('rowSupport').onclick = () => openSheet('サポート', 't-support', () => {
  let d = { improvement: '', feature: '' }; try { d = Object.assign(d, JSON.parse(localStorage.getItem(FB_KEY) || '{}')); } catch (e) {}
  const msg = (s) => { $('fbMsg').textContent = s; };
  const body = () => `ピッチメーターへのお問い合わせ\n\n【問い合わせ内容・改善してほしい点】\n${d.improvement}\n\n【追加してほしい機能】\n${d.feature}`;
  $('fbImprove').value = d.improvement; $('fbFeature').value = d.feature;
  const persist = () => { try { localStorage.setItem(FB_KEY, JSON.stringify(d)); msg('入力を端末内に保存しました。まだ送信していません。'); } catch (e) { msg('保存できませんでした。本文をコピーして残してください。'); } };
  $('fbImprove').oninput = () => { d.improvement = $('fbImprove').value; persist(); };
  $('fbFeature').oninput = () => { d.feature = $('fbFeature').value; persist(); };
  $('fbMail').onclick = () => {
    const url = 'mailto:' + SUPPORT + '?subject=' + encodeURIComponent('ピッチメーター お問い合わせ') + '&body=' + encodeURIComponent(body());
    if (url.length > 16000) { msg('本文が長いためコピーしてメールへ貼り付けてください。'); return; }
    try { window.location.href = url; msg('メール画面で内容を確認して送信してください。入力は保持しています。'); } catch (e) { msg('メールを開けませんでした。入力は保持されています。宛先・本文をコピーできます。'); }
  };
  $('fbCopy').onclick = async () => { try { await navigator.clipboard.writeText('宛先：' + SUPPORT + '\n\n' + body()); msg('コピーしました。送信していません。'); } catch (e) { msg('コピーできませんでした。'); } };
  $('fbClear').onclick = () => { d = { improvement: '', feature: '' }; $('fbImprove').value = ''; $('fbFeature').value = ''; persist(); };
});
// LicenseReader: 6000文字ごとにページ分け（iOS LicensePages.split と同じ）
let licPages = null;
$('rowLicense').onclick = () => openSheet('ライセンス・第三者ソフトウェア', 't-license', async () => {
  try {
    if (!licPages) { const r = await fetch('ThirdPartyNotices.txt'); if (!r.ok) throw new Error(); const t = await r.text(); const cps = Array.from(t); licPages = []; for (let i = 0; i < cps.length; i += 6000) licPages.push(cps.slice(i, i + 6000).join('')); if (!licPages.length) licPages = ['']; }
  } catch (e) { $('licHint').textContent = 'ライセンスを読み込めませんでした'; return; }
  let page = 0; const sel = $('licPage');
  sel.innerHTML = licPages.map((_, i) => `<option value="${i}">${i + 1} / ${licPages.length}</option>`).join('');
  $('licHint').textContent = '全文を順番に分けて表示します。文字の選択・コピーもできます。'; $('licNav').hidden = false;
  const show = () => { $('licText').textContent = licPages[page]; $('licText').scrollTop = 0; sel.value = String(page); $('licPageVal').textContent = `${page + 1} / ${licPages.length}`; $('licPrev').disabled = page === 0; $('licNext').disabled = page + 1 === licPages.length; };
  $('licPrev').onclick = () => { if (page > 0) { page--; show(); } }; $('licNext').onclick = () => { if (page + 1 < licPages.length) { page++; show(); } };
  sel.onchange = () => { page = +sel.value; show(); };
  show();
});

// ---------- select の表示値（iOS selectField と同じ見た目） ----------
function bindSelect(sel, val, on) { const upd = () => { val.textContent = sel.options[sel.selectedIndex].text; }; sel.addEventListener('change', () => { upd(); on && on(sel.value); }); upd(); }

// ---------- 開発者アイコン ----------
const brandImg = new Image(); brandImg.onload = () => { G.setBrand(brandImg); file.redraw(); }; brandImg.src = 'GaugeBrand.jpeg';

// ======================= 素材分析（MobileHome.fileTab） =======================
const file = (() => {
  // ---- state ----
  let srcFile = null, isVideo = false, url = null, media = null, L = null, R = null, duration = 0;
  let worker = null, job = 0, task = null; // task: 'analysis' | 'video' | null
  let result = null; // { frames, stem:[L,R]|null, key }
  let timeline = null, analysisFrames = null;
  let analysisMode = 'assisted', outputAudio = 'original', vertical = false, branding = true;
  let manualRangeEnabled = false, manualRange = null, rangeLow = 52, rangeHigh = 74;
  let placement = { x: null, y: null, scale: 1, angle: 0 };
  let sourceSize = { w: 640, h: 360 }, ready = false, fullscreen = false;
  let output = null; const completed = [];
  let raf = 0;
  const status = (s) => { $('fileStatus').textContent = s; };
  const progress = (u) => { $('progressWrap').hidden = u === null; if (u !== null) { $('progressBar').style.setProperty('--p', (u * 100).toFixed(0) + '%'); $('progressText').textContent = Math.round(u * 100) + '%'; } };
  const appearance = () => ({ maximumSeconds: MAX_SECONDS, vertical, branding, placement });
  const manualOf = (low, high) => { const r = { low, high, split1: low + (high - low) / 3, split2: low + 2 * (high - low) / 3, acceptedLow: 440 * Math.pow(2, (low - 69) / 12), acceptedHigh: 440 * Math.pow(2, (high - 69) / 12) }; return (isFinite(low) && isFinite(high) && 35 <= low && low < high && high <= 96) ? r : null; };
  const activeRange = () => (manualRangeEnabled ? manualRange : null);
  const displayedRange = () => activeRange() || C.makeRange(analysisFrames || []);
  const playing = () => !!(media && !media.paused && !media.ended);
  function setTask(t) {
    task = t;
    const busy = !!t;
    for (const id of ['analysisSel', 'audioSel', 'orientH', 'orientV', 'brandToggle', 'rangeAuto', 'rangeManual', 'midiLow', 'midiHigh']) $(id).disabled = busy;
    $('settings').classList.toggle('disabled', busy); $('rangeCard').classList.toggle('disabled', busy);
    for (const id of ['reBtn', 'exVideo', 'exAlpha', 'exGreen', 'exAudio', 'pickBtn', 'sampleBtn']) $(id).disabled = busy;
    $('editor').classList.toggle('off', busy); // playback.editingEnabled = (operationKind == "idle")
    if (busy) deselect();
    renderMidi(); ads.update();
  }

  // ---- 素材を選ぶ（startMovie(url)） ----
  $('pickBtn').onclick = () => $('fileInput').click(); // iOS Safari: 写真ライブラリ / ビデオを撮る / ファイルを選択
  $('fileInput').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) choose(f); });
  async function choose(f) {
    if (task) return;
    const looksVideo = /^video\//.test(f.type) || /\.(mp4|mov|m4v|webm|3gp)$/i.test(f.name || '');
    const looksAudio = /^audio\//.test(f.type) || /\.(mp3|m4a|wav|aac|caf|aif|aiff|flac|ogg|opus)$/i.test(f.name || '');
    $('editCard').hidden = false; $('fileName').textContent = f.name || '素材';
    if (!looksVideo && !looksAudio) { status('この素材には対応していません。動画（mp4 / mov）か音声（mp3 / m4a / wav / aac）を選んでください。'); return; }
    if (f.size > MAX_BYTES) { status('ファイルが大きすぎます（600MBまで）。短く書き出した素材を選んでください。'); return; }
    clearPlayback(); output = null; $('shareBtn').hidden = true; $('outDesc').hidden = true;
    srcFile = f; isVideo = looksVideo; L = R = null; result = null; analysisFrames = null;
    $('rangeCard').hidden = true; $('exports').hidden = true;
    startAnalysis();
  }
  $('reBtn').onclick = () => { if (srcFile && !task) { clearPlayback(); output = null; $('shareBtn').hidden = true; $('outDesc').hidden = true; result = null; analysisFrames = null; $('rangeCard').hidden = true; $('exports').hidden = true; startAnalysis(); } };
  // 2026-11-18: 動画（mov / mp4 / m4v）は decodeAudioData が開けない・止まることがある（iPhone の画面収録など）。
  // そのときは端末内で AAC 音声トラックだけを取り出して（PMCore.MovAudio）ADTS → decodeAudioData、だめなら WebCodecs AudioDecoder で復号する。
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const decodeAudio = (buf, ms) => new Promise((res, rej) => {
    const ctx = new OAC(2, 1, 44100); let done = false;
    const ok = (d) => { if (!done) { done = true; res(d); } }, ng = (e) => { if (!done) { done = true; rej(e || new Error('decode')); } };
    if (ms) setTimeout(() => ng(new Error('decode timeout')), ms);
    try { const p = ctx.decodeAudioData(buf, ok, ng); if (p && p.then) p.then(ok, ng); } catch (e) { ng(e); }
  });
  async function webCodecsDecode(m) {
    if (typeof AudioDecoder === 'undefined') throw new Error('decode: no AudioDecoder');
    const cfg = { codec: 'mp4a.40.' + m.aot, sampleRate: m.sampleRate, numberOfChannels: m.channels, description: m.asc };
    if (!(await AudioDecoder.isConfigSupported(cfg)).supported) throw new Error('decode: AAC unsupported');
    const parts = [], chs = Math.max(1, Math.min(2, m.channels)); let err = null;
    const dec = new AudioDecoder({ output: (a) => { const ch = []; for (let c = 0; c < chs; c++) { const x = new Float32Array(a.numberOfFrames); a.copyTo(x, { planeIndex: Math.min(c, a.numberOfChannels - 1), format: 'f32-planar' }); ch.push(x); } parts.push(ch); a.close(); }, error: (e) => { err = e; } });
    dec.configure(cfg); let t = 0;
    for (const f of m.frames) { dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(t * 1e6 / m.sampleRate), data: f })); t += 1024; }
    await dec.flush(); dec.close(); if (err) throw err;
    let n = 0; for (const p of parts) n += p[0].length; if (!n) throw new Error('decode: empty');
    const ctx = new OAC(chs, Math.max(1, Math.ceil(n * 44100 / m.sampleRate)), 44100), b = ctx.createBuffer(chs, n, m.sampleRate);
    for (let c = 0; c < chs; c++) { const o = b.getChannelData(c); let k = 0; for (const p of parts) { o.set(p[c], k); k += p[c].length; } }
    if (m.sampleRate === 44100) return b;
    const src = ctx.createBufferSource(); src.buffer = b; src.connect(ctx.destination); src.start(); return await ctx.startRendering();
  }
  async function decodeContainer(buf) {
    const m = C.MovAudio.demux(buf); let d = null;
    try { d = await decodeAudio(C.MovAudio.toADTS(m).buffer, 20000); } catch (e) { d = await webCodecsDecode(m); }
    // edit list: both ADTS and WebCodecs output still contain the encoder priming (1686 samples here) → drop it so audio lines up with the video
    const skip = Math.round(m.skip / m.timescale * 44100), lead = Math.round(m.leadSec * 44100);
    const chs = d.numberOfChannels > 1 ? [d.getChannelData(0), d.getChannelData(1)] : [d.getChannelData(0), d.getChannelData(0)];
    return chs.map((x) => { const y = new Float32Array(Math.max(0, x.length - skip) + lead); y.set(x.subarray(Math.min(skip, x.length)), lead); return y; });
  }
  async function decodeFile() {
    if (L) return;
    const box = /\.(mov|mp4|m4v|m4a)$/i.test(srcFile.name || '') || /^video\/(quicktime|mp4|x-m4v)$|^audio\/(mp4|x-m4a)$/i.test(srcFile.type || '');
    let d = null, first = null, ch = null;
    try { d = await decodeAudio(await srcFile.arrayBuffer(), box ? 15000 : 0); } catch (e) { first = e; }
    if (d) ch = [d.getChannelData(0), d.numberOfChannels > 1 ? d.getChannelData(1) : d.getChannelData(0)];
    else if (box) { try { ch = await decodeContainer(await srcFile.arrayBuffer()); } catch (e) { throw first || e; } }
    else throw first || new Error('decode');
    const n = Math.min(ch[0].length, Math.floor(MAX_SECONDS * 44100));
    L = ch[0].slice(0, n); R = ch[1].slice(0, n);
  }
  const keyOf = (a, o) => a + '|' + o + '|' + samples.signature();
  let pendingReject = null;
  function runProcess(analysis, audio, onProgress) {
    return new Promise((resolve, reject) => {
      const my = ++job; pendingReject = reject;
      if (!worker) worker = new Worker('worker.js?v=20261121tl2');
      worker.onmessage = (e) => {
        const m = e.data; if (my !== job) return;
        if (m.type === 'progress') onProgress(m.value, m.label);
        else if (m.type === 'result') resolve({ frames: Array.from(m.hz, (hz, i) => ({ hz, register: m.reg[i], fallback: !!m.fb[i], uraSure: !!(m.su && m.su[i]) })), stem: m.stemL ? [m.stemL, m.stemR] : null, key: keyOf(analysis, audio) });
        else if (m.type === 'error') reject(new Error(m.message));
      };
      worker.onerror = (ev) => { if (my === job) reject(new Error('worker')); };
      worker.postMessage({ type: 'process', id: my, L, R, analysis, audio, personal: samples.personal() });
    });
  }
  function cancelTask() { job++; if (worker) { worker.terminate(); worker = null; } if (exporter.active()) exporter.cancel(); if (pendingReject) { const r = pendingReject; pendingReject = null; r(new Error('cancelled')); } }
  $('cancelBtn').onclick = () => { if (!task) return; cancelTask(); setTask(null); progress(null); status('中止しました。試用回数は消費していません。'); };
  async function startAnalysis() {
    ads.noteAction();
    setTask('analysis'); status('解析しています（試用回数は消費しません）…'); progress(0);
    try {
      await decodeFile();
      result = await runProcess(analysisMode, outputAudio, (v) => progress(v));
      analysisFrames = result.frames;
      await loadPlayback();
      rebuildTimeline();
      $('rangeCard').hidden = false; $('exports').hidden = false; renderRange();
      progress(null); setTask(null);
      status('解析が完了しました。素材とメーターを再生・全画面で確認できます。保存は下の書き出しボタンを使ってください。');
    } catch (e) {
      if (!task) return; // cancelled
      progress(null); setTask(null);
      status(/decode|EncodingError|Unable|unsupported/i.test(String(e && (e.name + e.message))) || !L ? 'この素材は読み込めませんでした。音声トラックがない動画や、対応していない形式の可能性があります（対応: mp3 / m4a / wav / aac / mp4 / mov など）。' : '書き出し・解析を完了できませんでした。完成ファイル一覧と試用残数を確認してください。');
    }
  }

  // ---- 再生（MobilePlayback / PlaybackStage） ----
  function clearPlayback() {
    exitFullscreen(); cancelAnimationFrame(raf); raf = 0; ready = false;
    for (const el of [$('video')]) { try { el.pause(); } catch (e) {} el.removeAttribute('src'); el.load(); }
    if (media && media !== $('video')) { try { media.pause(); } catch (e) {} media.removeAttribute('src'); }
    media = null; if (url) { URL.revokeObjectURL(url); url = null; }
    timeline = null; placement = { x: null, y: null, scale: 1, angle: 0 }; sourceSize = { w: 640, h: 360 };
    $('stageBox').hidden = true; $('controls').hidden = true; $('placeHint').hidden = true; deselect();
  }
  function loadPlayback() {
    return new Promise((resolve, reject) => {
      url = URL.createObjectURL(srcFile);
      media = isVideo ? $('video') : new Audio();
      media.preload = 'auto'; if (!isVideo) media.setAttribute('playsinline', '');
      $('video').hidden = !isVideo;
      let done = false;
      const fin = () => {
        if (done) return; done = true;
        if (isVideo && media.videoWidth > 0) sourceSize = { w: media.videoWidth, h: media.videoHeight };
        const d = isFinite(media.duration) && media.duration > 0 ? media.duration : (analysisFrames.length * 0.02);
        duration = Math.min(d, MAX_SECONDS);
        $('seek').max = $('fsSeek').max = String(Math.max(0.01, duration));
        ready = true; $('stageBox').hidden = false; $('controls').hidden = false; $('placeHint').hidden = false;
        resize(); updateTime(); resolve();
      };
      media.onloadedmetadata = () => {
        if (media.duration === Infinity) { // MediaRecorder の webm は長さ未記録 → 末尾へシークして確定
          const fix = () => { if (isFinite(media.duration)) { media.removeEventListener('durationchange', fix); media.currentTime = 0; fin(); } };
          media.addEventListener('durationchange', fix); try { media.currentTime = 1e9; } catch (e) {} setTimeout(() => { media.removeEventListener('durationchange', fix); fin(); }, 1500);
        } else fin();
      };
      media.onerror = () => { if (!done) { done = true; status('素材の再生を準備できませんでした。ファイルの形式と保存場所を確認してください。'); reject(new Error('play')); } else status('素材の再生に失敗しました。別の対応素材を選んでください。'); };
      media.ontimeupdate = () => { if (media.currentTime >= duration - 0.01 && !media.paused) { media.pause(); } updateTime(); };
      media.onplay = () => { setAudioSession('playback'); syncPlayUI(); loop(); ads.update(); };
      media.onpause = () => { syncPlayUI(); draw(); ads.update(); };
      media.onended = media.onpause;
      media.src = url; media.load();
    });
  }
  function syncPlayUI() { const p = playing(); $('playBtn').textContent = p ? '一時停止' : '再生'; $('playState').textContent = p ? '再生中' : '停止中'; $('fsPlay').textContent = p ? 'Ⅱ 一時停止' : '▶ 再生'; }
  function rebuildTimeline() { if (!analysisFrames) return; timeline = C.buildStates(analysisFrames, vertical, activeRange()); draw(); }
  function stateAt(t) { const s = timeline.states; return s[Math.min(s.length - 1, Math.max(0, Math.round(t * 30)))]; }
  function resize() {
    if (!ready) return;
    const host = fullscreen ? $('fsStage') : $('stageBox');
    if (!fullscreen) host.style.height = (sourceSize.h > sourceSize.w ? 420 : 220) + 'px';
    const bw = host.clientWidth, bh = host.clientHeight; if (!bw || !bh) return;
    const fit = Math.min(bw / sourceSize.w, bh / sourceSize.h), fw = sourceSize.w * fit, fh = sourceSize.h * fit;
    const s = $('stageFit'); s.style.width = fw + 'px'; s.style.height = fh + 'px';
    draw(); layoutEditor();
  }
  function draw() {
    if (!timeline || !ready) return;
    const cv = $('overlay'), s = $('stageFit');
    const [w, h] = canvasFit(cv, s.clientWidth || 1, s.clientHeight || 1);
    G.render(cv.getContext('2d'), w, h, stateAt(media ? media.currentTime || 0 : 0), timeline.range, appearance());
  }
  function loop() { cancelAnimationFrame(raf); const step = () => { draw(); if (media && !media.paused) { updateTime(); raf = requestAnimationFrame(step); } }; raf = requestAnimationFrame(step); }
  function updateTime() {
    if (!media) return; const t = Math.min(duration, media.currentTime || 0), s = `${fmt2(t)} / ${fmt2(duration)}`;
    $('seek').value = t; $('fsSeek').value = t; $('timeText').textContent = s; $('fsTime').textContent = s;
  }
  function toggle() { if (!ready || !media) return; setAudioSession('playback'); if (media.paused) { if (media.currentTime >= duration - 0.05) media.currentTime = 0; media.play().catch(() => status('再生を開始できませんでした。もう一度押してください。')); } else media.pause(); }
  function stop() { if (!media) return; media.pause(); media.currentTime = 0; updateTime(); draw(); }
  function seek(v) { if (!ready || !media) return; media.currentTime = Math.min(duration, Math.max(0, +v)); updateTime(); draw(); }
  $('playBtn').onclick = toggle; $('stopBtn').onclick = stop; $('fsPlay').onclick = toggle; $('fsStop').onclick = stop;
  $('seek').oninput = () => seek($('seek').value); $('fsSeek').oninput = () => seek($('fsSeek').value);
  document.addEventListener('visibilitychange', () => { if (document.hidden && media) media.pause(); });

  // ---- 全画面（FullscreenPlayback）: 同じ video 要素を移すだけ（再読み込み・シークなし） ----
  const fsEl = $('fs');
  function enterFullscreen() {
    if (!ready) return; fullscreen = true; deselect();
    fsEl.classList.toggle('portrait', sourceSize.h > sourceSize.w);
    fsEl.hidden = false; $('fsStage').appendChild($('stageFit')); document.body.classList.add('fs-open');
    const req = fsEl.requestFullscreen || fsEl.webkitRequestFullscreen; // iPhone Safari は要素の全画面に非対応 → 画面いっぱいの表示で代替
    if (req && (document.fullscreenEnabled || document.webkitFullscreenEnabled)) { try { const p = req.call(fsEl); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
    requestAnimationFrame(() => { resize(); $('fsClose').focus({ preventScroll: true }); }); ads.update();
  }
  function exitFullscreen() {
    if (!fullscreen) return; fullscreen = false; deselect();
    const fe = document.fullscreenElement || document.webkitFullscreenElement;
    if (fe) { const ex = document.exitFullscreen || document.webkitExitFullscreen; try { const p = ex.call(document); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
    $('stageBox').appendChild($('stageFit')); fsEl.hidden = true; document.body.classList.remove('fs-open');
    requestAnimationFrame(resize); ads.update(); $('fsBtn').focus({ preventScroll: true });
  }
  $('fsBtn').onclick = enterFullscreen; $('fsClose').onclick = exitFullscreen;
  for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(ev, () => { if (!(document.fullscreenElement || document.webkitFullscreenElement) && fullscreen) exitFullscreen(); else resize(); });
  fsEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); exitFullscreen(); } });

  // ---- メーターの配置（GaugePlacementEditor） ----
  const ed = $('editor'), hit = $('meterHit');
  let selected = false, snapX = false, snapY = false, rotSnap = null, rotating = false;
  const norm = (a) => isFinite(a) ? Math.atan2(Math.sin(a), Math.cos(a)) : 0;
  function snapAngle(raw) { // MeterRotationSnap.update
    const a = norm(raw), engage = 3 * Math.PI / 180, release = 6 * Math.PI / 180;
    if (rotSnap !== null && Math.abs(norm(a - rotSnap)) <= release) return rotSnap;
    rotSnap = null; const nearest = Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
    if (Math.abs(norm(a - nearest)) <= engage) { rotSnap = norm(nearest); return rotSnap; }
    return a;
  }
  const degText = (a) => { const d = Math.round(norm(a) * 180 / Math.PI); return (d === 0 ? 0 : d) + '°'; };
  function geom() { const s = $('stageFit'), w = s.clientWidth, h = s.clientHeight, b = G.bounds(w, h, appearance()), c = G.center(placement, w, h, b), k = G.safeScale(placement); return { w, h, c, bw: b.w * k, bh: b.h * k }; }
  function corner(g, dx, dy) { const a = placement.angle; return { x: g.c.x + dx * Math.cos(a) - dy * Math.sin(a), y: g.c.y + dx * Math.sin(a) + dy * Math.cos(a) }; }
  function layoutEditor() {
    if (!ready) return; const g = geom(), a = placement.angle;
    const aw = Math.abs(g.bw * Math.cos(a)) + Math.abs(g.bh * Math.sin(a)), ah = Math.abs(g.bw * Math.sin(a)) + Math.abs(g.bh * Math.cos(a));
    Object.assign(hit.style, { left: (g.c.x - aw / 2) + 'px', top: (g.c.y - ah / 2) + 'px', width: aw + 'px', height: ah + 'px' });
    const sb = $('selBox'); sb.hidden = !selected;
    Object.assign(sb.style, { left: (g.c.x - g.bw / 2) + 'px', top: (g.c.y - g.bh / 2) + 'px', width: g.bw + 'px', height: g.bh + 'px', transform: `rotate(${a}rad)` });
    const r = corner(g, g.bw / 2, -g.bh / 2), s = corner(g, g.bw / 2, g.bh / 2);
    $('rotHandle').hidden = $('scaleHandle').hidden = !selected;
    Object.assign($('rotHandle').style, { left: (r.x - 22) + 'px', top: (r.y - 22) + 'px' }); Object.assign($('scaleHandle').style, { left: (s.x - 22) + 'px', top: (s.y - 22) + 'px' });
    $('resetPlace').hidden = !selected; $('resetPlace').classList.toggle('ghost', rotating);
    const db = $('degBadge'); db.hidden = !rotating; db.textContent = degText(a); db.classList.toggle('snapped', rotSnap !== null);
    Object.assign(db.style, { left: Math.min(Math.max(g.c.x, 38), Math.max(38, g.w - 38)) + 'px', top: Math.max(18, g.c.y - ah / 2 - 22) + 'px' });
    $('guideV').classList.toggle('on', snapX); $('guideH').classList.toggle('on', snapY);
  }
  function changed() { draw(); layoutEditor(); }
  function select() { if (task) return; selected = true; layoutEditor(); }
  function deselect() { selected = false; rotating = false; snapX = snapY = false; if (ready) layoutEditor(); }
  ed.addEventListener('pointerdown', (e) => { if (e.target === ed) deselect(); });
  // 1本指: 移動（中央スナップ 7pt / 解除 14pt）、2本指: 拡大縮小＋回転
  const ptrs = new Map(); let drag = null, pinch = null;
  const local = (e) => { const r = $('stageFit').getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  hit.addEventListener('pointerdown', (e) => {
    if (task) return; e.preventDefault(); hit.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, local(e)); select();
    if (ptrs.size === 1) { drag = { start: local(e), center: geom().c }; pinch = null; }
    else if (ptrs.size === 2) { const [p, q] = Array.from(ptrs.values()); pinch = { d0: Math.max(1, Math.hypot(q.x - p.x, q.y - p.y)), a0: Math.atan2(q.y - p.y, q.x - p.x), scale: G.safeScale(placement), angle: placement.angle }; drag = null; rotSnap = null; }
  });
  hit.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return; ptrs.set(e.pointerId, local(e));
    if (pinch && ptrs.size >= 2) {
      const [p, q] = Array.from(ptrs.values()), d = Math.hypot(q.x - p.x, q.y - p.y), a = Math.atan2(q.y - p.y, q.x - p.x);
      placement.scale = Math.min(2.5, Math.max(0.2, pinch.scale * d / pinch.d0)); rotating = true; placement.angle = snapAngle(pinch.angle + a - pinch.a0); changed();
    } else if (drag) {
      const g = geom(), cur = local(e), tx = drag.center.x + cur.x - drag.start.x, ty = drag.center.y + cur.y - drag.start.y;
      const ax = Math.abs(tx - g.w / 2) <= (snapX ? 14 : 7), ay = Math.abs(ty - g.h / 2) <= (snapY ? 14 : 7); snapX = ax; snapY = ay;
      placement.x = Math.min(1, Math.max(0, (ax ? g.w / 2 : tx) / g.w)); placement.y = Math.min(1, Math.max(0, (ay ? g.h / 2 : ty) / g.h)); changed();
    }
  });
  const up = (e) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) { pinch = null; if (rotating) { rotating = false; rotSnap = null; } } if (ptrs.size === 0) { drag = null; snapX = snapY = false; } else if (ptrs.size === 1 && !drag) { const p = Array.from(ptrs.values())[0]; drag = { start: p, center: geom().c }; } layoutEditor(); };
  hit.addEventListener('pointerup', up); hit.addEventListener('pointercancel', up);
  function handleDrag(el, onMove) {
    let st = null;
    el.addEventListener('pointerdown', (e) => { if (task) return; e.preventDefault(); e.stopPropagation(); el.setPointerCapture(e.pointerId); st = { p: local(e), placement: Object.assign({}, placement), c: geom().c }; rotSnap = null; });
    el.addEventListener('pointermove', (e) => { if (!st) return; onMove(st, local(e)); changed(); });
    const end = () => { st = null; rotating = false; rotSnap = null; layoutEditor(); };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  }
  handleDrag($('rotHandle'), (st, p) => { rotating = true; const a = Math.atan2(st.p.y - st.c.y, st.p.x - st.c.x), b = Math.atan2(p.y - st.c.y, p.x - st.c.x); placement.angle = snapAngle(st.placement.angle + b - a); });
  handleDrag($('scaleHandle'), (st, p) => { const d0 = Math.max(1, Math.hypot(st.p.x - st.c.x, st.p.y - st.c.y)), d1 = Math.hypot(p.x - st.c.x, p.y - st.c.y); placement.scale = Math.min(2.5, Math.max(0.2, G.safeScale(st.placement) * d1 / d0)); });
  $('resetPlace').onclick = (e) => { e.stopPropagation(); placement = { x: null, y: null, scale: 1, angle: 0 }; rotSnap = null; rotating = false; changed(); };

  // ---- settingsCard ----
  bindSelect($('analysisSel'), $('analysisVal'), (v) => { analysisMode = v; });
  bindSelect($('audioSel'), $('audioVal'), (v) => { outputAudio = v; });
  for (const b of [$('orientH'), $('orientV')]) b.onclick = () => { vertical = b.dataset.v === '1'; $('orientH').classList.toggle('on', !vertical); $('orientV').classList.toggle('on', vertical); rebuildTimeline(); layoutEditor(); };
  $('brandToggle').onchange = () => { branding = $('brandToggle').checked; draw(); layoutEditor(); };

  // ---- rangeCard（自動／手動 + MIDIIntervalControl） ----
  const midiOf = (low, high) => { const l = isFinite(low) ? Math.round(Math.min(95, Math.max(35, low))) : 52; const h = isFinite(high) ? Math.round(Math.min(96, Math.max(l + 1, high))) : Math.max(l + 1, 74); return { low: l, high: h }; };
  function renderRange() {
    const r = displayedRange(), on = manualRangeEnabled;
    $('rangeAuto').classList.toggle('on', !on); $('rangeManual').classList.toggle('on', on);
    $('rangeLowText').innerHTML = ''; $('rangeHighText').innerHTML = '';
    $('rangeLowText').append(`最低音 ${C.noteLabel(440 * Math.pow(2, (r.low - 69) / 12))}`, document.createElement('br'), `MIDI ${r.low.toFixed(1)}`);
    $('rangeHighText').append(`最高音 ${C.noteLabel(440 * Math.pow(2, (r.high - 69) / 12))}`, document.createElement('br'), `MIDI ${r.high.toFixed(1)}`);
    $('rangeSpan').textContent = `レンジ ${r.low.toFixed(1)}〜${r.high.toFixed(1)} MIDI`;
    renderMidi();
  }
  function renderMidi() {
    if ($('rangeCard').hidden) return;
    const iv = midiOf(displayedRange().low, displayedRange().high), editable = manualRangeEnabled && !task;
    $('midiCtl').classList.toggle('off', !editable); $('midiLow').disabled = $('midiHigh').disabled = !editable;
    if (document.activeElement !== $('midiLow')) $('midiLow').value = iv.low; if (document.activeElement !== $('midiHigh')) $('midiHigh').value = iv.high;
    const tw = $('midiTrack').clientWidth, span = Math.max(1, tw - 20), lx = 10 + span * (iv.low - 35) / 61, hx = 10 + span * (iv.high - 35) / 61;
    Object.assign($('midiBand').style, { left: lx + 'px', width: Math.max(1, hx - lx) + 'px' });
    $('midiLowKnob').style.left = (lx - 10) + 'px'; $('midiHighKnob').style.left = (hx - 10) + 'px';
    return { iv, lx, hx, span };
  }
  function setManual(low, high) { const r = manualOf(low, high); if (!r) return; manualRange = r; rangeLow = low; rangeHigh = high; renderRange(); rebuildTimeline(); }
  $('rangeAuto').onclick = () => { manualRangeEnabled = false; renderRange(); rebuildTimeline(); };
  $('rangeManual').onclick = () => { if (!manualRange) manualRange = manualOf(rangeLow, rangeHigh); manualRangeEnabled = true; renderRange(); rebuildTimeline(); };
  const ivSetLow = (iv, v) => midiOf(Math.min(iv.high - 1, Math.max(35, v)), iv.high);
  const ivSetHigh = (iv, v) => midiOf(iv.low, Math.max(iv.low + 1, Math.min(96, v)));
  const ivShift = (iv, d) => { d = Math.min(96 - iv.high, Math.max(35 - iv.low, d)); return midiOf(iv.low + d, iv.high + d); };
  for (const [id, lower] of [['midiLow', true], ['midiHigh', false]]) {
    $(id).addEventListener('input', () => { if (!manualRangeEnabled || task) return; const n = parseInt($(id).value, 10); if (!isFinite(n)) return; const iv = midiOf(displayedRange().low, displayedRange().high), v = lower ? ivSetLow(iv, n) : ivSetHigh(iv, n); setManual(v.low, v.high); });
    $(id).addEventListener('blur', renderMidi);
  }
  { let st = null; const tr = $('midiTrack');
    tr.addEventListener('pointerdown', (e) => { if (!manualRangeEnabled || task) return; e.preventDefault(); tr.setPointerCapture(e.pointerId); document.activeElement && document.activeElement.blur && document.activeElement.blur();
      const g = renderMidi(), x = e.clientX - tr.getBoundingClientRect().left;
      st = { iv: g.iv, x0: e.clientX, span: g.span, part: (x > g.lx + 10 && x < g.hx - 10) ? 'range' : (Math.abs(x - g.lx) <= Math.abs(x - g.hx) ? 'low' : 'high') }; });
    tr.addEventListener('pointermove', (e) => { if (!st) return; const d = Math.round((e.clientX - st.x0) / st.span * 61);
      const v = st.part === 'low' ? ivSetLow(st.iv, st.iv.low + d) : st.part === 'high' ? ivSetHigh(st.iv, st.iv.high + d) : ivShift(st.iv, d); setManual(v.low, v.high); });
    const end = () => { st = null; }; tr.addEventListener('pointerup', end); tr.addEventListener('pointercancel', end); }

  // ---- 書き出し（動画 / 透過メーターのみ / 音声のみ） ----
  const exporter = (() => {
    let cancelFn = null;
    const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
    function wav(l, r) { // AVAudioFile standardFormat と同じ 32bit float・2ch・44.1kHz
      const n = l.length, buf = new ArrayBuffer(44 + n * 8), v = new DataView(buf), w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
      w(0, 'RIFF'); v.setUint32(4, 36 + n * 8, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, 2, true);
      v.setUint32(24, 44100, true); v.setUint32(28, 44100 * 8, true); v.setUint16(32, 8, true); v.setUint16(34, 32, true); w(36, 'data'); v.setUint32(40, n * 8, true);
      const f = new Float32Array(buf, 44, n * 2); for (let i = 0; i < n; i++) { f[2 * i] = l[i]; f[2 * i + 1] = r[i]; }
      return new Blob([buf], { type: 'audio/wav' });
    }
    // 2026-11-19: iPhone / iPad / Mac の Safari・iPhone の Chrome（どれも WebKit）は WebM を録画できても「写真」や編集アプリで使えない。
    // 透過（WebM）は WebKit 以外だけ。WebKit では透過メーターも黒背景の MP4 で書き出す（iOS アプリの HEVC 透過非対応時と同じ扱い）。
    const appleWebKit = () => /Apple/.test(navigator.vendor || '') || /iP(hone|ad|od)/.test(navigator.userAgent || '') || (/Macintosh/.test(navigator.userAgent || '') && navigator.maxTouchPoints > 1);
    function mimeList(alpha) {
      const MR = window.MediaRecorder; if (!MR) return [];
      const list = alpha ? (appleWebKit() ? [] : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus'])
        : ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4;codecs=avc1.42E01E,opus', 'video/mp4;codecs=avc1,opus', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
      const usable = appleWebKit() ? list.filter(t => !/webm/.test(t)) : list; // iPhone は WebM を写真に保存できない → MP4 のみ
      return MR.isTypeSupported ? usable.filter(t => { try { return MR.isTypeSupported(t); } catch (e) { return false; } }) : (alpha ? [] : ['video/mp4']);
    }
    function pickMime(alpha) { return mimeList(alpha)[0] || null; }
    const overlaySize = (w, h) => { const k = Math.min(1, 1280 / Math.max(w, h)); return { w: Math.max(2, Math.floor(w * k / 2) * 2), h: Math.max(2, Math.floor(h * k / 2) * 2) }; };
    // 2026-11-19: iPhone の Safari など（WebKit）で「透過メーターのみ」を本当に透過で書き出す。
    // Safari の録画（MediaRecorder）・WebCodecs は透過を残せないため、端末の中で ProRes 4444（透過あり）の .mov を作る（alphamov.js / alpha-worker.js / ffmpeg/）。
    // iOS アプリは HEVC（透過あり）の .mov。どちらも 写真・動画編集アプリで透過素材として使える形式。失敗したら黒背景の MP4 に切り替える。
    const alphaMovSupported = () => appleWebKit() && !!window.PMAlphaMov && typeof WebAssembly === 'object' && !!window.Worker;
    // 2026-11-19: 配信中の iOS アプリと同じ「HEVC（透過あり）の .mov」を端末の中で作る（hevc-worker.js / hevca/）。TikTok でも透過のまま使える形式。
    // 失敗したら ProRes 4444 の .mov → それも無理なら黒背景の MP4。
    async function hevcMovie(audioLR, tl, onProgress, setCancel) {
      const A = window.PMAlphaMov, enc = A.hevcEncoder(); let cancelled = false;
      setCancel(() => { cancelled = true; enc.close(); });
      try {
        status('透過動画の準備をしています…');
        const size = isVideo ? overlaySize(sourceSize.w, sourceSize.h) : { w: 720, h: 1280 };
        const seconds = Math.min(duration, MAX_SECONDS), app = appearance(), N = Math.max(1, Math.ceil(seconds * 30));
        const headers = await enc.init(size.w, size.h, 30, 18);
        const gc = document.createElement('canvas'); gc.width = size.w; gc.height = size.h; const gx = gc.getContext('2d', { alpha: true, willReadFrequently: true });
        const frameBytes = size.w * size.h * 4, B = Math.max(1, Math.min(30, Math.floor(8e6 / frameBytes)));
        const chunks = [], sizes = [], keys = []; let spare = null;
        const add = (r) => { const d = new Uint8Array(r.data); let o = 0; r.sizes.forEach((n, k) => { const smp = A.hevcSample(d.subarray(o, o + n)); o += n; chunks.push(smp); sizes.push(smp.length); if (r.keys[k]) keys.push(sizes.length); }); };
        status('透過動画を書き出しています…');
        for (let i = 0; i < N; i += B) {
          if (cancelled) throw new Error('cancel');
          const n = Math.min(B, N - i), buf = spare && spare.byteLength === frameBytes * n ? new Uint8Array(spare) : new Uint8Array(frameBytes * n); spare = null;
          for (let k = 0; k < n; k++) {
            const t = (i + k) / 30;
            G.render(gx, size.w, size.h, tl.states[Math.min(tl.states.length - 1, Math.max(0, Math.round(t * 30)))], tl.range, app);
            buf.set(gx.getImageData(0, 0, size.w, size.h).data, k * frameBytes);
          }
          const r = await enc.encode(buf.buffer, i); add(r); spare = r.back || null;
          onProgress(Math.min(0.99, (i + n) / N));
          await new Promise((r) => setTimeout(r, 0));
        }
        add(await enc.flush());
        if (sizes.length !== N) { const e = new Error('フレーム数が合いません（' + sizes.length + '/' + N + '）'); e.why = 'encode'; throw e; }
        const samples = Math.min(audioLR[0].length, Math.round(N / 30 * 44100));
        const pcm = new Blob([A.pcm16(audioLR[0].subarray(0, samples), audioLR[1].subarray(0, samples))]);
        const blob = A.buildMov({ codec: 'hvc1', hvcC: A.hvcC(headers), width: size.w, height: size.h, fps: 30, chunks: [new Blob(chunks)], sizes, keys }, { rate: 44100, channels: 2, pcm });
        onProgress(1);
        return { blob, ext: 'mov', alpha: true, hevc: true };
      } finally { enc.close(); setCancel(null); }
    }
    async function alphaMovie(audioLR, tl, onProgress, setCancel) {
      const A = window.PMAlphaMov, enc = A.encoder(); let cancelled = false;
      setCancel(() => { cancelled = true; enc.close(); });
      try {
        status('透過動画の準備をしています…（初回は約32MBを読み込みます）');
        await enc.init();
        const size = isVideo ? overlaySize(sourceSize.w, sourceSize.h) : { w: 720, h: 1280 };
        const seconds = Math.min(duration, MAX_SECONDS), app = appearance(), N = Math.max(1, Math.ceil(seconds * 30));
        const gc = document.createElement('canvas'); gc.width = size.w; gc.height = size.h; const gx = gc.getContext('2d', { alpha: true, willReadFrequently: true });
        const frameBytes = size.w * size.h * 4, B = Math.max(1, Math.min(30, Math.floor(24e6 / frameBytes)));
        const q = seconds > 120 ? 13 : seconds > 60 ? 11 : 9; // 長い動画はファイルが大きくなりすぎないよう少し圧縮を強める
        const chunks = [], sizes = [];
        status('透過動画を書き出しています…');
        for (let i = 0; i < N; i += B) {
          if (cancelled) throw new Error('cancel');
          const n = Math.min(B, N - i), buf = new Uint8Array(frameBytes * n);
          for (let k = 0; k < n; k++) {
            const t = (i + k) / 30;
            G.render(gx, size.w, size.h, tl.states[Math.min(tl.states.length - 1, Math.max(0, Math.round(t * 30)))], tl.range, app);
            buf.set(gx.getImageData(0, 0, size.w, size.h).data, k * frameBytes);
          }
          const out = await enc.encode(buf.buffer, size.w, size.h, q);
          sizes.push(...A.splitProRes(out)); chunks.push(new Blob([out]));
          onProgress(Math.min(1, (i + n) / N));
          await new Promise((r) => setTimeout(r, 0));
        }
        if (sizes.length !== N) throw new Error('フレーム数が合いません');
        const samples = Math.min(audioLR[0].length, Math.round(N / 30 * 44100));
        const pcm = new Blob([A.pcm16(audioLR[0].subarray(0, samples), audioLR[1].subarray(0, samples))]);
        const blob = A.buildMov({ width: size.w, height: size.h, fps: 30, chunks, sizes }, { rate: 44100, channels: 2, pcm });
        return { blob, ext: 'mov', alpha: true, prores: true };
      } finally { enc.close(); setCancel(null); }
    }
    async function movie(ac, kind, audioLR, tl, onProgress) {
      const transparent = kind === 'transparent', green = kind === 'green'; // green: 緑背景（TikTok・CapCut のクロマキー用、MP4）
      const KEY_GREEN = '#00FF00'; // メーターの色（水色〜紫〜オレンジ）・白文字から離れた純粋な緑
      let alphaError = null;
      if (transparent && alphaMovSupported()) {
        let hevcError = null;
        try { return await hevcMovie(audioLR, tl, onProgress, (f) => { cancelFn = f; }); }
        catch (e) { if (e && e.message === 'cancel') throw e; hevcError = e; console.warn('hevc alpha failed', window.PMAlphaMov.reasonText(e), e); onProgress(0); }
        try { const r = await alphaMovie(audioLR, tl, onProgress, (f) => { cancelFn = f; }); r.hevcError = hevcError; return r; }
        catch (e) { if (e && e.message === 'cancel') throw e; alphaError = e; e.reason = window.PMAlphaMov.reasonText(e); console.warn('alpha mov failed', e.reason, e); onProgress(0); status('透過動画を作れなかったため（理由：' + e.reason + '）、黒背景の動画で書き出しています…'); }
      }
      let mimes = transparent ? mimeList(true) : [], alpha = mimes.length > 0;
      if (!alpha) mimes = mimeList(false); // 透過に対応しないブラウザ: 黒背景で書き出す（iOS の HEVC alpha 非対応時と同じ扱い）
      if (!mimes.length || !HTMLCanvasElement.prototype.captureStream) throw new Error('この端末のブラウザでは動画を書き出せません。Safari か Chrome の最新版でお試しください。');
      const size = isVideo ? overlaySize(sourceSize.w, sourceSize.h) : { w: 720, h: 1280 };
      const cv = document.createElement('canvas'); cv.width = size.w; cv.height = size.h;
      cv.setAttribute('aria-hidden', 'true'); cv.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1'; document.body.appendChild(cv);
      const ctx = cv.getContext('2d', { alpha: true }), gc = document.createElement('canvas'); gc.width = size.w; gc.height = size.h; const gx = gc.getContext('2d');
      const seconds = Math.min(duration, MAX_SECONDS), app = appearance();
      let v = null;
      if (isVideo && !transparent && !green) { v = document.createElement('video'); v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto'; v.src = url;
        try { await new Promise((res, rej) => { v.oncanplay = res; v.onerror = () => rej(new Error('元の動画を読み込めませんでした')); v.load(); }); } catch (e) { cv.remove(); throw e; } }
      const dest = ac.createMediaStreamDestination(), buf = ac.createBuffer(2, audioLR[0].length, 44100);
      buf.copyToChannel(audioLR[0], 0); buf.copyToChannel(audioLR[1], 1);
      const src = ac.createBufferSource(); src.buffer = buf; src.connect(dest);
      const frame = (t) => {
        ctx.clearRect(0, 0, size.w, size.h);
        if (!alpha) { ctx.fillStyle = green ? KEY_GREEN : '#000'; ctx.fillRect(0, 0, size.w, size.h); }
        if (v && v.readyState >= 2) ctx.drawImage(v, 0, 0, size.w, size.h);
        G.render(gx, size.w, size.h, tl.states[Math.min(tl.states.length - 1, Math.max(0, Math.round(t * 30)))], tl.range, app);
        ctx.drawImage(gc, 0, 0);
      };
      frame(0);
      const stream = new MediaStream([...cv.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
      let rec = null, mime = '';
      for (const t of mimes) { // 最初に作れた形式で録画（Safari は isTypeSupported が true でも作れないことがある）
        try { rec = new MediaRecorder(stream, Object.assign(t ? { mimeType: t } : {}, { videoBitsPerSecond: 8000000, audioBitsPerSecond: 192000 })); mime = t || rec.mimeType || 'video/mp4'; break; }
        catch (e) { rec = null; }
      }
      if (!rec) { cv.remove(); throw new Error('この端末のブラウザでは動画を書き出せません。Safari か Chrome の最新版でお試しください。'); }
      if (appleWebKit() && /webm/.test(rec.mimeType || '')) { cv.remove(); throw new Error('この端末のブラウザでは MP4 動画を書き出せません。iOS を最新にしてお試しください。'); }
      if (mime.startsWith('video/mp4')) alpha = false;
      const chunks = []; rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      let stopped = false, tick = 0;
      const finished = new Promise((res, rej) => { rec.onstop = () => res(); rec.onerror = (e) => rej(new Error('録画エラー: ' + ((e && e.error && (e.error.name || e.error.message)) || 'MediaRecorder'))); });
      cancelFn = () => { stopped = true; try { rec.stop(); } catch (e) {} try { src.stop(); } catch (e) {} if (v) v.pause(); };
      if (ac.state !== 'running') await ac.resume();
      rec.start(1000); const t0 = ac.currentTime + 0.05; src.start(t0); if (v) { v.currentTime = 0; await v.play().catch(() => {}); }
      await new Promise((res) => {
        const step = () => {
          if (stopped) return res();
          const t = Math.max(0, ac.currentTime - t0);
          frame(t); onProgress(Math.min(1, t / seconds));
          if (t >= seconds) { stopped = true; try { src.stop(); } catch (e) {} if (v) v.pause(); setTimeout(() => { try { rec.stop(); } catch (e) {} res(); }, 120); return; }
          tick = requestAnimationFrame(step);
        };
        tick = requestAnimationFrame(step);
      });
      try { await Promise.race([finished, new Promise((res) => setTimeout(res, 8000))]); } // 止まらない録画で固まらない
      finally { cancelFn = null; cv.remove(); if (v) { v.removeAttribute('src'); v.load(); } }
      if (stopped && !(Math.max(0, ac.currentTime - t0) >= seconds - 0.2) && !chunks.length) throw new Error('cancel');
      const type = (rec.mimeType || mime).split(';')[0] || 'video/mp4', ext = /mp4/.test(type) ? 'mp4' : 'webm';
      const blob = new Blob(chunks, { type }); if (blob.size < 1024) throw new Error('書き出した動画が空でした。もう一度お試しください。画面を開いたまま（ほかのアプリに切り替えずに）お待ちください。');
      return { blob, ext, alpha, green, fellBack: transparent && !alpha, alphaError };
    }
    return {
      active: () => !!cancelFn, cancel() { if (cancelFn) cancelFn(); cancelFn = null; },
      async run(kind) {
        if (task || !srcFile) return;
        const ac = kind === 'audio' ? null : new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 }); // ユーザー操作の中で作る（Safari）
        if (ac && ac.resume) ac.resume().catch(() => {});
        ads.noteAction(); if (media) media.pause();
        setTask('video'); status('書き出しを準備しています…'); progress(0);
        let my = job;
        try {
          if (!result || result.key !== keyOf(analysisMode, outputAudio)) { // 設定が変わったときだけ再処理（iOS は書き出しごとに同じ処理を実行）
            result = await runProcess(analysisMode, outputAudio, (u) => progress(u * 0.5)); analysisFrames = result.frames; rebuildTimeline(); renderRange(); my = job;
          }
          const audioLR = result.stem || [L, R];
          let out;
          if (kind === 'audio') out = { blob: wav(audioLR[0], audioLR[1]), ext: 'wav' };
          else { status('書き出しています…（再生と同じ時間がかかります）'); out = await movie(ac, kind, audioLR, timeline, (u) => progress(0.5 + u * 0.5)); }
          if (!task || my !== job) return;
          const name = `pitchmeter-${stamp()}.${out.ext}`;
          output = { file: new File([out.blob], name, { type: out.blob.type }), kind };
          completed.unshift(output); renderPast();
          progress(null); setTask(null);
          $('shareBtn').hidden = false; $('outDesc').hidden = false;
          $('outDesc').textContent = `${kind === 'audio' ? 'WAV音声' : '動画'} / 最大${MAX_SECONDS}秒。完成ファイルは追加消費なしで保存し直せます。` + (out.hevc ? '（透過つきの動画（HEVC・.mov、iOSアプリと同じ形式）です。共有から「ビデオを保存」で写真に入れられます）' : out.green ? '（緑背景の動画（' + out.ext.toUpperCase() + '）です。CapCutの「クロマキー」で緑を消すと、メーターだけを重ねられます）' : out.prores ? '（透過つきの動画（ProRes・.mov）です。共有から「ビデオを保存」で写真に入れられます）' + (out.hevcError ? '（HEVCで作れなかった理由：' + window.PMAlphaMov.reasonText(out.hevcError) + '）' : '') : out.fellBack ? (out.alphaError ? '（透過動画を作れなかったため（理由：' + out.alphaError.reason + '）、黒背景の動画（MP4）で書き出しました）' : '（このブラウザでは透過動画を作れないため、黒背景の動画（MP4）で書き出しました）') : '');
          status(kind === 'audio' ? '書き出しが完成しました' : '書き出しが完成しました。保存・共有先を選んでください。閉じた場合も完成ファイルは履歴に残ります。');
          ads.atExportCompletion(playing());
        } catch (e) {
          if (!task) return; progress(null); setTask(null);
          const m = (e && e.message) || ''; console.warn('export failed', e);
          status(/ブラウザ|空でした|MP4/.test(m) ? m : '書き出しできませんでした' + (m && m !== 'cancel' ? '（' + m + '）' : '') + '。もう一度お試しください。試用回数は消費していません。');
        } finally { if (ac) ac.close().catch(() => {}); }
      },
    };
  })();
  $('exVideo').onclick = () => exporter.run('video');
  $('exAlpha').onclick = () => exporter.run('transparent');
  $('exGreen').onclick = () => exporter.run('green');
  $('exAudio').onclick = () => exporter.run('audio');
  async function share(f) { // タップ（ユーザー操作）の中で呼ぶ: iPhone の Safari は共有シートの「ビデオを保存」で写真に保存できる
    if (navigator.canShare && navigator.share) {
      let ok = false; try { ok = navigator.canShare({ files: [f] }); } catch (e) { ok = false; }
      if (ok) {
        try { await navigator.share({ files: [f] }); return; }
        catch (e) { if (e && e.name === 'AbortError') return; console.warn('share failed', e); }
      }
    }
    try { const a = document.createElement('a'), u = URL.createObjectURL(f); a.href = u; a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 120000);
      status('保存を始めました。見つからないときは「ファイル」アプリのダウンロードを確認してください。'); }
    catch (e) { status('保存・共有できませんでした。もう一度「完成したファイルを保存・共有」を押してください。'); }
  }
  $('shareBtn').onclick = () => { if (output) share(output.file); };
  function renderPast() {
    $('pastExports').hidden = !completed.length; const list = $('pastList'); list.innerHTML = '';
    for (const c of completed) { const b = document.createElement('button'); b.className = 'linkbtn'; b.textContent = c.file.name; b.onclick = () => share(c.file); list.appendChild(b); }
  }

  return {
    resize, redraw: draw, choose,
    rewardEligible: () => !task && !playing() && !fullscreen && document.visibilityState === 'visible',
  };
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
      worker = new Worker('worker.js?v=20261121tl2'); tl = new C.GaugeTimeline([], C.defaultRange(), false); tl.frames = [];
      worker.onmessage = (e) => { const m = e.data; if (m.type === 'liveFrames' && m.gen === my && running) tl.append(m.frames.map(([hz, register, sure]) => ({ hz, register, uraSure: !!sure }))); };
      worker.postMessage({ type: 'liveStart', rate: ctx.sampleRate, personal: samples.personal() });
      src = ctx.createMediaStreamSource(stream);
      const sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination);
      const send = (buf) => { if (running && my === gen) worker.postMessage({ type: 'livePush', samples: buf, gen: my }, [buf.buffer]); };
      if (ctx.audioWorklet && window.AudioWorkletNode) {
        await ctx.audioWorklet.addModule('capture-worklet.js?v=20261121tl2');
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
// 「地声を録る」「ミックスを録る」「裏声を録る」「ミックス（裏声寄り）を録る」: マイク音声はこの端末のメモリだけで特徴量に変換し、
// 特徴量だけを localStorage に保存する（音声は保存しない・どこにも送らない）。結果は押した行の「開始」のすぐ下に出す。
// 「録音してそのまま素材分析する」は従来どおり WAV にして素材分析（file.choose）へ渡す（保存・送信なし）。
const rec = (() => {
  const COUNT = 3, MAX_SECONDS = 20, QUICK_SECONDS = 5;
  let phase = 'idle', target = null, ctx = null, stream = null, node = null, src = null, gen = 0, chunks = [], got = 0, timer = 0, startAt = 0, peak = 0;
  const results = {}; // k -> { kind: 'ok'|'err'|'info', text }
  const btn = $('recBtn'), panel = $('recPanel');
  const msg = (s) => { $('recMsg').textContent = s || ''; };
  const count = (s) => { $('recCount').textContent = s; };
  const state = (s) => { $('recState').textContent = s; };
  const nm = (k) => samples.nameOf(k);
  const hzName = (hz) => { const m = 69 + 12 * Math.log2(hz / 440); return `${C.doremi(m)}（${Math.round(hz)} Hz）`; };
  const range = (r) => (r && r.minF0 > 0) ? `${C.doremi(69 + 12 * Math.log2(r.minF0 / 440))}〜${C.doremi(69 + 12 * Math.log2(r.maxF0 / 440))}（${Math.round(r.minF0)}〜${Math.round(r.maxF0)} Hz）` : '';
  const guide = (k) => { const g = C.guideNotes(k, 0); return g.length ? `目安 ${hzName(g[0].hz)} 〜 ${hzName(g[g.length - 1].hz)}` : ''; };
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function criterionLine(k) {
    const r = samples.get(k); if (!r) return '';
    return samples.applyOn() ? `${nm(k)}の判定基準: あなたの声（適用中）` : `${nm(k)}の判定基準: 既定（「サンプル音声を適用」がオフ）`;
  }
  function savedText(k) { const r = samples.get(k); return r ? `声が出ていた時間 ${r.voicedSeconds.toFixed(1)}秒・${range(r)}\n${criterionLine(k)}` : ''; }
  function renderList() {
    const list = $('smpList');
    if (!list.children.length) {
      for (const c of samples.CATS) {
        const row = document.createElement('div'); row.className = 'smp-row'; row.id = 'smpRow-' + c.k;
        row.innerHTML = `<div class="smp-head"><div class="smp-name">${esc(c.name)}を録る</div><span class="spacer"></span>`
          + `<span class="smp-badge" id="smpBadge-${c.k}"></span><button class="btn primary smp-start" id="smpStart-${c.k}" aria-describedby="smpRes-${c.k}">開始</button></div>`
          + `<div class="smp-guide">${esc(c.guideNote)}<br>${esc(guide(c.k))}</div>`
          + `<p class="smp-res" id="smpRes-${c.k}" aria-live="polite"></p><button class="linkbtn smp-del" id="smpDel-${c.k}" hidden>この${esc(c.name)}のサンプルを削除</button>`;
        list.appendChild(row);
        $('smpStart-' + c.k).onclick = () => { if (phase === 'idle') start(c.k); };
        $('smpDel-' + c.k).onclick = () => { if (phase !== 'idle') return; samples.remove(c.k); results[c.k] = { kind: 'info', text: `${c.name}のサンプルを削除しました。${c.name}は既定の判定基準に戻りました。` }; render(); };
      }
    }
    for (const c of samples.CATS) {
      const r = samples.get(c.k), res = results[c.k], el = $('smpRes-' + c.k), busy = phase !== 'idle';
      const badge = $('smpBadge-' + c.k); badge.textContent = r ? (samples.applyOn() ? 'あなたの声' : '登録済み（オフ）') : '未登録'; badge.classList.toggle('off', !(r && samples.applyOn()));
      const sb = $('smpStart-' + c.k); sb.textContent = r ? '録り直す' : '開始'; sb.disabled = busy; sb.setAttribute('aria-label', `${c.name}を${r ? '録り直す' : '録る（開始）'}`);
      $('smpDel-' + c.k).hidden = !r || busy; $('smpRow-' + c.k).classList.toggle('active', target === c.k && busy);
      el.className = 'smp-res';
      if (res && res.kind === 'ok') { el.classList.add('ok'); el.innerHTML = `<b>${esc(res.text)}</b>\n${esc(savedText(c.k))}`; }
      else if (res && res.kind === 'err') { el.classList.add('err'); el.textContent = res.text + (r ? `\n（前に録った${c.name}のサンプルはそのまま使っています）` : ''); }
      else if (res && res.kind === 'info') { el.textContent = res.text; }
      else el.textContent = r ? savedText(c.k) : 'まだ録っていません。いまは既定の判定基準です。';
    }
  }
  function renderApply() {
    const any = samples.any(), on = samples.applyOn();
    for (const id of ['smpApply', 'smpApplyMain']) { const i = $(id); i.checked = on; i.setAttribute('aria-checked', on ? 'true' : 'false'); i.disabled = !any; }
    $('smpApplyRow').hidden = !any; $('smpApplyDesc').hidden = !any; $('smpReset').hidden = !any || phase !== 'idle';
    $('smpApplyDesc').textContent = on ? 'オン: 録ったサンプル音声で判定します（リアルタイム・素材分析の両方）。' : 'オフ: いつもの既定の判定に戻っています。サンプルは消えていません。';
    // 「サンプル音声を追加」ボタンのすぐ下の結果表示
    $('smpSummary').hidden = !any;
    if (any) {
      const have = samples.CATS.filter(c => samples.get(c.k)).map(c => c.name), last = samples.CATS.map(c => ({ c, r: samples.get(c.k) })).filter(x => x.r).sort((x, y) => y.r.at - x.r.at)[0];
      const lines = [`登録済み: ${have.join('・')}（${have.length}/4）`];
      if (last) lines.push(`最後に反映: ${last.c.name}・${last.r.voicedSeconds.toFixed(1)}秒・${range(last.r)}`);
      lines.push(on ? '判定はあなたの声の基準を使っています。' : '判定はいつもの既定に戻っています（サンプルは保存したまま）。');
      $('smpSumText').textContent = lines.join('\n');
    }
  }
  function render() { renderList(); renderApply(); }
  samples.onChange(renderApply);
  const onToggle = (e) => { samples.setApply(e.target.checked); render(); msg(''); };
  $('smpApply').onchange = onToggle; $('smpApplyMain').onchange = onToggle;
  $('smpReset').onclick = () => {
    if (phase !== 'idle') return;
    if (!window.confirm('録ったサンプル音声（地声・ミックス・ミックス（裏声寄り）・裏声）をすべて削除して、既定の判定基準に戻しますか？')) return;
    samples.clear(); for (const k in results) delete results[k]; render(); msg('初期設定に戻しました。判定はいつもの既定の基準です。');
  };
  function ui() {
    const rec = phase === 'rec';
    btn.classList.toggle('recording', phase !== 'idle');
    $('recBtnText').textContent = target === 'quick' ? (rec ? '停止して分析' : 'やめる') : (rec ? '録音を終える' : phase === 'analyze' ? '解析中…' : 'やめる');
    btn.disabled = phase === 'analyze';
    btn.setAttribute('aria-label', rec ? '録音を終える' : '録音をやめる');
    panel.hidden = phase === 'idle';
    const sheet = $('recSheet').querySelector('.rec-sheet'), row = (phase !== 'idle' && target !== 'quick') ? $('smpRow-' + target) : null;
    if (phase === 'idle') $('recLevelBar').style.width = '0%';
    if (row) row.insertBefore(panel, $('smpRes-' + target)); else sheet.insertBefore(panel, $('recMsg')); // 録音表示は押した行の中
    $('recQuick').disabled = phase !== 'idle';
    render();
  }
  function teardown() {
    gen++; clearInterval(timer); timer = 0;
    try { if (src) src.disconnect(); if (node) { node.disconnect(); if (node.port) node.port.onmessage = null; node.onaudioprocess = null; } } catch (e) {}
    if (stream) stream.getTracks().forEach(t => { t.onended = null; t.stop(); });
    if (ctx) { try { ctx.close(); } catch (e) {} }
    stream = null; node = null; src = null; ctx = null; setAudioSession('playback');
  }
  function fail(m) { const k = target; teardown(); chunks = []; phase = 'idle'; target = null; if (k && k !== 'quick') { results[k] = { kind: 'err', text: m }; msg(''); } else msg(m); ui(); }
  function cancel() { if (phase === 'idle') return; teardown(); chunks = []; phase = 'idle'; target = null; ui(); }
  const m = modal($('recSheet'), () => close());
  function open() { msg(''); phase = 'idle'; target = null; for (const k in results) if (results[k].kind !== 'ok') delete results[k]; ui(); m.open(); }
  function close() { cancel(); m.close(); }
  function wav(samplesF, rate) {
    const n = samplesF.length, b = new ArrayBuffer(44 + n * 2), v = new DataView(b); const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) { const x = Math.max(-1, Math.min(1, samplesF[i])); v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
    return new Blob([b], { type: 'audio/wav' });
  }
  /** 録った音声（メモリ上）→ 特徴量。音声はここで捨てる。 */
  function capture(k, all, rate) {
    let r; try { r = C.calibrationFrames(all, rate, k); } catch (e) { return { err: '解析できませんでした。もう一度「開始」を押してください。' }; }
    if (!r.ok) return { err: `声が十分に取れませんでした（声が出ていた時間 ${r.voicedSeconds.toFixed(1)}秒・2秒以上必要です）。${k === 'chest' ? '' : '高さが150 Hzより低いと使えません。'}もう少し長く、はっきりのばしてください。` };
    const f0 = r.frames.map(x => x[0]).sort((a, b) => a - b), q = (p) => f0[Math.min(f0.length - 1, Math.max(0, Math.round(p * (f0.length - 1))))];
    return { rec: { frames: r.frames, voicedSeconds: Math.round(r.voicedSeconds * 10) / 10, medianF0: Math.round(r.medianF0 * 10) / 10, minF0: Math.round(q(0.05) * 10) / 10, maxF0: Math.round(q(0.95) * 10) / 10, at: Date.now(), v: C.CAL.version } };
  }
  function finish() {
    if (phase !== 'rec') return;
    const rate = ctx ? ctx.sampleRate : 48000, k = target; teardown();
    let all = new Float32Array(got); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; } chunks = [];
    const done = (fn) => { phase = 'idle'; target = null; fn(); ui(); };
    if (all.length < rate * 0.5) { done(() => k === 'quick' ? msg('録音が短すぎました。もう一度押してください。') : (results[k] = { kind: 'err', text: '録音が短すぎました。もう一度「開始」を押してください。' })); return; }
    let sq = 0, pk = 0; for (let i = 0; i < all.length; i++) { const x = all[i]; sq += x * x; if (Math.abs(x) > pk) pk = Math.abs(x); }
    if (pk < 0.01 || 10 * Math.log10(sq / all.length + 1e-20) < -55) { const t = '声が小さくて聞き取れませんでした。マイクに近づいて、もう少し大きめに録ってください。'; done(() => k === 'quick' ? msg(t) : (results[k] = { kind: 'err', text: t })); return; }
    if (k === 'quick') {
      const d = new Date(), name = `サンプル音声 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}.wav`;
      let f; try { f = new File([wav(all, rate)], name, { type: 'audio/wav' }); } catch (e) { f = wav(all, rate); f.name = name; }
      phase = 'idle'; target = null; ui(); m.close(false); file.choose(f);
      requestAnimationFrame(() => { const ec = $('editCard'); if (ec && ec.scrollIntoView) ec.scrollIntoView({ block: 'start', behavior: 'smooth' }); });
      return;
    }
    phase = 'analyze'; target = k; ui(); count('…'); state('声の特徴を取り出しています（この端末の中だけ）');
    setTimeout(() => {
      const out = capture(k, all, rate); all = null;
      done(() => {
        if (out.err) results[k] = { kind: 'err', text: out.err };
        else if (!samples.put(k, out.rec)) results[k] = { kind: 'err', text: '端末に保存できませんでした（ブラウザの保存領域がいっぱいか、プライベートブラウズの可能性があります）。' };
        else results[k] = { kind: 'ok', text: `${nm(k)}のサンプルを反映しました` };
      });
      const sb = $('smpStart-' + k); if (sb) sb.focus({ preventScroll: true });
    }, 30);
  }
  async function start(k) {
    target = k; delete results[k]; msg(''); phase = 'prep'; ui(); count('…'); state('マイクを準備しています'); const my = ++gen;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.isSecureContext) { fail('このブラウザではマイクを使えません（https で開いてください）。'); return; }
    try { live.stop(); } catch (e) {}
    const limit = k === 'quick' ? QUICK_SECONDS : MAX_SECONDS;
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
        if (phase === 'rec') { chunks.push(buf); got += buf.length; if (got >= limit * ctx.sampleRate) finish(); } };
      if (ctx.audioWorklet && window.AudioWorkletNode) {
        await ctx.audioWorklet.addModule('capture-worklet.js?v=20261121tl2'); if (my !== gen) return;
        node = new AudioWorkletNode(ctx, 'pm-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
        node.port.onmessage = (e) => onChunk(e.data);
      } else { node = ctx.createScriptProcessor(2048, 1, 1); node.onaudioprocess = (e) => onChunk(new Float32Array(e.inputBuffer.getChannelData(0))); }
      src.connect(node); node.connect(sink);
      ctx.onstatechange = () => { if (ctx && ctx.state === 'interrupted') fail('ほかの音声で中断されたので録音をやめました。'); };
      const what = k === 'quick' ? '声' : nm(k);
      phase = 'count'; ui(); let left = COUNT; count(String(left)); state(`まもなく録音が始まります。${what}で準備してください`);
      timer = setInterval(() => { if (my !== gen) return;
        if (phase === 'count') { left--; if (left > 0) { count(String(left)); return; }
          phase = 'rec'; chunks = []; got = 0; startAt = performance.now(); ui(); count('0秒');
          state(k === 'quick' ? '録音中… 5秒で自動で止まります' : `録音中… ${what}で「あー」か「うー」。低い音から高い音へ（最長${MAX_SECONDS}秒）`); return; }
        if (phase === 'rec') { const el = Math.floor((performance.now() - startAt) / 1000); count(k === 'quick' ? String(Math.max(0, QUICK_SECONDS - el)) : el + '秒');
          if (performance.now() - startAt > limit * 1000 + 1500) finish(); } }, 1000);
    } catch (e) {
      if (my !== gen) return;
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      fail(denied ? 'マイクが許可されていません。ブラウザの設定でマイクを許可してから、もう一度押してください。' : (e && e.name === 'NotFoundError' ? 'マイクが見つかりませんでした。' : '録音を開始できませんでした。もう一度試してください。'));
    }
  }
  btn.onclick = () => { if (phase === 'rec') finish(); else if (phase === 'count' || phase === 'prep') cancel(); };
  $('recQuick').onclick = () => { if (phase === 'idle') start('quick'); };
  $('sampleBtn').onclick = open;
  $('recClose').onclick = close;
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  render();
  // テスト用（ヘッドレス確認）: 実際のマイクの代わりに音声配列を渡して同じ処理を通す。?smptest のときだけ。
  if (/[?&]smptest\b/.test(location.search)) window.__pmSampleTest = { capture: (k, mono, rate) => { const o = capture(k, mono, rate); if (o.rec) { samples.put(k, o.rec); results[k] = { kind: 'ok', text: `${nm(k)}のサンプルを反映しました` }; } else results[k] = { kind: 'err', text: o.err }; render(); return o; },
    personal: () => samples.personal(), open, setState: (k, ph) => { target = k; phase = ph; ui(); count(ph === 'rec' ? '4秒' : '3'); state(ph === 'rec' ? `録音中… ${nm(k)}で「あー」か「うー」。低い音から高い音へ（最長${MAX_SECONDS}秒）` : `まもなく録音が始まります。${nm(k)}で準備してください`); $('recLevelBar').style.width = '55%'; }, reset: () => { phase = 'idle'; target = null; ui(); } };
  return { cancel: close };
})();

// ======================= 判定用の声を集める（地声・裏声） =======================
// 学習用に同じ条件（「あー」・1音・4秒）でテイクを集める。音声（WAV）は端末内の IndexedDB にだけ保存。
// 「まとめて保存」は端末のファイル保存（iOS は共有シート→「ファイル」に保存/AirDrop）。ネットワークには何も送らない。
const col = (() => {
  const SECONDS = 4, COUNT = 3, TARGET = 30, AUTO_KEY = 'pm.collect.auto';
  const CAT = { chest: { ja: '地声', en: 'chest', guide: '目安 ラ2（110 Hz）〜 ミ4（330 Hz）の出しやすい高さ' }, falsetto: { ja: '裏声', en: 'falsetto', guide: '目安 ソ4（392 Hz）〜 シ5（988 Hz）の出しやすい高さ' } };
  let cat = 'chest', phase = 'idle', ctx = null, stream = null, node = null, src = null, gen = 0, chunks = [], got = 0, timer = 0, autoTimer = 0, startAt = 0, peak = 0;
  let takes = [], lastId = null, redoId = null, player = null, playingId = null, prepared = null, dbp = null;
  const msg = (t) => { $('colMsg').textContent = t || ''; };
  // ---- IndexedDB ----
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => { if (!window.indexedDB) { rej(new Error('noidb')); return; }
      const r = indexedDB.open('pm-collect', 1);
      r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('takes')) d.createObjectStore('takes', { keyPath: 'id', autoIncrement: true }); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error || new Error('idb')); });
    dbp.catch(() => { dbp = null; }); return dbp;
  }
  const tx = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction('takes', mode), st = t.objectStore('takes'); let out; const q = fn(st); if (q) q.onsuccess = () => { out = q.result; }; t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('abort')); }); };
  const loadAll = async () => { const all = await tx('readonly', st => st.getAll()); takes = (all || []).sort((a, b) => a.id - b.id); };
  // ---- 表示 ----
  const pad = (n, w) => String(n).padStart(w || 2, '0');
  const localTime = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  const numbered = () => { const n = { chest: 0, falsetto: 0 }; return takes.map(t => ({ t, no: ++n[t.cat] })); };
  function render() {
    const n = { chest: 0, falsetto: 0 }; for (const t of takes) n[t.cat]++;
    $('colNChest').textContent = n.chest; $('colNFals').textContent = n.falsetto;
    $('colBarChest').style.width = Math.min(100, n.chest / TARGET * 100) + '%'; $('colBarFals').style.width = Math.min(100, n.falsetto / TARGET * 100) + '%';
    $('colCntChest').classList.toggle('on', cat === 'chest'); $('colCntFals').classList.toggle('on', cat === 'falsetto');
    for (const [id, c] of [['colCatChest', 'chest'], ['colCatFals', 'falsetto']]) { const b = $(id); b.classList.toggle('on', cat === c); b.setAttribute('aria-checked', cat === c ? 'true' : 'false'); b.disabled = phase !== 'idle'; }
    $('colBig').textContent = CAT[cat].ja; $('colGuide').textContent = CAT[cat].guide;
    const busy = phase !== 'idle';
    $('colRec').classList.toggle('recording', busy);
    $('colRecText').textContent = phase === 'rec' ? '停止' : phase === 'count' || phase === 'prep' || phase === 'auto' ? 'やめる' : phase === 'save' ? '保存中…' : (redoId ? `${CAT[cat].ja}を録り直す` : `${CAT[cat].ja}を録音する`);
    $('colRec').disabled = phase === 'save';
    if (!busy) { $('colCount').textContent = String(SECONDS); if (!$('colState').dataset.keep) $('colState').textContent = `「録音する」を押すと3秒後に始まり、${SECONDS}秒で自動で止まります`; $('colLevelBar').style.width = '0%'; }
    const last = takes.length ? takes[takes.length - 1] : null;
    $('colRedo').disabled = busy || !last || !!redoId; $('colRedo').textContent = last ? `最後のテイクを録り直す（${CAT[last.cat].ja} #${numbered().pop().no}）` : '最後のテイクを録り直す';
    $('colSave').disabled = busy || !takes.length; $('colClear').disabled = busy || !takes.length;
    $('colTotal').textContent = takes.length ? `合計 ${takes.length}本` : '';
    const list = $('colList'); list.textContent = '';
    if (!takes.length) { const p = document.createElement('p'); p.className = 'col-empty'; p.textContent = 'まだ録っていません。上で地声か裏声を選んで「録音する」を押してください。'; list.appendChild(p); return; }
    for (const { t, no } of numbered().reverse()) {
      const row = document.createElement('div'); row.className = 'col-take';
      const meta = document.createElement('div'); meta.className = 'meta';
      const a = document.createElement('span'); a.innerHTML = `<b>${CAT[t.cat].ja} #${no}</b>`;
      const c = document.createElement('span'); c.className = 'caption'; c.textContent = `${t.duration.toFixed(1)}秒・${t.medianF0 > 0 ? Math.round(t.medianF0) + ' Hz（' + C.doremi(69 + 12 * Math.log2(t.medianF0 / 440)) + '）' : '高さ不明'}・${localTime(t.at).slice(11, 16)}`;
      meta.append(a, c);
      const sp = document.createElement('span'); sp.className = 'spacer';
      const play = document.createElement('button'); play.className = 'btn small'; play.textContent = playingId === t.id ? '停止' : '再生'; play.setAttribute('aria-label', `${CAT[t.cat].ja} #${no} を${playingId === t.id ? '停止' : '再生'}`); play.disabled = busy; play.onclick = () => togglePlay(t);
      const del = document.createElement('button'); del.className = 'btn small'; del.textContent = '削除'; del.setAttribute('aria-label', `${CAT[t.cat].ja} #${no} を削除`); del.disabled = busy;
      del.onclick = async () => { stopPlay(); try { await tx('readwrite', st => st.delete(t.id)); } catch (e) { msg('削除できませんでした。'); } await refresh(); msg(`${CAT[t.cat].ja} #${no} を削除しました。`); };
      row.append(meta, sp, play, del); list.appendChild(row);
    }
  }
  async function refresh() { prepared = null; try { await loadAll(); } catch (e) { msg('この端末に保存できません（プライベートブラウズでは使えないことがあります）。'); } render(); }
  function stopPlay() { if (player) { try { player.pause(); URL.revokeObjectURL(player.src); } catch (e) {} } player = null; playingId = null; }
  function togglePlay(t) {
    if (playingId === t.id) { stopPlay(); render(); return; }
    stopPlay(); setAudioSession('playback');
    player = new Audio(URL.createObjectURL(new Blob([t.wav], { type: 'audio/wav' }))); playingId = t.id;
    player.onended = () => { stopPlay(); render(); };
    player.play().catch(() => { stopPlay(); msg('再生できませんでした。'); render(); }); render();
  }
  // ---- 録音 ----
  function wav16(x, rate) {
    const n = x.length, b = new ArrayBuffer(44 + n * 2), v = new DataView(b); const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, x[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
    return b;
  }
  function medianF0(x, rate) {
    try { const f = C.analyzePitch16k(C.resampleAll(x, rate, 16000)).map(r => r.hz).filter(h => h > 0).sort((a, b) => a - b); return f.length ? f[f.length >> 1] : 0; } catch (e) { return 0; }
  }
  function teardown() {
    gen++; clearInterval(timer); timer = 0;
    try { if (src) src.disconnect(); if (node) { node.disconnect(); if (node.port) node.port.onmessage = null; node.onaudioprocess = null; } } catch (e) {}
    if (stream) stream.getTracks().forEach(t => { t.onended = null; t.stop(); });
    if (ctx) { try { ctx.close(); } catch (e) {} }
    stream = null; node = null; src = null; ctx = null; setAudioSession('playback');
  }
  function fail(t) { teardown(); chunks = []; phase = 'idle'; msg(t); render(); }
  function cancel() { clearTimeout(autoTimer); autoTimer = 0; if (phase === 'idle') return; teardown(); chunks = []; phase = 'idle'; render(); }
  /** 録った音声を保存（テスト用フックからも呼ぶ）。 */
  async function store(x, rate) {
    let sq = 0, pk = 0; for (let i = 0; i < x.length; i++) { const a = x[i]; sq += a * a; if (Math.abs(a) > pk) pk = Math.abs(a); }
    if (x.length < rate * 0.5) return { err: '録音が短すぎました。もう一度押してください。' };
    if (pk < 0.01 || 10 * Math.log10(sq / x.length + 1e-20) < -55) return { err: '声が小さくて聞き取れませんでした。マイクに近づいて、もう少し大きめに録ってください。' };
    const rec = { cat, wav: wav16(x, rate), rate, duration: Math.round(x.length / rate * 100) / 100, medianF0: Math.round(medianF0(x, rate) * 10) / 10, at: Date.now() };
    try {
      if (redoId) { rec.id = redoId; const old = takes.find(t => t.id === redoId); if (old) { rec.cat = old.cat; } await tx('readwrite', st => st.put(rec)); }
      else await tx('readwrite', st => st.add(rec));
    } catch (e) { return { err: '端末に保存できませんでした（空き容量かプライベートブラウズを確認してください）。' }; }
    const wasRedo = !!redoId; redoId = null; await refresh();
    const no = numbered().filter(o => o.t.cat === rec.cat).length;
    return { ok: wasRedo ? `${CAT[rec.cat].ja}のテイクを録り直しました。` : `${CAT[rec.cat].ja} #${no} を保存しました（${rec.duration.toFixed(1)}秒${rec.medianF0 > 0 ? '・' + Math.round(rec.medianF0) + ' Hz' : ''}）。` };
  }
  async function finish() {
    if (phase !== 'rec') return;
    const rate = ctx ? ctx.sampleRate : 48000; teardown();
    const x = new Float32Array(got); let o = 0; for (const c of chunks) { x.set(c.subarray(0, Math.min(c.length, got - o)), o); o += c.length; if (o >= got) break; } chunks = [];
    phase = 'save'; render(); $('colState').textContent = '保存しています';
    const r = await store(x, rate); phase = 'idle'; msg(r.err || r.ok); render();
    if (!r.err && $('colAuto').checked && !$('colSheet').hidden) { phase = 'auto'; let left = 3; $('colCount').textContent = String(left); $('colState').textContent = `${left}秒後に次の${CAT[cat].ja}を録ります`; render();
      const tick = () => { if (phase !== 'auto') return; left--; if (left <= 0) { phase = 'idle'; start(); return; } $('colCount').textContent = String(left); $('colState').textContent = `${left}秒後に次の${CAT[cat].ja}を録ります`; autoTimer = setTimeout(tick, 1000); };
      autoTimer = setTimeout(tick, 1000); }
  }
  async function start() {
    stopPlay(); msg(''); phase = 'prep'; render(); $('colCount').textContent = '…'; $('colState').textContent = 'マイクを準備しています'; const my = ++gen;
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
        $('colLevelBar').style.width = Math.min(100, Math.round(Math.sqrt(peak) * 140)) + '%';
        if (phase === 'rec') { chunks.push(buf); got += buf.length; if (got >= SECONDS * ctx.sampleRate) { got = SECONDS * ctx.sampleRate; finish(); } } };
      if (ctx.audioWorklet && window.AudioWorkletNode) {
        await ctx.audioWorklet.addModule('capture-worklet.js?v=20261121tl2'); if (my !== gen) return;
        node = new AudioWorkletNode(ctx, 'pm-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
        node.port.onmessage = (e) => onChunk(e.data);
      } else { node = ctx.createScriptProcessor(2048, 1, 1); node.onaudioprocess = (e) => onChunk(new Float32Array(e.inputBuffer.getChannelData(0))); }
      src.connect(node); node.connect(sink);
      ctx.onstatechange = () => { if (ctx && ctx.state === 'interrupted') fail('ほかの音声で中断されたので録音をやめました。'); };
      phase = 'count'; render(); let left = COUNT; $('colCount').textContent = String(left); $('colState').textContent = `まもなく録音が始まります。${CAT[cat].ja}で準備してください`;
      timer = setInterval(() => { if (my !== gen) return;
        if (phase === 'count') { left--; if (left > 0) { $('colCount').textContent = String(left); return; }
          phase = 'rec'; chunks = []; got = 0; startAt = performance.now(); render(); $('colCount').textContent = String(SECONDS); $('colState').textContent = `録音中… ${CAT[cat].ja}で「あー」`; return; }
        if (phase === 'rec') { $('colCount').textContent = String(Math.max(0, SECONDS - Math.floor((performance.now() - startAt) / 1000)));
          if (performance.now() - startAt > SECONDS * 1000 + 1500) finish(); } }, 1000);
    } catch (e) {
      if (my !== gen) return;
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      fail(denied ? 'マイクが許可されていません。ブラウザの設定でマイクを許可してから、もう一度押してください。' : (e && e.name === 'NotFoundError' ? 'マイクが見つかりませんでした。' : '録音を開始できませんでした。もう一度試してください。'));
    }
  }
  // ---- まとめて保存（ZIP・無圧縮）: chest/chest_001.wav, falsetto/falsetto_001.wav, labels.csv ----
  const crcT = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (u) => { let c = 0xffffffff; for (let i = 0; i < u.length; i++) c = crcT[(c ^ u[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function zip(files) { // files: [{ name, data: Uint8Array, date }]
    const enc = new TextEncoder(), parts = [], cen = []; let off = 0;
    for (const f of files) {
      const nm = enc.encode(f.name), crc = crc32(f.data), d = f.date, dt = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff, dd = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
      const h = new DataView(new ArrayBuffer(30)); h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true); h.setUint16(10, dt, true); h.setUint16(12, dd, true);
      h.setUint32(14, crc, true); h.setUint32(18, f.data.length, true); h.setUint32(22, f.data.length, true); h.setUint16(26, nm.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), nm, f.data);
      const c = new DataView(new ArrayBuffer(46)); c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true); c.setUint16(12, dt, true); c.setUint16(14, dd, true);
      c.setUint32(16, crc, true); c.setUint32(20, f.data.length, true); c.setUint32(24, f.data.length, true); c.setUint16(28, nm.length, true); c.setUint32(42, off, true);
      cen.push(new Uint8Array(c.buffer), nm); off += 30 + nm.length + f.data.length;
    }
    const csize = cen.reduce((a, u) => a + u.length, 0), e = new DataView(new ArrayBuffer(22)); e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
    return new Blob([...parts, ...cen, new Uint8Array(e.buffer)], { type: 'application/zip' });
  }
  function buildZip() {
    const rows = ['filename,category,category_en,duration_s,median_f0_hz,recorded_at'], files = [];
    for (const { t, no } of numbered()) { const en = CAT[t.cat].en, name = `${en}/${en}_${pad(no, 3)}.wav`;
      files.push({ name, data: new Uint8Array(t.wav), date: new Date(t.at) }); rows.push([name, CAT[t.cat].ja, en, t.duration.toFixed(2), t.medianF0 > 0 ? t.medianF0.toFixed(1) : '', localTime(t.at)].join(',')); }
    files.push({ name: 'labels.csv', data: new TextEncoder().encode('\ufeff' + rows.join('\r\n') + '\r\n'), date: new Date() });
    const d = new Date(), fname = `pitchmeter-voices-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.zip`;
    const blob = zip(files); let file; try { file = new File([blob], fname, { type: 'application/zip' }); } catch (e) { file = blob; file.name = fname; }
    return file;
  }
  function download(file) { const u = URL.createObjectURL(file), a = document.createElement('a'); a.href = u; a.download = file.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 60000); }
  async function save() {
    if (!takes.length) return;
    const n = { chest: 0, falsetto: 0 }; for (const t of takes) n[t.cat]++;
    const file = prepared || buildZip(); prepared = file;
    const done = `地声${n.chest}本・裏声${n.falsetto}本と labels.csv を「${file.name}」にまとめました。`;
    if (navigator.canShare && navigator.share && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: file.name }); msg(done); return; }
      catch (e) { if (e && e.name === 'AbortError') { msg('保存をやめました。もう一度「まとめて保存」を押すと保存できます。'); return; }
        if (e && e.name === 'NotAllowedError') { msg('準備ができました。もう一度「まとめて保存」を押してください。'); return; } }
    }
    download(file); msg(done + 'ダウンロードフォルダ（iPhone は「ファイル」）に保存されます。');
  }
  // ---- 画面 ----
  const m = modal($('colSheet'), () => close());
  async function open() { msg(''); delete $('colState').dataset.keep; m.open('colRec'); await refresh(); }
  function close() { cancel(); stopPlay(); m.close(); }
  for (const [id, c] of [['colCatChest', 'chest'], ['colCatFals', 'falsetto']]) $(id).onclick = () => { if (phase !== 'idle') return; cat = c; redoId = null; try { localStorage.setItem('pm.collect.cat', c); } catch (e) {} render(); };
  try { const c = localStorage.getItem('pm.collect.cat'); if (c === 'chest' || c === 'falsetto') cat = c; } catch (e) {}
  $('colRec').onclick = () => { if (phase === 'idle') start(); else if (phase === 'rec') finish(); else if (phase !== 'save') cancel(); };
  $('colRedo').onclick = () => { const last = takes[takes.length - 1]; if (!last || phase !== 'idle') return; redoId = last.id; cat = last.cat; msg(`${CAT[last.cat].ja} #${numbered().pop().no} を録り直します。「${CAT[last.cat].ja}を録り直す」を押してください。`); render(); };
  $('colSave').onclick = () => { if (phase === 'idle') save(); };
  $('colClear').onclick = async () => {
    if (phase !== 'idle' || !takes.length) return;
    if (!window.confirm(`録ったテイク（地声・裏声 合計${takes.length}本）をすべて削除しますか？元に戻せません。`)) return;
    stopPlay(); redoId = null; try { await tx('readwrite', st => st.clear()); } catch (e) {} await refresh(); msg('すべて削除しました。');
  };
  try { $('colAuto').checked = localStorage.getItem(AUTO_KEY) === '1'; } catch (e) {}
  $('colAuto').setAttribute('aria-checked', $('colAuto').checked ? 'true' : 'false');
  $('colAuto').onchange = (e) => { e.target.setAttribute('aria-checked', e.target.checked ? 'true' : 'false'); try { localStorage.setItem(AUTO_KEY, e.target.checked ? '1' : '0'); } catch (er) {} };
  $('colClose').onclick = close;
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  render();
  if (/[?&]smptest\b/.test(location.search)) window.__pmCollectTest = { buildZip, takes: () => takes, setRec: () => { phase = 'rec'; render(); $('colCount').textContent = '2'; $('colState').textContent = `録音中… ${CAT[cat].ja}で「あー」`; $('colLevelBar').style.width = '60%'; }, reset: () => { phase = 'idle'; render(); } };
  return { open, cancel: close };
})();
$('colOpen').onclick = () => { rec.cancel(); col.open(); };

ads.build(); ads.update();
selectTab('file');
// 起動時のプラン画面（FirstLaunchPlusPolicy: 加入者以外に、起動ごとに1回）。ウェブ版は表示のみ。
if (!/[?&]noplan\b/.test(location.search)) plan.open();
})();
