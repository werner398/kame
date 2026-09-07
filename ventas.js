const express = require("express");
const { llamarKame } = require("./kameClient");

const router = express.Router();

// GET /api/ventas?fechaDesde=2026-08-08&fechaHasta=2026-09-07&page=1
// OJO: KAME exige que el rango entre fechaDesde y fechaHasta no supere 31 días.
router.get("/", async (req, res) => {
  try {
    const hastaDefault = new Date().toISOString().slice(0, 10);
    const desdeDefault = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const {
      fechaDesde = desdeDefault,
      fechaHasta = hastaDefault,
      page = 1,
      per_page = 100,
    } = req.query;

    const datos = await llamarKame(
      `/Documento/getInformeVentas?page=${page}&per_page=${per_page}&fechaDesde=${fechaDesde}&fechaHasta=${fechaHasta}`
    );
    res.json(datos);
  } catch (error) {
    res.status(500).json({ error: error.message, detalle: error.detalle });
  }
});

module.exports = { router };
