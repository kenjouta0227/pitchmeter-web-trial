/* アプリ版（Android カラオケタブ）：開いたらすぐ「カラオケバー＋メーター」の画面にする。判定・採点・音程の計算には触らない。 */
(function () {
'use strict';
const $ = (id) => document.getElementById(id);
document.documentElement.classList.add('pm-app');
function tidy() {
  // アプリ版のみ：メーターの「配置の編集」ドラッグを外す（画面のスクロールを止めてしまうため。位置はアプリでは固定）
  document.querySelectorAll('.gauge.editable').forEach((g) => { g.classList.remove('editable'); g.onpointerdown = null; g.onpointermove = null; g.onpointerup = null; g.onpointercancel = null; });
  document.querySelectorAll('#combo-mixer .mx-small').forEach((p) => { if (/TikTok|緑の外/.test(p.textContent)) p.remove(); });
  // アプリ版のみ：ハモリ調整スライダー1つだけを外す（もともと操作できない固定値100%の欄。音量・採点・判定には使われていない）
  // アプリ版のみ：外したハモリスライダーの説明文も外す（2026-11-23 けんじょうさん指示）
  document.querySelectorAll('#combo-mixer .mx-small').forEach((p) => { if (/^\s*ハモリは/.test(p.textContent)) p.remove(); });
  document.querySelectorAll('#combo-mixer label.mx.off').forEach((l) => { const s = l.querySelector('span'); const r = l.querySelector('input[type=range]'); if (s && /^\s*ハモリ/.test(s.textContent) && r && !r.id) l.remove(); });
  const sm = document.querySelector('#c-more-menu small'); if (sm) sm.textContent = '素材はこの端末の中だけで処理します（送信しません）。カラオケは採点用に別でマイクを使います。';
}
// アプリ版のみ（2026-11-23 けんじょうさん指示）：「入力機器を選んでください」を出さず、端末の標準マイクを使う。
// iPhone は AirPods・イヤホンマイクなどを自分で選ぶので、アプリは「標準」（getUserMedia の deviceId 指定なし）で開くだけ。
// LIVE の startMic はそのまま（deviceId '__default__' は LIVE の作りで「指定なし」）。採点（カラオケ側）はもともと標準マイク。
function useDefaultMic() {
  try {
    const s = $('input-device'); if (!s) return;
    if (typeof knownInputs !== 'undefined' && !knownInputs.some((d) => d.deviceId === '__default__')) knownInputs.push({ deviceId: '__default__', label: '標準のマイク' });
    if (![...s.options].some((o) => o.value === '__default__')) s.add(new Option('標準のマイク', '__default__'));
    s.value = '__default__';
  } catch (e) {}
}
// アプリ版のみ（2026-11-23 けんじょうさん指示）：画面の並びだけ変える。音・採点・判定の処理は LIVE のまま。
// (1)「★ 採点する」の左に 再生・停止・リセット。LIVE の再生位置パネルのボタン（sk-play / sk-stop / sk-reset）を押すだけの中継ボタン。
// (2) 歌声・伴奏のスライダー（mx-v / mx-a、LIVE と同じ要素そのもの）を カラオケのバーとメーターの間へ移す。
// 中継ボタンの文字：記号（▶ ■ ↺）を上、ことばを下の2段にして、ボタンの中に収める（同じ文字をそのまま使う）
function skLabel(b, text) { b.dataset.src = text; const m = String(text).trim().match(/^(\S+)\s+(.+)$/); b.textContent = '';
  if (!m) { b.textContent = text; return; } const i = document.createElement('span'); i.className = 'i'; i.textContent = m[1]; i.setAttribute('aria-hidden', 'true');
  const t = document.createElement('span'); t.className = 't'; t.textContent = m[2]; b.append(i, t); b.setAttribute('aria-label', m[2]); }
function layout() {
  const row = $('combo-score-row'), score = $('c-score');
  if (row && score && !$('pm-sk')) {
    const box = document.createElement('div'); box.id = 'pm-sk';
    for (const [id, src] of [['pm-sk-play', 'sk-play'], ['pm-sk-stop', 'sk-stop'], ['pm-sk-reset', 'sk-reset']]) {
      const o = $(src); if (!o) continue;
      const b = document.createElement('button'); b.id = id; b.type = 'button'; skLabel(b, o.textContent); b.disabled = o.disabled;
      b.onclick = () => { const x = $(src); if (x && !x.disabled) x.click(); };
      box.appendChild(b);
    }
    row.insertBefore(box, score);
    // マイク（メーター・声区判定）は 再生 で自動で開始、停止・リセットで止める（標準マイク）。採点のマイクはカラオケ側が再生時に自分で開く（LIVE のまま）
    const meterOn = () => { try { return mode !== 'stopped'; } catch (e) { const s = $('status'); return s && !/^停止中/.test(s.textContent); } }; // mode = LIVE のメーターの状態
    $('pm-sk-play').addEventListener('click', () => { useDefaultMic(); if (!meterOn()) { const x = $('start'); if (x && !x.disabled) x.click(); } });
    for (const id of ['pm-sk-stop', 'pm-sk-reset']) $(id).addEventListener('click', () => { if (id === 'pm-sk-reset' && $('pm-sk-stop') && !$('pm-sk-stop').disabled) return; const x = $('stop'); if (x) x.click(); });
    let wasPlaying = false; // 再生が終わった・採点で止まった時もマイク（メーター）を止める
    setInterval(() => { const ss = $('sk-stop'), playing = !!ss && !ss.disabled; if (wasPlaying && !playing) { try { if (mode !== 'stopped') $('stop').click(); } catch (e) {} } wasPlaying = playing; }, 150);
    setInterval(() => { for (const [id, src] of [['pm-sk-play', 'sk-play'], ['pm-sk-stop', 'sk-stop'], ['pm-sk-reset', 'sk-reset']]) { const b = $(id), o = $(src); if (b && o) { if (b.disabled !== o.disabled) b.disabled = o.disabled; if (b.dataset.src !== o.textContent) skLabel(b, o.textContent); } } }, 150);
  }
  const kara = $('combo-kara'), v = $('mx-v'), a = $('mx-a');
  if (kara && v && a && !$('pm-vol')) {
    const card = document.createElement('div'); card.id = 'pm-vol'; card.setAttribute('aria-label', '音量');
    const h = [...document.querySelectorAll('#combo-mixer h3')].find((x) => x.textContent.trim() === '音量'); if (h) card.appendChild(h);
    for (const r of [v, a]) { const l = r.closest('label'); if (l) card.appendChild(l); }
    const note = $('mx-note'); if (note) card.appendChild(note);
    kara.insertAdjacentElement('afterend', card);
  }
}
// アプリ版のみ（2026-11-23 けんじょうさん指示）：見た目だけ。
// (3) 再生・停止・リセットの文字をボタンの中に収める（小さい iPhone でも）。(4) 歌声・伴奏のスライダーを今の半分の大きさに
//     （線の太さ・つまみ・行の高さ）。触れる範囲は見えない余白で確保。範囲・初期値・動きはそのまま。
// (5)「★ 採点する」→ 結果の画面に切り替えて大きな点数を出す（暗い背景・カウントアップ・ランクとひとこと・もう一度／閉じる）。
//     点数は LIVE の採点結果（kResult）を読むだけで、計算はしない。今のバーの右の SCORE 表示もそのまま残す。
function styleApp() {
  if ($('pm-app-style2')) return;
  const st = document.createElement('style'); st.id = 'pm-app-style2';
  st.textContent = `
html.pm-app #pm-sk{gap:5px}
html.pm-app #pm-sk button{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font-size:clamp(11px,3.4vw,14px);line-height:1.1;padding:4px 2px;white-space:nowrap;overflow:hidden}
html.pm-app #pm-sk button .i{font-size:.9em;line-height:1;opacity:.9}
html.pm-app #combo-score-row #c-score{flex:0 0 32%;width:32%;min-width:0;padding:0 6px;aspect-ratio:auto;min-height:48px}
html.pm-app #combo-score-row #c-score .cs-main{font-size:clamp(13px,4.2vw,18px);letter-spacing:.06em;white-space:nowrap}
html.pm-app #combo-score-row #c-score .cs-sub{font-size:clamp(8px,2.4vw,11px);white-space:normal;text-align:center;line-height:1.2}
html.pm-app #combo-score-row #pm-cscore{display:flex;align-items:center;gap:2px;flex:0 0 32%;width:32%;min-width:0}
html.pm-app #combo-score-row #pm-cscore #c-score{flex:1 1 auto;width:auto;min-width:0;padding:0 6px;aspect-ratio:auto;min-height:48px}
html.pm-app #pm-vol .pm-vol-h{display:flex;align-items:center;justify-content:space-between;margin:-2px -8px -2px 0}
html.pm-app #pm-vol{gap:3px;padding:8px 14px}
html.pm-app #pm-vol h3{font-size:12px;margin:0}
html.pm-app #pm-vol label.mx{gap:0;font-size:12px;line-height:14px}
html.pm-app #pm-vol label.mx span{font-size:12px;line-height:14px}
html.pm-app #pm-vol #mx-note{font-size:11px;line-height:1.4}
html.pm-app #pm-vol input[type=range]{-webkit-appearance:none;appearance:none;display:block;width:100%;height:28px;min-height:0;margin:-7px 0;padding:0;background:transparent;cursor:pointer;touch-action:pan-y}
html.pm-app #pm-vol input[type=range]::-webkit-slider-runnable-track{height:2px;border-radius:1px;background:linear-gradient(90deg,var(--pm-pink,#f285be) var(--p,100%),rgba(255,255,255,.2) var(--p,100%))}
html.pm-app #pm-vol input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;margin-top:-6px;border-radius:50%;background:#fff;border:0;box-shadow:0 0 0 1px rgba(0,0,0,.18),0 1px 3px rgba(0,0,0,.45)}
html.pm-app #pm-vol input[type=range]::-moz-range-track{height:2px;border-radius:1px;background:rgba(255,255,255,.2)}
html.pm-app #pm-vol input[type=range]::-moz-range-progress{height:2px;border-radius:1px;background:var(--pm-pink,#f285be)}
html.pm-app #pm-vol input[type=range]::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:#fff;border:0;box-shadow:0 1px 3px rgba(0,0,0,.45)}
html.pm-app #pm-vol input[type=range]:disabled{opacity:.4;cursor:default}
#pm-result{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:calc(24px + env(safe-area-inset-top,0px)) 22px calc(24px + env(safe-area-inset-bottom,0px));color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans',sans-serif;text-align:center;overflow:hidden;
  background:radial-gradient(ellipse 80% 55% at 50% 38%,rgba(187,124,232,.32),rgba(13,14,17,0) 70%),radial-gradient(ellipse 60% 40% at 80% 0%,rgba(104,50,73,.9),rgba(104,50,73,0) 100%),rgba(8,8,12,.94);
  opacity:0;transform:scale(1.04);transition:opacity .35s ease,transform .35s ease}
#pm-result.show{opacity:1;transform:none}
#pm-result::before{content:"";position:absolute;inset:-50%;background:repeating-conic-gradient(from 0deg at 50% 50%,rgba(242,133,190,.07) 0 6deg,transparent 6deg 18deg);animation:pmRays 18s linear infinite;pointer-events:none}
@keyframes pmRays{to{transform:rotate(360deg)}}
#pm-result > *{position:relative}
#pm-result .pmr-cap{font-size:13px;letter-spacing:.45em;color:#f285be;font-weight:700;padding-left:.45em}
#pm-result .pmr-phase{font-size:15px;color:#ececef;min-height:20px;letter-spacing:.1em}
#pm-result .pmr-big{display:flex;align-items:baseline;justify-content:center;gap:6px;font-variant-numeric:tabular-nums;line-height:1}
#pm-result .pmr-big .n{font-size:clamp(72px,26vw,132px);font-weight:900;letter-spacing:-.02em;background:linear-gradient(180deg,#fff 0%,#ffe1f1 45%,#f285be 100%);-webkit-background-clip:text;background-clip:text;color:transparent;filter:drop-shadow(0 0 18px rgba(242,133,190,.55)) drop-shadow(0 4px 0 rgba(34,22,40,.6))}
#pm-result .pmr-big .d{font-size:clamp(28px,9vw,46px);font-weight:800;color:#f7cfe4;font-variant-numeric:tabular-nums}
#pm-result .pmr-big .u{font-size:clamp(22px,7vw,34px);font-weight:800;color:#f7cfe4}
#pm-result .pmr-gauge{width:min(86vw,420px);height:10px;border-radius:5px;background:rgba(255,255,255,.12);overflow:hidden;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}
#pm-result .pmr-gauge i{display:block;height:100%;width:0;border-radius:5px;background:linear-gradient(90deg,#3bc4e0,#a678ff 50%,#ff8c6b)}
#pm-result .pmr-rank{font-size:clamp(40px,14vw,64px);font-weight:900;font-style:italic;letter-spacing:.04em;color:#fff;text-shadow:0 0 16px rgba(187,124,232,.9),0 0 2px #fff;opacity:0;transform:scale(2.2);transition:opacity .3s ease,transform .45s cubic-bezier(.2,1.6,.4,1)}
#pm-result .pmr-rank.on{opacity:1;transform:none}
#pm-result .pmr-msg{font-size:18px;font-weight:700;color:#ffe1f1;opacity:0;transition:opacity .4s ease .15s}
#pm-result .pmr-msg.on{opacity:1}
#pm-result .pmr-sub{font-size:12px;color:#b4b1b9;line-height:1.6;opacity:0;transition:opacity .4s ease .3s;max-width:420px}
#pm-result .pmr-sub.on{opacity:1}
#pm-result .pmr-btns{display:flex;gap:10px;margin-top:8px;opacity:0;transition:opacity .4s ease .45s}
#pm-result .pmr-btns.on{opacity:1}
#pm-result .pmr-btns button{min-width:128px;min-height:48px;border-radius:24px;border:0;font:700 16px/1 -apple-system,BlinkMacSystemFont,'Hiragino Sans',sans-serif;cursor:pointer}
#pm-result .pmr-btns .pmr-again{background:linear-gradient(90deg,#bb7ce8,#f285be);color:#221628;box-shadow:0 4px 14px rgba(187,124,232,.45)}
#pm-result .pmr-btns .pmr-close{background:#25232a;color:#ececef;box-shadow:inset 0 0 0 1px #48434e}
#pm-result.pmr-bad .pmr-big,#pm-result.pmr-bad .pmr-gauge,#pm-result.pmr-bad .pmr-rank{display:none}
@media (prefers-reduced-motion:reduce){#pm-result::before{animation:none}}
/* 2026-11-24：1画面にカラオケバー＋メーターを収める。ツマミと再生位置を小さく、音量は再生位置の下、メーターは見本（いまの声）くらいの高さに。バー126pxと音程バーの太さは変えない。判定・文面は変えない。 */
html.pm-app #pm-khead{padding:8px 14px 0}
html.pm-app #pm-khead .pm-brand{font-size:12px;letter-spacing:2px}
html.pm-app #pm-khead .pm-title{font-size:26px;line-height:1.28;margin:4px 0 0}
html.pm-app #pm-khead .pm-info{margin-bottom:0}
html.pm-app #combo-bar{margin:6px 12px 0;padding:6px 12px}
html.pm-app #combo-bar button,html.pm-app #combo-bar #c-pick{padding:8px 12px;min-height:40px}
html.pm-app #combo-green{padding:6px 10px;gap:6px;display:flex;flex-direction:column}
html.pm-app #combo-mixer.pm-seek{padding:4px 12px 6px!important}
html.pm-app #combo-mixer.pm-seek .sk{gap:2px}
html.pm-app #combo-mixer.pm-seek .pm-info,html.pm-app #pm-vol .pm-info{width:22px!important;height:22px!important;min-height:0!important;min-width:0;margin:0!important}
html.pm-app #combo-mixer.pm-seek .pm-info svg,html.pm-app #pm-vol .pm-info svg{width:13px;height:13px}
html.pm-app #combo-mixer.pm-seek .pm-seek-h,html.pm-app #pm-vol .pm-vol-h{min-height:0;margin:0}
html.pm-app #combo-mixer.pm-seek h3,html.pm-app #pm-vol h3{line-height:18px;margin:0;font-size:12px}
html.pm-app #pm-vol #mx-note{font-size:10px;line-height:13px;margin:0}
html.pm-app #combo-mixer.pm-seek .sk-time{font-size:14px;line-height:18px}
html.pm-app #combo-mixer.pm-seek .sk-range{margin:0;font-size:11px;line-height:14px}
html.pm-app #combo-mixer.pm-seek input[type=range]{-webkit-appearance:none;appearance:none;display:block;width:100%;height:22px;min-height:0;margin:0;padding:0;background:transparent;cursor:pointer;touch-action:pan-y}
html.pm-app #combo-mixer.pm-seek input[type=range]::-webkit-slider-runnable-track{height:2px;border-radius:1px;background:rgba(255,255,255,.2)}
html.pm-app #combo-mixer.pm-seek input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;margin-top:-6px;border-radius:50%;background:#fff;border:0;box-shadow:0 0 0 1px rgba(0,0,0,.18),0 1px 3px rgba(0,0,0,.45)}
html.pm-app #combo-mixer.pm-seek input[type=range]::-moz-range-track{height:2px;border-radius:1px;background:rgba(255,255,255,.2)}
html.pm-app #combo-mixer.pm-seek input[type=range]::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:#fff;border:0}
html.pm-app #pm-vol{margin:0;padding:4px 12px;gap:1px}
html.pm-app #pm-vol .pm-vol-h{margin:0 -6px 0 0}
html.pm-app #pm-vol label.mx{gap:0;line-height:13px}
html.pm-app #pm-vol input[type=range]{height:22px;margin:-5px 0}
html.pm-app #combo-score-row{gap:6px}
html.pm-app #combo-score-row #pm-sk button,html.pm-app #combo-score-row #c-score,html.pm-app #combo-score-row #pm-cscore #c-score{min-height:44px}
/* 採点する：文字をボタン枠内に収める（1列・1画面レイアウトは維持） */
html.pm-app #combo-score-row #c-score .cs-main,html.pm-app #combo-score-row #pm-cscore #c-score .cs-main{font-size:clamp(11px,3.15vw,13px);letter-spacing:0;max-width:100%;overflow:hidden}
html.pm-app #combo-score-row #pm-cscore #c-score{padding:0 4px}
/* メーターカード：見本（いまの声）くらいの高さ・紫枠。文面と判定は変えない。 */
html.pm-app #combo-gauge .gauge{padding:8px 12px 6px!important;border-radius:16px!important;background:linear-gradient(180deg,rgba(37,35,42,.85),#17171c)!important;border:0!important;box-shadow:0 0 0 1.5px rgba(187,124,232,.35),0 4px 10px rgba(187,124,232,.16)!important;overflow:visible}
html.pm-app #combo-gauge .gauge::before{content:"";position:absolute;inset:0;border-radius:16px;padding:3px;background:linear-gradient(135deg,rgba(187,124,232,.75),rgba(242,133,190,.75));-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;z-index:1}
html.pm-app #combo-gauge .readout{height:auto;min-height:22px;gap:8px;align-items:center;margin:0 0 2px}
html.pm-app #combo-gauge .readout strong{font-size:16px}
html.pm-app #combo-gauge .readout span,html.pm-app #combo-gauge .readout .register{font-size:13px!important}
html.pm-app #combo-gauge .badge{font-size:11px!important;min-height:22px;padding:0 10px;border-radius:999px;background:rgba(72,67,78,.35);display:inline-flex;align-items:center}
html.pm-app #combo-gauge .labels{margin:4px 0 2px;font-size:12px}
html.pm-app #combo-gauge .track{height:8px;border-radius:8px}
html.pm-app #combo-gauge .needle{width:16px;height:16px;border-width:2px;box-shadow:0 0 8px 2px #ffffff29}
html.pm-app #combo-gauge .needle:before{width:2px;height:22px;top:-6px;left:5px}
html.pm-app #combo-gauge .ticks{margin-top:6px;font-size:10px}
html.pm-app #combo-gauge .disclaimer{margin:6px 0 0;font-size:10px;line-height:1.35}
/* 2026-11-24: カラオケの素材取り込み中は、分析タブと同じ読み込み表示（スピナー・4pxバー・パーセント・中止）。判定・分離の動きは変えない。 */
html.pm-app #pm-load{--accent:var(--pm-accent);--control:var(--pm-control);--text:var(--pm-text);--bborder:var(--pm-btn-border);position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:18px 16px;background:rgba(13,14,17,.78)}
html.pm-app #pm-load[hidden]{display:none!important}
html.pm-app #pm-load .pm-load-box{width:100%;max-width:340px;display:flex;flex-direction:column;gap:10px;background:var(--pm-panel,#17171c);border-radius:16px;padding:14px}
html.pm-app #pm-load .caption{font-size:12px;line-height:1.5;margin:0;color:var(--text)}
html.pm-app #pm-load .mono{font-variant-numeric:tabular-nums}
html.pm-app #pm-load .progress{display:flex;align-items:center;gap:10px;font-size:12px}
html.pm-app #pm-load .progress .bar{flex:1;height:4px;border-radius:2px;background:var(--control);position:relative;overflow:hidden}
html.pm-app #pm-load .progress .bar::after{content:"";position:absolute;left:0;top:0;bottom:0;width:var(--p,0%);background:var(--accent);transition:width .15s}
html.pm-app #pm-load .spinner{width:18px;height:18px;border-radius:50%;border:2px solid rgba(255,255,255,.2);border-top-color:#fff;animation:spin .9s linear infinite;flex:none}
@keyframes spin{to{transform:rotate(360deg)}}
html.pm-app #pm-load .sbtn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:12px 14px;border-radius:10px;border:1px solid var(--bborder);background:var(--control);color:var(--text);font-size:13px;line-height:1.2;cursor:pointer}
html.pm-app #pm-load .sbtn.small{padding:6px 10px;font-size:12px}
html.pm-app #pm-load-err{margin:6px 14px 0;font-size:12px;line-height:1.5;color:var(--pm-text)}
html.pm-app #pm-load-err[hidden]{display:none!important}

html.pm-app #combo.pm-loading #c-pick,html.pm-app #combo.pm-loading #c-songs,html.pm-app #combo.pm-loading #pm-sk-play,html.pm-app #combo.pm-loading #pm-sk-reset,html.pm-app #combo.pm-loading #c-score,html.pm-app #combo.pm-loading #pm-cscore,html.pm-app #combo.pm-loading #sk-pos,html.pm-app #combo.pm-loading #pm-pick-row,html.pm-app #combo.pm-loading #pm-vol{opacity:.4;pointer-events:none}
/* 2026-11-24: アプリのカラオケ画面では LIVE 試作の下地（main）を出さない。要素は残して参照は壊れないようにする。 */
html.pm-app main{display:none!important}
html.pm-app,html.pm-app body{height:100%!important;max-height:100%!important;overflow:hidden!important;overscroll-behavior:none}
/* カラオケバー上の縦スワイプを #combo のスクロールに渡す（iOS では iframe の pointer-events:none が効かないことがある） */
html.pm-app #combo-kara{position:relative;touch-action:pan-y;-webkit-overflow-scrolling:touch}
html.pm-app #combo-kara::after{content:"";position:absolute;inset:0;z-index:2;touch-action:pan-y}
html.pm-app #kara-host.inbox{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;z-index:1;pointer-events:none;background:transparent}
html.pm-app #kara-host.inbox,html.pm-app #kara-host.inbox #kara-frame{pointer-events:none;touch-action:pan-y}
/* 2026-11-24: カラオケの「写真かファイルから選ぶ」右のⓘを外し、分析タブと同じ大きさに（393×852実測：高さ73・余白12 14・文字18.2・角丸10） */
html.pm-app #combo-bar{margin-left:16px!important;margin-right:16px!important;padding-left:0!important;padding-right:0!important}
html.pm-app #pm-pick-row{display:block;flex-basis:100%;width:100%;gap:0}
html.pm-app #combo-bar #c-pick,html.pm-app #pm-pick-row #c-pick,html.pm-app #combo-bar button#c-pick{
  display:flex;align-items:center;justify-content:center;gap:8px;box-sizing:border-box;
  width:100%;flex:none;flex-basis:auto;max-width:100%;
  padding:12px 14px!important;min-height:73px!important;height:73px;
  font-size:18.2px;font-weight:600;line-height:21.84px;border-radius:10px;
  border:1px solid var(--pm-btn-border,#a16f90)
}
html.pm-app #c-pick .kara-pick-icon{width:22px;height:22px;flex:none;pointer-events:none}
`;
  document.body.appendChild(st); // 元の style より後ろに置く（同じ強さの指定はこちらが勝つ）
}

function loadUI() {
  if ($('pm-load')) return;
  const combo = $('combo'); if (!combo) return;
  const iframe = () => $('kara-frame');
  const kEl = (id) => { try { const d = iframe() && iframe().contentDocument; return d && d.getElementById(id); } catch (e) { return null; } };
  const ov = document.createElement('div');
  ov.id = 'pm-load'; ov.hidden = true; ov.setAttribute('role', 'status'); ov.setAttribute('aria-live', 'polite');
  ov.innerHTML = '<div class="pm-load-box"><div class="caption" id="pm-load-text"></div><div class="progress" id="pm-load-wrap"><span class="spinner" aria-hidden="true"></span><div class="bar" id="pm-load-bar"></div><span id="pm-load-pct" class="caption mono">0%</span><button type="button" class="sbtn small" id="pm-load-cancel">中止</button></div></div>';
  document.body.appendChild(ov);
  const err = document.createElement('p');
  err.id = 'pm-load-err'; err.className = 'caption'; err.hidden = true; err.setAttribute('role', 'status'); err.setAttribute('aria-live', 'polite');
  const pickRow = $('pm-pick-row') || $('c-pick');
  if (pickRow && pickRow.parentNode) pickRow.parentNode.insertBefore(err, pickRow.nextSibling);
  else combo.insertBefore(err, combo.firstChild);
  const setP = (u) => { const bar = $('pm-load-bar'), pct = $('pm-load-pct'); if (bar) bar.style.setProperty('--p', (u * 100).toFixed(0) + '%'); if (pct) pct.textContent = Math.round(u * 100) + '%'; };
  const hideLoad = () => { ov.hidden = true; combo.classList.remove('pm-loading'); if ($('c-pick')) $('c-pick').disabled = false; };
  const showLoad = (text, u) => {
    ov.hidden = false; combo.classList.add('pm-loading'); if ($('c-pick')) $('c-pick').disabled = true;
    err.hidden = true; err.textContent = '';
    if (text) $('pm-load-text').textContent = text;
    if (u != null) setP(u);
  };
  const showErr = (msg) => { hideLoad(); if (msg) { err.textContent = msg; err.hidden = false; } else { err.textContent = ''; err.hidden = true; } };
  $('pm-load-cancel').onclick = () => { const b = kEl('kStop'); if (b) b.click(); };
  const parseP = (text) => {
    const t = text || '';
    const m = t.match(/(\d+)\s*%\s*$/);
    const pct = m ? Number(m[1]) : null;
    if (/見本の音程を解析中/.test(t)) return 0.72 + (pct == null ? 0 : pct / 100 * 0.28);
    if (/歌声を分離中/.test(t)) return 0.12 + (pct == null ? 0 : pct / 100 * 0.60);
    if (/分離を準備|分離モデルを準備|長い素材/.test(t)) return 0.10;
    if (/読み取り中|音声を読み/.test(t)) return 0.04;
    if (pct != null) return pct / 100;
    return null;
  };
  let watching = false;
  const tickLoad = () => {
    let mode = '', text = '';
    try {
      const w = iframe() && iframe().contentWindow;
      const st = w && w.__pmK && w.__pmK.state();
      if (st) mode = st.mode || '';
      const ks = kEl('kStatus'); if (ks) text = ks.textContent || '';
    } catch (e) {}
    if (mode === 'loading') {
      watching = true;
      showLoad(text || '端末内で音声を読み取り中…', parseP(text));
    } else if (mode === 'ready' && (watching || !ov.hidden)) {
      watching = false; hideLoad(); err.hidden = true; err.textContent = '';
    } else if (!ov.hidden && mode === 'idle' && text && !/準備しました|素材を選ぶと/.test(text)) {
      watching = false; showErr(text);
    } else if (watching && mode && mode !== 'loading') {
      watching = false;
      if (text && !/準備しました|素材を選ぶと/.test(text)) showErr(text);
      else hideLoad();
    }
  };
  setInterval(tickLoad, 100);
  self.__pmLoad = { show: showLoad, hide: hideLoad, err: showErr, tick: tickLoad };
}

function rangeFill() { for (const id of ['mx-v', 'mx-a']) { const r = $(id); if (!r) continue; const f = () => { const lo = Number(r.min) || 0, hi = Number(r.max) || 100; r.style.setProperty('--p', ((Number(r.value) - lo) / (hi - lo) * 100) + '%'); };
  if (!r.dataset.pmFill) { r.dataset.pmFill = '1'; r.addEventListener('input', f); r.addEventListener('change', f); } f(); } }
function rankOf(v) { return v >= 98 ? ['SSS', '神がかった歌声！'] : v >= 95 ? ['SS', '最高の歌声！'] : v >= 90 ? ['S', 'すばらしい！'] : v >= 85 ? ['A+', 'とても上手！'] : v >= 80 ? ['A', '上手！'] : v >= 70 ? ['B', 'いい感じ！'] : v >= 60 ? ['C', 'その調子！'] : ['D', 'もう一度チャレンジ！']; }
function previewUsage() { try { return parent!==self ? parent.PMPreviewKaraoke : null; } catch (_) { return null; } }
function closeResult() { const e=$('pm-result'); if(!e || e.dataset.closing) return; e.dataset.closing='yes'; e.classList.remove('show');
  setTimeout(()=>{e.remove(); const quota=previewUsage(); if(quota) quota.closed(self);},300); }
let resultSeq = 0;
function showResult(preview=null) { // Reuse the existing score renderer without changing scoring.
  const my = ++resultSeq, t0 = performance.now();
  const kd = () => { try { return $('kara-frame').contentDocument; } catch (e) { return null; } };
  const wait = () => { if (my !== resultSeq) return; const d = kd(), res = d && d.getElementById('kResult'); const txt = res && !res.hidden ? res.textContent.trim() : '';
    if (!txt) { if (performance.now() - t0 < 4000) setTimeout(wait, 100); return; } open(txt); };
  const open = (txt) => {
    const old = $('pm-result'); if (old) old.remove();
    const m = txt.match(/^\s*(\d+)\s*点/), base = txt.match(/基礎\s*(\d+)\s*点/), bonus = txt.match(/加点\s*(\d+)\s*点/);
    const box = document.createElement('div'); box.id = 'pm-result'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', '採点結果');
    box.innerHTML = '<div class="pmr-cap">SCORE</div><div class="pmr-phase">採点中…</div>'
      + '<div class="pmr-big" aria-live="off"><span class="n">0</span><span class="d">.000</span><span class="u">点</span></div><div class="pmr-gauge"><i></i></div>'
      + '<div class="pmr-rank"></div><div class="pmr-msg"></div><div class="pmr-sub"></div><div class="pmr-btns"><button class="pmr-again" type="button">もう一度</button><button class="pmr-close" type="button">閉じる</button></div>';
    document.body.appendChild(box);
    box.querySelector('.pmr-close').onclick = closeResult;
    box.querySelector('.pmr-again').onclick = () => { closeResult(); const r = $('pm-sk-reset'); if (r && !r.disabled) r.click(); setTimeout(() => { const p = $('pm-sk-play'); if (p && !p.disabled) p.click(); }, 400); };
    requestAnimationFrame(() => box.classList.add('show'));
    const on = (sel) => box.querySelector(sel).classList.add('on');
    if (!m) { box.classList.add('pmr-bad'); box.querySelector('.pmr-phase').textContent = ''; const g = box.querySelector('.pmr-msg'); g.textContent = txt.slice(0, 80); on('.pmr-msg'); on('.pmr-btns'); setTimeout(() => box.querySelector('.pmr-close').focus(), 50); return; }
    const score = Math.max(0, Math.min(100, Number(m[1]))), n = box.querySelector('.pmr-big .n'), dd = box.querySelector('.pmr-big .d'), bar = box.querySelector('.pmr-gauge i');
    const [rk, word] = rankOf(score);
    box.querySelector('.pmr-rank').textContent = rk; box.querySelector('.pmr-msg').textContent = word;
    box.querySelector('.pmr-sub').textContent = (base ? '基礎 ' + base[1] + '点' : '') + (bonus ? ' ＋ 加点 ' + bonus[1] + '点' : '');
    if (preview) {
      // No numeric result is shown until the user is still on the result and the credit is recorded.
      box.querySelector('.pmr-big').style.visibility='hidden';
      const btns=box.querySelector('.pmr-btns'), again=box.querySelector('.pmr-again');
      on('.pmr-btns'); again.hidden=true;
      const current=()=>box.isConnected && !box.dataset.closing && my===resultSeq;
      setTimeout(async()=>{
        if(!current())return;
        const permitted=await preview.quota.reveal(self,preview.takeID,current);
        if(!current())return;
        box.querySelector('.pmr-phase').textContent='';
        if(!permitted){
          box.classList.add('pmr-bad');
          box.querySelector('.pmr-msg').textContent='採点の残り回数を確認できませんでした。';
          box.querySelector('.pmr-close').focus(); on('.pmr-msg'); return;
        }
        n.textContent=String(score); dd.textContent=''; bar.style.width=score+'%';
        box.querySelector('.pmr-big').style.visibility='';
        again.hidden=false; on('.pmr-rank'); on('.pmr-msg'); on('.pmr-sub');
        box.querySelector('.pmr-close').focus({preventScroll:true});
      },950);
      return;
    }
    const roll = 900, dur = 2200; let s0 = 0;
    const step = (t) => { if (!box.isConnected) return; if (!s0) s0 = t; const el = t - s0;
      if (el < roll) { n.textContent = String(Math.floor(Math.random() * 100)); dd.textContent = '.' + String(Math.floor(Math.random() * 1000)).padStart(3, '0'); requestAnimationFrame(step); return; }
      { const ph = box.querySelector('.pmr-phase'); if (ph.textContent) ph.textContent = ''; }
      const p = Math.min(1, (el - roll) / dur), e = 1 - Math.pow(1 - p, 4), v = score * e;
      n.textContent = String(Math.floor(v)); dd.textContent = p < 1 ? '.' + String(Math.floor((v % 1) * 1000)).padStart(3, '0') : ''; bar.style.width = v + '%';
      if (p < 1) { requestAnimationFrame(step); return; }
      n.textContent = String(score); on('.pmr-rank'); on('.pmr-msg'); on('.pmr-sub'); on('.pmr-btns'); };
    requestAnimationFrame(step); setTimeout(() => box.querySelector('.pmr-close').focus({ preventScroll: true }), 50);
  };
  if (preview) open(preview.text); else setTimeout(wait,120);
}
function scoreScreen() { const b=$('c-score'); if(!b || b.dataset.pmResult)return; b.dataset.pmResult='1';
  b.addEventListener('click',e=>{
    const quota=previewUsage(); if(!quota) return;
    e.stopImmediatePropagation(); e.preventDefault();
    if(b.disabled || $('pm-result') || !quota.canTry(self)) return;
    const player=$('kara-frame').contentWindow?.__pmK;
    const r=player?.previewScore(()=>quota.newTakeID(self));
    if(!r)return;
    if(!r.valid || !Number.isFinite(r.score) || !r.takeID) {
      showResult({text:r.reason||'採点できませんでした。歌声を拾えているかご確認ください。'}); return;
    }
    showResult({text:r.score+' 点 · 基礎 '+r.baseScore+'点 + 加点 '+r.bonus+'点',takeID:r.takeID,quota});
  },true);
  b.addEventListener('click',()=>{if(!b.disabled)showResult();});
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('pm-result')) { e.stopImmediatePropagation(); closeResult(); } }, true);
  for (const id of ['pm-sk-play', 'pm-sk-reset']) { const x = $(id); if (x) x.addEventListener('click', closeResult); } }
