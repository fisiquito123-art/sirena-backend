// SIRENA — backend real con base de datos persistente (libSQL / Turso)
// -------------------------------------------------------------
// Qué hace este servidor:
//  1) Recibe reportes ciudadanos (POST /api/reportes) y los guarda en una BD real
//  2) Expone un panel de moderación protegido por login (usuario/contraseña)
//  3) Publica un feed GeoJSON en vivo (GET /reportes.geojson) con SOLO los reportes aprobados,
//     pensado para conectarse como "capa remota" en https://umap.hotosm.org/en/
//
// BASE DE DATOS — esto es lo importante:
//  - Si NO configuras TURSO_DATABASE_URL, usa un archivo local (reportes.db) — perfecto
//    para probar en tu computadora, pero se resetea si lo corres en un servidor con
//    disco temporal (como el plan gratis de Render).
//  - Si SÍ configuras TURSO_DATABASE_URL y TURSO_AUTH_TOKEN (variables de entorno),
//    los datos se guardan en una base de datos remota gratuita y permanente (turso.tech),
//    que NO se borra aunque el servidor se reinicie o se duerma. Ver README.md para
//    cómo crear la cuenta gratis y obtener esas dos variables.
//
// Cómo correrlo localmente:
//   npm install
//   node server.js
//   abre http://localhost:3000  (formulario ciudadano)
//   abre http://localhost:3000/moderar.html  (panel de moderador)

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@libsql/client');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Base de datos ----------
const usandoTurso = !!process.env.TURSO_DATABASE_URL;
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || `file:${path.join(__dirname, 'reportes.db')}`,
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS reportes (
      id TEXT PRIMARY KEY,
      categoria TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      descripcion TEXT,
      cantidad INTEGER,
      telefono TEXT,
      foto TEXT,
      estado TEXT NOT NULL DEFAULT 'pendiente',
      creado_en INTEGER NOT NULL
    )
  `);
}

const CATEGORIAS = {
  inundacion:  { label: 'Inundación',        color: '#1D74C4' },
  fallecido:   { label: 'Fallecido',         color: '#C6392F' },
  atrapado:    { label: 'Herido / atrapado', color: '#DB7A2C' },
  estructural: { label: 'Daño estructural',  color: '#7B57B0' },
  via:         { label: 'Vía bloqueada',     color: '#B9860F' },
  necesidad:   { label: 'Necesidad urgente', color: '#158F76' }
};

// ---------- Autenticación simple de moderador ----------
// Prototipo: credenciales fijas + tokens de sesión en memoria.
// Antes de producción real: reemplazar por usuarios en la BD con contraseñas
// hasheadas (bcrypt) y tokens con expiración real (JWT o sesiones persistentes).
const MOD_USER = process.env.MOD_USER || 'moderador';
const MOD_PASS = process.env.MOD_PASS || 'demo2026';
const sessions = new Set();

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token && sessions.has(token)) return next();
  return res.status(401).json({ error: 'No autorizado' });
}

app.post('/api/login', (req, res) => {
  const { usuario, contrasena } = req.body || {};
  if (usuario === MOD_USER && contrasena === MOD_PASS) {
    const token = crypto.randomBytes(24).toString('hex');
    sessions.add(token);
    return res.json({ token });
  }
  return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
});

app.post('/api/logout', requireAuth, (req, res) => {
  const token = req.headers.authorization.slice(7);
  sessions.delete(token);
  res.json({ ok: true });
});

// ---------- Crear reporte (público, sin login) ----------
app.post('/api/reportes', async (req, res) => {
  try {
    const { categoria, lat, lng, descripcion, cantidad, telefono, foto } = req.body || {};

    if (!CATEGORIAS[categoria]) return res.status(400).json({ error: 'Categoría inválida' });
    if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'Ubicación inválida' });
    if (!descripcion || descripcion.trim().length < 4) return res.status(400).json({ error: 'Falta descripción' });

    const id = crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO reportes (id, categoria, lat, lng, descripcion, cantidad, telefono, foto, estado, creado_en)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?)`,
      args: [id, categoria, lat, lng, descripcion.trim(), cantidad || null, telefono || null, foto || null, Date.now()]
    });

    res.status(201).json({ id, estado: 'pendiente' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error del servidor al guardar el reporte' });
  }
});

// ---------- Listar reportes (moderador, requiere login) ----------
app.get('/api/reportes', requireAuth, async (req, res) => {
  const result = await db.execute('SELECT * FROM reportes ORDER BY creado_en DESC');
  res.json(result.rows);
});

// ---------- Aprobar / descartar (moderador) ----------
app.post('/api/reportes/:id/aprobar', requireAuth, async (req, res) => {
  await db.execute({ sql: "UPDATE reportes SET estado='aprobado' WHERE id=?", args: [req.params.id] });
  res.json({ ok: true });
});
app.post('/api/reportes/:id/descartar', requireAuth, async (req, res) => {
  await db.execute({ sql: "UPDATE reportes SET estado='descartado' WHERE id=?", args: [req.params.id] });
  res.json({ ok: true });
});

// ---------- Feed público GeoJSON — esto es lo que consume umap.hotosm.org ----------
app.get('/reportes.geojson', async (req, res) => {
  const result = await db.execute("SELECT * FROM reportes WHERE estado='aprobado' ORDER BY creado_en DESC");
  const features = result.rows.map(r => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
    properties: {
      name: CATEGORIAS[r.categoria] ? CATEGORIAS[r.categoria].label : r.categoria,
      description: r.descripcion,
      cantidad: r.cantidad,
      categoria: r.categoria,
      fecha: new Date(r.creado_en).toISOString(),
      _umap_options: {
        color: CATEGORIAS[r.categoria] ? CATEGORIAS[r.categoria].color : '#333333',
        iconClass: 'Circle'
      }
    }
  }));
  res.set('Access-Control-Allow-Origin', '*'); // necesario para que umap.hotosm.org pueda leerlo
  res.json({ type: 'FeatureCollection', features });
});

// ---------- Exportar datos (moderador) ----------
app.get('/api/exportar/db', requireAuth, (req, res) => {
  if (usandoTurso) {
    return res.status(400).json({ error: 'Estás usando Turso (base remota); descarga los datos con Exportar CSV en vez del archivo .db.' });
  }
  res.download(path.join(__dirname, 'reportes.db'), 'reportes.db');
});

app.get('/api/exportar/csv', requireAuth, async (req, res) => {
  const result = await db.execute('SELECT * FROM reportes ORDER BY creado_en DESC');
  const headers = ['id','categoria','lat','lng','descripcion','cantidad','telefono','estado','creado_en'];
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [headers.join(',')];
  result.rows.forEach(r => {
    lines.push(headers.map(h => escape(r[h])).join(','));
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="reportes.csv"');
  res.send(lines.join('\n'));
});

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`SIRENA backend escuchando en http://localhost:${PORT}`);
    console.log(`Base de datos: ${usandoTurso ? 'Turso (remota, permanente)' : 'archivo local reportes.db (temporal si el disco no persiste)'}`);
    console.log(`Feed público para uMap: http://localhost:${PORT}/reportes.geojson`);
  });
}).catch(err => {
  console.error('Error inicializando la base de datos:', err);
  process.exit(1);
});
