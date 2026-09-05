const express = require("express");
const { llamarKame } = require("./kameClient");

const router = express.Router();

// GET /api/ventas?fechaDesde=2026-01-01&fechaHasta=2026-01-31&page=1
router.get("/", async (req, res) => {
  try {
    const {
      fechaDesde = "2026-01-01",
      fechaHasta = new Date().toISOString().slice(0, 10),
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