// アプリ版のみ（2026-11-23 けんじょうさん指示・見本＝LIVE の単独カラオケ画面）：
// (1) 上に見出し「REALTIME / KARAOKE」「見本に重ねて、声を描こう。」（LIVE カラオケ v17 と同じ文字・色）
// (2) 説明の文（LIVE カラオケ v17 の説明文そのまま。音程バーの色の説明 ⓘ は 11-23 19:27 指示で外した）は、アプリの既存の ⓘ と同じ丸い i ボタンにして、押した時だけ出す（StudioInformationModal と同じ見た目）
const PM_INFO = {
  'カラオケ': 'フレーズごとに見本を表示。動く縦メーターに合わせて歌おう。',
  '再生位置': 'バーを動かすと、その位置から再生・採点します。「停止」は一時停止（採点しません）。「リセット」は、再生中なら今の位置から採点し直し、止まっているときは最初（0:00）に戻します。「採点する」を押すと自動で止まり、採点開始位置から止めた位置までを採点します。',
  '音量': '歌声と伴奏を別々に調整できます（再生中も変えられます）。',
  '採点する': '再生中に押すと止めて採点'
};
const PM_ISVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 10.6v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="7.5" r="1.15" fill="currentColor"/></svg>';
function infoBtn(key, sm) { const b = document.createElement('button'); b.type = 'button'; b.className = 'pm-info' + (sm ? ' sm' : ''); b.dataset.info = key; b.setAttribute('aria-label', key + 'の説明'); b.innerHTML = PM_ISVG; b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); showInfo(key, PM_INFO[key] || ''); }; return b; }
function showInfo(title, text) { let m = $('pm-imodal');
  if (!m) { m = document.createElement('div'); m.id = 'pm-imodal'; m.hidden = true; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', 'pm-ititle');
    m.innerHTML = '<div class="pm-ibox"><div class="pm-irow"><strong id="pm-ititle"></strong><span style="flex:1"></span><button type="button" class="xbtn" id="pm-iclose" aria-label="閉じる"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button></div><p id="pm-itext"></p></div>';
    document.body.appendChild(m); const close = () => { m.hidden = true; }; m.addEventListener('click', (e) => { if (e.target === m) close(); }); m.querySelector('#pm-iclose').onclick = close;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !m.hidden) close(); }); }
  $('pm-ititle').textContent = title; $('pm-itext').textContent = text; m.hidden = false; $('pm-iclose').focus(); }
