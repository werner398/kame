// DIAGNÓSTICO TEMPORAL — se borra apenas se revisa el resultado.
// Prueba (solo lectura, solo GET) si KAME ya expone algún endpoint de
// movimientos de inventario (kardex). Lista fija de rutas: no acepta
// rutas arbitrarias desde afuera.
const express = require("express");
const { llamarKame } = require("./kameClient");

const router = express.Router();

const desde = "2026-11-01";
const hasta = "2026-11-24";
const q = `?page=1&per_page=5&fechaDesde=${desde}&fechaHasta=${hasta}`;

const CANDIDATAS = [
  `/Inventario/getInformeInventario${q}`,
  `/Inventario/getInformeInventario`,
  `/Inventario/getKardex${q}`,
  `/Inventario/getMovimientos${q}`,
  `/Inventario/getMovimientoInventario${q}`,
  `/Inventario/getInformeMovimientos${q}`,
  `/Inventario/getInventario${q}`,
  `/Documento/getInformeInventario${q}`,
  `/Documento/getInventario${q}`,
  `/Inventario/getStock`, // control: este sabemos que existe
];

router.get("/kardex", async (req, res) => {
  const resultados = [];
  for (const ruta of CANDIDATAS) {
    try {
      const datos = await llamarKame(ruta);
      const texto = typeof datos === "string" ? datos : JSON.stringify(datos);
      resultados.push({ ruta, status: 200, muestra: (texto || "").slice(0, 600) });
    } catch (e) {
      const det = typeof e.detalle === "string" ? e.detalle : JSON.stringify(e.detalle);
      resultados.push({ ruta, status: e.status ?? "error", muestra: (det || e.message || "").slice(0, 300) });
    }
  }
  res.json(resultados);
});

module.exports = { router };
