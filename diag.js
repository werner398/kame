// DIAGNÓSTICO TEMPORAL — se borra apenas se revisa el resultado.
// Prueba (solo lectura, solo GET) filtros y límites de
// /Inventario/getInformeInventario. Lista fija de rutas.
const express = require("express");
const { llamarKame } = require("./kameClient");

const router = express.Router();

const base = "/Inventario/getInformeInventario";
const nov = "fechaDesde=2026-11-01&fechaHasta=2026-11-24";

const CASOS = [
  ["sku_otro", `${base}?page=1&per_page=1000&fechaDesde=2025-11-24&fechaHasta=2026-11-24&sku=577864`],
  ["Sku_otro", `${base}?page=1&per_page=1000&fechaDesde=2025-11-24&fechaHasta=2026-11-24&Sku=577864`],
  ["desde_2015", `${base}?page=1&per_page=1000&fechaDesde=2015-01-01&fechaHasta=2026-11-24`],
  ["oct_2026", `${base}?page=1&per_page=1000&fechaDesde=2026-10-01&fechaHasta=2026-10-31`],
  ["stock_700030", `/Inventario/getStockArticulo/TUBO-BRUNIDO-32x42`],
  ["ventas_nov", `/Documento/getInformeVentas?page=1&per_page=100&fechaDesde=2026-10-25&fechaHasta=2026-11-24`],
];

function resumir(datos) {
  if (datos && typeof datos === "object" && !Array.isArray(datos)) {
    const items = datos.items ?? datos.data ?? null;
    const r = { claves: Object.keys(datos).filter(k => k !== "items" && k !== "data") };
    for (const k of r.claves) if (typeof datos[k] !== "object") r[k] = datos[k];
    if (Array.isArray(items)) {
      r.n = items.length;
      r.skus = new Set(items.map(i => i.Sku)).size;
      r.bodegas = [...new Set(items.map(i => i.Bodega))];
      r.fechas = items.length ? [items[0].Fecha, items[items.length - 1].Fecha] : [];
      r.ej700030 = items.filter(i => i.Sku === "700030").slice(0, 6)
        .map(i => [i.Fecha?.slice(0, 10), i.Bodega, i.TipoMovimiento, i.CantidadEntrada, i.CantidadSalida, i.CantidadSaldo, i.Origen, i.DocumentoReferencia, i.Folio]);
      r.origenes = [...new Set(items.map(i => i.Origen + "|" + i.MotivoMovimiento))].slice(0, 15);
    }
    return r;
  }
  return { raw: String(JSON.stringify(datos)).slice(0, 300) };
}

router.get("/kardex", async (req, res) => {
  // ?caso=<nombre> corre solo ese caso (algunos tardan mucho).
  const lista = req.query.caso ? CASOS.filter(([n]) => n === req.query.caso) : CASOS;
  const out = {};
  await Promise.all(lista.map(async ([nombre, ruta]) => {
    const t0 = Date.now();
    try {
      out[nombre] = { ms: 0, ...resumir(await llamarKame(ruta)) };
    } catch (e) {
      out[nombre] = { status: e.status, err: String(JSON.stringify(e.detalle) || e.message).slice(0, 300) };
    }
    out[nombre].ms = Date.now() - t0;
  }));
  res.json(out);
});

module.exports = { router };
