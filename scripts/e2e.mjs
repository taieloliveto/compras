// Prueba de punta a punta con un navegador real (Playwright): app + servidor con KV simulado.
// Uso: node scripts/e2e.mjs   (requiere `playwright` con Chromium instalado)
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import worker from '../server/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, '..', 'web');
const SHOTS = process.env.SHOTS_DIR || join(here, '..', '.shots');
mkdirSync(SHOTS, { recursive: true });
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [here, '/opt/npm-tools/node_modules'] }));

// ---- servidor de la API (Worker + KV en memoria) ----
const store = new Map();
const env = { SERVER_SECRET: 'e2e-secret-largo-largo', KV: { get: async k => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); }, delete: async k => { store.delete(k); } } };
const api = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = await worker.fetch(new Request('http://api.local' + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
// ---- servidor estático de la app ----
// config.js: por defecto trae el servidor "de fábrica" (como en producción). Con la cookie noserver=1 queda vacío.
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
let API = '';
const web = http.createServer((req, res) => {
  let p = new URL(req.url, 'http://x').pathname; if (p === '/') p = '/index.html';
  const f = join(WEB, p);
  if (!f.startsWith(WEB) || !existsSync(f)) { res.writeHead(404); return res.end(); }
  const headers = { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' };
  if (process.env.E2E_CSP) {   // mismos encabezados de seguridad que web/vercel.json (localhost → 127.0.0.1)
    const rule = JSON.parse(readFileSync(join(WEB, 'vercel.json'), 'utf8')).headers.find(h => h.source === '/(.*)');
    for (const { key, value } of rule.headers) headers[key] = value.replace('http://localhost:*', 'http://127.0.0.1:*');
  }
  if (p === '/config.js' && !/noserver=1/.test(req.headers.cookie || '')) {
    res.writeHead(200, headers); return res.end(`window.COMPRAS_CONFIG={API_URL:${JSON.stringify(API)}};`);
  }
  res.writeHead(200, headers); res.end(readFileSync(f));
});
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const [apiPort, webPort] = [await listen(api), await listen(web)];
const APP = `http://127.0.0.1:${webPort}/`;
API = `http://127.0.0.1:${apiPort}`;

const browser = await chromium.launch();
const errors = [];
let n = 0;
const step = async (name, fn) => { try { await fn(); n++; console.log('  ✓', name); } catch (e) { console.log('  ✗', name); throw e; } };
const newDevice = async (opts = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, ...opts });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  return { ctx, page };
};
const rowsIn = (p, scope) => p.locator(`${scope} .it .nm`).allTextContents();
const rx = s => new RegExp('^' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
const row = (p, scope, name) => p.locator(`${scope} .it`).filter({ has: p.locator('.nm', { hasText: rx(name) }) });
const qty = async (p, scope, name) => { const r = row(p, scope, name); return (await r.locator('.qty').count()) ? await r.locator('.qty').textContent() : '×1'; };
const settle = p => p.waitForFunction(() => document.querySelector('.sy')?.textContent === 'Sincronizado', null, { timeout: 8000 });
const activeTag = p => p.evaluate(() => (document.activeElement && (document.activeElement.id || document.activeElement.tagName)) || '');
const goTab = (p, t) => p.locator(`#nv nav [data-t=${t}]`).click();
const openFromLists = async (p, name) => { await goTab(p, 'lists'); await p.locator('.card', { hasText: name }).click(); await p.locator('#lt').filter({ hasText: name }).waitFor(); };

const A = await newDevice();
const a = A.page;

console.log('dispositivo A');
await step('Ingreso: no pide la URL del servidor y no hay barra', async () => {
  await a.goto(APP);
  await a.getByRole('heading', { name: 'Compras' }).waitFor();
  assert.equal(await a.locator('[data-au=server]').count(), 0);
  assert.equal(await a.locator('#nv').isHidden(), true);
  await a.screenshot({ path: join(SHOTS, '1-ingreso.png') });
});
await step('rechaza una contraseña corta al crear la cuenta', async () => {
  await a.getByRole('button', { name: 'Crear cuenta', exact: true }).first().click();
  await a.fill('[data-au=email]', 'ana@mail.com'); await a.fill('[data-au=pass]', 'corta');
  await a.locator('#af button[type=submit]').click();
  await a.getByText('al menos 8 caracteres').waitFor();
});
await step('crea la cuenta y abre Home con el campo para agregar (sin abrir el teclado)', async () => {
  await a.fill('[data-au=pass]', 'contraseña-segura');
  await a.locator('#af button[type=submit]').click();
  await a.getByRole('heading', { name: 'Agregar' }).waitFor();
  await a.locator('#qi').waitFor();
  assert.ok(await a.locator('#nv').isVisible());
  assert.equal(await a.locator('#nl').isHidden(), true, 'sin listas no hay acceso rápido');
  assert.notEqual(await activeTag(a), 'qi');
});
await step('agregar sin tener listas crea una lista sola', async () => {
  await a.fill('#qi', 'Fideos'); await a.keyboard.press('Enter');
  await a.locator('#dest b', { hasText: 'Mi lista' }).waitFor();
  assert.deepEqual(await rowsIn(a, '#prev'), ['Fideos']);
  await a.locator('#nl').waitFor();
  assert.match(await a.locator('#nl-n').textContent(), /Mi lista/);
});
await step('el destino permite crear otra lista y se queda en Home', async () => {
  await a.locator('#dest').click();
  await a.getByRole('button', { name: '+ Nueva lista' }).click();
  await a.fill('#sn', 'Súper'); await a.keyboard.press('Enter');
  await a.locator('#dest b', { hasText: 'Súper' }).waitFor();
  assert.deepEqual(await rowsIn(a, '#prev'), []);
  assert.match(await a.locator('#nl-n').textContent(), /Súper/);
});
await step('cantidad al agregar: el selector se aplica y se reinicia', async () => {
  await a.locator('[data-a=aqp]').click(); await a.locator('[data-a=aqp]').click();
  assert.equal(await a.locator('#aq').textContent(), '3');
  await a.fill('#qi', 'leche'); await a.keyboard.press('Enter');
  assert.equal(await qty(a, '#prev', 'Leche'), '×3');
  assert.equal(await a.locator('#aq').textContent(), '1');
});
await step('varios productos: el número escrito gana sobre el selector', async () => {
  await a.locator('[data-a=aqp]').click();                      // 2
  await a.fill('#qi', 'pan, 4 sal, Pan lactal x3, avena'); await a.keyboard.press('Enter');
  assert.equal(await qty(a, '#prev', 'Pan'), '×2');
  assert.equal(await qty(a, '#prev', 'Sal'), '×4');
  assert.equal(await qty(a, '#prev', 'Pan lactal'), '×3');
  assert.equal(await qty(a, '#prev', 'Avena'), '×2');
});
await step('sugerencias: un toque agrega con la cantidad elegida y deja el teclado abierto', async () => {
  await a.locator('[data-a=aqp]').click(); await a.locator('[data-a=aqp]').click();   // 3
  await a.fill('#qi', 'arr');
  await a.locator('.chip', { hasText: 'Arroz' }).click();
  assert.equal(await qty(a, '#prev', 'Arroz'), '×3');
  assert.equal(await activeTag(a), 'qi');
});
await step('repetir un producto suma la cantidad en vez de duplicarlo', async () => {
  await a.fill('#qi', 'leche'); await a.keyboard.press('Enter');
  assert.equal((await rowsIn(a, '#prev')).filter(x => x === 'Leche').length, 1);
  assert.equal(await qty(a, '#prev', 'Leche'), '×4');
  await a.screenshot({ path: join(SHOTS, '2-home.png') });
});
await step('marcar desde Home lo saca de "por comprar"', async () => {
  await row(a, '#prev', 'Pan').locator('.main').click();
  assert.ok(!(await rowsIn(a, '#prev')).includes('Pan'));
});
await step('el acceso rápido abre la última lista y queda resaltado', async () => {
  await a.locator('#nl').click();
  await a.locator('#lt').filter({ hasText: 'Súper' }).waitFor();
  assert.equal(await a.locator('#nl').getAttribute('aria-current'), 'page');
  await a.getByText('En el carrito · 1').waitFor();
  assert.equal(await a.locator('.it.done .nm').textContent(), 'Pan');
  await a.screenshot({ path: join(SHOTS, '3-lista.png') });
});
await step('en la lista también se elige la cantidad al agregar', async () => {
  await a.locator('[data-a=aqp]').click();
  await a.fill('#qi', 'yerba'); await a.keyboard.press('Enter');
  assert.equal(await qty(a, '#items', 'Yerba'), '×2');
});
await step('editar: la ventana sale flotante y centrada, y NO abre el teclado', async () => {
  await a.locator('#items .it', { hasText: 'Avena' }).locator('.more').click();
  await a.locator('.sh').waitFor();
  await a.waitForTimeout(350);
  const box = await a.locator('.sh').boundingBox(), vp = a.viewportSize();
  assert.ok(Math.abs(box.x + box.width / 2 - vp.width / 2) < 2, 'centrada en horizontal');
  assert.ok(Math.abs(box.y + box.height / 2 - vp.height / 2) < 4, 'centrada en vertical');
  assert.ok(box.x >= 8 && box.x + box.width <= vp.width - 8, 'flota con margen a los lados');
  assert.notEqual(await activeTag(a), 'sn', 'el campo no tiene foco al abrir');
  assert.notEqual(await a.evaluate(() => document.activeElement.tagName), 'INPUT');
  await a.screenshot({ path: join(SHOTS, '4-editar.png') });
  await a.locator('#sn').click();
  assert.equal(await activeTag(a), 'sn', 'al tocar el campo sí');
});
await step('editar cantidad y nombre desde la ventana', async () => {
  await a.locator('[data-a=qp]').click(); await a.locator('[data-a=qp]').click();
  await a.fill('#sn', 'Avena integral'); await a.locator('#sf button[type=submit]').click();
  assert.equal(await qty(a, '#items', 'Avena integral'), '×4');
});
await step('eliminar un producto y deshacer', async () => {
  await a.locator('#items .it', { hasText: 'Avena integral' }).locator('.more').click();
  await a.getByRole('button', { name: 'Eliminar producto' }).click();
  assert.ok(!(await rowsIn(a, '#items')).includes('Avena integral'));
  await a.locator('#t button', { hasText: 'Deshacer' }).click();
  assert.ok((await rowsIn(a, '#items')).includes('Avena integral'));
});
await step('sincroniza con la nube', async () => { await settle(a); });
await step('al recargar abre Home y la última lista queda a un toque', async () => {
  await a.reload();
  await a.getByRole('heading', { name: 'Agregar' }).waitFor();
  await a.locator('#dest b', { hasText: 'Súper' }).waitFor();
  assert.match(await a.locator('#nl-n').textContent(), /Súper/);
  assert.ok((await rowsIn(a, '#prev')).includes('Leche'));
});
await step('Listas: gestiona varias y marca cuál fue la última', async () => {
  await goTab(a, 'lists');
  await a.locator('.card', { hasText: 'Súper' }).waitFor();
  assert.equal(await a.locator('.card .tag').count(), 1);
  assert.ok(await a.locator('.card', { hasText: 'Súper' }).locator('.tag').count());
  await a.screenshot({ path: join(SHOTS, '5-listas.png') });
  await a.locator('.card', { hasText: 'Mi lista' }).click();
  await a.locator('#lt').filter({ hasText: 'Mi lista' }).waitFor();
  await settle(a);
  await a.reload();
  await a.locator('#dest b', { hasText: 'Mi lista' }).waitFor();
  assert.match(await a.locator('#nl-n').textContent(), /Mi lista/);
});
await step('funciona sin conexión y agrega desde Home', async () => {
  await a.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 8000 }).catch(async () => { await a.reload(); await a.waitForFunction(() => navigator.serviceWorker.controller); });
  await A.ctx.setOffline(true);
  await a.reload();
  await a.locator('#dest b', { hasText: 'Mi lista' }).waitFor();
  await a.fill('#qi', 'Lechuga'); await a.keyboard.press('Enter');
  assert.ok((await rowsIn(a, '#prev')).includes('Lechuga'));
  await a.waitForFunction(() => document.querySelector('.sy')?.textContent === 'Sin conexión', null, { timeout: 8000 });
});

