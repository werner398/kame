// Base de datos PROPIA del dashboard. Nunca toca la base de KAME.
// Guarda cosas que el ERP no maneja: comentarios de clientes,
// el estado "revisado" de facturas vencidas, y el registro de auditoría
// de cada cambio que este backend hace en KAME (producto/precio/etc).

const Database = require("better-sqlite3");
const path = require("path");

const dbPath = path.join(__dirname, "..", "dashboard.db");
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
`);

module.exports = db;
