'use strict';
/* Compras — app de listas de compras (PWA). Usa merge.js (global: mergeState, sanitizeState, emptyState, norm). */
(() => {
const VERSION = '1.2.0';
const CFG = window.COMPRAS_CONFIG || {};
const KEY = 'compras.v1';
const $ = s => document.querySelector(s);
const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => Date.now();
let seq = 0;
const uid = () => Math.random().toString(36).slice(2, 8) + now().toString(36);
const stamp = () => now() + (++seq % 1000) / 1000;

/* ---------- Estado ---------- */
let S = { email: '', token: '', server: '', data: emptyState(), dirty: false };
try {
  const r = JSON.parse(localStorage.getItem(KEY) || 'null');
  if (r && typeof r === 'object') {
    S.email = String(r.email || ''); S.token = String(r.token || ''); S.server = String(r.server || '');
    S.dirty = !!r.dirty; S.data = sanitizeState(r.data);
  }
} catch (_) {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (_) {} };

let view = 'auth', cur = '', sheet = null, busy = false, st = 'ok', rev = 0;
let authMode = 'login', authErr = '', authEmail = S.email, authPass = '', authName = '';
let installEvt = null;
let addQty = 1;                       // cantidad elegida antes de agregar

const D = () => S.data;
const lists = () => Object.values(D().lists).filter(l => !l.del).sort((a, b) => a.c - b.c);
const itemsOf = l => Object.values(l.items).filter(i => !i.del);
const pendingOf = l => itemsOf(l).filter(i => !i.d).sort((a, b) => b.c - a.c);
const doneOf = l => itemsOf(l).filter(i => i.d).sort((a, b) => b.u - a.u);
const curList = () => { const l = D().lists[cur]; return l && !l.del ? l : null; };
/* Lista a la que se agrega desde Home: la última que usaste (o la primera si no hay registro). */
const destList = () => { const l = D().lists[D().last]; return (l && !l.del) ? l : (lists()[0] || null); };
/* Lista sobre la que operan las acciones de producto, según la pantalla. */
const activeList = () => (view === 'home' ? destList() : curList());

/* ---------- Servidor ---------- */
class ApiErr extends Error { constructor(m, status, net) { super(m); this.status = status; this.net = !!net; } }
const apiBase = () => String(CFG.API_URL || S.server || '').trim().replace(/\/+$/, '');
async function api(path, opts = {}) {
  const base = apiBase();
  if (!base) throw new ApiErr('Falta la URL del servidor', 0);
  const h = { 'Content-Type': 'application/json' };
  if (S.token) h.Authorization = 'Bearer ' + S.token;
  let r;
  try { r = await fetch(base + path, { ...opts, headers: h }); }
  catch (_) { throw new ApiErr('Sin conexión con el servidor', 0, true); }
  let b = null; try { b = await r.json(); } catch (_) {}
  if (!r.ok) throw new ApiErr((b && b.error) || 'Error del servidor', r.status);
  return b;
}

/* ---------- Sincronización ---------- */
let syncing = false, again = false, syncT = null;
function setSt(v) { st = v; paintSync(); }
function queueSync(ms = 900) {
  if (!S.token) return;
  setSt('pend');
  clearTimeout(syncT);
  syncT = setTimeout(() => sync(), ms);
}
async function sync() {
  if (!S.token || !apiBase()) return false;
  if (syncing) { again = true; return false; }
  syncing = true;
  const r0 = rev, wasDirty = S.dirty;
  try {
    const res = wasDirty
      ? await api('/data', { method: 'PUT', body: JSON.stringify({ data: S.data }) })
      : await api('/data');
    S.data = mergeState(S.data, res.data);
    if (rev === r0) S.dirty = false; else again = true;
    save();
    setSt(S.dirty ? 'pend' : 'ok');
    afterRemote();
    return true;
  } catch (e) {
    if (e.status === 401) { expireSession(); return false; }
    setSt(e.net ? 'off' : 'err');
    return false;
  } finally {
    syncing = false;
    if (again) { again = false; queueSync(300); }
  }
}
function expireSession() {
  S.token = ''; save();
  authErr = 'Tu sesión venció. Ingresá de nuevo.'; authEmail = S.email; authPass = '';
  go('auth');
}
/* Después de recibir datos de afuera: repintar sin pisar lo que el usuario está haciendo. */
function afterRemote() {
  if (view === 'list') { if (!curList()) { go('lists'); return; } paintList(); }
  else if (view === 'home' && !sheet) paintHome();
  else if (view === 'lists' && !sheet) paintCards();
  paintNav();
}

/* ---------- Mutaciones ---------- */
function touch() { S.dirty = true; rev++; save(); queueSync(); }
function setLast(id) {
  if (D().last === id) return;
  D().last = id; D().lastU = now(); touch();
}
function parseEntry(s) {
  s = s.trim().replace(/\s+/g, ' ');
  if (!s) return null;
  let q = 1, n = s, m, x = false;            // x: la persona escribió la cantidad
  const unit = /^(kg|kgs|kilo|kilos|g|gr|grs|l|lt|lts|litro|litros|ml|cc|cm|mm)\b/i;
  if ((m = s.match(/^(\d{1,2})\s*(?:x|×)?\s+(.+)$/i)) && !unit.test(m[2])) { q = +m[1]; n = m[2]; x = true; }
  else if ((m = s.match(/^(.+?)\s+[x×]\s*(\d{1,2})$/i) || s.match(/^(.+?)\s*×\s*(\d{1,2})$/))) { n = m[1]; q = +m[2]; x = true; }
  n = n.trim();
  if (!n) return null;
  n = n[0].toUpperCase() + n.slice(1);
  return { n: n.slice(0, 120), q: Math.min(99, Math.max(1, q)), x };
}
function addItem(l, e) {
  const k = norm(e.n), t = now();
  const ex = itemsOf(l).find(i => norm(i.n) === k);
  let name = e.n;
  if (ex) {
    if (ex.d) { ex.d = false; ex.q = e.q; } else ex.q = Math.min(99, ex.q + e.q);
    ex.u = t; name = ex.n;
  } else {
    const id = uid();
    l.items[id] = { id, n: e.n, q: e.q, d: false, c: stamp(), u: t, del: false };
  }
  const c = D().cat[k] || { n: name, c: 0, u: 0 };
  c.n = name; c.c = Math.min(9999, c.c + 1); c.u = t;
  D().cat[k] = c;
}
/* Agrega uno o varios productos (separados por coma, punto y coma o salto de línea).
   Los que no traen cantidad escrita usan la cantidad elegida con el selector. */
function addText(text) {
  const entries = String(text).split(/[\n,;]+/).map(parseEntry).filter(Boolean);
  if (!entries.length) return 0;
  let l = activeList();
  if (!l) {
    if (view !== 'home') return 0;
    l = D().lists[newList('Mi lista')];       // primera vez: se crea una lista sola
  }
  let n = 0;
  for (const e of entries) {
    if (Object.keys(l.items).length >= 1900) { toast('La lista llegó al máximo de productos'); break; }
    if (!e.x) e.q = addQty;
    addItem(l, e); n++;
  }
  if (n) {
    addQty = 1;
    if (D().last !== l.id) { D().last = l.id; D().lastU = now(); }
    touch();
    if (view === 'home') {
      const lid = l.id;
      toast(n === 1 ? `“${entries[0].n}” agregado a ${l.n}` : `${n} productos agregados a ${l.n}`, 'Ver lista', () => openList(lid));
    }
  }
  return n;
}
function toggle(id) {
  const it = activeList()?.items[id];
  if (!it) return;
  it.d = !it.d; it.u = now(); touch(); repaint();
}
function delItem(id) {
  const l = activeList(), it = l?.items[id];
  if (!it) return;
  const lid = l.id;
  it.del = true; it.u = now(); touch(); repaint();
  toast('Producto eliminado', 'Deshacer', () => {
    const x = D().lists[lid]?.items[id];
    if (x) { x.del = false; x.u = now(); touch(); repaint(); }
  });
}
function clearDone() {
  const l = curList(); if (!l) return;
  const lid = cur, ids = doneOf(l).map(i => i.id);
  if (!ids.length) return;
  const t = now();
  ids.forEach(i => { l.items[i].del = true; l.items[i].u = t; });
  touch(); paintList();
  toast(ids.length === 1 ? '1 producto quitado del carrito' : `${ids.length} productos quitados del carrito`, 'Deshacer', () => {
    const L = D().lists[lid]; if (!L) return;
    const t2 = now();
    ids.forEach(i => { if (L.items[i]) { L.items[i].del = false; L.items[i].u = t2; } });
    touch(); repaint();
  });
}
function uncheckAll() {
  const l = curList(); if (!l) return;
  const t = now();
  doneOf(l).forEach(i => { i.d = false; i.u = t; });
  touch(); paintList();
}
function newList(name) {
  const t = now(), id = uid();
  const n = (name || '').trim().slice(0, 80) || `Lista ${lists().length + 1}`;
  D().lists[id] = { id, n, c: stamp(), u: t, del: false, items: {} };
  touch();
  return id;
}
function renameList(name) {
  const l = curList(); if (!l) return;
  const n = (name || '').trim().slice(0, 80);
  if (!n) return;
  l.n = n; l.u = now(); touch();
}
function duplicateList() {
  const l = curList(); if (!l) return;
  const id = uid(), t = now();
  const copy = { id, n: (l.n + ' (copia)').slice(0, 80), c: stamp(), u: t, del: false, items: {} };
  for (const i of itemsOf(l)) { const iid = uid(); copy.items[iid] = { id: iid, n: i.n, q: i.q, d: false, c: stamp(), u: t, del: false }; }
  D().lists[id] = copy; touch();
  return id;
}
function deleteList() {
  const l = curList(); if (!l) return;
  l.del = true; l.u = now(); l.items = {};
  if (D().last === l.id) { D().last = ''; D().lastU = now(); }
  touch();
}

/* ---------- Sugerencias (carga rápida) ---------- */
const DEF = ['Leche', 'Pan', 'Huevos', 'Arroz', 'Fideos', 'Aceite', 'Azúcar', 'Sal', 'Yerba', 'Café', 'Manzanas', 'Bananas', 'Tomates', 'Papas', 'Cebollas', 'Pollo', 'Carne picada', 'Queso', 'Jabón', 'Papel higiénico'];
function catalog() {
  const c = Object.values(D().cat).sort((a, b) => b.c - a.c || b.u - a.u);
  const have = new Set(c.map(x => norm(x.n)));
  const out = c.map(x => x.n);
  if (out.length < 12) for (const d of DEF) if (!have.has(norm(d))) out.push(d);
  return out;
}
function suggestions(q) {
  const l = activeList();
  const inList = new Set(l ? pendingOf(l).map(i => norm(i.n)) : []);
  const nq = norm(q.replace(/^\d{1,2}\s*(?:x|×)?\s+/i, ''));
  let c = catalog().filter(n => !inList.has(norm(n)));
  if (nq) {
    c = c.filter(n => norm(n).includes(nq));
    c.sort((a, b) => (norm(b).startsWith(nq) ? 1 : 0) - (norm(a).startsWith(nq) ? 1 : 0));
    if (c.length === 1 && norm(c[0]) === nq) return [];
  }
  return c.slice(0, nq ? 6 : 10);
}

/* ---------- Vistas ---------- */
const LOGO = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 7h14M5 12h8M5 17h6"/><path d="m15 16 2 2 4-4"/></svg>';
const SYL = { ok: 'Sincronizado', pend: 'Guardando…', off: 'Sin conexión', err: 'Error al sincronizar' };
const syncBadge = () => `<span class="sy ${st}" role="status">${SYL[st]}</span>`;
function paintSync() { document.querySelectorAll('.sy').forEach(e => { e.className = 'sy ' + st; e.textContent = SYL[st]; }); }
const stepHtml = (label = true) => `<div class="qs" role="group" aria-label="Cantidad a agregar">${label ? '<span>Cantidad</span>' : ''}<button type="button" data-a="aqm" aria-label="Menos">−</button><b id="aq">${addQty}</b><button type="button" data-a="aqp" aria-label="Más">+</button></div>`;
function syncStep() { const e = $('#aq'); if (e) e.textContent = addQty; }

function vAuth() {
  const login = authMode === 'login';
  return `<div class="auth"><div class="logo">${LOGO}</div><h1>Compras</h1>
<p class="mut">Tus listas de compras, siempre con vos y en todos tus dispositivos.</p>
<div class="seg" role="group" aria-label="Modo"><button type="button" data-a="am" data-m="login" aria-pressed="${login}">Ingresar</button><button type="button" data-a="am" data-m="signup" aria-pressed="${!login}">Crear cuenta</button></div>
<form id="af" novalidate>
${login ? '' : `<label class="f">¿Cómo te gustaría que te llamen?<input type="text" data-au="name" value="${esc(authName)}" maxlength="30" placeholder="Tu nombre o apodo" autocomplete="given-name" autocapitalize="words"></label>`}
<label class="f">Email<input type="email" data-au="email" value="${esc(authEmail)}" autocomplete="email" inputmode="email" autocapitalize="none" spellcheck="false"></label>
<label class="f">Contraseña<input type="password" data-au="pass" value="${esc(authPass)}" autocomplete="${login ? 'current-password' : 'new-password'}" ${login ? '' : 'placeholder="Mínimo 8 caracteres"'}></label>
${CFG.API_URL ? '' : `<label class="f">URL del servidor<input type="url" data-au="server" value="${esc(S.server)}" placeholder="https://compras-server.tu-usuario.workers.dev" autocapitalize="none" spellcheck="false"></label>`}
<p class="err" role="alert">${esc(authErr)}</p>
<button class="btn" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Un momento…' : login ? 'Ingresar' : 'Crear cuenta'}</button>
</form></div>`;
}

/* Home: lo primero que ves. Un campo para sumar productos a la última lista usada. */
function vHome() {
  return `<div class="bar"><span></span>${syncBadge()}</div>
<section class="homec">
<h1 id="hi"></h1>
<p class="ask">¿Qué vas a agregar hoy?</p>
<form id="qa" class="qa home" autocomplete="off">
<input id="qi" class="in" type="text" placeholder="Ej: leche, 2 pan, queso x3" enterkeyhint="done" autocomplete="off" autocapitalize="sentences" aria-label="Producto">
<div class="qrow">${stepHtml(false)}<button id="dest" type="button" class="dest" data-a="pick" aria-haspopup="dialog" aria-label="Lista donde agregar"></button></div>
<button class="btn" type="submit">Agregar</button>
</form>
<div id="sug"></div>
</section>`;
}
function paintHome() {
  const el = $('#dest'); if (!el) return;
  const l = destList();
  $('#hi').textContent = D().name ? `Hola ${D().name} 👋` : 'Hola 👋';
  el.innerHTML = l ? `<b>${esc(l.n)}</b><span aria-hidden="true">▾</span>` : '<span class="mut">Lista nueva</span><span aria-hidden="true">▾</span>';
  paintSug();
}

function listStats(l) {
  const all = itemsOf(l), d = all.filter(i => i.d).length;
  return { total: all.length, done: d, left: all.length - d };
}
function cardHtml(l) {
  const s = listStats(l);
  const sub = !s.total ? 'Vacía' : s.left === 0 ? 'Todo comprado ✓' : `${s.left} por comprar · ${s.total} en total`;
  return `<button class="card" data-a="open" data-id="${esc(l.id)}"><b>${esc(l.n)}${D().last === l.id ? '<span class="tag">Última</span>' : ''}</b><small>${sub}</small>${s.total ? `<div class="pbar" aria-hidden="true"><i style="width:${Math.round(s.done / s.total * 100)}%"></i></div>` : ''}</button>`;
}
function cardsHtml() {
  const L = lists();
  if (!L.length) return `<div class="empty"><div class="big" aria-hidden="true">🛒</div><h2>Todavía no tenés listas</h2><p class="mut">Creá la primera y empezá a cargar productos.</p></div>`;
  return L.map(cardHtml).join('');
}
function vLists() {
  return `<div class="bar"><h1>Mis listas</h1>${syncBadge()}</div><div id="cards">${cardsHtml()}</div><button class="btn newbtn" data-a="newlist">+ Nueva lista</button>`;
}
function paintCards() { const el = $('#cards'); if (el) el.innerHTML = cardsHtml(); }

function vList() {
  return `<div class="top"><button class="icon" data-a="lists" aria-label="Volver a mis listas">‹</button><button class="ttl" data-a="switch" aria-haspopup="dialog"><b id="lt"></b><small id="ls"></small></button>${syncBadge()}<button class="icon" data-a="lmenu" aria-label="Opciones de la lista">⋯</button></div>
<form id="qa" class="qa" autocomplete="off"><div class="qr"><input id="qi" class="in" type="text" placeholder="Agregar producto… (ej: 2 leche)" enterkeyhint="done" autocomplete="off" autocapitalize="sentences" aria-label="Agregar producto"><button class="btn" type="submit" aria-label="Agregar">+</button></div>${stepHtml()}</form>
<div id="sug"></div><div id="items"></div>`;
}
function rowHtml(i) {
  return `<div class="it${i.d ? ' done' : ''}"><button class="main" data-a="tg" data-id="${esc(i.id)}" aria-pressed="${i.d}"><span class="box" aria-hidden="true"></span><span class="nm">${esc(i.n)}</span>${i.q > 1 ? `<span class="qty">×${i.q}</span>` : ''}</button><button class="more" data-a="ed" data-id="${esc(i.id)}" aria-label="Editar ${esc(i.n)}">⋯</button></div>`;
}
function paintList() {
  const l = curList(); if (!l) return;
  const p = pendingOf(l), d = doneOf(l);
  $('#lt').textContent = l.n;
  $('#ls').textContent = !p.length && !d.length ? 'Lista vacía' : p.length ? `${p.length} por comprar` : 'Todo comprado';
  let h = '';
  if (!p.length && !d.length) h = `<div class="empty"><div class="big" aria-hidden="true">📝</div><p class="mut">Escribí arriba lo que necesitás.<br>Podés poner varios separados por coma: <i>leche, pan, 2 huevos</i></p></div>`;
  else if (!p.length) h = `<div class="alldone">🎉 ¡Todo comprado!</div>`;
  h += p.map(rowHtml).join('');
  if (d.length) h += `<div class="sec"><h3>En el carrito · ${d.length}</h3><span><button class="mini" data-a="unall">Desmarcar</button><button class="mini" data-a="cleardone">Vaciar</button></span></div>` + d.map(rowHtml).join('');
  $('#items').innerHTML = h;
  paintSug(); paintNav();
}
function paintSug() {
  const el = $('#sug'), qi = $('#qi'); if (!el) return;
  const q = qi ? qi.value : '';
  const s = suggestions(q);
  el.innerHTML = s.length ? (q.trim() ? '' : '<p class="lab">Frecuentes</p>') + '<div class="chips">' + s.map(n => `<button type="button" class="chip" data-a="sg" data-n="${esc(n)}">+ ${esc(n)}</button>`).join('') + '</div>' : '';
}
function repaint() { if (view === 'home') paintHome(); else if (view === 'list') paintList(); paintNav(); }

function vSet() {
  const n = lists().length;
  return `<div class="bar"><h1>Ajustes</h1>${syncBadge()}</div>
<h3>Cuenta</h3>
<div class="set-row"><span class="mut">Sesión</span><span>${esc(S.email)}</span></div>
<div class="set-row"><span class="mut">Cómo te llamamos</span><span>${esc(D().name || '—')}</span></div>
<div class="set-row"><span class="mut">Listas</span><span>${n}</span></div>
<button class="sb" data-a="editname">Cambiar mi nombre</button>
<button class="sb" data-a="syncnow">Sincronizar ahora</button>
${installEvt ? '<button class="sb" data-a="install">Instalar la app</button>' : '<p class="mut small">Para instalarla: en Android, menú del navegador → <i>Instalar app</i>. En iPhone, Safari → Compartir → <i>Agregar a inicio</i>.</p>'}
<h3>Datos</h3>
<button class="sb" data-a="export">Exportar mis listas (JSON)</button>
<h3>Sesión</h3>
<button class="sb" data-a="logout">Cerrar sesión</button>
<button class="sb dng" data-a="delacc">Eliminar mi cuenta y mis datos</button>
<p class="mut small" style="margin-top:22px">Compras ${VERSION}. Tus listas se guardan en este dispositivo y en la nube; funcionan sin conexión y se sincronizan cuando vuelve.</p>`;
}

/* Barra flotante: pestañas + acceso rápido a la última lista. */
function paintNav() {
  document.querySelectorAll('#nv .nb[data-t]').forEach(b => (b.dataset.t === view ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  const b = $('#nl'); if (!b) return;
  const l = destList();
  b.hidden = !l;
  if (l) {
    $('#nl-n').textContent = l.n;
    b.setAttribute('aria-label', `Abrir la lista ${l.n}`);
    if (view === 'list') b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
}

/* ---------- Ventanas flotantes ---------- */
function sheetHtml() {
  const s = sheet; if (!s) return '';
  if (s.t === 'ask') return `<div class="sh" role="dialog" aria-modal="true" aria-label="${esc(s.msg)}"><h2>${esc(s.msg)}</h2>${s.sub ? `<p class="mut">${esc(s.sub)}</p>` : ''}<button class="btn" data-a="yes">${esc(s.yes || 'Sí, eliminar')}</button><button class="btn ghost" data-a="close">Cancelar</button></div>`;
  if (s.t === 'newlist') return `<form id="sf" class="sh" role="dialog" aria-modal="true" aria-label="Nueva lista"><h2>Nueva lista</h2><input id="sn" class="in" type="text" maxlength="80" placeholder="Nombre (ej: Súper, Verdulería)" autocomplete="off" aria-label="Nombre de la lista"><button class="btn" type="submit" style="margin-top:14px">Crear lista</button><button class="btn ghost" type="button" data-a="close">Cancelar</button></form>`;
  if (s.t === 'rename') return `<form id="sf" class="sh" role="dialog" aria-modal="true" aria-label="Renombrar lista"><h2>Renombrar lista</h2><input id="sn" class="in" type="text" maxlength="80" value="${esc(curList()?.n || '')}" autocomplete="off" aria-label="Nombre de la lista"><button class="btn" type="submit" style="margin-top:14px">Guardar</button><button class="btn ghost" type="button" data-a="close">Cancelar</button></form>`;
  if (s.t === 'item') { const i = activeList()?.items[s.id]; if (!i) return '';
    return `<form id="sf" class="sh" role="dialog" aria-modal="true" aria-label="Editar producto"><h2>Editar producto</h2><input id="sn" class="in" type="text" maxlength="120" value="${esc(i.n)}" autocomplete="off" aria-label="Nombre del producto"><div class="step"><span>Cantidad</span><span style="display:flex;align-items:center;gap:12px"><button type="button" data-a="qm" aria-label="Menos">−</button><b id="sq">${i.q}</b><button type="button" data-a="qp" aria-label="Más">+</button></span></div><button class="btn" type="submit" style="margin-top:18px">Guardar</button><button class="btn danger" type="button" data-a="delitem" data-id="${esc(i.id)}">Eliminar producto</button><button class="btn ghost" type="button" data-a="close">Cancelar</button></form>`; }
  if (s.t === 'name') return `<form id="sf" class="sh" role="dialog" aria-modal="true" aria-label="Tu nombre"><h2>¿Cómo te llamamos?</h2><input id="sn" class="in" type="text" maxlength="30" value="${esc(D().name || '')}" placeholder="Tu nombre o apodo" autocomplete="off" autocapitalize="words" aria-label="Tu nombre"><button class="btn" type="submit" style="margin-top:14px">Guardar</button><button class="btn ghost" type="button" data-a="close">Cancelar</button></form>`;
  if (s.t === 'pick') { const L = lists(), d = destList();
    return `<div class="sh" role="dialog" aria-modal="true" aria-label="Agregar a otra lista"><h2>Agregar a…</h2>${L.map(l => `<button class="rowb" data-a="setdest" data-id="${esc(l.id)}"><span>${esc(l.n)}</span>${d && l.id === d.id ? '<span class="ck" aria-label="Lista elegida">✓</span>' : ''}</button>`).join('')}<button class="rowb" data-a="newlist" style="color:var(--acc);font-weight:700">+ Nueva lista</button></div>`; }
  if (s.t === 'switch') { const L = lists();
    return `<div class="sh" role="dialog" aria-modal="true" aria-label="Cambiar de lista"><h2>Mis listas</h2>${L.map(l => `<button class="rowb" data-a="open" data-id="${esc(l.id)}"><span>${esc(l.n)}</span>${l.id === cur ? '<span class="ck" aria-label="Lista actual">✓</span>' : ''}</button>`).join('')}<button class="rowb" data-a="newlist" style="color:var(--acc);font-weight:700">+ Nueva lista</button></div>`; }
  if (s.t === 'lmenu') return `<div class="sh" role="dialog" aria-modal="true" aria-label="Opciones de la lista"><h2>${esc(curList()?.n || 'Lista')}</h2><button class="rowb" data-a="rename">Renombrar</button><button class="rowb" data-a="dup">Duplicar (sin marcar)</button><button class="rowb" data-a="unall2">Desmarcar todo</button><button class="rowb" data-a="cleardone2">Vaciar comprados</button><button class="rowb dng" data-a="dellist">Eliminar lista</button></div>`;
  return '';
}
function renderSheet() {
  const root = $('#ov-root');
  root.innerHTML = '';
  if (!sheet) return;
  const o = document.createElement('div');
  o.className = 'ov'; o.innerHTML = sheetHtml();
  const d = o.firstElementChild;
  if (!d) { sheet = null; return; }
  o.addEventListener('click', e => { if (e.target === o) closeSheet(); });
  root.append(o);
  /* El teclado solo se abre solo al crear una lista (ahí lo único que hay que hacer es escribir).
     En el resto, el foco va a la ventana y el teclado aparece cuando tocás un campo. */
  const f = d.querySelector('#sn');
  if (f && sheet.t === 'newlist') f.focus();
  else { d.tabIndex = -1; d.focus({ preventScroll: true }); }
}
function openSheet(s) { sheet = s; renderSheet(); }
function closeSheet() { sheet = null; renderSheet(); }

function toast(msg, label, fn) {
  const root = $('#t-root'); root.innerHTML = '';
  const d = document.createElement('div'); d.id = 't'; d.setAttribute('role', 'status');
  d.append(document.createTextNode(msg));
  if (label && fn) { const b = document.createElement('button'); b.textContent = label; b.onclick = () => { root.innerHTML = ''; fn(); }; d.append(b); }
  root.append(d);
  clearTimeout(toast.t); toast.t = setTimeout(() => { root.innerHTML = ''; }, label ? 6000 : 3200);
}

/* ---------- Render ---------- */
function go(v) { view = v; sheet = null; render(); window.scrollTo(0, 0); }
function render() {
  const v = $('#v');
  v.innerHTML = view === 'auth' ? vAuth() : view === 'home' ? vHome() : view === 'lists' ? vLists() : view === 'list' ? vList() : vSet();
  const showNav = view !== 'auth';
  $('#nv').hidden = !showNav;
  document.body.classList.toggle('nonav', !showNav);
  if (view === 'list') paintList();
  if (view === 'home') paintHome();
  paintNav();
  renderSheet();
  paintSync();
}
function openList(id) {
  if (!D().lists[id] || D().lists[id].del) return;
  cur = id; setLast(id); go('list');
}

/* ---------- Acciones ---------- */
function ask(msg, sub, yes, fn) { sheet = { t: 'ask', msg, sub, yes, fn }; renderSheet(); }
function wipeLocal(keepEmail) {
  S = { email: keepEmail ? S.email : '', token: '', server: S.server, data: emptyState(), dirty: false };
  cur = ''; addQty = 1; save();
}
async function doAuth() {
  if (busy) return;
  const em = authEmail.trim().toLowerCase(), pw = authPass;
  if (!CFG.API_URL) {
    const sv = $('[data-au=server]'), url = sv ? sv.value.trim() : S.server;
    if (!/^https?:\/\/\S+$/i.test(url)) { authErr = 'Pegá la URL del servidor (empieza con https://)'; render(); return; }
    S.server = url; save();
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { authErr = 'Ingresá un email válido'; render(); return; }
  if (authMode === 'signup' && pw.length < 8) { authErr = 'La contraseña debe tener al menos 8 caracteres'; render(); return; }
  if (!pw) { authErr = 'Ingresá tu contraseña'; render(); return; }
  busy = true; authErr = ''; render();
  try {
    const r = await api('/' + authMode, { method: 'POST', body: JSON.stringify({ email: em, password: pw }) });
    if (S.email && S.email !== em) { S.data = emptyState(); S.dirty = false; }
    S.email = em; S.token = r.token; authPass = ''; save();
    if (authMode === 'signup') {
      S.dirty = true;
      const nm = authName.trim().slice(0, 30);
      if (nm) { D().name = nm; D().nameU = now(); }
      save();
    }
    await sync();
    busy = false; go('home');
    return;
  } catch (e) { authErr = e.message; }
  busy = false; render();
}
async function logout() {
  if (S.dirty) { toast('Sincronizando antes de salir…'); await sync(); }
  if (S.dirty) { closeSheet(); toast('Hay cambios sin subir. Conectate e intentá de nuevo.'); return; }
  wipeLocal(true); authEmail = S.email; authPass = ''; authName = ''; authErr = ''; go('auth');
}
async function deleteAccount() {
  try { await api('/account', { method: 'DELETE' }); }
  catch (e) { closeSheet(); toast(e.net ? 'Sin conexión: no se pudo eliminar la cuenta' : e.message); return; }
  wipeLocal(false); authEmail = ''; authPass = ''; authErr = ''; authMode = 'signup'; go('auth');
  toast('Cuenta eliminada');
}
function exportData() {
  const out = { exportado: new Date().toISOString(), listas: lists().map(l => ({ nombre: l.n, productos: itemsOf(l).map(i => ({ nombre: i.n, cantidad: i.q, comprado: i.d })) })) };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
  a.download = `compras-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function openDest() { const l = destList(); if (l) openList(l.id); else go('lists'); }

const A = {
  tab(b) { go(b.dataset.t); },
  am(b) { authMode = b.dataset.m; authErr = ''; render(); },
  lists() { go('lists'); },
  open(b) { openList(b.dataset.id); },
  lastlist() { openDest(); },
  pick() { openSheet(lists().length ? { t: 'pick' } : { t: 'newlist' }); },
  setdest(b) { setLast(b.dataset.id); closeSheet(); repaint(); },
  aqm() { addQty = Math.max(1, addQty - 1); syncStep(); },
  aqp() { addQty = Math.min(99, addQty + 1); syncStep(); },
  newlist() { openSheet({ t: 'newlist' }); },
  editname() { openSheet({ t: 'name' }); },
  switch() { openSheet({ t: 'switch' }); },
  lmenu() { openSheet({ t: 'lmenu' }); },
  rename() { openSheet({ t: 'rename' }); },
  dup() { const id = duplicateList(); closeSheet(); if (id) { openList(id); toast('Lista duplicada'); } },
  unall2() { closeSheet(); uncheckAll(); },
  cleardone2() { closeSheet(); clearDone(); },
  dellist() { const l = curList(); if (!l) return; ask(`¿Eliminar “${l.n}”?`, 'Se borra la lista con todos sus productos.', 'Sí, eliminar', () => { deleteList(); go('lists'); }); },
  tg(b) { toggle(b.dataset.id); },
  ed(b) { openSheet({ t: 'item', id: b.dataset.id }); },
  qm() { const e = $('#sq'); e.textContent = Math.max(1, +e.textContent - 1); },
  qp() { const e = $('#sq'); e.textContent = Math.min(99, +e.textContent + 1); },
  delitem(b) { closeSheet(); delItem(b.dataset.id); },
  unall() { uncheckAll(); },
  cleardone() { clearDone(); },
  sg(b) {
    const qi = $('#qi'); const q = (qi.value.match(/^(\d{1,2})\s*(?:x|×)?\s+/i) || [])[1];
    addText((q ? q + ' ' : '') + b.dataset.n); qi.value = ''; repaint(); syncStep(); qi.focus();
  },
  close() { closeSheet(); },
  yes() { const f = sheet && sheet.fn; closeSheet(); if (f) f(); },
  syncnow() { toast('Sincronizando…'); sync().then(ok => { if (ok) toast('Todo sincronizado'); else if (S.token) toast(st === 'off' ? 'Sin conexión' : 'No se pudo sincronizar'); }); },
  export() { exportData(); },
  logout() { ask('¿Cerrar sesión?', 'Tus listas quedan guardadas en la nube. Se borran de este dispositivo.', 'Cerrar sesión', logout); },
  delacc() { ask('¿Eliminar tu cuenta?', 'Se borran tus listas y tu cuenta para siempre. No se puede deshacer.', 'Sí, eliminar todo', deleteAccount); },
  install() { if (!installEvt) return; installEvt.prompt(); installEvt = null; render(); }
};

document.addEventListener('click', e => {
  const b = e.target.closest('[data-a]');
  if (b && A[b.dataset.a]) A[b.dataset.a](b);
});
/* Los chips y el selector de cantidad no le sacan el foco al campo: el teclado queda abierto para cargar rápido. */
document.addEventListener('mousedown', e => { if (e.target.closest('.chip, .qs button')) e.preventDefault(); });
document.addEventListener('submit', e => {
  e.preventDefault();
  const id = e.target.id;
  if (id === 'af') doAuth();
  else if (id === 'qa') {
    const qi = $('#qi'); addText(qi.value); qi.value = ''; repaint(); syncStep(); qi.focus();
  } else if (id === 'sf' && sheet) {
    const val = ($('#sn') || {}).value || '';
    if (sheet.t === 'newlist') {
      const nid = newList(val); closeSheet();
      if (view === 'home') { setLast(nid); repaint(); } else openList(nid);
    } else if (sheet.t === 'rename') { renameList(val); closeSheet(); paintList(); }
    else if (sheet.t === 'name') { D().name = val.trim().slice(0, 30); D().nameU = now(); touch(); closeSheet(); render(); }
    else if (sheet.t === 'item') {
      const i = activeList()?.items[sheet.id];
      const n = val.trim().slice(0, 120);
      if (i && n) { i.n = n; i.q = Math.min(99, Math.max(1, +$('#sq').textContent || 1)); i.u = now(); touch(); }
      closeSheet(); repaint();
    }
  }
});
document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'qi') paintSug();
  const au = t.dataset && t.dataset.au;
  if (au === 'name') authName = t.value;
  else if (au === 'email') authEmail = t.value;
  else if (au === 'pass') authPass = t.value;
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && sheet) closeSheet(); });

/* ---------- Ciclo de vida ---------- */
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.token) sync(); });
window.addEventListener('online', () => { if (S.token) sync(); });
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; if (view === 'set') render(); });
setInterval(() => { if (document.visibilityState === 'visible' && S.token && !sheet) sync(); }, 60000);

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}

/* Arranque: con sesión abre Home (campo para agregar); la última lista queda a un toque en la barra. */
if (S.token) {
  view = 'home';
  if (!navigator.onLine) st = 'off';
  render();
  sync();
} else {
  render();
}
})();
