# SIRENA — backend real con base de datos + conexión a umap.hotosm.org

Esto reemplaza el prototipo anterior (que era solo un archivo HTML sin
servidor). Ahora sí hay un servidor real con base de datos (SQLite) que
guarda los reportes de verdad, y un feed público que **umap.hotosm.org
puede leer en vivo**.

## ¿Qué incluye?

- `server.js` — servidor (Node + Express + SQLite). Guarda los reportes,
  maneja el login del moderador y publica el feed público.
- `public/index.html` — formulario público para que cualquier persona
  reporte un incidente (sin login, sin WhatsApp, solo un link).
- `public/moderar.html` — panel de moderador con login real contra el
  servidor (no un interruptor falso como antes).
- `reportes.db` — se crea solo la primera vez que corres el servidor.
  Esta es la base de datos real.

## 1. Probarlo en tu computadora

```
npm install
node server.js
```

- Formulario ciudadano: http://localhost:3000
- Panel de moderador: http://localhost:3000/moderar.html
  (usuario: `moderador`, contraseña: `demo2026`)
- Feed público para uMap: http://localhost:3000/reportes.geojson

## 2. Publicarlo en internet (para que el otro jefe lo pruebe de verdad)

Mientras esté solo en tu computadora, nadie más lo puede ver. Para que
sea real y accesible desde cualquier lado, necesitas subirlo a un
servicio de hosting. La opción más simple y gratuita para empezar:

**Railway (railway.app)**
1. Crea una cuenta gratis en https://railway.app
2. "New Project" → "Deploy from GitHub repo" (sube esta carpeta a un
   repo de GitHub primero) o usa "Empty Project" y sube los archivos
   directamente.
3. Railway detecta que es un proyecto Node.js y lo levanta solo.
4. En variables de entorno (Settings → Variables), puedes cambiar las
   credenciales del moderador:
   - `MOD_USER=moderador`
   - `MOD_PASS=una-contraseña-mejor-que-demo2026`
5. Te da una URL pública, por ejemplo:
   `https://sirena-production.up.railway.app`

(Render.com y Fly.io funcionan igual de simple, por si prefieres otra opción.)

## 3. Conectar el feed a umap.hotosm.org (para que el mapa SIEMPRE sea uMap)

Una vez que tu servidor esté publicado con una URL real:

1. Entra a https://umap.hotosm.org/es/map/new/ y crea tu mapa,
   centrado en Perú.
2. En el panel de edición, haz clic en **"Importar datos"** (ícono de
   flecha hacia abajo, o `Ctrl+I`).
3. En **"Origen de los datos"**, elige la opción de **URL** (no
   archivo) y pega:
   ```
   https://TU-SERVIDOR.up.railway.app/reportes.geojson
   ```
4. En **"Formato"**, elige `geojson`.
5. Marca la opción de **capa dinámica / datos remotos** (en uMap se
   llama "Dynamic data" o similar según el idioma) — así el mapa vuelve
   a consultar la URL cada vez que alguien lo abre o se mueve por el
   mapa, mostrando los reportes más recientes automáticamente.
6. Guarda el mapa.

Desde ese momento, cualquier reporte que un ciudadano envíe por tu
formulario, y que el moderador apruebe, va a aparecer en el mapa de
**umap.hotosm.org** sin que nadie tenga que subir nada a mano.

## Notas importantes antes de producción real

- Las credenciales de moderador son fijas (`moderador`/`demo2026`) solo
  para que puedan probarlo rápido. Antes de usarlo con datos reales,
  hay que cambiarlas (variables de entorno) y, si va a haber varios
  moderadores, agregar una tabla de usuarios con contraseñas
  encriptadas.
- La categoría "Fallecido" solo guarda cantidad y ubicación — no nombre
  ni foto identificable — por el tema de sensibilidad del dato.
- `reportes.db` es un archivo SQLite. En Railway/Render el disco puede
  reiniciarse en cada despliegue según el plan; para uso serio a largo
  plazo conviene migrar a una base de datos administrada (Postgres),
  pero para probar y validar el flujo esto es suficiente y real.
