const express = require("express");
const { llamarKame } = require("./kameClient");
const db = require("./db");

const router = express.Router();

// Solo estos 3 campos son editables desde el dashboard.
// Aunque updArticulo de KAME acepta muchísimos más, nunca los tocamos:
// así evitamos que un bug o un dato mal armado pise configuración
// del producto que el dashboard no debería gestionar.
const CAMPOS_EDITABLES = {
  nombre: "descripcion",
  precioLista: "precioVentaNeto",
  stockMin: "stockMin",
  stockMax: "stockMax",
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

  // Solo aceptamos las claves que definimos como editables. Cualquier
  // otra cosa que venga en el body se ignora silenciosamente.
  const camposInvalidos = Object.keys(cambios).filter((k) => !CAMPOS_EDITABLES[k]);
  if (camposInvalidos.length > 0) {
    return res.status(400).json({
      error: `Estos campos no son editables desde el dashboard: ${camposInvalidos.join(", ")}`,
    });
  }

  // Validaciones básicas antes de escribir a KAME
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
    // 1. Traemos el producto tal como está hoy en KAME
    const actual = await llamarKame(
      `/Maestro/getListArticulo?Sku=${encodeURIComponent(sku)}`
    );
    const productoActual = Array.isArray(actual) ? actual[0] : actual?.data?.[0] ?? actual;

    if (!productoActual) {
      return res.status(404).json({ error: `No se encontró el producto ${sku} en KAME` });
    }

    // 2. Armamos el body completo para updArticulo: partimos de TODO
    // lo que ya tiene el producto, y solo pisamos los campos que
    // el usuario efectivamente cambió. Así nunca borramos accidentalmente
    // configuración que el dashboard no gestiona.
    const bodyActualizacion = {
      ...productoActual,
      usuario: process.env.KAME_USUARIO_SISTEMA,
      sku,
    };

    const registrosAuditoria = [];

    for (const [campoDashboard, valorNuevo] of Object.entries(cambios)) {
      const campoKame = CAMPOS_EDITABLES[campoDashboard];
      const valorAnterior = productoActual[campoKame];

      if (String(valorAnterior) === String(valorNuevo)) continue; // sin cambio real

      bodyActualizacion[campoKame] = valorNuevo;
      registrosAuditoria.push({ campo: campoKame, valorAnterior, valorNuevo });
    }

    if (registrosAuditoria.length === 0) {
      return res.json({ ok: true, mensaje: "No había cambios reales que aplicar" });
    }

    // 3. Escribimos a KAME
    await llamarKame(`/Inventario/updArticulo/${encodeURIComponent(sku)}`, {
      method: "PUT",
      body: JSON.stringify(bodyActualizacion),
    });

    // 4. Auditoría en nuestra propia base — recién después de confirmar
    // que KAME aceptó el cambio
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
