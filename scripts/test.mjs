// Pruebas de la lógica de datos y del servidor (KV simulado). Uso: node scripts/test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeState, sanitizeState, emptyState } from '../server/src/merge.js';
import worker from '../server/src/index.js';

let n = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { n++; console.log('  ✓', name); }, e => { console.log('  ✗', name); throw e; });

// web/merge.js y server/src/merge.js salen de shared/merge.js
await ok('las copias de merge.js están sincronizadas', () => {
  const shared = readFileSync(new URL('../shared/merge.js', import.meta.url), 'utf8');
  assert.equal(readFileSync(new URL('../web/merge.js', import.meta.url), 'utf8'), shared);
  assert.ok(readFileSync(new URL('../server/src/merge.js', import.meta.url), 'utf8').startsWith(shared));
});

const L = (id, n, items = {}, u = 1, extra = {}) => ({ id, n, c: 1, u, del: false, items, ...extra });
const I = (id, n, u, extra = {}) => ({ id, n, q: 1, d: false, c: 1, u, del: false, ...extra });
const T = Date.now();

console.log('merge');
await ok('une listas y productos de dos dispositivos', () => {
  const a = { lists: { l1: L('l1', 'Súper', { i1: I('i1', 'Leche', T) }) } };
  const b = { lists: { l1: L('l1', 'Súper', { i2: I('i2', 'Pan', T) }), l2: L('l2', 'Feria') } };
  const m = mergeState(a, b);
  assert.deepEqual(Object.keys(m.lists).sort(), ['l1', 'l2']);
  assert.deepEqual(Object.keys(m.lists.l1.items).sort(), ['i1', 'i2']);
});
await ok('gana el cambio más reciente de un producto', () => {
  const a = { lists: { l1: L('l1', 'S', { i1: I('i1', 'Leche', T, { d: true }) }) } };
  const b = { lists: { l1: L('l1', 'S', { i1: I('i1', 'Leche', T + 5, { d: false }) }) } };
  assert.equal(mergeState(a, b).lists.l1.items.i1.d, false);
  assert.equal(mergeState(b, a).lists.l1.items.i1.d, false);
});
await ok('un producto borrado no resucita', () => {
  const a = { lists: { l1: L('l1', 'S', { i1: I('i1', 'Leche', T + 9, { del: true }) }) } };
  const b = { lists: { l1: L('l1', 'S', { i1: I('i1', 'Leche', T) }) } };
  assert.equal(mergeState(a, b).lists.l1.items.i1.del, true);
});
await ok('una lista borrada pierde sus productos', () => {
  const a = { lists: { l1: L('l1', 'S', {}, T + 9, { del: true }) } };
  const b = { lists: { l1: L('l1', 'S', { i1: I('i1', 'Leche', T) }, T) } };
  const m = mergeState(a, b);
  assert.equal(m.lists.l1.del, true);
  assert.deepEqual(m.lists.l1.items, {});
});
await ok('las marcas de borrado viejas (>30 días) se limpian', () => {
  const old = T - 31 * 86400000;
  const m = sanitizeState({ lists: { l1: L('l1', 'S', { i1: I('i1', 'x', old, { del: true }) }), l2: L('l2', 'Z', {}, old, { del: true }) } });
  assert.ok(!m.lists.l2);
  assert.ok(!m.lists.l1.items.i1);
});
await ok('la última lista usada se resuelve por fecha', () => {
  const m = mergeState({ last: 'a', lastU: 1 }, { last: 'b', lastU: 2 });
  assert.equal(m.last, 'b');
});
await ok('el nombre se resuelve por fecha y se recorta', () => {
  const m = mergeState({ name: 'Ana', nameU: 1 }, { name: 'Tai', nameU: 2 });
  assert.equal(m.name, 'Tai');
  assert.equal(mergeState({ name: 'Tai', nameU: 2 }, { name: 'Ana', nameU: 1 }).name, 'Tai');
  assert.equal(mergeState({ name: '' , nameU: 0 }, { name: 'Tai', nameU: 5 }).name, 'Tai');
  assert.equal(sanitizeState({ name: '  ' + 'x'.repeat(80) }).name.length, 30);
});
await ok('el catálogo de frecuentes se une', () => {
  const m = mergeState({ cat: { leche: { n: 'Leche', c: 3, u: 5 } } }, { cat: { pan: { n: 'Pan', c: 1, u: 1 } } });
  assert.deepEqual(Object.keys(m.cat).sort(), ['leche', 'pan']);
});
await ok('es idempotente y conmutativo', () => {
  const a = { lists: { l1: L('l1', 'S', { i1: I('i1', 'A', T) }) }, last: 'l1', lastU: 3 };
  const b = { lists: { l1: L('l1', 'S', { i1: I('i1', 'A', T + 1, { d: true }), i2: I('i2', 'B', T) }) } };
  const ab = mergeState(a, b), ba = mergeState(b, a);
  assert.deepEqual(ab, ba);
  assert.deepEqual(mergeState(ab, ab), ab);
});
await ok('descarta basura y acota valores', () => {
  const m = sanitizeState({ lists: { 'bad id!': L('x', 'x'), ok1: { n: 'x'.repeat(500), items: { a: { n: 'y', q: 9999 }, b: { n: '' }, c: 5 } } }, cat: 7 });
  assert.deepEqual(Object.keys(m.lists), ['ok1']);
  assert.equal(m.lists.ok1.n.length, 80);
  assert.deepEqual(Object.keys(m.lists.ok1.items), ['a']);
  assert.equal(m.lists.ok1.items.a.q, 99);
  assert.deepEqual(sanitizeState('hola'), emptyState());
});

