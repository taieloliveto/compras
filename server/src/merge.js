/* Lógica de datos compartida entre la app y el servidor.
   FUENTE ÚNICA: shared/merge.js. Después de editarla corré `npm run sync-shared`
   (copia a web/merge.js y a server/src/merge.js). No edites esas copias a mano. */

const DAY = 86400000, TOMB_TTL = 30 * DAY;
const MAXL = 200, MAXI = 2000, MAXC = 500, MAXB = 500, MAXBI = 300;
const idOk = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(s);
const str = (s, n) => typeof s === 'string' ? s.slice(0, n) : '';
const num = x => Number.isFinite(+x) ? +x : 0;
const price = x => Math.min(1e9, Math.max(0, Math.round(num(x) * 100) / 100));
const ymdOk = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

/* Emoji de una lista: un solo carácter emoji (banderas, familias y teclas incluidas) o vacío. */
const EMO = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3/u;
const isEmoji = g => typeof g === 'string' && g.length > 0 && g.length <= 16 && EMO.test(g);
function firstEmoji(s) {
  s = typeof s === 'string' ? s.trim() : '';
  if (!s) return '';
  let g;
  try { const it = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)[Symbol.iterator]().next(); g = it.done ? '' : it.value.segment; }
  catch (_) { g = Array.from(s)[0] || ''; }
  return isEmoji(g) ? g : '';
}

function emptyState() { return { lists: {}, buys: {}, cat: {}, last: '', lastU: 0, name: '', nameU: 0 }; }

/* Limpia y acota cualquier dato que venga de afuera (disco, red, otro dispositivo). */
function sanitizeState(d, now) {
  now = now || Date.now();
  const out = emptyState();
  if (!d || typeof d !== 'object') return out;

  const L = d.lists && typeof d.lists === 'object' ? d.lists : {};
  for (const id of Object.keys(L).slice(0, MAXL)) {
    const l = L[id];
    if (!idOk(id) || !l || typeof l !== 'object') continue;
    const del = !!l.del, u = num(l.u);
    if (del && u < now - TOMB_TTL) continue;
    const nl = { id, n: str(l.n, 80) || 'Lista', e: firstEmoji(l.e), o: Math.min(1e6, Math.max(0, Math.round(num(l.o)))), c: num(l.c), u, del, items: {}, buy: null };
    if (!del && l.buy && typeof l.buy === 'object') nl.buy = { n: str(l.buy.n, 80).trim(), dt: ymdOk(l.buy.dt) ? l.buy.dt : '', g: price(l.buy.g) };
    if (!del && l.items && typeof l.items === 'object') {
      for (const iid of Object.keys(l.items).slice(0, MAXI)) {
        const it = l.items[iid];
        if (!idOk(iid) || !it || typeof it !== 'object') continue;
        const idel = !!it.del, iu = num(it.u);
        if (idel && iu < now - TOMB_TTL) continue;
        const n = str(it.n, 120).trim();
        if (!n) continue;
        nl.items[iid] = { id: iid, n, q: Math.min(99, Math.max(1, Math.round(num(it.q)) || 1)), d: !!it.d, p: it.d ? price(it.p) : 0, w: Math.min(1e7, Math.max(0, Math.round(num(it.w)))), c: num(it.c), u: iu, del: idel };
      }
    }
    out.lists[id] = nl;
  }

  /* Compras cerradas (historial): cada una guarda una copia de lo que se compró. */
  const B = d.buys && typeof d.buys === 'object' ? d.buys : {};
  const be = [];
  for (const id of Object.keys(B).slice(0, MAXB * 2)) {
    const b = B[id];
    if (!idOk(id) || !b || typeof b !== 'object') continue;
    const del = !!b.del, u = num(b.u);
    if (del && u < now - TOMB_TTL) continue;
    const its = [];
    if (!del && Array.isArray(b.its)) for (const x of b.its.slice(0, MAXBI)) {
      if (!x || typeof x !== 'object') continue;
      const n = str(x.n, 120).trim();
      if (n) its.push({ n, q: Math.min(99, Math.max(1, Math.round(num(x.q)) || 1)), p: price(x.p), w: Math.min(1e7, Math.max(0, Math.round(num(x.w)))) });
    }
    be.push({ id, lid: idOk(b.lid) ? b.lid : '', ln: str(b.ln, 80), le: firstEmoji(b.le), n: str(b.n, 80).trim() || 'Compra', dt: ymdOk(b.dt) ? b.dt : '', g: price(b.g), its, c: num(b.c), u, del });
  }
  be.sort((a, b) => (a.del - b.del) || b.u - a.u);
  for (const b of be.slice(0, MAXB)) out.buys[b.id] = b;

  const C = d.cat && typeof d.cat === 'object' ? d.cat : {};
  const ce = [];
  for (const k of Object.keys(C).slice(0, MAXC * 2)) {
    const e = C[k];
    if (!e || typeof e !== 'object') continue;
    const n = str(e.n, 120).trim();
    if (!n) continue;
    ce.push([norm(n), { n, c: Math.min(9999, Math.max(0, Math.round(num(e.c)))), u: num(e.u) }]);
  }
  ce.sort((a, b) => b[1].c - a[1].c || b[1].u - a[1].u);
  for (const [k, v] of ce.slice(0, MAXC)) out.cat[k] = v;

  out.last = idOk(d.last) ? d.last : '';
  out.lastU = num(d.lastU);
  out.name = str(typeof d.name === 'string' ? d.name.trim() : '', 30);
  out.nameU = num(d.nameU);
  return out;
}

/* Une dos estados. Gana el cambio más reciente (`u`) por lista y por producto. */
function mergeState(a, b, now) {
  a = sanitizeState(a, now);
  b = sanitizeState(b, now);
  const out = emptyState();

  const ids = new Set([...Object.keys(a.lists), ...Object.keys(b.lists)]);
  for (const id of ids) {
    const x = a.lists[id], y = b.lists[id];
    if (!x || !y) { out.lists[id] = x || y; continue; }
    const w = x.u >= y.u ? x : y;
    const items = {};
    for (const i of new Set([...Object.keys(x.items), ...Object.keys(y.items)])) {
      const p = x.items[i], q = y.items[i];
      items[i] = !p ? q : !q ? p : (p.u >= q.u ? p : q);
    }
    out.lists[id] = { ...w, items };
  }

  for (const k of new Set([...Object.keys(a.buys), ...Object.keys(b.buys)])) {
    const p = a.buys[k], q = b.buys[k];
    out.buys[k] = !p ? q : !q ? p : (p.u >= q.u ? p : q);
  }

  for (const k of new Set([...Object.keys(a.cat), ...Object.keys(b.cat)])) {
    const p = a.cat[k], q = b.cat[k];
    out.cat[k] = !p ? q : !q ? p : (p.u >= q.u ? p : q);
  }

  const w = a.lastU >= b.lastU ? a : b;
  out.last = w.last;
  out.lastU = w.lastU;
  const wn = a.nameU >= b.nameU ? a : b;
  out.name = wn.name;
  out.nameU = wn.nameU;
  return sanitizeState(out, now);
}

export { mergeState, sanitizeState, emptyState, norm };