console.log('dispositivo B (mismo usuario)');
const B = await newDevice();
const b = B.page;
await step('inicia sesión (sin servidor), y recupera todo en Home', async () => {
  await b.goto(APP);
  await b.fill('[data-au=email]', 'ANA@mail.com'); await b.fill('[data-au=pass]', 'contraseña-segura');
  await b.locator('#af button[type=submit]').click();
  await b.getByRole('heading', { name: 'Agregar' }).waitFor();
  await b.locator('#dest b').waitFor();
});
await step('ve la lista Súper con lo que cargó A', async () => {
  await openFromLists(b, 'Súper');
  const names = await rowsIn(b, '#items');
  assert.ok(names.includes('Leche') && names.includes('Sal'));
  assert.equal(await qty(b, '#items', 'Leche'), '×4');
  assert.equal(await b.locator('.it.done .nm').textContent(), 'Pan');
});
await step('rechaza la contraseña incorrecta (modo con campo de servidor visible)', async () => {
  const C = await newDevice(); const c = C.page;
  await C.ctx.addCookies([{ name: 'noserver', value: '1', url: APP }]);
  await c.goto(APP);
  assert.equal(await c.locator('[data-au=server]').count(), 1);
  await c.fill('[data-au=email]', 'ana@mail.com'); await c.fill('[data-au=pass]', 'incorrecta-123'); await c.fill('[data-au=server]', API);
  await c.locator('#af button[type=submit]').click();
  await c.getByText('Email o contraseña incorrectos').waitFor();
  await C.ctx.close();
});
await step('B marca un producto y A lo ve al volver la conexión', async () => {
  await row(b, '#items', 'Sal').locator('.main').click();
  await settle(b);
  await A.ctx.setOffline(false);
  await a.evaluate(() => window.dispatchEvent(new Event('online')));
  await a.waitForFunction(() => document.querySelector('.sy')?.textContent === 'Sincronizado', null, { timeout: 8000 });
  await openFromLists(a, 'Súper');
  await a.locator('.it.done', { hasText: 'Sal' }).waitFor();
});
await step('lo que A cargó sin conexión llega a B', async () => {
  await openFromLists(b, 'Mi lista');
  await b.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await b.locator('.it', { hasText: 'Lechuga' }).waitFor({ timeout: 8000 });
});
await step('la barra flotante entra en una pantalla de 320 px', async () => {
  await b.setViewportSize({ width: 320, height: 640 });
  await goTab(b, 'home');
  const fits = await b.evaluate(() => [...document.querySelector('#nv').children].filter(c => !c.hidden).every(c => { const r = c.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }));
  assert.ok(fits, 'los botones de la barra caben en 320 px');
  await b.screenshot({ path: join(SHOTS, '6-320px.png') });
  await b.setViewportSize({ width: 390, height: 844 });
});

