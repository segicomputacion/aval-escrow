require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const nodemailer = require('nodemailer');

const app = express();

// ============================================
// CONFIGURACIÓN
// ============================================
const PORT = process.env.PORT || 3001;
const FILE = process.env.DB_PATH || './database.json';
const NODE_ENV = process.env.NODE_ENV || 'development';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@avalescrow.com').toLowerCase();
const FEE_COMPRADOR = 0.02;
const FEE_VENDEDOR = 0.02;
const MONTO_MINIMO = 50000;

app.set('trust proxy', 1); // Railway/NGINX termina TLS

// CORS solo si se configura explícitamente. Por defecto el frontend se
// sirve desde el mismo origen y no hace falta. (Antes estaba abierto al
// mundo: cualquier sitio podía llamar a la API.)
if (process.env.CORS_ORIGIN) {
  app.use(cors({ origin: process.env.CORS_ORIGIN.split(',').map(s => s.trim()) }));
}
app.use(express.json({ limit: '50kb' }));

// Headers de seguridad básicos
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

// Log de requests
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - t}ms)`));
  next();
});

// ============================================
// BASE DE DATOS (JSON con escritura atómica)
// ============================================
let data = { usuarios: [], transacciones: [], sessions: {}, codigos: {} };
try {
  if (fs.existsSync(FILE)) data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch (e) {
  console.error('database.json ilegible, se reinicia:', e.message);
}
// Compatibilidad con archivos viejos
data.usuarios ||= [];
data.transacciones ||= [];
data.sessions ||= {};
data.codigos ||= {};

function save() {
  // Escritura atómica: si el proceso muere a mitad, no se corrompe la DB
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

// Podar sesiones viejas (>30 días) y códigos vencidos
(function prune() {
  const now = Date.now();
  let dirty = false;
  for (const [k, v] of Object.entries(data.sessions)) {
    if (now - new Date(v.created_at).getTime() > 30 * 86400000) { delete data.sessions[k]; dirty = true; }
  }
  for (const [k, v] of Object.entries(data.codigos)) {
    if (v.expira < now) { delete data.codigos[k]; dirty = true; }
  }
  if (dirty) save();
})();

// ============================================
// HELPERS
// ============================================
function hash(p) {
  const s = crypto.randomBytes(16).toString('hex');
  return s + ':' + crypto.scryptSync(p, s, 64).toString('hex');
}
function validPassword(p, stored) {
  try {
    const [s, h] = stored.split(':');
    const x = crypto.scryptSync(p, s, 64);
    return crypto.timingSafeEqual(x, Buffer.from(h, 'hex'));
  } catch { return false; }
}
function pub(u) {
  return {
    id: u.id, email: u.email, nombre: u.nombre,
    es_admin: !!u.es_admin, created_at: u.created_at,
    ultimo_login: u.ultimo_login || null
  };
}
const user = id => data.usuarios.find(x => x.id === id);
const findTx = id => data.transacciones.find(x => x.id === id);
const fee = m => Math.round(m * FEE_COMPRADOR);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function findOrCreateUser(email, nombre) {
  const e = String(email).trim().toLowerCase();
  let u = data.usuarios.find(x => x.email === e);
  if (!u) {
    u = {
      id: uuid(), email: e,
      nombre: String(nombre || e.split('@')[0]).slice(0, 100),
      created_at: new Date().toISOString()
    };
    data.usuarios.push(u);
    save();
  }
  return u;
}

// ---------- Sesiones (tokens Bearer) ----------
function getToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return req.headers['x-session-token'] || '';
}
function createSession(u) {
  const token = crypto.randomBytes(32).toString('hex');
  data.sessions[token] = { usuario_id: u.id, created_at: new Date().toISOString() };
  save();
  return token;
}
function currentUser(req) {
  const token = getToken(req);
  if (!token) return null;
  const s = data.sessions[token];
  if (!s) return null;
  return user(s.usuario_id) || null;
}
function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Ingresá para continuar' });
  req.user = u;
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.es_admin) return res.status(403).json({ error: 'Solo administradores' });
  next();
}

// ---------- Rate limiting (en memoria) ----------
const hits = new Map();
function limit(max, windowMs) {
  return (req, res, next) => {
    const key = req.ip + '|' + req.path;
    const now = Date.now();
    const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Demasiados intentos. Esperá un minuto y probá de nuevo.' });
    arr.push(now);
    hits.set(key, arr);
    next();
  };
}

// ---------- Cadenas de pagos ----------
function raizDe(tx) {
  let r = tx;
  while (r.parent_id) {
    const p = findTx(r.parent_id);
    if (!p) break;
    r = p;
  }
  return r;
}
function cadenaDe(tx) {
  const links = [];
  let cur = raizDe(tx);
  while (cur) {
    links.push(cur);
    cur = cur.chain_child_id ? findTx(cur.chain_child_id) : null;
  }
  return links;
}
// Lo que el vendedor de este eslabón puede retirar:
// monto - fee vendedor - lo comprometido con el eslabón siguiente.
function retiroDisponible(tx) {
  const child = tx.chain_child_id ? findTx(tx.chain_child_id) : null;
  return tx.monto_ars - tx.fee_vendedor_ars - (child ? child.monto_ars : 0);
}
function enrich(t) {
  return {
    ...t,
    comprador_nombre: user(t.comprador_id)?.nombre || '—',
    vendedor_nombre: user(t.vendedor_id)?.nombre || '—'
  };
}

// ============================================
// EMAIL (códigos de acceso)
// ============================================
function makeTransport() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}
async function enviarCodigo(email) {
  const codigo = String(crypto.randomInt(100000, 1000000));
  data.codigos[email] = { codigo, expira: Date.now() + 10 * 60 * 1000, intentos: 0 };
  save();

  const tx = makeTransport();
  if (tx) {
    await tx.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email,
      subject: 'Tu código de AvalEscrow',
      text: `Tu código de acceso: ${codigo}\nVence en 10 minutos. Si no pediste este código, ignoralo.`,
      html: `<p>Tu código de acceso:</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px">${codigo}</p><p style="color:#666">Vence en 10 minutos.</p>`
    });
    return { ok: true };
  }
  // Sin SMTP: en desarrollo devolvemos el código para poder probar.
  if (NODE_ENV !== 'production') return { ok: true, dev_code: codigo };
  return { ok: false, error: 'Servicio de email no configurado (faltan variables SMTP_*)' };
}

