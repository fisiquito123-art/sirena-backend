// SIRENA — backend con base de datos persistente (libSQL / Turso)
// -------------------------------------------------------------
// Estructura inspirada en Ushahidi Platform:
//  - Reportes (posts) con estado: pendiente / aprobado / descartado
//  - Eventos (collections/sets): agrupan reportes por desastre específico
//  - Usuarios con ROLES: 'admin' (gestiona todo) y 'moderador' (solo aprueba/descarta)
//  - Feed público (lista) además del mapa
//
// BASE DE DATOS:
//  - Sin TURSO_DATABASE_URL configurada: usa un archivo local (reportes.db) — para probar
//    en tu computadora.
//  - Con TURSO_DATABASE_URL + TURSO_AUTH_TOKEN: base de datos remota permanente (turso.tech).
//    Ver README.md.
//
// Cómo correrlo localmente:
//   npm install
//   node server.js
//   http://localhost:3000            (formulario ciudadano)
//   http://localhost:3000/feed.html  (lista pública de reportes aprobados)
//   http://localhost:3000/mapa.html  (mapa)
//   http://localhost:3000/moderar.html (panel de moderación / administración)
//
// Usuario admin inicial (se crea solo la primera vez que arranca, si no hay usuarios):
//   usuario: el valor de MOD_USER (por defecto 'moderador')
//   contraseña: el valor de MOD_PASS (por defecto 'demo2026')
//   rol: admin

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

const CATEGORIAS_INICIALES = [
  { key: 'inundacion',  label: 'Inundación',        color: '#1D74C4' },
  { key: 'fallecido',   label: 'Fallecido',         color: '#C6392F' },
  { key: 'atrapado',    label: 'Herido / atrapado', color: '#DB7A2C' },
  { key: 'estructural', label: 'Daño estructural',  color: '#7B57B0' },
  { key: 'via',         label: 'Vía bloqueada',     color: '#B9860F' },
  { key: 'necesidad',   label: 'Necesidad urgente', color: '#158F76' }
];

