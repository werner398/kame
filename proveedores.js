const express = require("express");
const db = require("./db");

const router = express.Router();

// Esto vive SOLO en nuestra base de datos — KAME confirmó que no maneja
// relación producto-proveedor a nivel de ERP, así que no hay nada que
// sincronizar con la API. Es un registro paralelo propio del dashboard.

// GET /api/proveedores/:sku — lista los proveedores guardados para ese producto
router.get("/:sku", (req, res) => {
  const filas = db
    .prepare(
      "SELECT id, proveedor, codigo_proveedor, precio, cantidad_minima, plazo_entrega, kg_m, activo, usuario, fecha_actualizacion FROM proveedores_producto WHERE sku = ? ORDER BY activo DESC, fecha_actualizacion DESC"
    )
    .all(req.params.sku);
  res.json(filas);
});

// POST /api/proveedores/:sku — agrega una nueva relación producto-proveedor
router.post("/:sku", (req, res) => {
  const { proveedor, codigoProveedor, precio, kgM, usuario } = req.body;

  if (!proveedor || !usuario) {
    return res.status(400).json({ error: "Faltan datos: proveedor y usuario son obligatorios" });
  }

  const resultado = db
    .prepare(
      `INSERT INTO proveedores_producto
       (sku, proveedor, codigo_proveedor, precio, kg_m, usuario, activo)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    )
    .run(req.params.sku, proveedor, codigoProveedor || null, precio || null, kgM || null, usuario);

  res.json({ ok: true, id: resultado.lastInsertRowid });
});

// PUT /api/proveedores/:sku/:id — actualiza una relación ya existente
router.put("/:sku/:id", (req, res) => {
  const { precio, cantidadMinima, plazoEntrega, activo, usuario } = req.body;

  if (!usuario) {
    return res.status(400).json({ error: "Falta indicar qué usuario hace el cambio" });
  }

  const fila = db
    .prepare("SELECT * FROM proveedores_producto WHERE id = ? AND sku = ?")
    .get(req.params.id, req.params.sku);

  if (!fila) {
    return res.status(404).json({ error: "No se encontró esa relación producto-proveedor" });
  }

  db.prepare(
    `UPDATE proveedores_producto
     SET precio = ?, cantidad_minima = ?, plazo_entrega = ?, activo = ?, usuario = ?, fecha_actualizacion = datetime('now')
     WHERE id = ?`
  ).run(
    precio ?? fila.precio,
    cantidadMinima ?? fila.cantidad_minima,
    plazoEntrega ?? fila.plazo_entrega,
    activo !== undefined ? (activo ? 1 : 0) : fila.activo,
    usuario,
    req.params.id
  );

  res.json({ ok: true });
});

module.exports = { router };