console.log('servidor');
const store = new Map();
const KV = { get: async k => store.get(k) ?? null, put: async (k, v) => { KV.writes++; store.set(k, v); }, delete: async k => { store.delete(k); }, writes: 0 };
const env = { KV, SERVER_SECRET: 'secreto-de-prueba-largo' };
const call = async (method, path, body, token) => {
  const r = await worker.fetch(new Request('https://x.test' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: r.status, body: await r.json() };
};

let token;
await ok('registro valida email y contraseña', async () => {
  assert.equal((await call('POST', '/signup', { email: 'no-es-email', password: '12345678' })).status, 400);
  assert.equal((await call('POST', '/signup', { email: 'a@b.com', password: 'corta' })).status, 400);
});
await ok('registro e ingreso', async () => {
  const s = await call('POST', '/signup', { email: 'Ana@Mail.com', password: 'contraseña-1' });
  assert.equal(s.status, 200); token = s.body.token;
  assert.equal((await call('POST', '/signup', { email: 'ana@mail.com', password: 'otra-contra-2' })).status, 409);
  assert.equal((await call('POST', '/login', { email: 'ana@mail.com', password: 'mala-mala-1' })).status, 401);
  assert.equal((await call('POST', '/login', { email: 'nadie@mail.com', password: 'contraseña-1' })).status, 401);
  assert.equal((await call('POST', '/login', { email: 'ANA@mail.com', password: 'contraseña-1' })).status, 200);
});
await ok('la contraseña no se guarda en texto plano', () => {
  assert.ok(!store.get('user:ana@mail.com').includes('contraseña-1'));
});
await ok('sin token o con token adulterado no hay acceso', async () => {
  assert.equal((await call('GET', '/data')).status, 401);
  assert.equal((await call('GET', '/data', null, token.slice(0, -2) + 'xx')).status, 401);
});
await ok('un token vencido se rechaza', async () => {
  const real = Date.now; Date.now = () => real() + 61 * 86400000;
  try { assert.equal((await call('GET', '/data', null, token)).status, 401); } finally { Date.now = real; }
});
await ok('dos dispositivos se sincronizan sin pisarse', async () => {
  const phone = { lists: { l1: L('l1', 'Súper', { i1: I('i1', 'Leche', T) }) }, last: 'l1', lastU: T };
  const pc = { lists: { l1: L('l1', 'Súper', { i2: I('i2', 'Pan', T) }) } };
  await call('PUT', '/data', { data: phone }, token);
  const r = await call('PUT', '/data', { data: pc }, token);
  assert.deepEqual(Object.keys(r.body.data.lists.l1.items).sort(), ['i1', 'i2']);
  const g = await call('GET', '/data', null, token);
  assert.deepEqual(Object.keys(g.body.data.lists.l1.items).sort(), ['i1', 'i2']);
  assert.equal(g.body.data.last, 'l1');
});
await ok('no escribe en KV si no hubo cambios', async () => {
  const before = KV.writes;
  const g = await call('GET', '/data', null, token);
  await call('PUT', '/data', { data: g.body.data }, token);
  assert.equal(KV.writes, before);
});
await ok('rechaza cuerpos enormes', async () => {
  const big = { lists: {}, pad: 'x'.repeat(950000) };
  assert.equal((await call('PUT', '/data', { data: big }, token)).status, 413);
});
await ok('eliminar la cuenta borra los datos', async () => {
  assert.equal((await call('DELETE', '/account', null, token)).status, 200);
  assert.equal(store.has('user:ana@mail.com'), false);
  assert.equal((await call('GET', '/data', null, token)).status, 401);
});

console.log(`\n${n} pruebas OK`);
