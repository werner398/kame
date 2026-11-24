// DIAGNÓSTICO TEMPORAL — se borra apenas se revisa el resultado.
// Prueba (solo lectura, solo GET) filtros y límites de
// /Inventario/getInformeInventario. Lista fija de rutas.
const express = require("express");
const { llamarKame } = require("./kameClient");

const router = express.Router();

const base = "/Inventario/getInformeInventario";
const nov = "fechaDesde=2026-11-01&fechaHasta=2026-11-24";

const CASOS = [
  ["nov_sin_filtro", `${base}?page=1&per_page=500&${nov}`],
  ["nov_pag2", `${base}?page=2&per_page=500&${nov}`],
  ["sku_minus", `${base}?page=1&per_page=500&${nov}&sku=700030`],
  ["Sku_mayus", `${base}?page=1&per_page=500&${nov}&Sku=700030`],
  ["articulo", `${base}?page=1&per_page=500&${nov}&articulo=TUBO-BRUNIDO-32x42`],
  ["bodega", `${base}?page=1&per_page=500&${nov}&bodega=Renca`],
  ["Bodega_mayus", `${base}?page=1&per_page=500&${nov}&Bodega=Renca`],
  ["rango_60d", `${base}?page=1&per_page=5&fechaDesde=2026-09-25&fechaHasta=2026-11-24`],
  ["rango_1ano", `${base}?page=1&per_page=5&fechaDesde=2025-11-24&fechaHasta=2026-11-24`],
  ["per_page_2000", `${base}?page=1&per_page=2000&${nov}`],
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
  const out = {};
  for (const [nombre, ruta] of CASOS) {
    try {
      out[nombre] = resumir(await llamarKame(ruta));
    } catch (e) {
      out[nombre] = { status: e.status, err: String(JSON.stringify(e.detalle) || e.message).slice(0, 300) };
    }
  }
  res.json(out);
});

module.exports = { router };