// ============================================
// USUARIOS / AUTENTICACIÓN
// ============================================
app.post('/api/usuarios/enviar-codigo', limit(25, 60000), async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Ingresá un email válido' });
  try {
    const r = await enviarCodigo(email);
    if (!r.ok) return res.status(503).json({ error: r.error });
    res.json({ success: true, ...(r.dev_code ? { dev_code: r.dev_code } : {}) });
  } catch (e) {
    console.error('Error enviando código:', e.message);
    res.status(500).json({ error: 'No se pudo enviar el código' });
  }
});

app.post('/api/usuarios/verificar-codigo', limit(25, 60000), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const codigo = String(req.body.codigo || '').trim();
  const reg = data.codigos[email];
  if (!reg || reg.expira < Date.now()) return res.status(401).json({ error: 'El código venció. Pedí uno nuevo.' });
  if (reg.intentos >= 5) {
    delete data.codigos[email]; save();
    return res.status(429).json({ error: 'Demasiados intentos. Pedí un código nuevo.' });
  }
  if (reg.codigo !== codigo) {
    reg.intentos++; save();
    return res.status(401).json({ error: 'Código incorrecto' });
  }
  delete data.codigos[email];
  let u = data.usuarios.find(x => x.email ===email);
  if (!u) {
    u = {
      id: uuid(), email,
      nombre: String(req.body.nombre || email.split('@')[0]).slice(0, 100),
      created_at: new Date().toISOString()
    };
    data.usuarios.push(u);
  }
  u.ultimo_login = new Date().toISOString();
  save();
  res.json({ success: true, ...pub(u), token: createSession(u) });
});

