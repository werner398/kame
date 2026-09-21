const express = require("express");
const { llamarKame } = require("./kameClient");
const db = require("./db");

const router = express.Router();

// Solo estos 3 campos son editables desde el dashboard.
// Aunque updArticulo de KAME acepta muchísimos más, nunca los tocamos:
// así evitamos que un bug o un dato mal armado pise configuración
// del producto que el dashboard no debería gestionar.
const CAMPOS_EDITABLES = {
  nombre: "Descripcion",
  precioLista: "PrecioVentaNeto",
  stockMin: "StockMin",
  stockMax: "StockMax",
};

router.get("/:sku", async (req, res) => {
  try {
    const datos = await llamarKame(
      `/Maestro/getListArticulo?Sku=${encodeURIComponent(req.params.sku)}`
    );
    res.json(datos);
  } catch (error) {
    res.status(500).json({ error: error.message, detalle: error.detalle });
  }
});

router.get("/:sku/auditoria", (req, res) => {
  const cambios = db
    .prepare(
      "SELECT campo, valor_anterior, valor_nuevo, usuario, fecha FROM auditoria_cambios WHERE sku = ? ORDER BY fecha DESC"
    )
    .all(req.params.sku);
  res.json(cambios);
});

// GET /api/productos/:sku/comentarios — lista los comentarios/notas
// guardados para ese producto (registro propio, no vive en KAME).
router.get("/:sku/comentarios", (req, res) => {
  const comentarios = db
    .prepare(
      "SELECT id, usuario, comentario, fecha FROM comentarios_producto WHERE sku = ? ORDER BY fecha DESC"
    )
    .all(req.params.sku);
  res.json(comentarios);
});

// POST /api/productos/:sku/comentarios — agrega una nota nueva al producto
router.post("/:sku/comentarios", (req, res) => {
  const { usuario, comentario } = req.body;

  if (!usuario || !comentario) {
    return res.status(400).json({ error: "Faltan usuario o comentario" });
  }

  const resultado = db
    .prepare(
      "INSERT INTO comentarios_producto (sku, usuario, comentario) VALUES (?, ?, ?)"
    )
    .run(req.params.sku, usuario, comentario);

  res.json({ ok: true, id: resultado.lastInsertRowid });
});

// PUT /api/productos/:sku
// Body esperado: { usuario, cambios: { nombre?, precioLista?, stockMin?, stockMax? } }
router.put("/:sku", async (req, res) => {
  const { sku } = req.params;
  const { usuario, cambios } = req.body;

  if (!usuario) {
    return res.status(400).json({ error: "Falta indicar qué usuario hace el cambio" });
  }
  if (!cambios || Object.keys(cambios).length === 0) {
    return res.status(400).json({ error: "No se enviaron cambios" });
  }

  const camposInvalidos = Object.keys(cambios).filter((k) => !CAMPOS_EDITABLES[k]);
  if (camposInvalidos.length > 0) {
    return res.status(400).json({
      error: `Estos campos no son editables desde el dashboard: ${camposInvalidos.join(", ")}`,
    });
  }

  if (cambios.precioLista !== undefined && Number(cambios.precioLista) <= 0) {
    return res.status(400).json({ error: "El precio de lista debe ser mayor a 0" });
  }
  if (
    cambios.stockMin !== undefined &&
    cambios.stockMax !== undefined &&
    Number(cambios.stockMin) > Number(cambios.stockMax)
  ) {
    return res.status(400).json({ error: "El mínimo no puede ser mayor que el máximo" });
  }

  try {
    const actual = await llamarKame(
      `/Maestro/getListArticulo?Sku=${encodeURIComponent(sku)}`
    );
    const lista = Array.isArray(actual) ? actual : (actual?.items ?? actual?.data ?? []);
    const productoActual = lista[0];

    if (!productoActual) {
      return res.status(404).json({ error: `No se encontró el producto ${sku} en KAME` });
    }

    const bodyActualizacion = {
      ...productoActual,
      usuario: process.env.KAME_USUARIO_SISTEMA,
    };

    if (typeof bodyActualizacion.UsaSeguimientoLotes === "string") {
      bodyActualizacion.UsaSeguimientoLotes = bodyActualizacion.UsaSeguimientoLotes === "S";
    }

    const registrosAuditoria = [];

    for (const [campoDashboard, valorNuevo] of Object.entries(cambios)) {
      const campoKame = CAMPOS_EDITABLES[campoDashboard];
      const valorAnterior = productoActual[campoKame];

      if (String(valorAnterior) === String(valorNuevo)) continue;

      bodyActualizacion[campoKame] = valorNuevo;
      registrosAuditoria.push({ campo: campoKame, valorAnterior, valorNuevo });
    }

    if (registrosAuditoria.length === 0) {
      return res.json({ ok: true, mensaje: "No había cambios reales que aplicar" });
    }

    await llamarKame(`/Inventario/updArticulo/${encodeURIComponent(sku)}`, {
      method: "PUT",
      body: JSON.stringify(bodyActualizacion),
    });

    const insertar = db.prepare(
      "INSERT INTO auditoria_cambios (sku, campo, valor_anterior, valor_nuevo, usuario) VALUES (?, ?, ?, ?, ?)"
    );
    for (const registro of registrosAuditoria) {
      insertar.run(sku, registro.campo, String(registro.valorAnterior), String(registro.valorNuevo), usuario);
    }

    res.json({ ok: true, cambiosAplicados: registrosAuditoria });
  } catch (error) {
    res.status(500).json({ error: error.message, detalle: error.detalle });
  }
});

module.exports = { router };