// ---------- Utilidades de contraseña (sin dependencias externas) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hashGuardado) {
  const intento = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(intento, 'hex');
  const b = Buffer.from(hashGuardado, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

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
      evento_id TEXT,
      geom_type TEXT NOT NULL DEFAULT 'point',
      geom_json TEXT,
      creado_en INTEGER NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS eventos (
      id TEXT PRIMARY KEY,
      nombre TEXT NOT NULL,
      descripcion TEXT,
      activo INTEGER NOT NULL DEFAULT 1,
      creado_en INTEGER NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id TEXT PRIMARY KEY,
      usuario TEXT NOT NULL UNIQUE,
      salt TEXT NOT NULL,
      hash TEXT NOT NULL,
      rol TEXT NOT NULL DEFAULT 'moderador',
      creado_en INTEGER NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS categorias (
      id TEXT PRIMARY KEY,
      clave TEXT NOT NULL UNIQUE,
      etiqueta TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#333333',
      creado_en INTEGER NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS campos_personalizados (
      id TEXT PRIMARY KEY,
      clave TEXT NOT NULL UNIQUE,
      etiqueta TEXT NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'text',
      opciones_json TEXT,
      requerido INTEGER NOT NULL DEFAULT 0,
      orden INTEGER NOT NULL DEFAULT 0,
      creado_en INTEGER NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS config (
      clave TEXT PRIMARY KEY,
      valor TEXT NOT NULL
    )
  `);
  try { await db.execute('ALTER TABLE reportes ADD COLUMN datos_extra TEXT'); } catch (e) {}
  // Compatibilidad con bases de datos creadas antes de estas columnas
  try { await db.execute('ALTER TABLE reportes ADD COLUMN evento_id TEXT'); } catch (e) {}
  try { await db.execute("ALTER TABLE reportes ADD COLUMN geom_type TEXT NOT NULL DEFAULT 'point'"); } catch (e) {}
  try { await db.execute('ALTER TABLE reportes ADD COLUMN geom_json TEXT'); } catch (e) {}

  // Sembrar categorías iniciales si la tabla está vacía
  const catCount = await db.execute('SELECT COUNT(*) as n FROM categorias');
  if (Number(catCount.rows[0].n) === 0) {
    for (const c of CATEGORIAS_INICIALES) {
      await db.execute({
        sql: 'INSERT INTO categorias (id, clave, etiqueta, color, creado_en) VALUES (?, ?, ?, ?, ?)',
        args: [crypto.randomUUID(), c.key, c.label, c.color, Date.now()]
      });
    }
    console.log('Categorías iniciales creadas.');
  }

  // Crear el usuario admin inicial si todavía no hay ningún usuario
  const count = await db.execute('SELECT COUNT(*) as n FROM usuarios');
  if (Number(count.rows[0].n) === 0) {
    const usuarioInicial = process.env.MOD_USER || 'moderador';
    const passInicial = process.env.MOD_PASS || 'demo2026';
    const { salt, hash } = hashPassword(passInicial);
    await db.execute({
      sql: 'INSERT INTO usuarios (id, usuario, salt, hash, rol, creado_en) VALUES (?, ?, ?, ?, ?, ?)',
      args: [crypto.randomUUID(), usuarioInicial, salt, hash, 'admin', Date.now()]
    });
    console.log(`Usuario admin inicial creado: ${usuarioInicial} (rol: admin)`);
  }
}

async function obtenerCategorias() {
  const result = await db.execute('SELECT * FROM categorias ORDER BY creado_en ASC');
  const mapa = {};
  result.rows.forEach(c => { mapa[c.clave] = { label: c.etiqueta, color: c.color }; });
  return mapa;
}

// ---------- Autenticación con roles ----------
const sessions = new Map(); // token -> { id, usuario, rol }

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const sesion = token && sessions.get(token);
  if (!sesion) return res.status(401).json({ error: 'No autorizado' });
  req.sesion = sesion;
  next();
}
function requireAdmin(req, res, next) {
  if (req.sesion.rol !== 'admin') return res.status(403).json({ error: 'Solo un administrador puede hacer esto' });
  next();
}

app.post('/api/login', async (req, res) => {
  const { usuario, contrasena } = req.body || {};
  if (!usuario || !contrasena) return res.status(400).json({ error: 'Falta usuario o contraseña' });

  const result = await db.execute({ sql: 'SELECT * FROM usuarios WHERE usuario = ?', args: [usuario] });
  const fila = result.rows[0];
  if (!fila || !verifyPassword(contrasena, fila.salt, fila.hash)) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { id: fila.id, usuario: fila.usuario, rol: fila.rol });
  res.json({ token, usuario: fila.usuario, rol: fila.rol });
});

app.post('/api/logout', requireAuth, (req, res) => {
  const token = req.headers.authorization.slice(7);
  sessions.delete(token);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json(req.sesion);
});

// ---------- Usuarios (solo admin) ----------
app.get('/api/usuarios', requireAuth, requireAdmin, async (req, res) => {
  const result = await db.execute('SELECT id, usuario, rol, creado_en FROM usuarios ORDER BY creado_en ASC');
  res.json(result.rows);
});

app.post('/api/usuarios', requireAuth, requireAdmin, async (req, res) => {
  const { usuario, contrasena, rol } = req.body || {};
  if (!usuario || !contrasena) return res.status(400).json({ error: 'Falta usuario o contraseña' });
  if (contrasena.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  const rolFinal = rol === 'admin' ? 'admin' : 'moderador';
  const { salt, hash } = hashPassword(contrasena);
  try {
    const id = crypto.randomUUID();
    await db.execute({
      sql: 'INSERT INTO usuarios (id, usuario, salt, hash, rol, creado_en) VALUES (?, ?, ?, ?, ?, ?)',
      args: [id, usuario, salt, hash, rolFinal, Date.now()]
    });
    res.status(201).json({ id, usuario, rol: rolFinal });
  } catch (err) {
    res.status(400).json({ error: 'Ese nombre de usuario ya existe' });
  }
});

app.delete('/api/usuarios/:id', requireAuth, requireAdmin, async (req, res) => {
  const admins = await db.execute("SELECT COUNT(*) as n FROM usuarios WHERE rol = 'admin'");
  const objetivo = await db.execute({ sql: 'SELECT rol FROM usuarios WHERE id = ?', args: [req.params.id] });
  if (objetivo.rows[0] && objetivo.rows[0].rol === 'admin' && Number(admins.rows[0].n) <= 1) {
    return res.status(400).json({ error: 'No puedes borrar al único administrador' });
  }
  await db.execute({ sql: 'DELETE FROM usuarios WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
});

// ---------- Categorías (públicas para leer, solo admin para editar) ----------
app.get('/api/categorias', async (req, res) => {
  const result = await db.execute('SELECT * FROM categorias ORDER BY creado_en ASC');
  res.json(result.rows);
});

app.post('/api/categorias', requireAuth, requireAdmin, async (req, res) => {
  const { clave, etiqueta, color } = req.body || {};
  if (!clave || !etiqueta) return res.status(400).json({ error: 'Falta clave o etiqueta' });
  try {
    const id = crypto.randomUUID();
    await db.execute({
      sql: 'INSERT INTO categorias (id, clave, etiqueta, color, creado_en) VALUES (?, ?, ?, ?, ?)',
      args: [id, clave.trim().toLowerCase().replace(/\s+/g, '_'), etiqueta.trim(), color || '#333333', Date.now()]
    });
    res.status(201).json({ id });
  } catch (err) {
    res.status(400).json({ error: 'Esa clave de categoría ya existe' });
  }
});

app.put('/api/categorias/:id', requireAuth, requireAdmin, async (req, res) => {
  const { etiqueta, color } = req.body || {};
  await db.execute({
    sql: 'UPDATE categorias SET etiqueta = COALESCE(?, etiqueta), color = COALESCE(?, color) WHERE id = ?',
    args: [etiqueta || null, color || null, req.params.id]
  });
  res.json({ ok: true });
});

app.delete('/api/categorias/:id', requireAuth, requireAdmin, async (req, res) => {
  await db.execute({ sql: 'DELETE FROM categorias WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
});

// ---------- Integración con HDX (Humanitarian Data Exchange) ----------
// HDX está construido sobre CKAN. Para actualizar un archivo ya existente en un
// dataset de HDX, su API espera: POST a /api/3/action/resource_patch con el
// header Authorization = tu API Key, y el archivo en multipart/form-data.
// Antes de poder enviar algo automáticamente, alguien tiene que:
//   1) Crear una cuenta y una organización en data.humdata.org
//   2) Crear el dataset y subir el CSV una primera vez a mano (esto crea un "resource ID")
//   3) Pegar aquí la API Key (de tu perfil de HDX) y ese Resource ID
// Después de eso, este botón sí sube una actualización real, no es una simulación.

app.get('/api/config/hdx', requireAuth, requireAdmin, async (req, res) => {
  const result = await db.execute("SELECT * FROM config WHERE clave IN ('hdx_api_key','hdx_resource_id')");
  const config = {};
  result.rows.forEach(r => { config[r.clave] = r.valor; });
  res.json({
    hdx_api_key: config.hdx_api_key ? '••••••••' + config.hdx_api_key.slice(-4) : '',
    hdx_resource_id: config.hdx_resource_id || '',
    configurado: !!(config.hdx_api_key && config.hdx_resource_id)
  });
});

app.put('/api/config/hdx', requireAuth, requireAdmin, async (req, res) => {
  const { hdx_api_key, hdx_resource_id } = req.body || {};
  if (hdx_api_key) {
    await db.execute({
      sql: 'INSERT INTO config (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor',
      args: ['hdx_api_key', hdx_api_key]
    });
  }
  if (hdx_resource_id !== undefined) {
    await db.execute({
      sql: 'INSERT INTO config (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor',
      args: ['hdx_resource_id', hdx_resource_id]
    });
  }
  res.json({ ok: true });
});

async function generarHxlCsv() {
  const result = await db.execute("SELECT * FROM reportes WHERE estado='aprobado' ORDER BY creado_en DESC");
  const categorias = await obtenerCategorias();
  const camposResult = await db.execute('SELECT * FROM campos_personalizados ORDER BY orden ASC');
  const camposExtra = camposResult.rows;

  const columnasFijas = ['fecha', 'categoria', 'descripcion', 'cantidad', 'lat', 'lng', 'tipo_geometria', 'geometria_geojson'];
  const etiquetasFijas = ['#date', '#category', '#description', '#affected', '#geo+lat', '#geo+lon', '#geo+type', '#geo+shape'];
  const columnas = [...columnasFijas, ...camposExtra.map(c => c.clave)];
  const etiquetasHXL = [...etiquetasFijas, ...camposExtra.map(c => `#meta+${c.clave}`)];
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [columnas.join(','), etiquetasHXL.join(',')];

  result.rows.forEach(r => {
    const cat = categorias[r.categoria] ? categorias[r.categoria].label : r.categoria;
    const extra = r.datos_extra ? JSON.parse(r.datos_extra) : {};
    const fila = [new Date(r.creado_en).toISOString(), cat, r.descripcion, r.cantidad, r.lat, r.lng, r.geom_type, r.geom_type === 'polygon' ? r.geom_json : ''];
    camposExtra.forEach(c => fila.push(extra[c.clave] ?? ''));
    lines.push(fila.map(escape).join(','));
  });
  return lines.join('\n');
}

app.post('/api/hdx/enviar', requireAuth, requireAdmin, async (req, res) => {
  const result = await db.execute("SELECT * FROM config WHERE clave IN ('hdx_api_key','hdx_resource_id')");
  const config = {};
  result.rows.forEach(r => { config[r.clave] = r.valor; });

  if (!config.hdx_api_key || !config.hdx_resource_id) {
    return res.status(400).json({ error: 'Falta configurar la API Key y el Resource ID de HDX primero.' });
  }

  try {
    const csv = await generarHxlCsv();
    const form = new FormData();
    form.append('id', config.hdx_resource_id);
    form.append('upload', new Blob([csv], { type: 'text/csv' }), 'sirena_hdx_hxl.csv');

    const respuesta = await fetch('https://data.humdata.org/api/3/action/resource_patch', {
      method: 'POST',
      headers: { 'Authorization': config.hdx_api_key },
      body: form
    });
    const data = await respuesta.json();
    if (!data.success) {
      return res.status(400).json({ error: data.error ? JSON.stringify(data.error) : 'HDX rechazó la actualización.' });
    }
    res.json({ ok: true, url: data.result ? data.result.url : null });
  } catch (err) {
    console.error('Error enviando a HDX:', err);
    res.status(500).json({ error: 'No se pudo conectar con HDX: ' + err.message });
  }
});

// ---------- Configuración del mapa central (lat/lng/zoom inicial) ----------
const CONFIG_DEFAULT = { map_lat: '-10.35', map_lng: '-76.98', map_zoom: '7' };

app.get('/api/config', async (req, res) => {
  const result = await db.execute('SELECT * FROM config');
  const config = { ...CONFIG_DEFAULT };
  result.rows.forEach(r => { config[r.clave] = r.valor; });
  res.json({
    map_lat: parseFloat(config.map_lat),
    map_lng: parseFloat(config.map_lng),
    map_zoom: parseInt(config.map_zoom, 10)
  });
});

app.put('/api/config', requireAuth, requireAdmin, async (req, res) => {
  const { map_lat, map_lng, map_zoom } = req.body || {};
  const entradas = [];
  if (map_lat !== undefined) entradas.push(['map_lat', String(map_lat)]);
  if (map_lng !== undefined) entradas.push(['map_lng', String(map_lng)]);
  if (map_zoom !== undefined) entradas.push(['map_zoom', String(map_zoom)]);
  for (const [clave, valor] of entradas) {
    await db.execute({
      sql: 'INSERT INTO config (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor',
      args: [clave, valor]
    });
  }
  res.json({ ok: true });
});

// ---------- Campos personalizados de la encuesta (diseñador de formulario) ----------
app.get('/api/campos', async (req, res) => {
  const result = await db.execute('SELECT * FROM campos_personalizados ORDER BY orden ASC, creado_en ASC');
  res.json(result.rows.map(c => ({ ...c, opciones: c.opciones_json ? JSON.parse(c.opciones_json) : [] })));
});

const TIPOS_VALIDOS = ['text', 'textarea', 'number', 'select', 'checkbox'];

app.post('/api/campos', requireAuth, requireAdmin, async (req, res) => {
  const { clave, etiqueta, tipo, opciones, requerido, orden } = req.body || {};
  if (!etiqueta || !etiqueta.trim()) return res.status(400).json({ error: 'Falta la etiqueta del campo' });
  if (!TIPOS_VALIDOS.includes(tipo)) return res.status(400).json({ error: 'Tipo de campo inválido' });
  const claveFinal = (clave || etiqueta).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  try {
    const id = crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO campos_personalizados (id, clave, etiqueta, tipo, opciones_json, requerido, orden, creado_en)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, claveFinal, etiqueta.trim(), tipo, opciones ? JSON.stringify(opciones) : null, requerido ? 1 : 0, orden || 0, Date.now()]
    });
    res.status(201).json({ id, clave: claveFinal });
  } catch (err) {
    res.status(400).json({ error: 'Ya existe un campo con ese nombre' });
  }
});

