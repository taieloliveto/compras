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
  if (p === '/config.js') {   // el config.js real apunta a producción: en la prueba se reemplaza
    const none = /noserver=1/.test(req.headers.cookie || '');
    res.writeHead(200, headers); return res.end(`window.COMPRAS_CONFIG={API_URL:${JSON.stringify(none ? '' : API)}};`);
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
const goTab = (p, t) => p.locator(`#nv [data-t=${t}]`).click();
const openLast = async p => { await p.locator('#nl').click(); await p.locator('#lt').waitFor(); };
const openFromLists = async (p, name) => { await goTab(p, 'lists'); await p.locator('.card', { hasText: name }).click(); await p.locator('#lt').filter({ hasText: name }).waitFor(); };
const toastHas = (p, t) => p.locator('#t', { hasText: t }).waitFor({ timeout: 5000 });

const A = await newDevice();
const a = A.page;

console.log('dispositivo A');
await step('Ingreso: no pide la URL del servidor, no hay barra y el nombre solo se pide al crear cuenta', async () => {
  await a.goto(APP);
  await a.getByRole('heading', { name: 'Compras' }).waitFor();
  assert.equal(await a.locator('[data-au=server]').count(), 0);
  assert.equal(await a.locator('#nv').isHidden(), true);
  assert.equal(await a.locator('[data-au=name]').count(), 0, 'en "Ingresar" no se pide el nombre');
  await a.screenshot({ path: join(SHOTS, '1-ingreso.png') });
  await a.getByRole('button', { name: 'Crear cuenta', exact: true }).first().click();
  assert.equal(await a.locator('[data-au=name]').count(), 1, 'al crear cuenta sí');
  await a.screenshot({ path: join(SHOTS, '1b-crear-cuenta.png') });
});
await step('rechaza una contraseña corta al crear la cuenta', async () => {
  await a.fill('[data-au=name]', 'Taiel');
  await a.fill('[data-au=email]', 'ana@mail.com'); await a.fill('[data-au=pass]', 'corta');
  await a.locator('#af button[type=submit]').click();
  await a.getByText('al menos 8 caracteres').waitFor();
  assert.equal(await a.inputValue('[data-au=name]'), 'Taiel', 'el nombre escrito se conserva tras el error');
});
await step('crea la cuenta y abre Home: "Hola Taiel", sin listado, sin teclado', async () => {
  await a.fill('[data-au=pass]', 'contraseña-segura');
  await a.locator('#af button[type=submit]').click();
  await a.getByRole('heading', { name: 'Hola Taiel 👋' }).waitFor();
  await a.getByText('¿Qué vas a agregar hoy?').waitFor();
  assert.equal(await a.locator('#prev').count(), 0, 'no hay listado en Home');
  assert.equal(await a.getByText('Por comprar').count(), 0);
  assert.equal(await a.locator('#nl').isHidden(), true, 'sin listas no hay acceso rápido');
  assert.notEqual(await activeTag(a), 'qi');
});
await step('Home: todo centrado y con el orden texto → cantidad → selector de lista → Agregar', async () => {
  const bb = sel => a.locator(sel).boundingBox(), vp = a.viewportSize();
  const [h1, qi, qs, dest, add] = [await bb('#hi'), await bb('#qi'), await bb('.qa.home .qs'), await bb('#dest'), await bb('.qa.home button[type=submit]')];
  assert.ok(Math.abs(h1.x + h1.width / 2 - vp.width / 2) < 3, 'saludo centrado en horizontal');
  assert.ok(Math.abs(qi.x + qi.width / 2 - vp.width / 2) < 3, 'campo centrado en horizontal');
  assert.ok(qi.y + qi.height <= qs.y + 1 && qs.x + qs.width <= dest.x + 1 && Math.abs(qs.y - dest.y) < 12 && Math.max(qs.y + qs.height, dest.y + dest.height) <= add.y + 1, 'orden del formulario');
  const sug = await bb('#sug');
  const top = h1.y, bottom = Math.max(add.y + add.height, sug.y + sug.height), nav = await bb('#nv nav');
  const gapTop = top - 64, gapBottom = nav.y - bottom;
  assert.ok(Math.abs(gapTop - gapBottom) < 60, `bloque centrado en vertical (arriba ${Math.round(gapTop)} / abajo ${Math.round(gapBottom)})`);
  await a.screenshot({ path: join(SHOTS, '2a-home-vacio.png') });
});
await step('Home: fondo de íconos con degradé, detrás del texto y solo en Home', async () => {
  const bg = await a.evaluate(async () => {
    const hb = document.querySelector('.hbg'), i = hb && hb.querySelector('i');
    const cs = getComputedStyle(hb), ci = getComputedStyle(i);
    const img = await fetch('img/pattern.png');
    const hi = document.querySelector('#hi').getBoundingClientRect();
    const top = document.elementFromPoint(hi.x + hi.width / 2, hi.y + hi.height / 2);
    return { grad: (cs.maskImage || cs.webkitMaskImage || ''), pat: (ci.maskImage || ci.webkitMaskImage || ''), status: img.status, type: img.headers.get('content-type'), h: hb.getBoundingClientRect().height, pos: cs.position, textOnTop: !!top && !!top.closest('#hi'), safari: ci.webkitMaskImage || '' };
  });
  assert.match(bg.grad, /linear-gradient/, 'el fondo se desvanece con un degradé');
  assert.match(bg.pat, /pattern\.png/, 'usa el patrón de íconos');
  assert.equal(bg.status, 200); assert.match(bg.type, /image\/png/);
  assert.ok(bg.h > 300 && bg.h < 500, 'ocupa la parte de arriba (alto ' + bg.h + ')');
  assert.ok(bg.textOnTop, 'el saludo queda por encima del fondo');
  await a.screenshot({ path: join(SHOTS, '2c-home-fondo.png') });
});
await step('la barra: Home, Listas y la última lista juntas; Ajustes aparte a la derecha', async () => {
  await a.fill('#qi', 'Fideos'); await a.keyboard.press('Enter');          // crea "Mi lista"
  await a.locator('#nl').waitFor();
  const x = async s => (await a.locator(s).boundingBox());
  const [h, l, n, st] = [await x('#nv [data-t=home]'), await x('#nv [data-t=lists]'), await x('#nl'), await x('#nv > [data-t=set]')];
  assert.ok(h.x < l.x && l.x < n.x && n.x < st.x, 'orden: Home, Listas, última lista, Ajustes');
  assert.equal(await a.locator('#nv nav #nl').count(), 1, 'la última lista está dentro de la píldora');
  assert.equal(await a.locator('#nv > [data-t=set]').count(), 1, 'Ajustes está en su propio botón');
  await a.screenshot({ path: join(SHOTS, '2b-barra.png') });
});
await step('agregar sin listas crea "Mi lista" y avisa con "Ver lista"', async () => {
  await a.locator('#dest b', { hasText: 'Mi lista' }).waitFor();
  await toastHas(a, '“Fideos” agregado a Mi lista');
  assert.match(await a.locator('#nl-n').textContent(), /Mi lista/);
});
await step('el selector crea otra lista y se queda en Home', async () => {
  await a.locator('#dest').click();
  await a.getByRole('button', { name: '+ Nueva lista' }).click();
  await a.fill('#sn', 'Súper'); await a.keyboard.press('Enter');
  await a.locator('#dest b', { hasText: 'Súper' }).waitFor();
  assert.match(await a.locator('#nl-n').textContent(), /Súper/);
  await a.getByRole('heading', { name: 'Hola Taiel 👋' }).waitFor();
});
await step('cantidad al agregar: el selector se aplica y se reinicia', async () => {
  await a.locator('[data-a=aqp]').click(); await a.locator('[data-a=aqp]').click();
  assert.equal(await a.locator('#aq').textContent(), '3');
  await a.fill('#qi', 'leche'); await a.keyboard.press('Enter');
  await toastHas(a, '“Leche” agregado a Súper');
  assert.equal(await a.locator('#aq').textContent(), '1');
});
await step('varios productos: el número escrito gana sobre el selector', async () => {
  await a.locator('[data-a=aqp]').click();                      // 2
  await a.fill('#qi', 'pan, 4 sal, Pan lactal x3, avena'); await a.keyboard.press('Enter');
  await toastHas(a, '4 productos agregados a Súper');
});
await step('sugerencias: un toque agrega con la cantidad elegida y deja el teclado abierto', async () => {
  await a.locator('[data-a=aqp]').click(); await a.locator('[data-a=aqp]').click();   // 3
  await a.fill('#qi', 'arr');
  await a.locator('.chip', { hasText: 'Arroz' }).click();
  await toastHas(a, '“Arroz” agregado a Súper');
  assert.equal(await activeTag(a), 'qi');
});
await step('repetir suma la cantidad; el botón Agregar funciona con un toque', async () => {
  await a.fill('#qi', 'leche'); await a.keyboard.press('Enter');
  await a.fill('#qi', 'tomates'); await a.locator('.qa.home button[type=submit]').click();
  await toastHas(a, '“Tomates” agregado a Súper');
  await a.screenshot({ path: join(SHOTS, '2-home.png') });
});
await step('"Ver lista" del aviso y el acceso rápido llevan a la lista con todo lo cargado', async () => {
  await a.locator('#t button', { hasText: 'Ver lista' }).click();
  await a.locator('#lt').filter({ hasText: 'Súper' }).waitFor();
  assert.equal(await a.locator('#nl').getAttribute('aria-current'), 'page');
  const names = await rowsIn(a, '#items');
  assert.equal(names.filter(x => x === 'Leche').length, 1, 'sin duplicados');
  for (const [n, q] of [['Leche', '×4'], ['Pan', '×2'], ['Sal', '×4'], ['Pan lactal', '×3'], ['Avena', '×2'], ['Arroz', '×3'], ['Tomates', '×1']]) assert.equal(await qty(a, '#items', n), q, n);
  assert.ok(!names.includes('Fideos'), 'Fideos quedó en la otra lista');
});
await step('marcar un producto lo baja a "En el carrito"', async () => {
  await row(a, '#items', 'Pan').locator('.main').click();
  await a.getByText('En el carrito · 1').waitFor();
  assert.equal(await a.locator('.it.done .nm').textContent(), 'Pan');
  await a.screenshot({ path: join(SHOTS, '3-lista.png') });
});
await step('en la lista también se elige la cantidad al agregar', async () => {
  await a.locator('[data-a=aqp]').click();
  await a.fill('#qi', 'yerba'); await a.keyboard.press('Enter');
  assert.equal(await qty(a, '#items', 'Yerba'), '×2');
});
await step('editar: ventana flotante y centrada, y NO abre el teclado', async () => {
  await a.locator('#items .it', { hasText: 'Avena' }).locator('.more').click();
  await a.locator('.sh').waitFor();
  await a.waitForTimeout(350);
  const box = await a.locator('.sh').boundingBox(), vp = a.viewportSize();
  assert.ok(Math.abs(box.x + box.width / 2 - vp.width / 2) < 2, 'centrada en horizontal');
  assert.ok(Math.abs(box.y + box.height / 2 - vp.height / 2) < 4, 'centrada en vertical');
  assert.ok(box.x >= 8 && box.x + box.width <= vp.width - 8, 'flota con margen');
  assert.notEqual(await a.evaluate(() => document.activeElement.tagName), 'INPUT');
  await a.screenshot({ path: join(SHOTS, '4-editar.png') });
  await a.locator('#sn').click();
  assert.equal(await activeTag(a), 'sn', 'al tocar el campo sí');
});
await step('editar cantidad y nombre; eliminar y deshacer', async () => {
  await a.locator('[data-a=qp]').click(); await a.locator('[data-a=qp]').click();
  await a.fill('#sn', 'Avena integral'); await a.locator('#sf button[type=submit]').click();
  assert.equal(await qty(a, '#items', 'Avena integral'), '×4');
  await a.locator('#items .it', { hasText: 'Avena integral' }).locator('.more').click();
  await a.getByRole('button', { name: 'Eliminar producto' }).click();
  assert.ok(!(await rowsIn(a, '#items')).includes('Avena integral'));
  await a.locator('#t button', { hasText: 'Deshacer' }).click();
  assert.ok((await rowsIn(a, '#items')).includes('Avena integral'));
});
await step('la barra superior no se mueve al hacer scroll', async () => {
  await a.fill('#qi', Array.from({ length: 26 }, (_, i) => `Producto ${i + 1}`).join(', ')); await a.keyboard.press('Enter');
  await a.waitForTimeout(150);
  const y0 = (await a.locator('.top').boundingBox()).y, q0 = (await a.locator('.qa').boundingBox()).y;
  await a.evaluate(() => window.scrollTo(0, 700)); await a.waitForTimeout(150);
  assert.ok(await a.evaluate(() => window.scrollY) > 300, 'la página realmente se desplazó');
  const y1 = (await a.locator('.top').boundingBox()).y, q1 = (await a.locator('.qa').boundingBox()).y;
  assert.ok(Math.abs(y0) < 1 && Math.abs(y1) < 1, `la barra queda pegada arriba (antes ${y0}, después ${y1})`);
  assert.ok(Math.abs(q0 - q1) < 1, 'el campo de agregar queda debajo de la barra, sin saltos');
  await a.screenshot({ path: join(SHOTS, '3b-scroll.png') });
  await a.evaluate(() => window.scrollTo(0, 0));
});
await step('sincroniza con la nube', async () => { await settle(a); });
await step('al recargar abre Home con el saludo y la última lista a un toque', async () => {
  await a.reload();
  await a.getByRole('heading', { name: 'Hola Taiel 👋' }).waitFor();
  await a.locator('#dest b', { hasText: 'Súper' }).waitFor();
  assert.match(await a.locator('#nl-n').textContent(), /Súper/);
});
await step('Mis listas: encabezado arriba y botón "Nueva lista" al final', async () => {
  await goTab(a, 'lists');
  await a.locator('.card', { hasText: 'Súper' }).waitFor();
  const bar = await a.locator('.bar').boundingBox();
  assert.ok(Math.abs(bar.y) < 1, 'encabezado pegado arriba');
  const cards = await a.locator('.card').evaluateAll(els => Math.max(...els.map(e => e.getBoundingClientRect().bottom)));
  const nb = await a.locator('.newbtn').boundingBox();
  assert.ok(nb.y >= cards, 'el botón está debajo de todas las listas');
  assert.equal(await a.locator('.card .tag').count(), 1);
  assert.ok(await a.locator('.card', { hasText: 'Súper' }).locator('.tag').count());
  await a.screenshot({ path: join(SHOTS, '5-listas.png') });
  await a.locator('.card', { hasText: 'Mi lista' }).click();
  await a.locator('#lt').filter({ hasText: 'Mi lista' }).waitFor();
  await settle(a);
  await a.reload();
  await a.locator('#dest b', { hasText: 'Mi lista' }).waitFor();
});
await step('Ajustes: se ve el nombre y se cambia desde una ventana sin abrir el teclado', async () => {
  await goTab(a, 'set');
  await a.getByText('Cómo te llamamos').waitFor();
  assert.equal(await a.locator('.set-row', { hasText: 'Cómo te llamamos' }).locator('span').last().textContent(), 'Taiel');
  await a.getByRole('button', { name: 'Cambiar mi nombre' }).click();
  await a.locator('.sh').waitFor();
  assert.notEqual(await a.evaluate(() => document.activeElement.tagName), 'INPUT');
  await a.locator('#sn').click();
  await a.fill('#sn', 'Tai'); await a.locator('#sf button[type=submit]').click();
  assert.equal(await a.locator('.set-row', { hasText: 'Cómo te llamamos' }).locator('span').last().textContent(), 'Tai');
  await a.screenshot({ path: join(SHOTS, '7-ajustes.png') });
  await goTab(a, 'home');
  await a.getByRole('heading', { name: 'Hola Tai 👋' }).waitFor();
  await settle(a);
});
await step('funciona sin conexión y agrega desde Home', async () => {
  await a.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 8000 }).catch(async () => { await a.reload(); await a.waitForFunction(() => navigator.serviceWorker.controller); });
  await A.ctx.setOffline(true);
  await a.reload();
  await a.getByRole('heading', { name: 'Hola Tai 👋' }).waitFor();
  await a.fill('#qi', 'Lechuga'); await a.keyboard.press('Enter');
  await toastHas(a, '“Lechuga” agregado a Mi lista');
  await a.waitForFunction(() => document.querySelector('.sy')?.textContent === 'Sin conexión', null, { timeout: 8000 });
});