app.post('/api/usuarios/registro', limit(25, 60000), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Ingresá un email válido' });
  if (password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  if (data.usuarios.some(x => x.email === email)) return res.status(409).json({ error: 'Ya existe un usuario con ese email' });
  const u = {
    id: uuid(), email,
    nombre: String(req.body.nombre || email.split('@')[0]).slice(0, 100),
    password: hash(password),
    created_at: new Date().toISOString()
  };
  data.usuarios.push(u); save();
  res.json({ success: true, ...pub(u), token: createSession(u) });
});

app.post('/api/usuarios/login', limit(25, 60000), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const u = data.usuarios.find(x => x.email === email);
  if (!u || !u.password || !validPassword(String(req.body.password || ''), u.password)) {
    return res.status(401).json({ error: 'Email o contraseña incorrectos' });
  }
  u.ultimo_login = new Date().toISOString(); save();
  res.json({ success: true, ...pub(u), token: createSession(u) });
});

app.post('/api/usuarios/logout', requireAuth, (req, res) => {
  delete data.sessions[getToken(req)]; save();
  res.json({ success: true });
});

app.get('/api/usuarios/me', requireAuth, (req, res) => res.json(pub(req.user)));

// ============================================
// TRANSACCIONES
// ============================================
app.post('/api/transacciones', requireAuth, limit(30, 60000), (req, res) => {
  const monto_ars = Number(req.body.monto_ars);
  if (!Number.isInteger(monto_ars) || monto_ars < MONTO_MINIMO) {
    return res.status(400).json({ error: `El monto mínimo es $${MONTO_MINIMO.toLocaleString('es-AR')}` });
  }
  const descripcion = String(req.body.descripcion || '').trim();
  if (descripcion.length < 3 || descripcion.length > 500) {
    return res.status(400).json({ error: 'La descripción debe tener entre 3 y 500 caracteres' });
  }
  const vendedor_email = String(req.body.vendedor_email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(vendedor_email)) return res.status(400).json({ error: 'Email del vendedor inválido' });

  const plazo_dias = Math.min(90, Math.max(1, Number(req.body.plazo_dias) || 7));
  const vendedor = findOrCreateUser(vendedor_email, req.body.vendedor_nombre);
  if (vendedor.id === req.user.id) {
    return res.status(400).json({ error: 'No podés ser vendedor de tu propia transacción' });
  }

  const t = {
    id: uuid(),
    comprador_id: req.user.id,
    vendedor_id: vendedor.id,
    monto_ars,
    fee_comprador_ars: fee(monto_ars),
    fee_vendedor_ars: fee(monto_ars),
    descripcion,
    estado: 'pendiente_pago',
    plazo_dias,
    parent_id: null,
    chain_child_id: null,
    acuerdos: [],
    created_at: new Date().toISOString()
  };
  t.link_pago = `${process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`}/?pagar=${t.id}`;
  data.transacciones.push(t); save();
  res.json(t);
});

app.post('/api/transacciones/cadena', requireAuth, limit(30, 60000), (req, res) => {
  const origen = findTx(req.body.tx_origen_id);
  if (!origen) return res.status(404).json({ error: 'Eslabón origen no encontrado' });
  if (origen.vendedor_id !== req.user.id) {
    return res.status(403).json({ error: 'Solo el vendedor del eslabón anterior puede crear el siguiente' });
  }
  if (origen.estado !== 'depositado') {
    return res.status(409).json({ error: 'El eslabón anterior debe tener los fondos retenidos' });
  }
  if (origen.chain_child_id) return res.status(409).json({ error: 'Este eslabón ya tiene un siguiente' });

  const monto_ars = Number(req.body.monto_ars);
  if (!Number.isInteger(monto_ars) || monto_ars < MONTO_MINIMO) {
    return res.status(400).json({ error: `El monto mínimo es $${MONTO_MINIMO.toLocaleString('es-AR')}` });
  }
  if (monto_ars > origen.monto_ars) {
    return res.status(400).json({ error: 'El monto excede lo disponible en el eslabón anterior' });
  }
  const descripcion = String(req.body.descripcion || '').trim();
  if (descripcion.length < 3 || descripcion.length > 500) {
    return res.status(400).json({ error: 'La descripción debe tener entre 3 y 500 caracteres' });
  }
  const vendedor_email = String(req.body.vendedor_email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(vendedor_email)) return res.status(400).json({ error: 'Email del vendedor inválido' });

  const plazo_dias = Math.min(90, Math.max(1, Number(req.body.plazo_dias) || 7));
  const vendedor = findOrCreateUser(vendedor_email, req.body.vendedor_nombre);
  if (vendedor.id === req.user.id || vendedor.id === origen.comprador_id) {
    return res.status(400).json({ error: 'El vendedor del eslabón no puede ser una de las partes anteriores' });
  }

  const child = {
    id: uuid(),
    comprador_id: req.user.id,       // el vendedor del eslabón anterior compra el siguiente
    vendedor_id: vendedor.id,
    monto_ars,
    fee_comprador_ars: 0,            // en cadena no se cobra fee de comprador (no hay nueva transferencia)
    fee_vendedor_ars: fee(monto_ars),
    descripcion,
    estado: 'depositado',            // cubierto por el depósito del eslabón raíz
    plazo_dias,
    parent_id: origen.id,
    chain_child_id: null,
    acuerdos: [],
    created_at: new Date().toISOString()
  };
  origen.chain_child_id = child.id;
  data.transacciones.push(child); save();
  res.json(enrich(child));
});

app.get('/api/transacciones', requireAuth, (req, res) => {
  const mine = data.transacciones.filter(
    t => t.comprador_id === req.user.id || t.vendedor_id === req.user.id
  );
  res.json(mine.map(enrich));
});

app.get('/api/transacciones/:id', (req, res) => {
  const t = findTx(req.params.id);
  if (!t) return res.status(404).json({ error: 'Transacción no encontrada' });

  const u = currentUser(req);
  const esParticipante = u && (u.id === t.comprador_id || u.id === t.vendedor_id);
  const base = enrich(t);

  // Público (link de pago): sin emails ni datos sensibles
  if (!esParticipante) {
    const { comprador_id, vendedor_id, acuerdos, retiro_alias, retiro_cbu, ...pubTx } = base;
    return res.json(pubTx);
  }

  // Participante: todo + flags para la UI
  const root = raizDe(t);
  const child = t.chain_child_id ? findTx(t.chain_child_id) : null;
  res.json({
    ...base,
    comprador_email: user(t.comprador_id)?.email,
    vendedor_email: user(t.vendedor_id)?.email,
    link_pago: `${process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`}/?pagar=${t.id}`,
    soy_comprador: u.id === t.comprador_id,
    soy_vendedor: u.id === t.vendedor_id,
    es_raiz: !t.parent_id,
    monto_hijo: child ? child.monto_ars : null,
    retiro_solicitado: !!t.retirado,
    monto_retiro: t.vendedor_id === u.id && t.estado === 'completado' && !t.retirado ? retiroDisponible(t) : null,
    raiz_id: root.id,
    acuerdos_resumen: (t.acuerdos || []).map(a => ({
      usuario_id: a.usuario_id,
      nombre: user(a.usuario_id)?.nombre || '—',
      ganador_vendedor: a.ganador_vendedor
    }))
  });
});