app.put('/api/campos/:id', requireAuth, requireAdmin, async (req, res) => {
  const { etiqueta, tipo, opciones, requerido, orden } = req.body || {};
  await db.execute({
    sql: `UPDATE campos_personalizados SET
            etiqueta = COALESCE(?, etiqueta),
            tipo = COALESCE(?, tipo),
            opciones_json = ?,
            requerido = COALESCE(?, requerido),
            orden = COALESCE(?, orden)
          WHERE id = ?`,
    args: [etiqueta || null, tipo || null, opciones ? JSON.stringify(opciones) : null, requerido !== undefined ? (requerido ? 1 : 0) : null, orden !== undefined ? orden : null, req.params.id]
  });
  res.json({ ok: true });
});

app.delete('/api/campos/:id', requireAuth, requireAdmin, async (req, res) => {
  await db.execute({ sql: 'DELETE FROM campos_personalizados WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
});

// ---------- Eventos (colecciones) ----------
app.get('/api/eventos', async (req, res) => {
  const result = await db.execute('SELECT * FROM eventos WHERE activo = 1 ORDER BY creado_en DESC');
  res.json(result.rows);
});

app.get('/api/eventos/todos', requireAuth, requireAdmin, async (req, res) => {
  const result = await db.execute('SELECT * FROM eventos ORDER BY creado_en DESC');
  res.json(result.rows);
});

app.post('/api/eventos', requireAuth, requireAdmin, async (req, res) => {
  const { nombre, descripcion } = req.body || {};
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'Falta el nombre del evento' });
  const id = crypto.randomUUID();
  await db.execute({
    sql: 'INSERT INTO eventos (id, nombre, descripcion, activo, creado_en) VALUES (?, ?, ?, 1, ?)',
    args: [id, nombre.trim(), descripcion || null, Date.now()]
  });
  res.status(201).json({ id, nombre: nombre.trim() });
});

