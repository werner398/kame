const express = require("express");
const { llamarKame } = require("./kameClient");
const db = require("./db");

const router = express.Router();

// Este único endpoint de KAME (getCuentaxCobrar) alimenta tanto la
// pantalla "Saldo clientes" como "Facturas Vencidas" del sistema actual.
// La diferencia entre ambas es solo cómo se filtra/agrupa acá.
router.get("/", async (req, res) => {
  try {
    const {
      fechaVencimientoDesde = "2020-01-01",
      fechaVencimientoHasta = new Date().toISOString().slice(0, 10),
      page = 1,
      per_page = 100,
    } = req.query;

    const datos = await llamarKame(
      `/Contabilidad/getCuentaxCobrar?page=${page}&per_page=${per_page}&fechaVencimientoDesde=${fechaVencimientoDesde}&fechaVencimientoHasta=${fechaVencimientoHasta}`
    );

    // Le agregamos el estado "revisado" (que es nuestro, no de KAME)
    // a cada documento vencido, si existe
    const marcados = db.prepare("SELECT numero_documento FROM facturas_revisadas").all();
    const setRevisados = new Set(marcados.map((m) => m.numero_documento));

    const filas = datos?.items ?? datos?.data;
    if (Array.isArray(filas)) {
      const filasConEstado = filas.map((doc) => ({
        ...doc,
        revisado: setRevisados.has(`${doc.Documento ?? ""}-${doc.FolioDocumento ?? doc.numero ?? ""}`),
      }));
      if (Array.isArray(datos.items)) datos.items = filasConEstado;
      else datos.data = filasConEstado;
    }

    res.json(datos);
  } catch (error) {
    res.status(500).json({ error: error.message, detalle: error.detalle });
  }
});

// Marcar/desmarcar una factura como revisada — esto vive SOLO en
// nuestra base, nunca toca KAME.
router.post("/:numeroDocumento/revisado", (req, res) => {
  const { numeroDocumento } = req.params;
  const { usuario } = req.body;

  if (!usuario) {
    return res.status(400).json({ error: "Falta el usuario que revisó" });
  }

  db.prepare(
    "INSERT OR REPLACE INTO facturas_revisadas (numero_documento, revisado_por, fecha) VALUES (?, ?, datetime('now'))"
  ).run(numeroDocumento, usuario);

  res.json({ ok: true, numeroDocumento, revisado_por: usuario });
});

router.delete("/:numeroDocumento/revisado", (req, res) => {
  db.prepare("DELETE FROM facturas_revisadas WHERE numero_documento = ?").run(
    req.params.numeroDocumento
  );
  res.json({ ok: true });
});

module.exports = { router };