// ---------- Pago notificado por el comprador ----------
app.post('/api/webhook/pago', requireAuth, (req, res) => {
  const t = findTx(req.body.transaccion_id);
  if (!t) return res.status(404).json({ error: 'Transacción no encontrada' });
  if (t.comprador_id !== req.user.id) return res.status(403).json({ error: 'Solo el comprador puede notificar el pago' });
  if (t.estado !== 'pendiente_pago') return res.status(409).json({ error: `La transacción ya está en estado "${t.estado}"` });
  t.estado = 'depositado';
  t.depositado_at = new Date().toISOString();
  save();
  res.json({ success: true, estado: t.estado });
});

// ---------- Confirmar entrega (libera la cadena desde el raíz) ----------
app.post('/api/transacciones/:id/confirmar', requireAuth, (req, res) => {
  const t = findTx(req.params.id);
  if (!t) return res.status(404).json({ error: 'Transacción no encontrada' });
  if (t.parent_id) {
    return res.status(400).json({ error: 'La cadena se libera confirmando el eslabón inicial' });
  }
  if (t.comprador_id !== req.user.id) return res.status(403).json({ error: 'Solo el comprador puede confirmar' });
  if (t.estado !== 'depositado') return res.status(409).json({ error: `No se puede confirmar en estado "${t.estado}"` });

  const links = cadenaDe(t);
  const ahora = new Date().toISOString();
  links.forEach(l => { l.estado = 'completado'; l.completado_at = ahora; });
  save();
  res.json({
    success: true,
    estado: t.estado,
    liberados: links.map(l => ({ id: l.id, descripcion: l.descripcion, monto_vendedor: retiroDisponible(l) }))
  });
});

