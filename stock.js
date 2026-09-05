const express = require("express");
const { llamarKame } = require("../kameClient");

const router = express.Router();

// Cache simple en memoria para no gastar cuota de KAME en cada carga
// de pantalla. Se refresca sola cada X minutos (ver server.js).
let cacheStockGeneral = { datos: null, actualizadoEn: null };

router.get("/", async (req, res) => {
  try {
    if (!cacheStockGeneral.datos) {
      cacheStockGeneral.datos = await llamarKame("/Inventario/getStock");
      cacheStockGeneral.actualizadoEn = new Date().toISOString();
    }
    res.json({
      actualizadoEn: cacheStockGeneral.actualizadoEn,
      datos: cacheStockGeneral.datos,
    });
  } catch (error) {
    res.status(500).json({ error: error.message, detalle: error.detalle });
  }
});

router.get("/bodega/:nombreBodega", async (req, res) => {
  try {
    const datos = await llamarKame(
      `/Inventario/getStockBodega/${encodeURIComponent(req.params.nombreBodega)}`
    );
    res.json(datos);
  } catch (error) {
    res.status(500).json({ error: error.message, detalle: error.detalle });
  }
});

router.get("/articulo/:nombreArticulo", async (req, res) => {
  try {
    const datos = await llamarKame(
      `/Inventario/getStockArticulo/${encodeURIComponent(req.params.nombreArticulo)}`
    );
    res.json(datos);
  } catch (error) {
    res.status(500).json({ error: error.message, detalle: error.detalle });
  }
});

router.get("/articulo/:nombreArticulo/bodega/:nombreBodega", async (req, res) => {
  try {
    const { nombreArticulo, nombreBodega } = req.params;
    const datos = await llamarKame(
      `/Inventario/getStockArticuloByBodega/${encodeURIComponent(nombreArticulo)}/${encodeURIComponent(nombreBodega)}`
    );
    res.json(datos);
  } catch (error) {
    res.status(500).json({ error: error.message, detalle: error.detalle });
  }
});

// Se llama desde server.js cada cierto tiempo para refrescar la cache
async function refrescarCacheStock() {
  try {
    cacheStockGeneral.datos = await llamarKame("/Inventario/getStock");
    cacheStockGeneral.actualizadoEn = new Date().toISOString();
    console.log("Cache de stock actualizada:", cacheStockGeneral.actualizadoEn);
  } catch (error) {
    console.error("Error refrescando cache de stock:", error.message);
  }
}

module.exports = { router, refrescarCacheStock };