function infoUI() {
  const combo = $('combo'), bar = $('combo-bar');
  if (combo && bar && !$('pm-khead')) { const h = document.createElement('div'); h.id = 'pm-khead';
    h.innerHTML = '<div class="pm-brand">REALTIME / KARAOKE</div><div class="pm-trow"><h1 class="pm-title">見本に重ねて、<br>声を描こう。</h1></div>';
    h.querySelector('.pm-trow').appendChild(infoBtn('カラオケ')); bar.parentNode.insertBefore(h, bar); }
  // 2026-11-23 19:29 指示：「再生位置」のカードを 再生・停止・リセット・採点する の段のすぐ上へ。下の説明文は ⓘ に（シーク・採点区間の動きは LIVE のまま）
  const sk = $('sk'), row = $('combo-score-row'), mixer = $('combo-mixer');
  if (sk && row && mixer && !mixer.classList.contains('pm-seek')) {
    sk.querySelectorAll('.mx-small').forEach((p) => { if (/^\s*バーを動かすと/.test(p.textContent)) p.remove(); });
    const h = sk.querySelector('h3'); if (h) { const t = document.createElement('div'); t.className = 'pm-seek-h'; h.parentNode.insertBefore(t, h); t.appendChild(h); t.appendChild(infoBtn('再生位置', true)); }
    // 再生位置のカード（LIVE の #combo-mixer そのもの。中身は #sk だけ）を 再生・停止・リセット・採点する の段のすぐ上へ移す。LIVE の #combo-mixer の見た目（色・数字）はそのまま効く
    if (sk.parentNode !== mixer) mixer.appendChild(sk); mixer.classList.add('pm-seek'); row.parentNode.insertBefore(mixer, row); }
  const pick = $('c-pick'); if (pick && !$('pm-pick-row')) { const r = document.createElement('div'); r.id = 'pm-pick-row'; pick.parentNode.insertBefore(r, pick); r.appendChild(pick); }
  // 2026-11-24 指示：「歌声と伴奏を別々に調整できます…」と「再生中に押すと止めて採点」を ⓘ に（音量の見出し・採点するの横）。余白を詰める。「表示は音の高さと…」はそのまま。判定・採点の動きは変えない。
  const vol = $('pm-vol');
  // 2026-11-24 指示：音量スライダー（ツマミ）を「再生位置」の直下へ。1画面にバーとメーターを収める。
  if (vol && mixer) mixer.insertAdjacentElement('afterend', vol);
  if (vol && !vol.querySelector('.pm-vol-h')) {
    const h = vol.querySelector('h3'); if (h) { const t = document.createElement('div'); t.className = 'pm-vol-h'; h.parentNode.insertBefore(t, h); t.appendChild(h); t.appendChild(infoBtn('音量', true)); }
    const note = $('mx-note');
    if (note) {
      const syncNote = () => { note.hidden = /歌声と伴奏を別々に調整できます/.test(note.textContent || ''); };
      syncNote(); new MutationObserver(syncNote).observe(note, { childList: true, characterData: true, subtree: true });
    }
  }
  const score = $('c-score');
  if (score && !$('pm-cscore')) {
    const sub = score.querySelector('.cs-sub'); if (sub) sub.remove();
    const r = document.createElement('div'); r.id = 'pm-cscore'; score.parentNode.insertBefore(r, score); r.appendChild(score); r.appendChild(infoBtn('採点する', true));
  }
}
function open() { tidy(); useDefaultMic(); styleApp(); layout(); infoUI(); loadUI(); rangeFill(); scoreScreen(); { const cm = $('c-mic'); if (cm) cm.onclick = () => { useDefaultMic(); $('start').click(); }; } try { self.PMSingle.openCombo(); } catch (e) { const s = $('c-status'); if (s) s.textContent = 'カラオケを開けませんでした（' + (e && e.message || e) + '）'; } }
if (document.readyState === 'complete') open(); else window.addEventListener('load', open);
const combo = $('combo'); if (combo) combo.addEventListener('scroll', () => window.dispatchEvent(new Event('resize')), { passive: true });
// タブを離れた時：マイクとカラオケの再生を止める（採点はしない）
self.PMApp = { pause() { try { $('stop').click(); } catch (e) {} try { const w = $('kara-frame').contentWindow; if (w && w.__pmK) w.__pmK.pause(); } catch (e) {} } };
})();
