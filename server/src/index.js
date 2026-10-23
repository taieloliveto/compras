// Servidor de Compras (Cloudflare Worker): cuentas, sesión y sincronización de listas.
// Base: el servidor de Cierre, sin la síntesis con IA ni los avisos push, y con sesiones que vencen.
import { mergeState, sanitizeState } from './merge.js';

const TOKEN_TTL = 60 * 86400;        // las sesiones duran 60 días
const MAX_BODY = 900000;             // bytes por sincronización

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64u(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function hashPass(pw, saltB64) {
  const salt = saltB64 ? Uint8Array.from(atob(saltB64), c => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return { salt: btoa(String.fromCharCode(...salt)), hash: btoa(String.fromCharCode(...new Uint8Array(bits))) };
}

async function hmac(msg, secret) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
async function makeToken(email, env) {
  const p = b64u(enc.encode(JSON.stringify({ e: email, x: Math.floor(Date.now() / 1000) + TOKEN_TTL })));
  return p + '.' + await hmac(p, env.SERVER_SECRET);
}
async function verifyToken(token, env) {
  if (!token) return null;
  const [p, sig] = token.split('.');
  if (!p || !sig) return null;
  if (!safeEq(await hmac(p, env.SERVER_SECRET), sig)) return null;
  try {
    const o = JSON.parse(dec.decode(b64uToBytes(p)));
    return o.x > Date.now() / 1000 && typeof o.e === 'string' ? o.e : null;
  } catch (_) { return null; }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const h = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Cache-Control': 'no-store',
      Vary: 'Origin'
    };
    const j = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...h, 'Content-Type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    if (!env.SERVER_SECRET) return j({ error: 'Falta configurar SERVER_SECRET en el servidor' }, 500);

    try {
      if (url.pathname === '/health') return j({ ok: true });

      if (url.pathname === '/signup' && req.method === 'POST') {
        const { email, password } = await req.json();
        const em = String(email || '').trim().toLowerCase();
        if (!EMAIL_RE.test(em) || em.length > 254) return j({ error: 'Ingresá un email válido' }, 400);
        if (typeof password !== 'string' || password.length < 8 || password.length > 200) return j({ error: 'La contraseña debe tener entre 8 y 200 caracteres' }, 400);
        if (await env.KV.get('user:' + em)) return j({ error: 'Ya existe una cuenta con ese email' }, 409);
        const { salt, hash } = await hashPass(password);
        await env.KV.put('user:' + em, JSON.stringify({ salt, hash, data: sanitizeState(null), createdAt: Date.now() }));
        return j({ token: await makeToken(em, env) });
      }

      if (url.pathname === '/login' && req.method === 'POST') {
        const { email, password } = await req.json();
        const em = String(email || '').trim().toLowerCase();
        const bad = () => j({ error: 'Email o contraseña incorrectos' }, 401);
        if (typeof password !== 'string' || password.length > 200) return bad();
        const raw = await env.KV.get('user:' + em);
        if (!raw) return bad();
        const u = JSON.parse(raw);
        const { hash } = await hashPass(password, u.salt);
        if (!safeEq(hash, u.hash)) return bad();
        return j({ token: await makeToken(em, env) });
      }

      const email = await verifyToken((req.headers.get('Authorization') || '').replace(/^Bearer /, ''), env);

      if (url.pathname === '/data' && req.method === 'GET') {
        if (!email) return j({ error: 'No autenticado' }, 401);
        const raw = await env.KV.get('user:' + email);
        if (!raw) return j({ error: 'No autenticado' }, 401);
        return j({ data: sanitizeState(JSON.parse(raw).data) });
      }

      if (url.pathname === '/data' && req.method === 'PUT') {
        if (!email) return j({ error: 'No autenticado' }, 401);
        const body = await req.text();
        if (body.length > MAX_BODY) return j({ error: 'Demasiados datos' }, 413);
        const incoming = JSON.parse(body).data;
        const raw = await env.KV.get('user:' + email);
        if (!raw) return j({ error: 'No autenticado' }, 401);
        const u = JSON.parse(raw);
        const before = JSON.stringify(sanitizeState(u.data));
        const merged = mergeState(u.data, incoming);
        // KV gratis permite pocas escrituras por día: solo se escribe si algo cambió.
        if (JSON.stringify(merged) !== before) {
          u.data = merged;
          await env.KV.put('user:' + email, JSON.stringify(u));
        }
        return j({ data: merged });
      }

      if (url.pathname === '/account' && req.method === 'DELETE') {
        if (!email) return j({ error: 'No autenticado' }, 401);
        await env.KV.delete('user:' + email);
        return j({ ok: true });
      }

      return j({ error: 'No encontrado' }, 404);
    } catch (err) {
      return j({ error: 'Error del servidor' }, 500);
    }
  }
};