app.post('/api/eventos/:id/archivar', requireAuth, requireAdmin, async (req, res) => {
  await db.execute({ sql: 'UPDATE eventos SET activo = 0 WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
});
app.post('/api/eventos/:id/reactivar', requireAuth, requireAdmin, async (req, res) => {
  await db.execute({ sql: 'UPDATE eventos SET activo = 1 WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
});

// ---------- Crear reporte (público, sin login) ----------
app.post('/api/reportes', async (req, res) => {
  try {
    const { categoria, lat, lng, descripcion, cantidad, telefono, foto, evento_id, geom_type, polygon, extra } = req.body || {};

    const categorias = await obtenerCategorias();
    if (!categorias[categoria]) return res.status(400).json({ error: 'Categoría inválida' });
    if (!descripcion || descripcion.trim().length < 4) return res.status(400).json({ error: 'Falta descripción' });

    // Validar campos personalizados obligatorios (diseñador de encuestas)
    const camposResult = await db.execute('SELECT * FROM campos_personalizados');
    const extraFinal = extra || {};
    for (const campo of camposResult.rows) {
      if (campo.requerido && (extraFinal[campo.clave] === undefined || extraFinal[campo.clave] === '')) {
        return res.status(400).json({ error: `Falta el campo obligatorio: ${campo.etiqueta}` });
      }
    }

    let tipoGeom = 'point';
    let geomJson = null;
    let finalLat, finalLng;

    if (geom_type === 'polygon') {
      if (!Array.isArray(polygon) || polygon.length < 3) {
        return res.status(400).json({ error: 'El polígono necesita al menos 3 puntos' });
      }
      tipoGeom = 'polygon';
      // GeoJSON usa [lng, lat] y el anillo debe cerrarse (primer punto = último)
      const ring = polygon.map(p => [p.lng, p.lat]);
      ring.push(ring[0]);
      geomJson = JSON.stringify({ type: 'Polygon', coordinates: [ring] });
      // Centroide simple, para poder centrar el mapa y guardar algo en lat/lng
      finalLat = polygon.reduce((s, p) => s + p.lat, 0) / polygon.length;
      finalLng = polygon.reduce((s, p) => s + p.lng, 0) / polygon.length;
    } else {
      if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'Ubicación inválida' });
      finalLat = lat; finalLng = lng;
    }

    const id = crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO reportes (id, categoria, lat, lng, descripcion, cantidad, telefono, foto, estado, evento_id, geom_type, geom_json, datos_extra, creado_en)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?, ?, ?, ?, ?)`,
      args: [id, categoria, finalLat, finalLng, descripcion.trim(), cantidad || null, telefono || null, foto || null, evento_id || null, tipoGeom, geomJson, JSON.stringify(extraFinal), Date.now()]
    });

    res.status(201).json({ id, estado: 'pendiente' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error del servidor al guardar el reporte' });
  }
});

// ---------- Listar reportes (moderador o admin) ----------
app.get('/api/reportes', requireAuth, async (req, res) => {
  const result = await db.execute(`
    SELECT r.*, e.nombre as evento_nombre
    FROM reportes r LEFT JOIN eventos e ON r.evento_id = e.id
    ORDER BY r.creado_en DESC
  `);
  res.json(result.rows);
});

// ---------- Aprobar / descartar (moderador o admin) ----------
app.post('/api/reportes/:id/aprobar', requireAuth, async (req, res) => {
  await db.execute({ sql: "UPDATE reportes SET estado='aprobado' WHERE id=?", args: [req.params.id] });
  res.json({ ok: true });
});
app.post('/api/reportes/:id/descartar', requireAuth, async (req, res) => {
  await db.execute({ sql: "UPDATE reportes SET estado='descartado' WHERE id=?", args: [req.params.id] });
  res.json({ ok: true });
});

// ---------- Feed público (lista + mapa, ambos leen de aquí) ----------
app.get('/api/feed', async (req, res) => {
  const { evento, categoria } = req.query;
  let sql = `
    SELECT r.*, e.nombre as evento_nombre
    FROM reportes r LEFT JOIN eventos e ON r.evento_id = e.id
    WHERE r.estado = 'aprobado'
  `;
  const args = [];
  if (evento) { sql += ' AND r.evento_id = ?'; args.push(evento); }
  if (categoria) { sql += ' AND r.categoria = ?'; args.push(categoria); }
  sql += ' ORDER BY r.creado_en DESC';
  const result = await db.execute({ sql, args });
  res.json(result.rows);
});

// ---------- Feed público GeoJSON — para umap.hotosm.org u otros consumidores ----------
app.get('/reportes.geojson', async (req, res) => {
  const { evento, categoria } = req.query;
  let sql = "SELECT * FROM reportes WHERE estado='aprobado'";
  const args = [];
  if (evento) { sql += ' AND evento_id = ?'; args.push(evento); }
  if (categoria) { sql += ' AND categoria = ?'; args.push(categoria); }
  sql += ' ORDER BY creado_en DESC';
  const result = await db.execute({ sql, args });
  const categorias = await obtenerCategorias();
  const features = result.rows.map(r => {
    const cat = categorias[r.categoria] || { label: r.categoria, color: '#333333' };
    const geometry = (r.geom_type === 'polygon' && r.geom_json)
      ? JSON.parse(r.geom_json)
      : { type: 'Point', coordinates: [r.lng, r.lat] };
    return {
      type: 'Feature',
      geometry,
      properties: {
        name: cat.label,
        description: r.descripcion,
        cantidad: r.cantidad,
        categoria: r.categoria,
        fecha: new Date(r.creado_en).toISOString(),
        campos: r.datos_extra ? JSON.parse(r.datos_extra) : {},
        _umap_options: { color: cat.color, iconClass: 'Circle' }
      }
    };
  });
  res.set('Access-Control-Allow-Origin', '*');
  res.json({ type: 'FeatureCollection', features });
});

// ---------- Exportar datos (solo admin) ----------
app.get('/api/exportar/db', requireAuth, requireAdmin, (req, res) => {
  if (usandoTurso) {
    return res.status(400).json({ error: 'Estás usando Turso (base remota); descarga los datos con Exportar CSV en vez del archivo .db.' });
  }
  res.download(path.join(__dirname, 'reportes.db'), 'reportes.db');
});

app.get('/api/exportar/csv', requireAuth, requireAdmin, async (req, res) => {
  const result = await db.execute('SELECT * FROM reportes ORDER BY creado_en DESC');
  const headers = ['id','categoria','lat','lng','descripcion','cantidad','telefono','estado','evento_id','creado_en'];
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [headers.join(',')];
  result.rows.forEach(r => { lines.push(headers.map(h => escape(r[h])).join(',')); });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="reportes.csv"');
  res.send(lines.join('\n'));
});

// ---------- Actividad (estadísticas para el dashboard) ----------
app.get('/api/activity', requireAuth, async (req, res) => {
  const dias = 14;
  const desde = Date.now() - dias * 24 * 60 * 60 * 1000;

  const porDia = await db.execute({
    sql: `SELECT date(creado_en/1000, 'unixepoch') as dia, COUNT(*) as n
          FROM reportes WHERE creado_en >= ? GROUP BY dia ORDER BY dia ASC`,
    args: [desde]
  });
  const porCategoria = await db.execute(
    `SELECT categoria, COUNT(*) as n FROM reportes GROUP BY categoria ORDER BY n DESC`
  );
  const porEstado = await db.execute(
    `SELECT estado, COUNT(*) as n FROM reportes GROUP BY estado`
  );
  const categorias = await obtenerCategorias();

  res.json({
    por_dia: porDia.rows,
    por_categoria: porCategoria.rows.map(r => ({
      categoria: r.categoria,
      etiqueta: categorias[r.categoria] ? categorias[r.categoria].label : r.categoria,
      color: categorias[r.categoria] ? categorias[r.categoria].color : '#333333',
      n: r.n
    })),
    por_estado: porEstado.rows
  });
});

// ---------- Exportar a HDX (formato HXL — Humanitarian Exchange Language) ----------
// HXL es el estándar que usa el Humanitarian Data Exchange: un CSV normal, pero con
// una segunda fila de "etiquetas" (#date, #geo+lat, #geo+lon, etc.) que cualquier
// herramienta humanitaria (incluyendo GIS de INDECI) puede leer automáticamente.
app.get('/api/exportar/hxl', requireAuth, requireAdmin, async (req, res) => {
  const result = await db.execute("SELECT * FROM reportes WHERE estado='aprobado' ORDER BY creado_en DESC");
  const categorias = await obtenerCategorias();
  const camposResult = await db.execute('SELECT * FROM campos_personalizados ORDER BY orden ASC');
  const camposExtra = camposResult.rows; // columnas dinámicas del diseñador de encuestas

  const columnasFijas = ['fecha', 'categoria', 'descripcion', 'cantidad', 'lat', 'lng', 'tipo_geometria', 'geometria_geojson'];
  const etiquetasFijas = ['#date', '#category', '#description', '#affected', '#geo+lat', '#geo+lon', '#geo+type', '#geo+shape'];

  const columnas = [...columnasFijas, ...camposExtra.map(c => c.clave)];
  const etiquetasHXL = [...etiquetasFijas, ...camposExtra.map(c => `#meta+${c.clave}`)];

  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [columnas.join(','), etiquetasHXL.join(',')];

  result.rows.forEach(r => {
    const cat = categorias[r.categoria] ? categorias[r.categoria].label : r.categoria;
    const extra = r.datos_extra ? JSON.parse(r.datos_extra) : {};
    const fila = [
      new Date(r.creado_en).toISOString(),
      cat,
      r.descripcion,
      r.cantidad,
      r.lat,
      r.lng,
      r.geom_type,
      r.geom_type === 'polygon' ? r.geom_json : ''
    ];
    camposExtra.forEach(c => fila.push(extra[c.clave] ?? ''));
    lines.push(fila.map(escape).join(','));
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="sirena_hdx_hxl.csv"');
  res.send(lines.join('\n'));
});

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`SIRENA backend escuchando en http://localhost:${PORT}`);
    console.log(`Base de datos: ${usandoTurso ? 'Turso (remota, permanente)' : 'archivo local reportes.db'}`);
  });
}).catch(err => {
  console.error('Error inicializando la base de datos:', err);
  process.exit(1);
});
