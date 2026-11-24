// Movimientos de inventario (kardex) desde KAME:
//   GET /Inventario/getInformeInventario?page&per_page&fechaDesde&fechaHasta[&bodega]
//
// Lo que se comprobó en producción (2026-11-24):
// - fechaDesde y fechaHasta son obligatorias.
// - El filtro "bodega" SÍ funciona; el filtro por SKU NO (KAME lo ignora),
//   así que filtramos por SKU acá.
// - per_page máximo 1000; responde { items, page, per_page, total }.
// - Rangos de 1 año funcionan; uno desde 2015 se colgó, por eso partimos
//   en bloques de 180 días.
//
// El saldo: en vez de confiar en CantidadSaldo (no está claro desde dónde
// acumula), lo calculamos hacia atrás partiendo del stock actual de KAME.
// Por eso siempre se consulta hasta HOY, aunque se muestre hasta "hasta".
const express = require("express");
const { llamarKame } = require("./kameClient");

const router = express.Router();

const DIAS_POR_BLOQUE = 180;
const POR_PAGINA = 1000;

const esFecha = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const hoyISO = () => new Date().toISOString().slice(0, 10);
const norm = (s) => String(s ?? "").trim().toLowerCase();

function bloquesDeFechas(desde, hasta) {
  const bloques = [];
  let inicio = new Date(desde + "T00:00:00Z");
  const fin = new Date(hasta + "T00:00:00Z");
  while (inicio <= fin) {
    const finBloque = new Date(inicio);
    finBloque.setUTCDate(finBloque.getUTCDate() + DIAS_POR_BLOQUE - 1);
    const hastaBloque = finBloque < fin ? finBloque : fin;
    bloques.push({ desde: inicio.toISOString().slice(0, 10), hasta: hastaBloque.toISOString().slice(0, 10) });
    inicio = new Date(hastaBloque);
    inicio.setUTCDate(inicio.getUTCDate() + 1);
  }
  return bloques;
}

async function traerMovimientos(desde, hasta, bodega) {
  let todos = [];
  for (const b of bloquesDeFechas(desde, hasta)) {
    for (let pagina = 1; pagina <= 200; pagina++) {
      let ruta = `/Inventario/getInformeInventario?page=${pagina}&per_page=${POR_PAGINA}&fechaDesde=${b.desde}&fechaHasta=${b.hasta}`;
      if (bodega) ruta += `&bodega=${encodeURIComponent(bodega)}`;
      const resp = await llamarKame(ruta);
      if (resp && resp.Estado === "Error") {
        const e = new Error("KAME rechazó la consulta de movimientos");
        e.detalle = resp;
        throw e;
      }
      const filas = resp?.items ?? resp?.data ?? [];
      todos = todos.concat(filas);
      const total = Number(resp?.total ?? NaN);
      if (filas.length < POR_PAGINA) break;
      if (!Number.isNaN(total) && pagina * POR_PAGINA >= total) break;
    }
  }
  return todos;
}

async function stockActual(sku, articulo, bodega) {
  try {
    if (bodega) {
      if (!articulo) return null;
      const r = await llamarKame(
        `/Inventario/getStockArticuloByBodega/${encodeURIComponent(articulo)}/${encodeURIComponent(bodega)}`
      );
      const obj = Array.isArray(r) ? r[0] : r;
      return obj && obj.saldo != null ? Number(obj.saldo) : null;
    }
    const lista = await llamarKame("/Inventario/getStock");
    const arr = Array.isArray(lista) ? lista : (lista?.items ?? lista?.data ?? []);
    const fila = arr.find((p) => norm(p.SKU) === norm(sku));
    return fila && fila.saldo != null ? Number(fila.saldo) : null;
  } catch {
    return null;
  }
}

const redondear = (n) => Math.round(n * 1000) / 1000;

// GET /api/movimientos?sku=&bodega=&desde=YYYY-MM-DD&hasta=YYYY-MM-DD
router.get("/", async (req, res) => {
  try {
    const sku = String(req.query.sku || "").trim();
    const bodega = req.query.bodega && req.query.bodega !== "TODAS" ? String(req.query.bodega) : "";
    const hoy = hoyISO();
    const hasta = esFecha(req.query.hasta) ? req.query.hasta : hoy;
    const desde = esFecha(req.query.desde) ? req.query.desde : `${Number(hoy.slice(0, 4)) - 1}${hoy.slice(4)}`;
    if (desde > hasta) return res.status(400).json({ error: "La fecha 'desde' es posterior a 'hasta'" });

    // Siempre hasta hoy, para poder anclar el saldo en el stock actual.
    const hastaConsulta = hasta > hoy ? hasta : hoy;
    let movs = await traerMovimientos(desde, hastaConsulta, bodega);
    if (sku) movs = movs.filter((m) => norm(m.Sku) === norm(sku));

    // Orden cronológico estable (KAME ya los entrega casi ordenados).
    movs = movs
      .map((m, i) => ({ m, i }))
      .sort((a, b) => String(a.m.Fecha).localeCompare(String(b.m.Fecha)) || a.i - b.i)
      .map(({ m }) => m);

    let stock = null;
    let saldoInicial = null;
    if (sku) {
      const articulo = req.query.articulo || movs.find((m) => m.Articulo)?.Articulo || "";
      stock = await stockActual(sku, articulo, bodega);
      if (stock != null) {
        let saldo = stock;
        for (let i = movs.length - 1; i >= 0; i--) {
          movs[i] = { ...movs[i], SaldoCalculado: redondear(saldo) };
          saldo -= Number(movs[i].CantidadEntrada || 0) - Number(movs[i].CantidadSalida || 0);
        }
        saldoInicial = redondear(saldo);
      }
    }

    // Saldo al final del rango mostrado = saldo del último movimiento <= hasta,
    // o el saldo inicial si no hubo movimientos en el rango.
    const visibles = movs.filter((m) => String(m.Fecha).slice(0, 10) <= hasta);
    const entradas = visibles.reduce((s, m) => s + Number(m.CantidadEntrada || 0), 0);
    const salidas = visibles.reduce((s, m) => s + Number(m.CantidadSalida || 0), 0);
    const saldoFinal = visibles.length && visibles[visibles.length - 1].SaldoCalculado != null
      ? visibles[visibles.length - 1].SaldoCalculado
      : saldoInicial;

    res.json({
      sku, bodega: bodega || "TODAS", desde, hasta,
      stockActual: stock,
      saldoInicial,
      totalEntradas: redondear(entradas),
      totalSalidas: redondear(salidas),
      saldoFinal,
      items: visibles,
    });
  } catch (error) {
    res.status(500).json({ error: error.message, detalle: error.detalle });
  }
});

module.exports = { router, traerMovimientos };