console.log('dispositivo B (mismo usuario)');
const B = await newDevice();
const b = B.page;
await step('inicia sesión (sin servidor) y ve su nombre guardado en la cuenta', async () => {
  await b.goto(APP);
  await b.fill('[data-au=email]', 'ANA@mail.com'); await b.fill('[data-au=pass]', 'contraseña-segura');
  await b.locator('#af button[type=submit]').click();
  await b.getByRole('heading', { name: 'Hola Tai 👋' }).waitFor();
  await b.locator('#dest b').waitFor();
});
await step('ve la lista Súper con lo que cargó A', async () => {
  await openFromLists(b, 'Súper');
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
  const fits = await b.evaluate(() => [...document.querySelectorAll('#nv nav, #nv > button')].every(c => { const r = c.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }));
  assert.ok(fits, 'cabe en 320 px');
  await b.screenshot({ path: join(SHOTS, '6-320px.png') });
  await b.setViewportSize({ width: 390, height: 844 });
});

console.log('emoji en las listas');
await step('crear lista con emoji aparte: se elige con un toque, el foco queda en el nombre', async () => {
  await goTab(a, 'lists');
  await a.getByRole('button', { name: '+ Nueva lista' }).click();
  await a.locator('.sh').waitFor();
  assert.equal(await a.locator('#se').count(), 1, 'hay un campo de emoji aparte del nombre');
  const [se, sn] = [await a.locator('#se').boundingBox(), await a.locator('#sn').boundingBox()];
  assert.ok(se.x + se.width <= sn.x + 1 && Math.abs(se.y - sn.y) < 12, 'emoji a la izquierda del nombre, en la misma fila');
  await a.locator('.egrid button[data-e="🥦"]').click();
  assert.equal(await a.inputValue('#se'), '🥦');
  assert.equal(await a.locator('.egrid button[data-e="🥦"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await activeTag(a), 'sn', 'tocar un emoji no cambia el foco');
  await a.screenshot({ path: join(SHOTS, '9-nueva-lista-emoji.png') });
  await a.fill('#sn', 'Verdulería'); await a.keyboard.press('Enter');
  await a.locator('#lt').filter({ hasText: 'Verdulería' }).waitFor();
});
await step('el emoji se ve delante del nombre en el encabezado, la barra, Home y la lista de listas', async () => {
  assert.equal((await a.locator('#lt .em').textContent()).trim(), '🥦');
  assert.equal(await a.locator('#nl-e').textContent(), '🥦');
  assert.equal(await a.locator('#nl-e').isVisible(), true);
  assert.equal(await a.locator('#nl svg').isHidden(), true, 'el emoji reemplaza al ícono de la barra');
  assert.equal((await a.locator('#nl-n').textContent()).trim(), 'Verdulería');
  await a.locator('.ttl').click();
  assert.match(await a.locator('.sh .rowb', { hasText: 'Verdulería' }).textContent(), /🥦\s*Verdulería/);
  await a.keyboard.press('Escape');
  await goTab(a, 'lists');
  assert.equal((await a.locator('.card', { hasText: 'Verdulería' }).locator('.em').textContent()).trim(), '🥦');
  assert.equal(await a.locator('.card', { hasText: 'Súper' }).locator('.em').count(), 0, 'las listas sin emoji no muestran nada raro');
  await a.screenshot({ path: join(SHOTS, '9b-listas-emoji.png') });
  await goTab(a, 'home');
  assert.match(await a.locator('#dest').textContent(), /🥦\s*Verdulería/);
  await a.fill('#qi', 'zanahoria'); await a.keyboard.press('Enter');
  await toastHas(a, '“Zanahoria” agregado a 🥦 Verdulería');
  await a.screenshot({ path: join(SHOTS, '9c-home-emoji.png') });
});
await step('editar la lista: el emoji se cambia aparte, sin abrir el teclado, y solo admite emojis', async () => {
  await a.locator('#nl').click();
  await a.locator('#lt').filter({ hasText: 'Verdulería' }).waitFor();
  await a.locator('[aria-label="Opciones de la lista"]').click();
  await a.getByRole('button', { name: 'Editar nombre y emoji' }).click();
  await a.locator('.sh').waitFor(); await a.waitForTimeout(300);
  assert.equal(await a.inputValue('#se'), '🥦');
  assert.equal(await a.inputValue('#sn'), 'Verdulería');
  assert.notEqual(await a.evaluate(() => document.activeElement.tagName), 'INPUT', 'no abre el teclado solo');
  await a.fill('#se', 'abc'); assert.equal(await a.inputValue('#se'), '', 'las letras no entran como emoji');
  await a.fill('#se', '🥦🍐'); assert.equal(await a.inputValue('#se'), '🍐', 'si escribís otro, reemplaza al anterior');
  await a.fill('#sn', 'Verdu'); await a.locator('#sf button[type=submit]').click();
  await a.locator('#lt').filter({ hasText: 'Verdu' }).waitFor();
  assert.equal((await a.locator('#lt .em').textContent()).trim(), '🍐');
  assert.equal(await a.locator('#nl-e').textContent(), '🍐');
});
await step('quitar el emoji vuelve a mostrar el ícono; se puede dejar otro y el nombre original', async () => {
  await a.locator('[aria-label="Opciones de la lista"]').click();
  await a.getByRole('button', { name: 'Editar nombre y emoji' }).click();
  await a.locator('.egrid .noemo').click();
  assert.equal(await a.inputValue('#se'), '');
  await a.locator('#sf button[type=submit]').click();
  await a.locator('#lt').filter({ hasText: 'Verdu' }).waitFor();
  assert.equal(await a.locator('#lt .em').count(), 0);
  assert.equal(await a.locator('#nl svg').isVisible(), true, 'vuelve el ícono de la barra');
  assert.equal(await a.locator('#nl-e').isHidden(), true);
  await a.locator('[aria-label="Opciones de la lista"]').click();
  await a.getByRole('button', { name: 'Editar nombre y emoji' }).click();
  await a.fill('#se', '🥬'); await a.fill('#sn', 'Verdulería'); await a.locator('#sf button[type=submit]').click();
  await a.locator('#lt').filter({ hasText: 'Verdulería' }).waitFor();
  assert.equal((await a.locator('#lt .em').textContent()).trim(), '🥬');
  await settle(a);
});
await step('B recibe la lista con su emoji', async () => {
  await b.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await goTab(b, 'lists');
  await b.locator('.card', { hasText: 'Verdulería' }).locator('.em').waitFor({ timeout: 8000 });
  assert.equal((await b.locator('.card', { hasText: 'Verdulería' }).locator('.em').textContent()).trim(), '🥬');
  await b.screenshot({ path: join(SHOTS, '9d-B-listas-emoji.png') });
});

console.log('ajustes y sesión');
await step('exportar descarga un JSON', async () => {
  await goTab(a, 'set');
  const [dl] = await Promise.all([a.waitForEvent('download'), a.getByRole('button', { name: /Exportar/ }).click()]);
  const j = JSON.parse(readFileSync(await dl.path(), 'utf8'));
  assert.deepEqual(j.listas.map(l => l.nombre).sort(), ['Mi lista', 'Súper', 'Verdulería']);
  assert.equal(j.listas.find(l => l.nombre === 'Verdulería').emoji, '🥬');
});
await step('cerrar sesión borra los datos locales y al volver a ingresar recupera el nombre', async () => {
  await a.getByRole('button', { name: 'Cerrar sesión' }).click();
  await a.locator('.sh .btn', { hasText: 'Cerrar sesión' }).click();
  await a.getByRole('heading', { name: 'Compras' }).waitFor();
  const ls = JSON.parse(await a.evaluate(() => localStorage.getItem('compras.v1')));
  assert.equal(ls.token, ''); assert.deepEqual(ls.data.lists, {}); assert.equal(ls.data.name, '');
  await a.fill('[data-au=pass]', 'contraseña-segura');
  await a.locator('#af button[type=submit]').click();
  await a.getByRole('heading', { name: 'Hola Tai 👋' }).waitFor();
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
