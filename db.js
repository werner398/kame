// Base de datos PROPIA del dashboard. Nunca toca la base de KAME.
// Guarda cosas que el ERP no maneja: comentarios de clientes y de
// productos, el estado "revisado" de facturas vencidas, el registro
// de auditoría de cada cambio que este backend hace en KAME, y los
// proveedores por producto (que KAME confirmó que no maneja).

const Database = require("better-sqlite3");
const path = require("path");

// En Railway, el disco del contenedor se borra en cada despliegue. Si hay
// un volumen conectado (RAILWAY_VOLUME_MOUNT_PATH) o se indica DB_PATH,
// la base vive ahí y sobrevive a los despliegues.
const dbPath =
  process.env.DB_PATH ||
  (process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "dashboard.db")
    : path.join(__dirname, "..", "dashboard.db"));
const dbPersistente = Boolean(process.env.DB_PATH || process.env.RAILWAY_VOLUME_MOUNT_PATH);
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS comentarios_cliente (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rut_cliente TEXT NOT NULL,
    usuario TEXT NOT NULL,
    comentario TEXT NOT NULL,
    fecha TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS comentarios_producto (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT NOT NULL,
    usuario TEXT NOT NULL,
    comentario TEXT NOT NULL,
    fecha TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS facturas_revisadas (
    numero_documento TEXT PRIMARY KEY,
    revisado_por TEXT NOT NULL,
    fecha TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS auditoria_cambios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT NOT NULL,
    campo TEXT NOT NULL,
    valor_anterior TEXT,
    valor_nuevo TEXT,
    usuario TEXT NOT NULL,
    fecha TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS proveedores_producto (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT NOT NULL,
    proveedor TEXT NOT NULL,
    codigo_proveedor TEXT,
    precio REAL,
    moneda TEXT NOT NULL DEFAULT 'CLP',
    cantidad_minima INTEGER,
    plazo_entrega TEXT,
    kg_m REAL,
    activo INTEGER NOT NULL DEFAULT 1,
    usuario TEXT NOT NULL,
    fecha_actualizacion TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Cotizaciones y notas de venta emitidas desde el dashboard hacia KAME,
  -- con lo que se envió, lo que KAME respondió y si se pudo confirmar.
  CREATE TABLE IF NOT EXISTS documentos_emitidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    folio TEXT,
    vendedor TEXT,
    rut TEXT,
    rzn_social TEXT,
    total REAL,
    estado TEXT NOT NULL,
    emitido_por TEXT,
    payload TEXT,
    respuesta TEXT,
    verificacion TEXT,
    error TEXT,
    fecha TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Claves propias de cada vendedor de KAME para entrar a la ventana de
  -- ventas. Solo se guarda el hash (scrypt), nunca la clave.
  CREATE TABLE IF NOT EXISTS claves_vendedor (
    vendedor_clave TEXT PRIMARY KEY,
    vendedor TEXT NOT NULL,
    sal TEXT NOT NULL,
    hash TEXT NOT NULL,
    activo INTEGER NOT NULL DEFAULT 1,
    actualizado TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Archivos adjuntos a un documento emitido (ej. la OC del cliente).
  -- El archivo vive en la carpeta "adjuntos" junto a la base; aquí solo los datos.
  CREATE TABLE IF NOT EXISTS adjuntos_documento (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    documento_id INTEGER NOT NULL,
    nombre TEXT NOT NULL,
    tipo_mime TEXT NOT NULL,
    tamano INTEGER NOT NULL,
    archivo TEXT NOT NULL,
    subido_por TEXT,
    fecha TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sesiones_vendedor (
    token_hash TEXT PRIMARY KEY,
    vendedor TEXT NOT NULL,
    vendedor_clave TEXT NOT NULL,
    expira INTEGER NOT NULL
  );
`);

// Migración: N° y fecha de la OC del cliente en cada documento emitido.
for (const columna of ["nro_oc TEXT", "fecha_oc TEXT"]) {
  try { db.exec(`ALTER TABLE documentos_emitidos ADD COLUMN ${columna}`); } catch { /* ya existe */ }
}

// Migración: si la tabla proveedores_producto ya existía de antes (sin la
// columna "moneda"), la agregamos ahora. Si ya existe, SQLite tira error
// de "columna duplicada" — lo ignoramos a propósito.
try {
  db.exec("ALTER TABLE proveedores_producto ADD COLUMN moneda TEXT NOT NULL DEFAULT 'CLP'");
} catch (error) {
  // La columna ya existía — no hay nada que hacer.
}

db.persistente = dbPersistente;

// Archivos adjuntos (ej. la OC del cliente) en una carpeta junto a la base,
// así también quedan en el volumen de Railway.
const fs = require("fs");
db.carpetaAdjuntos = path.join(path.dirname(dbPath), "adjuntos");
fs.mkdirSync(db.carpetaAdjuntos, { recursive: true });
module.exports = db;