console.log('ajustes y sesión');
await step('exportar descarga un JSON', async () => {
  await goTab(a, 'set');
  const [dl] = await Promise.all([a.waitForEvent('download'), a.getByRole('button', { name: /Exportar/ }).click()]);
  const j = JSON.parse(readFileSync(await dl.path(), 'utf8'));
  assert.deepEqual(j.listas.map(l => l.nombre).sort(), ['Mi lista', 'Súper']);
  await a.screenshot({ path: join(SHOTS, '7-ajustes.png') });
});
await step('cerrar sesión borra los datos locales y vuelve a ingresar', async () => {
  await a.getByRole('button', { name: 'Cerrar sesión' }).click();
  await a.locator('.sh .btn', { hasText: 'Cerrar sesión' }).click();
  await a.getByRole('heading', { name: 'Compras' }).waitFor();
  const ls = JSON.parse(await a.evaluate(() => localStorage.getItem('compras.v1')));
  assert.equal(ls.token, ''); assert.deepEqual(ls.data.lists, {});
  await a.fill('[data-au=pass]', 'contraseña-segura');
  await a.locator('#af button[type=submit]').click();
  await a.getByRole('heading', { name: 'Agregar' }).waitFor();
});
await step('eliminar la cuenta borra todo en el servidor', async () => {
  await goTab(a, 'set');
  await a.getByRole('button', { name: /Eliminar mi cuenta/ }).click();
  await a.locator('.sh .btn', { hasText: 'Sí, eliminar todo' }).click();
  await a.getByRole('heading', { name: 'Compras' }).waitFor();
  assert.equal(store.size, 0);
});

console.log('escritorio');
await step('captura de verificación', async () => {
  const D = await newDevice({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await D.page.goto(APP);
  await D.page.screenshot({ path: join(SHOTS, '8-escritorio-ingreso.png') });
  await D.ctx.close();
});

await browser.close(); api.close(); web.close();
const real = errors.filter(e => !/Failed to load resource|net::ERR/.test(e));
assert.deepEqual(real, [], 'errores de consola/JS: ' + real.join(' | '));
console.log(`\n${n} pasos OK — capturas en ${SHOTS}`);