// ---------- Disputas ----------
function puedeResolver(t, ganador) {
  const acuerdos = t.acuerdos || [];
  for (const pid of [t.comprador_id, t.vendedor_id]) {
    if (!acuerdos.some(a => a.usuario_id === pid && a.ganador_vendedor === ganador)) {
      return { ok: false, falta: `la aceptación de ${user(pid)?.nombre || 'una parte'}` };
    }
  }
  // Liberar un eslabón que no es el raíz gasta la confirmación del comprador original
  if (ganador && t.parent_id) {
    const root = raizDe(t);
    if (!acuerdos.some(a => a.usuario_id === root.comprador_id && a.ganador_vendedor === true)) {
      return { ok: false, falta: 'la aceptación del comprador original (libera sus fondos)' };
    }
  }
  return { ok: true };
}

function aplicarResolucion(t, ganadorVendedor) {
  const links = cadenaDe(t);
  const ahora = new Date().toISOString();
  links.forEach(l => {
    l.estado = ganadorVendedor ? 'completado' : 'reembolsado';
    l.resuelto_at = ahora;
  });
}

app.post('/api/transacciones/:id/disputa', requireAuth, (req, res) => {
  const t = findTx(req.params.id);
  if (!t) return res.status(404).json({ error: 'Transacción no encontrada' });
  if (t.comprador_id !== req.user.id && t.vendedor_id !== req.user.id) {
    return res.status(403).json({ error: 'Solo participantes pueden abrir disputa' });
  }
  if (t.estado !== 'depositado') return res.status(409).json({ error: `No se puede abrir disputa en estado "${t.estado}"` });

  const links = cadenaDe(t);
  links.forEach(l => { l.estado = 'disputa'; });
  t.disputa_abierta_por = req.user.id;
  t.disputa_motivo = String(req.body.motivo || '').slice(0, 500);
  t.acuerdos = []; // cada ronda empieza de cero
  save();
  res.json({ success: true, estado: t.estado, congelados: links.length });
});

app.post('/api/transacciones/:id/aceptar-acuerdo', requireAuth, (req, res) => {
  const t = findTx(req.params.id);
  if (!t) return res.status(404).json({ error: 'Transacción no encontrada' });
  if (t.estado !== 'disputa') return res.status(409).json({ error: 'No hay disputa activa' });

  const links = cadenaDe(t);
  if (!links.some(l => l.comprador_id === req.user.id || l.vendedor_id === req.user.id)) {
    return res.status(403).json({ error: 'Solo participantes de la cadena pueden aceptar' });
  }

  const ganador = !!req.body.ganador_vendedor;
  t.acuerdos = (t.acuerdos || []).filter(a => a.usuario_id !== req.user.id);
  t.acuerdos.push({ usuario_id: req.user.id, ganador_vendedor: ganador, created_at: new Date().toISOString() });
  save();

  const r = puedeResolver(t, ganador);
  if (r.ok) {
    aplicarResolucion(t, ganador); save();
    return res.json({ success: true, resuelto: true, estado: t.estado });
  }
  res.json({ success: true, resuelto: false, falta: r.falta });
});

// ---------- Admin ----------
app.get('/api/admin/disputas', requireAuth, requireAdmin, (req, res) => {
  res.json(data.transacciones.filter(t => t.estado === 'disputa').map(enrich));
});

app.post('/api/admin/transacciones/:id/resolver', requireAuth, requireAdmin, (req, res) => {
  const t = findTx(req.params.id);
  if (!t) return res.status(404).json({ error: 'Transacción no encontrada' });
  if (t.estado !== 'disputa') return res.status(409).json({ error: 'La transacción no está en disputa' });
  aplicarResolucion(t, !!req.body.ganador_vendedor);
  t.resuelto_por = req.user.id;
  save();
  res.json({ success: true, estado: t.estado });
});

