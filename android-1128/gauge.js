/* Port of GaugeArtwork.render + GaugePlacement (GaugeMovieExporter.swift / GaugePlacementEditor.swift) to Canvas 2D.
   appearance = { maximumSeconds, vertical, branding, placement:{x,y,scale,angle} } (same rules as GaugeAppearance). */
(function (root) {
'use strict';
const FONT = '"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP",system-ui,sans-serif';
const DISCLAIMER = '表示は音の高さに基づく目安です。発声や音域には個人差があります';
const BRAND_NAME = '@kenjouwasanoyatsura_';
let brand = null;
function setBrand(img) { brand = img && img.naturalWidth ? img : null; }
function norm(a) {
  if (typeof a === 'boolean' || a === undefined || a === null) return { maximumSeconds: 300, vertical: !!a, branding: false, placement: null };
  return a;
}
const A = {
  fixed: (a) => a.maximumSeconds !== 300,
  isVertical: (a) => a.maximumSeconds === 300 && !!a.vertical,
  showsBrand: (a) => a.maximumSeconds === 40 || !!a.branding,
};
const safeScale = (p) => (p && isFinite(p.scale)) ? Math.min(2.5, Math.max(0.2, p.scale)) : 1;
function bounds(w, h, a) {
  if (A.isVertical(a)) return { x: w * 0.03, y: h * 0.12, w: w * 0.32, h: h * 0.62 };
  const gw = w * 0.9, ph = gw * ((A.showsBrand(a) ? 0.34 : 0.245) + (A.fixed(a) ? 0.04 : 0));
  return { x: w * 0.05 - gw * 0.02, y: h - ph - h * 0.055 - gw * 0.015, w: gw * 1.04, h: ph };
}
function center(p, w, h, b) {
  return { x: p && p.x !== null && p.x !== undefined && isFinite(p.x) ? p.x * w : b.x + b.w / 2,
           y: p && p.y !== null && p.y !== undefined && isFinite(p.y) ? p.y * h : b.y + b.h / 2 };
}
function render(ctx, w, h, state, range, appearance) {
  const C = root.PMCore, a = norm(appearance), p = a.placement || { scale: 1, angle: 0 };
  ctx.clearRect(0, 0, w, h);
  const b = bounds(w, h, a), c = center(p, w, h, b);
  ctx.save();
  ctx.translate(c.x, c.y); ctx.rotate(p.angle || 0); const s = safeScale(p); ctx.scale(s, s); ctx.translate(-(b.x + b.w / 2), -(b.y + b.h / 2));
  const text = (str, x, baseline, font, alpha) => {
    ctx.font = `600 ${font}px ${FONT}`; ctx.fillStyle = `rgba(255,255,255,${alpha === undefined ? 1 : alpha})`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillText(str, x, baseline);
  };
  const rr = (x, y, ww, hh, r) => { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + ww, y, x + ww, y + hh, r); ctx.arcTo(x + ww, y + hh, x, y + hh, r); ctx.arcTo(x, y + hh, x, y, r); ctx.arcTo(x, y, x + ww, y, r); ctx.closePath(); };
  const panel = (x, y, ww, hh, r) => { ctx.fillStyle = 'rgba(14,13,18,0.78)'; rr(x, y, ww, hh, r); ctx.fill(); };
  const bar = (x, y, ww, hh, vert) => { ctx.save(); rr(x, y, ww, hh, Math.min(ww, hh) / 2); ctx.clip();
    const g = vert ? ctx.createLinearGradient(x, y + hh, x, y) : ctx.createLinearGradient(x, y, x + ww, y);
    g.addColorStop(0, 'rgb(59,196,224)'); g.addColorStop(0.5, 'rgb(166,120,255)'); g.addColorStop(1, 'rgb(255,140,107)');
    ctx.fillStyle = g; ctx.fillRect(x, y, ww, hh); ctx.restore(); };
  const icon = (x, y, ww, hh) => { if (!brand) return; ctx.save(); ctx.beginPath();
    ctx.ellipse(x + ww * 0.084 + ww * 0.416, y + hh * 0.032 + hh * 0.468, ww * 0.416, hh * 0.468, 0, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(brand, x, y, ww, hh); ctx.restore(); };
  const fixed = A.fixed(a), vertical = A.isVertical(a);
  const position = C.pointerPosition(state.midi, range); // 2026-11-20 声の高さの目安（ファ♯4≈373Hz が真ん中）。core.js pointerPosition
  const cen = (range.split1 + range.split2) / 2, half = (range.split2 - range.split1) / 2;
  let near = Math.min(1, Math.max(0, 1 - Math.abs(state.midi - cen) / half)), mix = near * near * (3 - 2 * near);
  if (!fixed && state.midi > cen) {
    const hold = range.low + (range.high - range.low) * Math.max((cen - range.low) / (range.high - range.low), vertical ? 0.73 : 2 / 3);
    near = Math.min(1, Math.max(0, (state.midi - hold) / (range.high - hold))); mix = 1 - near * near * (3 - 2 * near);
  }
  function pointer(x, y, radius, unit, vert) {
    if (!(state.opacity > 0.002)) return;
    ctx.save(); ctx.globalAlpha = state.opacity;
    const fill = `rgb(${255 * (1 - 0.14 * mix)},${255 * (1 - 0.76 * mix)},${255 * (1 - 0.70 * mix)})`;
    ctx.shadowBlur = unit * 0.018; ctx.shadowColor = `rgba(${255 * (1 - 0.03 * mix)},${255 * (1 - 0.78 * mix)},${255 * (1 - 0.67 * mix)},${0.16 + 0.49 * mix})`;
    ctx.strokeStyle = fill; ctx.lineWidth = unit * 0.004;
    ctx.beginPath(); if (vert) { ctx.moveTo(x - radius * 1.7, y); ctx.lineTo(x + radius * 1.7, y); } else { ctx.moveTo(x, y - radius * 1.7); ctx.lineTo(x, y + radius * 1.7); } ctx.stroke();
    ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgb(255,245,242)'; ctx.stroke(); ctx.restore();
  }
  const note = (hz) => C.noteLabel(hz);
  const label = C.REG_LABEL[state.register];
  const showRegister = root.PMMeterLabels.active(label, state.readoutAlpha);
  if (vertical) {
    const x = w * 0.15, y = h * 0.18, length = h * 0.5, bw = w * 0.032, py = h * 0.68 - position * h * 0.5;
    panel(w * 0.03, h * 0.12, w * 0.32, h * 0.62, w * 0.025);
    bar(x - bw / 2, y, bw, length, true);
    if (!showRegister) for (const [str, yy] of [['裏声', h * 0.195], ['ミックス', h * 0.405], ['地声', h * 0.64]]) Array.from(str).forEach((ch, i) => text(ch, w * 0.095, yy + i * w * 0.034, w * 0.027));
    pointer(x, py, w * 0.022, w, true);
    if (state.readoutAlpha > 0) { text(state.hz.toFixed(1) + ' Hz', w * 0.255, py - w * 0.006, w * 0.027, state.readoutAlpha); text(note(state.hz), w * 0.255, py + w * 0.030, w * 0.030, state.readoutAlpha);
      if (showRegister) text(label, w * 0.255, py + w * 0.064, w * 0.027, state.readoutAlpha); }
    text('最高音', w * 0.255, h * 0.145 + w * 0.03, w * 0.022); text(note(range.acceptedHigh), w * 0.255, h * 0.145, w * 0.024);
    text('最低音', w * 0.255, h * 0.71 + w * 0.03, w * 0.022); text(note(range.acceptedLow), w * 0.255, h * 0.71, w * 0.024);
    if (A.showsBrand(a) && brand) { const ih = w * 0.055, iw = ih * brand.naturalWidth / brand.naturalHeight; icon(w * 0.15 - iw / 2, h * 0.716 - ih / 2, iw, ih); }
    ctx.restore();
    text('表示は音の高さに基づく目安です。', w / 2, h * 0.93, w * 0.024); text('発声や音域には個人差があります', w / 2, h * 0.95, w * 0.024);
    return;
  }
  const gw = w * 0.9, ph = gw * ((A.showsBrand(a) ? 0.34 : 0.245) + (fixed ? 0.04 : 0)), left = w * 0.05, top = h - ph - h * 0.055;
  panel(left - gw * 0.02, top - gw * 0.015, gw * 1.04, ph, gw * 0.025);
  if (state.readoutAlpha > 0) {
    const str = state.hz.toFixed(1) + ' Hz' + (a.maximumSeconds === 40 ? '' : '  ·  ' + note(state.hz)) + (showRegister ? '  ·  ' + label : '');
    ctx.font = `600 ${gw * 0.032}px ${FONT}`; const rw = ctx.measureText(str).width;
    text(str, Math.max(left + rw / 2 + gw * 0.01, Math.min(left + gw - rw / 2 - gw * 0.01, left + position * gw)), top + gw * 0.038, gw * 0.032, state.readoutAlpha);
  }
  if (!showRegister) for (const [str, x] of [['地声', left + gw / 6], ['ミックス', w / 2], ['裏声', left + gw * 5 / 6]]) text(str, x, top + gw * 0.092, gw * 0.026);
  const gy = top + gw * 0.123, gh = gw * 0.028;
  bar(left, gy, gw, gh, false);
  pointer(left + position * gw, gy + gh / 2, gw * 0.019, gw, false);
  if (fixed) { text('最低音 ' + note(range.acceptedLow), left + gw * 0.16, top + gw * 0.202, gw * 0.022); text('最高音 ' + note(range.acceptedHigh), left + gw * 0.84, top + gw * 0.202, gw * 0.022); }
  else { text('最低音 ' + note(range.acceptedLow), left + gw * 0.14, top + gw * 0.18, gw * 0.022); text('最高音 ' + note(range.acceptedHigh), left + gw * 0.86, top + gw * 0.18, gw * 0.022); }
  text(DISCLAIMER, w / 2, top + gw * (0.207 + (fixed ? 0.04 : 0)), gw * 0.018);
  if (A.showsBrand(a) && brand) {
    const ih = gw * 0.065, iw = ih * brand.naturalWidth / brand.naturalHeight;
    icon(left + gw * 0.02, top + gw * (0.25 + (fixed ? 0.04 : 0)), iw, ih);
    ctx.font = `600 ${gw * 0.024}px ${FONT}`; const raw = ctx.measureText(BRAND_NAME).width, fs = gw * 0.024 * Math.min(1, gw * 0.72 / raw);
    text(BRAND_NAME, left + gw * 0.115 + Math.min(raw, gw * 0.72) / 2, top + gw * (0.294 + (fixed ? 0.04 : 0)), fs);
  }
  ctx.restore();
}
root.PMGauge = { render, bounds, center, safeScale, setBrand, A, DISCLAIMER, BRAND_NAME,
  emptyState: () => ({ midi: 66, opacity: 0, hz: 0, readoutAlpha: 0, register: 0, mixBandAlpha: 1, uraBandAlpha: 1, chestBandAlpha: 1 }) };
})(typeof self !== 'undefined' ? self : this);
