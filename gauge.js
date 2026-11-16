/* Port of GaugeArtwork.render (horizontal meter, Full/300 appearance without branding) to Canvas 2D. */
(function (root) {
'use strict';
const FONT = '"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP",system-ui,sans-serif';
const DISCLAIMER = '表示は音の高さに基づく目安です。発声や音域には個人差があります';
function render(ctx, w, h, state, range, vertical) {
  const C = root.PMCore;
  ctx.clearRect(0, 0, w, h);
  const text = (s, x, baseline, font, alpha) => {
    ctx.font = `600 ${font}px ${FONT}`; ctx.fillStyle = `rgba(255,255,255,${alpha === undefined ? 1 : alpha})`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillText(s, x, baseline);
  };
  const rr = (x, y, ww, hh, r) => { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + ww, y, x + ww, y + hh, r); ctx.arcTo(x + ww, y + hh, x, y + hh, r); ctx.arcTo(x, y + hh, x, y, r); ctx.arcTo(x, y, x + ww, y, r); ctx.closePath(); };
  const position = Math.min(1, Math.max(0, (state.midi - range.low) / (range.high - range.low)));
  const center = (range.split1 + range.split2) / 2, half = (range.split2 - range.split1) / 2;
  let near = Math.min(1, Math.max(0, 1 - Math.abs(state.midi - center) / half)), mix = near * near * (3 - 2 * near);
  if (state.midi > center) { // appearance.fixed == false (Full / live)
    const hold = range.low + (range.high - range.low) * Math.max((center - range.low) / (range.high - range.low), vertical ? 0.73 : 2 / 3);
    near = Math.min(1, Math.max(0, (state.midi - hold) / (range.high - hold))); mix = 1 - near * near * (3 - 2 * near);
  }
  if (vertical) {
    const x = w * 0.15, y = h * 0.18, length = h * 0.5, bw = w * 0.032, py = h * 0.68 - position * h * 0.5;
    ctx.fillStyle = 'rgba(14,13,18,0.78)'; rr(w * 0.03, h * 0.12, w * 0.32, h * 0.62, w * 0.025); ctx.fill();
    ctx.save(); rr(x - bw / 2, y, bw, length, bw / 2); ctx.clip();
    const g = ctx.createLinearGradient(x - bw / 2, y + length, x - bw / 2, y);
    g.addColorStop(0, 'rgb(59,196,224)'); g.addColorStop(0.5, 'rgb(166,120,255)'); g.addColorStop(1, 'rgb(255,140,107)');
    ctx.fillStyle = g; ctx.fillRect(x - bw / 2, y, bw, length); ctx.restore();
    for (const [s, yy, a] of [['裏声', h * 0.195, state.uraBandAlpha], ['ミックス', h * 0.405, state.mixBandAlpha], ['地声', h * 0.64, state.chestBandAlpha ?? 1]]) if (a > 0.01) Array.from(s).forEach((ch, i) => text(ch, w * 0.095, yy + i * w * 0.034, w * 0.027, a));
    pointer(x, py, w * 0.022, w, true);
    if (state.readoutAlpha > 0) { text(state.hz.toFixed(1) + ' Hz', w * 0.255, py - w * 0.006, w * 0.027, state.readoutAlpha); text(C.noteLabel(state.hz), w * 0.255, py + w * 0.030, w * 0.030, state.readoutAlpha);
      const label = C.REG_LABEL[state.register]; if (label) text(label, w * 0.255, py + w * 0.064, w * 0.027, state.readoutAlpha); }
    text('最高音', w * 0.255, h * 0.145 + w * 0.03, w * 0.022); text(C.noteLabel(range.acceptedHigh), w * 0.255, h * 0.145, w * 0.024);
    text('最低音', w * 0.255, h * 0.71 + w * 0.03, w * 0.022); text(C.noteLabel(range.acceptedLow), w * 0.255, h * 0.71, w * 0.024);
    text('表示は音の高さに基づく目安です。', w / 2, h * 0.93, w * 0.024); text('発声や音域には個人差があります', w / 2, h * 0.95, w * 0.024);
    return;
  }
  const gw = w * 0.9, ph = gw * 0.245, left = w * 0.05, top = h - ph - h * 0.055;
  ctx.fillStyle = 'rgba(14,13,18,0.78)'; rr(left - gw * 0.02, top - gw * 0.015, gw * 1.04, ph, gw * 0.025); ctx.fill();
  if (state.readoutAlpha > 0) {
    const label = C.REG_LABEL[state.register];
    const s = state.hz.toFixed(1) + ' Hz' + '  ·  ' + C.noteLabel(state.hz) + (label ? '  ·  ' + label : '');
    ctx.font = `600 ${gw * 0.032}px ${FONT}`; const rw = ctx.measureText(s).width;
    text(s, Math.max(left + rw / 2 + gw * 0.01, Math.min(left + gw - rw / 2 - gw * 0.01, left + position * gw)), top + gw * 0.038, gw * 0.032, state.readoutAlpha);
  }
  for (const [s, x, a] of [['地声', left + gw / 6, state.chestBandAlpha ?? 1], ['ミックス', w / 2, state.mixBandAlpha], ['裏声', left + gw * 5 / 6, state.uraBandAlpha]]) if (a > 0.01) text(s, x, top + gw * 0.092, gw * 0.026, a);
  const gy = top + gw * 0.123, gh = gw * 0.028;
  ctx.save(); rr(left, gy, gw, gh, gh / 2); ctx.clip();
  const g = ctx.createLinearGradient(left, gy, left + gw, gy);
  g.addColorStop(0, 'rgb(59,196,224)'); g.addColorStop(0.5, 'rgb(166,120,255)'); g.addColorStop(1, 'rgb(255,140,107)');
  ctx.fillStyle = g; ctx.fillRect(left, gy, gw, gh); ctx.restore();
  pointer(left + position * gw, gy + gh / 2, gw * 0.019, gw, false);
  text('最低音 ' + C.noteLabel(range.acceptedLow), left + gw * 0.14, top + gw * 0.18, gw * 0.022);
  text('最高音 ' + C.noteLabel(range.acceptedHigh), left + gw * 0.86, top + gw * 0.18, gw * 0.022);
  text(DISCLAIMER, w / 2, top + gw * 0.207, gw * 0.018);
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
}
root.PMGauge = { render, emptyState: () => ({ midi: 66, opacity: 0, hz: 0, readoutAlpha: 0, register: 0, mixBandAlpha: 1, uraBandAlpha: 1 }) };
})(typeof self !== 'undefined' ? self : this);
