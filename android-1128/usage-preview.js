/* Safari feature preview only. No account, ads, billing, uploads or StoreKit. */
(function (root) {
  'use strict';
  const KEY = 'pm.preview.featureUsage.v1', PREV = 'pm.preview.liveSession.v1', PLAN = 'pm.preview.plan.v1';
  const uuid = () => (root.crypto.randomUUID ? root.crypto.randomUUID() : Array.from(root.crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join(''));
  const identity = s => typeof s === 'string' && /^[a-f0-9-]{32,36}$/i.test(s);
  const jst = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit' });
  const month = d => { const p = jst.formatToParts(d); return p.find(x=>x.type==='year').value + '-' + p.find(x=>x.type==='month').value; };
  function make(storage, tabStorage, now = () => new Date(), lock = null) {
    let tier = 'free', session = null;
    try { const t = tabStorage.getItem(PLAN); if (t === 'full' || t === 'plus') tier = t; } catch (_) {}
    const defaults = () => ({ monthly: {}, ads: {}, scores: {}, pending: {}, mixMonthly: {}, mixResults: {} });
    const read = () => { const s = storage.getItem(KEY); if (s === null) return defaults(); const x = JSON.parse(s); if (!x || !['monthly','ads','scores','pending'].every(k => x[k] && typeof x[k]==='object' && !Array.isArray(x[k]))) throw Error('usage storage'); for (const k of ['mixMonthly','mixResults']) { if (!(k in x)) x[k]={}; if (!x[k] || typeof x[k]!=='object' || Array.isArray(x[k])) throw Error('usage storage'); } return x; };
    function edit(fn) { const d = read(), result = fn(d); if (result !== false) storage.setItem(KEY, JSON.stringify(d)); return result; }
    const change = fn => lock ? lock.request(KEY, () => edit(fn)) : Promise.resolve().then(() => edit(fn));
    const liveAds = d => Object.keys(d.ads).filter(id => d.ads[id].live === null);
    const karaAds = d => Object.keys(d.ads).filter(id => d.ads[id].kara === null);
    const mixAds = d => Object.keys(d.ads).filter(id => d.ads[id].mix === null);
    const mixBase = (d,p) => Math.max(0, 5 - (d.mixMonthly[p] || 0));
    const base = (d, p) => Math.max(0, 5 - (d.monthly[p] || 0));
    function state() {
      try {
        const d = read(), p = month(now()), a = session && d.pending[session];
        return { tier, live: base(d,p) + liveAds(d).length + (a && (a.kind==='ad' || a.period===p) ? 1 : 0), karaoke: karaAds(d).length, mix: mixBase(d,p) + mixAds(d).length, active: !!a, available: true };
      } catch (_) { return {tier,live:0,karaoke:0,mix:0,active:false,available:false}; }
    }
    function finishLive() {
      if (session) {
        const id = session; session = null;
        // The quota is already reserved durably. If close cannot run, the next page still sees the debit.
        const settle = d => { if (!d.pending[id]) return false; delete d.pending[id]; return true; };
        if (lock) change(settle).catch(() => {}); else { try { edit(settle); } catch (_) {} }
        try { if (tabStorage.getItem(PREV) === id) tabStorage.removeItem(PREV); } catch (_) {}
      }
    }
    try {
      const old = tabStorage.getItem(PREV);
      if (identity(old)) {
        // A reload or restored tab is a new session. No second debit is applied.
        change(d => { if (!d.pending[old]) return false; delete d.pending[old]; return true; }).catch(() => {});
        tabStorage.removeItem(PREV);
      }
    } catch (_) {}
    return {
      state, uuid, finishLive,
      tier(t) { if (!['free','full','plus'].includes(t) || t===tier) return; tier=t; try { tabStorage.setItem(PLAN,t); } catch (_) {} },
      canStart() { const s=state(); return s.tier!=='free' || s.active || s.live>0; },
      canKaraoke() { const s=state(); return s.tier==='full' || (s.tier==='free' && s.karaoke>0); },
      async startLive(stillWanted=()=>true) {
        if (!stillWanted()) return false;
        if (tier!=='free') return true;
        try { return await change(d => {
          if (!stillWanted()) return false;
          if (tier!=='free' || (session && d.pending[session])) return true;
          const period = month(now()), id = uuid();
          if (base(d,period)>0) { d.monthly[period]=(d.monthly[period]||0)+1; d.pending[id]={kind:'month',period}; }
          else { const ad=liveAds(d)[0]; if (!ad) return false; d.ads[ad].live=id; d.pending[id]={kind:'ad',period}; }
          // Keep the active identifier only when the durable write succeeded.
          return {id};
        }).then(r => { if (r && r.id) { session=r.id; try { tabStorage.setItem(PREV,session); } catch (_) {} if (!stillWanted()) { finishLive(); return false; } } return !!r; }); }
        catch (_) { return false; }
      },
      async earn(id) {
        if (!identity(id) || tier!=='free') return false;
        try { return !!(await change(d => { if (tier!=='free' || d.ads[id]) return false; d.ads[id]={live:null,kara:null,mix:null}; return true; })); } catch (_) { return false; }
      },
      hasMixResult(id) {
        if (!identity(id) || tier!=='free') return false;
        try { return Object.hasOwn(read().mixResults, id); } catch (_) { return false; }
      },
      async revealMix(id, isShowing=()=>true) {
        if (!identity(id) || !isShowing()) return false;
        if (tier==='full') return true;
        if (tier!=='free') return false;
        try { return !!(await change(d => {
          if (!isShowing() || tier==='plus') return false;
          if (tier==='full' || Object.hasOwn(d.mixResults,id)) return true;
          const p=month(now());
          if (mixBase(d,p)>0) d.mixMonthly[p]=(d.mixMonthly[p]||0)+1;
          else { const ad=mixAds(d)[0]; if (!ad) return false; d.ads[ad].mix=id; }
          d.mixResults[id]=p;
          return true;
        })); } catch (_) { return false; }
      },
      async revealScore(id, isShowing=()=>true) {
        if (!identity(id) || !isShowing()) return false;
        if (tier==='full') return true;
        if (tier!=='free') return false;
        try { return !!(await change(d => {
          if (!isShowing() || tier==='plus') return false;
          if (tier==='full' || d.scores[id]) return true;
          const ad=karaAds(d)[0]; if (!ad) return false;
          d.ads[ad].kara=id; d.scores[id]=ad; return true;
        })); } catch (_) { return false; }
      }
    };
  }
  root.PMUsagePreview = { make, KEY, month };
})(typeof window !== 'undefined' ? window : globalThis);
