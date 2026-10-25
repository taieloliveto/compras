# Compras

App personal para crear y gestionar varias listas de compras. PWA instalable, funciona sin conexión y sincroniza tus listas entre dispositivos con una cuenta (email + contraseña).

- **Home**: saludo "Hola *tu nombre*" y "¿Qué vas a agregar hoy?", con el formulario centrado: campo de texto, cantidad (− / +), selector de lista y botón Agregar. Podés cargar varios juntos (`leche, 2 pan, queso x3`) y tocar sugerencias. Al agregar aparece un aviso con "Ver lista". Si repetís un producto, suma la cantidad.
- **Nombre**: se pide al crear la cuenta ("¿Cómo te gustaría que te llamen?") y se cambia en Ajustes. Viaja con la cuenta a todos tus dispositivos.
- **Barra flotante**: Home, Listas y la última lista abierta (acceso rápido) juntas; Ajustes en su propio botón a la derecha. La barra superior queda fija arriba.
- **Fondo de Home**: patrón de íconos de compras que se desvanece hacia abajo (`web/img/pattern.png`). Es solo una máscara, así que el color lo pone el tema claro/oscuro. Para cambiarlo: `python3 -I scripts/make-pattern.py tu-imagen.png`.
- **Mis listas**: ver y gestionar las listas; el botón "+ Nueva lista" está al final. Cada lista puede tener un **emoji aparte del nombre** (se elige de una grilla o se escribe desde el teclado de emojis) y se ve delante del nombre en todas partes; en la barra flotante reemplaza al ícono. Dentro de cada lista: editar nombre y emoji, duplicar, desmarcar todo, vaciar comprados y eliminar.
- **Ventanas flotantes y centradas**; el teclado solo se abre cuando tocás un campo (salvo al crear una lista nueva).
- **Nube y offline**: sesión de 60 días; los cambios de dos dispositivos se combinan producto por producto; funciona sin conexión.

## Cómo está armado

```
compras/
├── web/       La app (HTML/CSS/JS sin build). Es lo que va a Vercel.
├── server/    API en Cloudflare Worker + KV (cuentas y sincronización).
├── shared/    Lógica de combinación de datos, una sola fuente para app y servidor.
└── scripts/   Íconos, sincronización de shared/ y pruebas.
```

Es una **copia nueva** armada a partir de Cierre: la carpeta y el proyecto de Cierre no se tocan. Qué se reutilizó y qué cambió:

| De Cierre | En Compras |
|---|---|
| Esquema de cuentas (email + contraseña con PBKDF2) y sincronización por Worker + KV | Se mantiene, con sesiones que vencen (60 días), mensajes de error genéricos y límites de tamaño |
| Look & feel (tarjetas redondeadas, navegación inferior, hojas modales, avisos) | Se mantiene, con modo claro/oscuro automático y sin depender de Google Fonts |
| Service worker + manifest PWA | Rehecho: la app abre sin conexión y toma las versiones nuevas sola |
| Sincronización: reemplaza todo el contenido | **Combina por producto** (si usás dos dispositivos no se pierden cambios) |
| Síntesis semanal con IA, avisos push, Capacitor/APK | No se llevó (no aplica a listas de compras) |

> **Importante:** el servidor de Compras usa **su propio** KV y su propio `SERVER_SECRET`. No reutilices los de Cierre: mezclarías cuentas y datos entre las dos apps.

## Publicar (≈10 minutos)

Necesitás Node 20+ y cuentas gratuitas de Cloudflare y Vercel.

### 1) Servidor (Cloudflare)

```bash
cd server
npm install
npx wrangler login
npx wrangler kv namespace create compras_kv   # copiá el "id" y pegalo en wrangler.toml
npx wrangler secret put SERVER_SECRET         # un texto largo al azar, ej: openssl rand -base64 48
npx wrangler deploy
```

`wrangler deploy` te imprime la URL, algo como `https://compras-server.tu-usuario.workers.dev`. Probala: `…/health` tiene que responder `{"ok":true}`.

### 2) App (Vercel, proyecto independiente)

1. Subí esta carpeta a un repo nuevo de GitHub (o usá la CLI de Vercel).
2. En Vercel: **Add New → Project** → elegí el repo → **Root Directory: `web`** → Framework Preset: **Other** → sin Build Command → Deploy.
   Con CLI: `cd web && npx vercel --prod` (cuando pregunte, creá un proyecto **nuevo**).
3. **Antes de publicar**, abrí `web/config.js` y poné la URL de tu servidor (la de `wrangler deploy`):
   ```js
   window.COMPRAS_CONFIG = { API_URL: "https://compras-server.tu-usuario.workers.dev" };
   ```
   Con eso la pantalla de ingreso **no pide el servidor**: queda oculto y solo se pide email y contraseña. (Si dejás `API_URL` vacío, la app pide la URL en el ingreso.)
4. Abrí la URL que te da Vercel y creá tu cuenta.

**Si la página queda en blanco o dice "Cargando…" de más:** falta algún archivo en lo publicado. Probá abrir `tu-app.vercel.app/app.js` y `tu-app.vercel.app/merge.js`: si dan 404, no se subieron. En el repo de GitHub, la carpeta `web` tiene que mostrar estos archivos: `index.html`, `app.js`, `merge.js`, `config.js`, `styles.css`, `sw.js`, `manifest.webmanifest`, `vercel.json` y la carpeta `icons` (con 4 imágenes).

> Si copiás a mano la carpeta de Cierre en tu Mac, **borrá cualquier carpeta `.vercel`** antes de desplegar: si no, Vercel lo toma como el proyecto de Cierre y lo pisa.

### 3) Instalarla en el celular

- **Android (Chrome):** menú → *Instalar app*.
- **iPhone (Safari):** Compartir → *Agregar a inicio*.

### Opcional: cerrar la API a tu sitio

En `server/wrangler.toml` descomentá `[vars]` y poné `ALLOWED_ORIGIN = "https://tu-app.vercel.app"`; después `npx wrangler deploy`.

## Desarrollo y pruebas

```bash
# Si editás shared/merge.js, copialo a la app y al servidor:
npm run sync-shared

npm test                  # lógica de datos + servidor (KV simulado), sin dependencias
node scripts/e2e.mjs      # recorrido completo en un navegador real (requiere Playwright con Chromium)
python3 scripts/make-icons.py   # regenera los íconos (requiere Pillow)
```

La app se puede probar local con cualquier servidor estático sobre `web/` (por ejemplo `npx serve web`) y la API con `cd server && npx wrangler dev`.

## Límites a tener en cuenta

- **Plan gratuito de Cloudflare KV:** ~1.000 escrituras por día. La app agrupa los cambios (espera ~1 s) y el servidor no escribe si no hay cambios, así que alcanza de sobra para uso personal.
- **Sesiones:** duran 60 días y no se pueden revocar de a una; para cerrar todas, cambiá `SERVER_SECRET`.
- **Contraseñas:** se guardan con hash (PBKDF2), nunca en texto plano. No hay "olvidé mi contraseña" (haría falta un servicio de email); está pensada para uso personal.
- **Reloj:** si dos dispositivos editan el mismo producto a la vez, gana el cambio más reciente según la hora de cada dispositivo.
