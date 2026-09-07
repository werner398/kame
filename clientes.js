const express = require("express");
const { llamarKame } = require("./kameClient");
const db = require("./db");

const router = express.Router();

// Cache simple en memoria de la lista de clientes (rut + nombre), armada
// a partir de getCuentaxCobrar — KAME no tiene un endpoint de búsqueda
// de clientes por nombre, así que reusamos esta data que ya trae ambos.
// Solo encuentra clientes con al menos un documento en los últimos 2 años.
let cacheClientes = { lista: null, actualizadoEn: null };

async function obtenerListaClientes() {
  const ahora = Date.now();
  // Se refresca cada 10 minutos, para no golpear la cuota de KAME
  // cada vez que alguien busca por nombre.
  if (cacheClientes.lista && ahora - cacheClientes.actualizadoEn < 10 * 60 * 1000) {
    return cacheClientes.lista;
  }

  const hasta = new Date().toISOString().slice(0, 10);
  const desde = new Date(ahora - 730 * 86400000).toISOString().slice(0, 10);

  const datos = await llamarKame(
    `/Contabilidad/getCuentaxCobrar?page=1&per_page=1000&fechaVencimientoDesde=${desde}&fechaVencimientoHasta=${hasta}`
  );
  const filas = datos?.items ?? datos?.data ?? [];

  const vistos = new Map();
  for (const f of filas) {
    const rut = f.Rut;
    const nombre = f.RznSocial;
    if (rut && nombre && !vistos.has(rut)) vistos.set(rut, nombre);
  }

  cacheClientes.lista = Array.from(vistos, ([rut, nombre]) => ({ rut, nombre }));
  cacheClientes.actualizadoEn = ahora;
  return cacheClientes.lista;
}

// GET /api/clientes/buscar?nombre=angelica
// OJO: esta ruta va ANTES de "/:rut" para que Express no la confunda
// con una búsqueda de ficha por RUT.
router.get("/buscar", async (req, res) => {
  try {
    const q = (req.query.nombre || "").trim().toLowerCase();
    if (q.length < 2) {
      return res.status(400).json({ error: "Escribe al menos 2 letras para buscar" });
    }
    const lista = await obtenerListaClientes();
    const coincidencias = lista
      .filter((c) => c.nombre.toLowerCase().includes(q))
      .slice(0, 20);
    res.json({ coincidencias });
  } catch (error) {
    res.status(500).json({ error: error.message, detalle: error.detalle });
  }
});

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
