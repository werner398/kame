// Acceso por vendedor a la ventana de ventas.
//
// Los vendedores se leen de KAME (maestro de vendedores, no ocupan licencia).
// Cada uno tiene una clave propia guardada SOLO en nuestra base (hash scrypt,
// nunca la clave en texto). Al entrar recibe una sesión de 12 horas; todo
// documento que emita queda a su nombre en KAME, sin poder elegir otro.
//
// Las claves las asigna el administrador con CLAVE_ADMIN.

const express = require("express");
const crypto = require("crypto");
const db = require("./db");

const router = express.Router();

const HORAS_SESION = 12;
const MAX_FALLOS = 5;
const MINUTOS_BLOQUEO = 10;

// ---------- Utilidades de clave ----------

function hashClave(clave, sal = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(clave), sal, 64).toString("hex");
  return { sal, hash };
}

function claveCorrecta(clave, sal, hashGuardado) {
  const { hash } = hashClave(clave, sal);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(hashGuardado, "hex"));
}

const hashToken = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
const clave = (nombre) => String(nombre || "").trim().toLowerCase();

function esAdmin(req) {
  // Se ignoran espacios al inicio/fin (es fácil pegar uno sin querer en Railway)
  const esperada = String(process.env.CLAVE_ADMIN || "").trim();
  if (!esperada) return false;
  const a = crypto.createHash("sha256").update(String(req.get("x-clave") || "").trim()).digest();
  const b = crypto.createHash("sha256").update(esperada).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------- Sesiones ----------

function sesionDesdeRequest(req) {
  const m = String(req.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const fila = db
    .prepare("SELECT vendedor, vendedor_clave, expira FROM sesiones_vendedor WHERE token_hash = ?")
    .get(hashToken(m[1]));
  if (!fila || fila.expira < Date.now()) return null;
  // El vendedor pudo ser desactivado después de entrar
  const activo = db
    .prepare("SELECT activo FROM claves_vendedor WHERE vendedor_clave = ?")
    .get(fila.vendedor_clave);
  if (!activo || !activo.activo) return null;
  return { vendedor: fila.vendedor };
}

// Middleware para rutas que emiten: deja pasar al admin (CLAVE_ADMIN) o a
// un vendedor con sesión. Deja en req.acceso quién es.
function exigirAcceso(req, res, next) {
  if (esAdmin(req)) {
    req.acceso = { rol: "admin" };
    return next();
  }
  const s = sesionDesdeRequest(req);
  if (s) {
    req.acceso = { rol: "vendedor", vendedor: s.vendedor };
    return next();
  }
  if (!process.env.CLAVE_ADMIN && !req.get("authorization")) {
    return res.status(503).json({ error: "Emisión bloqueada: falta configurar CLAVE_ADMIN en Railway." });
  }
  return res.status(401).json({ error: "Sesión vencida o clave incorrecta. Vuelve a entrar." });
}

function exigirAdmin(req, res, next) {
  if (!process.env.CLAVE_ADMIN) {
    return res.status(503).json({ error: "Falta configurar CLAVE_ADMIN en Railway." });
  }
  if (!esAdmin(req)) return res.status(401).json({ error: "Clave de administrador incorrecta" });
  next();
}

// ---------- Bloqueo por intentos fallidos (en memoria) ----------

const fallos = new Map(); // vendedor_clave -> { n, hasta }

function bloqueado(v) {
  const f = fallos.get(v);
  return f && f.hasta && f.hasta > Date.now() ? Math.ceil((f.hasta - Date.now()) / 60000) : 0;
}
function registrarFallo(v) {
  const f = fallos.get(v) || { n: 0, hasta: 0 };
  f.n += 1;
  if (f.n >= MAX_FALLOS) {
    f.hasta = Date.now() + MINUTOS_BLOQUEO * 60000;
    f.n = 0;
  }
  fallos.set(v, f);
}

// ---------- Rutas ----------
// El listado de vendedores de KAME se inyecta desde documentos.js para no
// duplicar la consulta ni su cache.
function crearRutas(listarVendedores) {
  // GET /api/vendedores — nombres desde KAME y si tienen clave asignada.
  // Público: es lo que llena el desplegable de "Emitido por".
  router.get("/", async (req, res) => {
    try {
      const nombres = await listarVendedores({ forzar: req.query.refrescar === "1" });
      const conClave = new Set(
        db.prepare("SELECT vendedor_clave FROM claves_vendedor WHERE activo = 1").all().map((r) => r.vendedor_clave)
      );
      res.json({
        vendedores: nombres.map((n) => ({ nombre: n, tieneClave: conClave.has(clave(n)) })),
        baseDatosPersistente: db.persistente,
      });
    } catch (error) {
      res.status(502).json({ error: error.message, detalle: error.detalle });
    }
  });

  // POST /api/vendedores/entrar  { vendedor, clave }
  router.post("/entrar", async (req, res) => {
    const { vendedor, clave: claveIngresada } = req.body || {};
    const v = clave(vendedor);
    if (!v || !claveIngresada) return res.status(400).json({ error: "Elige tu nombre y escribe tu clave" });

    const min = bloqueado(v);
    if (min) return res.status(429).json({ error: `Demasiados intentos. Espera ${min} min.` });

    const fila = db.prepare("SELECT * FROM claves_vendedor WHERE vendedor_clave = ? AND activo = 1").get(v);
    if (!fila || !claveCorrecta(claveIngresada, fila.sal, fila.hash)) {
      registrarFallo(v);
      return res.status(401).json({ error: fila ? "Clave incorrecta" : "Este vendedor no tiene clave asignada. Pídesela al administrador." });
    }

    // El nombre debe seguir existiendo en KAME
    let nombreKame = fila.vendedor;
    try {
      const nombres = await listarVendedores();
      const enKame = nombres.find((n) => clave(n) === v);
      if (!enKame) return res.status(403).json({ error: "Este vendedor ya no existe en KAME" });
      nombreKame = enKame;
    } catch {
      // Si KAME no responde, dejamos entrar con el nombre guardado; al emitir se vuelve a validar.
    }

    fallos.delete(v);
    const token = crypto.randomBytes(32).toString("hex");
    const expira = Date.now() + HORAS_SESION * 3600 * 1000;
    db.prepare("DELETE FROM sesiones_vendedor WHERE expira < ?").run(Date.now());
    db.prepare("INSERT INTO sesiones_vendedor (token_hash, vendedor, vendedor_clave, expira) VALUES (?, ?, ?, ?)").run(
      hashToken(token), nombreKame, v, expira
    );
    res.json({ token, vendedor: nombreKame, expira: new Date(expira).toISOString() });
  });

  // POST /api/vendedores/salir
  router.post("/salir", (req, res) => {
    const m = String(req.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
    if (m) db.prepare("DELETE FROM sesiones_vendedor WHERE token_hash = ?").run(hashToken(m[1]));
    res.json({ ok: true });
  });

  // GET /api/vendedores/sesion — quién soy (para retomar sesión al recargar)
  router.get("/sesion", (req, res) => {
    if (esAdmin(req)) return res.json({ rol: "admin" });
    const s = sesionDesdeRequest(req);
    if (!s) return res.status(401).json({ error: "Sin sesión" });
    res.json({ rol: "vendedor", vendedor: s.vendedor });
  });

  // PUT /api/vendedores/clave  { vendedor, clave }  — solo admin
  router.put("/clave", exigirAdmin, async (req, res) => {
    const { vendedor, clave: nueva } = req.body || {};
    if (!vendedor) return res.status(400).json({ error: "Falta el vendedor" });
    if (!nueva || String(nueva).length < 6) {
      return res.status(400).json({ error: "La clave debe tener al menos 6 caracteres" });
    }
    const nombres = await listarVendedores({ forzar: true }).catch(() => null);
    const enKame = nombres?.find((n) => clave(n) === clave(vendedor));
    if (nombres && !enKame) return res.status(404).json({ error: "Ese vendedor no existe en KAME" });

    const { sal, hash } = hashClave(nueva);
    db.prepare(`
      INSERT INTO claves_vendedor (vendedor_clave, vendedor, sal, hash, activo, actualizado)
      VALUES (?, ?, ?, ?, 1, datetime('now'))
      ON CONFLICT(vendedor_clave) DO UPDATE SET vendedor = excluded.vendedor, sal = excluded.sal,
        hash = excluded.hash, activo = 1, actualizado = datetime('now')
    `).run(clave(vendedor), enKame || vendedor, sal, hash);
    // Cambiar la clave cierra las sesiones abiertas de ese vendedor
    db.prepare("DELETE FROM sesiones_vendedor WHERE vendedor_clave = ?").run(clave(vendedor));
    res.json({ ok: true, vendedor: enKame || vendedor });
  });

  // DELETE /api/vendedores/clave  { vendedor }  — quita el acceso (solo admin)
  router.delete("/clave", exigirAdmin, (req, res) => {
    const { vendedor } = req.body || {};
    db.prepare("UPDATE claves_vendedor SET activo = 0, actualizado = datetime('now') WHERE vendedor_clave = ?").run(clave(vendedor));
    db.prepare("DELETE FROM sesiones_vendedor WHERE vendedor_clave = ?").run(clave(vendedor));
    res.json({ ok: true });
  });

  return router;
}

module.exports = { crearRutas, exigirAcceso };
