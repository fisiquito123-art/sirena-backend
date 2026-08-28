// SIRENA — backend real con base de datos (SQLite embebido en Node)
// -------------------------------------------------------------
// Qué hace este servidor:
//  1) Recibe reportes ciudadanos (POST /api/reportes) y los guarda en una BD real (reportes.db)
//  2) Expone un panel de moderación protegido por login (usuario/contraseña)
//  3) Publica un feed GeoJSON en vivo (GET /reportes.geojson) con SOLO los reportes aprobados,
//     pensado para conectarse como "capa remota" en https://umap.hotosm.org/en/
//
// Cómo correrlo localmente:
//   npm install
//   node server.js
//   abre http://localhost:3000  (formulario ciudadano)
//   abre http://localhost:3000/moderar.html  (panel de moderador)
//
// Ver README.md para cómo publicarlo en internet (Railway/Render) y cómo
// conectar el feed a umap.hotosm.org paso a paso.

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Base de datos ----------
const db = new DatabaseSync(path.join(__dirname, 'reportes.db'));
db.exec(`
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
app.post('/api/reportes', (req, res) => {
  const { categoria, lat, lng, descripcion, cantidad, telefono, foto } = req.body || {};

  if (!CATEGORIAS[categoria]) return res.status(400).json({ error: 'Categoría inválida' });
  if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'Ubicación inválida' });
  if (!descripcion || descripcion.trim().length < 4) return res.status(400).json({ error: 'Falta descripción' });

  const id = crypto.randomUUID();
  const stmt = db.prepare(`
    INSERT INTO reportes (id, categoria, lat, lng, descripcion, cantidad, telefono, foto, estado, creado_en)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?)
  `);
  stmt.run(id, categoria, lat, lng, descripcion.trim(), cantidad || null, telefono || null, foto || null, Date.now());

  res.status(201).json({ id, estado: 'pendiente' });
});

// ---------- Listar reportes (moderador, requiere login) ----------
app.get('/api/reportes', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM reportes ORDER BY creado_en DESC').all();
  res.json(rows);
});

// ---------- Aprobar / descartar (moderador) ----------
app.post('/api/reportes/:id/aprobar', requireAuth, (req, res) => {
  db.prepare("UPDATE reportes SET estado='aprobado' WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});
app.post('/api/reportes/:id/descartar', requireAuth, (req, res) => {
  db.prepare("UPDATE reportes SET estado='descartado' WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// ---------- Feed público GeoJSON — esto es lo que consume umap.hotosm.org ----------
app.get('/reportes.geojson', (req, res) => {
  const rows = db.prepare("SELECT * FROM reportes WHERE estado='aprobado' ORDER BY creado_en DESC").all();
  const features = rows.map(r => ({
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
  res.download(path.join(__dirname, 'reportes.db'), 'reportes.db');
});

app.get('/api/exportar/csv', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM reportes ORDER BY creado_en DESC').all();
  const headers = ['id','categoria','lat','lng','descripcion','cantidad','telefono','estado','creado_en'];
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [headers.join(',')];
  rows.forEach(r => {
    lines.push(headers.map(h => escape(r[h])).join(','));
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="reportes.csv"');
  res.send(lines.join('\n'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SIRENA backend escuchando en http://localhost:${PORT}`);
  console.log(`Feed público para uMap: http://localhost:${PORT}/reportes.geojson`);
});
