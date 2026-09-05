const express = require("express");
const { llamarKame } = require("./kameClient");
const db = require("./db");

const router = express.Router();

// Ficha del cliente (nombre, dirección, teléfono, contacto, email)
// más sus comentarios propios, todo en una sola respuesta para el dashboard.
router.get("/:rut", async (req, res) => {
  try {
    const ficha = await llamarKame(
      `/Maestro/getListFicha?rut=${encodeURIComponent(req.params.rut)}`
    );

    const comentarios = db
      .prepare(
        "SELECT id, usuario, comentario, fecha FROM comentarios_cliente WHERE rut_cliente = ? ORDER BY fecha DESC"
      )
      .all(req.params.rut);

    res.json({ ficha, comentarios });
  } catch (error) {
    res.status(500).json({ error: error.message, detalle: error.detalle });
  }
});

router.post("/:rut/comentarios", (req, res) => {
  const { usuario, comentario } = req.body;

  if (!usuario || !comentario) {
    return res.status(400).json({ error: "Faltan usuario o comentario" });
  }

  const resultado = db
    .prepare(
      "INSERT INTO comentarios_cliente (rut_cliente, usuario, comentario) VALUES (?, ?, ?)"
    )
    .run(req.params.rut, usuario, comentario);

  res.json({ ok: true, id: resultado.lastInsertRowid });
});

module.exports = { router };