// ---------- Retiro (solo vendedor de cada eslabón) ----------
app.post('/api/transacciones/:id/retirar', requireAuth, (req, res) => {
  const t = findTx(req.params.id);
  if (!t) return res.status(404).json({ error: 'Transacción no encontrada' });
  if (t.vendedor_id !== req.user.id) return res.status(403).json({ error: 'Solo el vendedor puede solicitar el retiro' });
  if (t.estado !== 'completado') return res.status(409).json({ error: 'Los fondos aún no están liberados' });
  if (t.retirado) return res.status(409).json({ error: 'Ya se solicitó el retiro de esta transacción' });

  const alias = String(req.body.alias || '').trim();
  const cbu = String(req.body.cbu || '').trim();
  if (!alias && !cbu) return res.status(400).json({ error: 'Ingresá al menos un alias o CBU' });
  if (alias.length > 100 || cbu.length > 34) return res.status(400).json({ error: 'Datos bancarios inválidos' });

  t.retirado = 1;
  t.retiro_alias = alias || null;
  t.retiro_cbu = cbu || null;
  t.retiro_monto = retiroDisponible(t);
  t.retiro_at = new Date().toISOString();
  save();
  res.json({ success: true, mensaje: `Retiro de $${t.retiro_monto.toLocaleString('es-AR')} solicitado`, monto: t.retiro_monto });
});

// ============================================
// CONFIGURACIÓN / COMISIONES
// ============================================
app.get('/api/config/datos-pago', (req, res) => res.json({
  alias: process.env.BANCO_ALIAS || 'AVAL.ESCROW.PAGOS',
  cbu: process.env.BANCO_CBU || '0000003100000000000001',
  titular: process.env.BANCO_TITULAR || 'AvalEscrow S.A.',
  cuit: process.env.BANCO_CUIT || '30-00000000-0',
  banco: process.env.BANCO_NOMBRE || 'Mercado Pago',
  monto_minimo: MONTO_MINIMO,
  fee_comprador: FEE_COMPRADOR,
  fee_vendedor: FEE_VENDEDOR
}));

app.get('/api/comisiones', (req, res) => res.json({
  fee_comprador: FEE_COMPRADOR, fee_vendedor: FEE_VENDEDOR, monto_minimo: MONTO_MINIMO
}));

app.post('/api/comisiones/calcular', (req, res) => {
  const monto = Number(req.body.monto);
  if (!Number.isInteger(monto) || monto < MONTO_MINIMO) {
    return res.json({ valido: false, error: `El monto mínimo es $${MONTO_MINIMO.toLocaleString('es-AR')}` });
  }
  const fc = fee(monto), fv = fee(monto);
  res.json({
    valido: true, monto, fee_comprador: fc, fee_vendedor: fv,
    total_comprador: monto + fc, total_vendedor: monto - fv
  });
});

// ============================================
// HEALTH / STATIC / SPA
// ============================================
const health = (req, res) => res.json({ ok: true, service: 'aval-escrow' });
app.get('/health', health);
app.get('/api/health', health);

app.use(express.static(path.join(__dirname, '../frontend')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Endpoint no encontrado' });
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ============================================
// ADMIN SEED (solo si ADMIN_PASSWORD está definido — nunca defaults)
// ============================================
if (process.env.ADMIN_PASSWORD) {
  if (!data.usuarios.some(x => x.email === ADMIN_EMAIL)) {
    data.usuarios.push({
      id: 'admin001', email: ADMIN_EMAIL,
      nombre: 'Administrador AvalEscrow',
      password: hash(process.env.ADMIN_PASSWORD),
      es_admin: 1,
      created_at: new Date().toISOString()
    });
    save();
    console.log(`Cuenta admin creada: ${ADMIN_EMAIL}`);
  }
} else {
  console.warn('⚠️  ADMIN_PASSWORD no definido: no se creó cuenta admin (las funciones de admin quedan deshabilitadas).');
}

app.listen(PORT, '0.0.0.0', () => console.log(`AvalEscrow online en puerto ${PORT} (${NODE_ENV})`));
