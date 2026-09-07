
const express = require("express");
const { llamarKame } = require("./kameClient");

const router = express.Router();

// KAME exige que fechaDesde/fechaHasta no superen 31 días por llamada.
// Esta función parte un rango más largo (por ejemplo, un año completo)
// en bloques de máximo 31 días, para poder pedirle a KAME de a poco
// sin que el usuario del dashboard tenga que preocuparse de ese límite.
function construirBloques(fechaDesde, fechaHasta, maxDias = 31) {
  const bloques = [];
  let cursor = new Date(`${fechaDesde}T00:00:00`);
  const fin = new Date(`${fechaHasta}T00:00:00`);

  while (cursor <= fin) {
    const finBloque = new Date(cursor);
    finBloque.setDate(finBloque.getDate() + maxDias - 1);
    if (finBloque > fin) finBloque.setTime(fin.getTime());

    bloques.push({
      desde: cursor.toISOString().slice(0, 10),
      hasta: finBloque.toISOString().slice(0, 10),
    });

    cursor = new Date(finBloque);
    cursor.setDate(cursor.getDate() + 1);
  }

  return bloques;
}

// GET /api/ventas?fechaDesde=2025-01-01&fechaHasta=2026-09-07
// Acepta cualquier rango de fechas, sin límite — el backend se encarga
// de partirlo en bloques de 31 días y juntar los resultados.
router.get("/", async (req, res) => {
  try {
    const hastaDefault = new Date().toISOString().slice(0, 10);
    const desdeDefault = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const { fechaDesde = desdeDefault, fechaHasta = hastaDefault, per_page = 300 } = req.query;

    const bloques = construirBloques(fechaDesde, fechaHasta, 31);

    if (bloques.length > 120) {
      return res.status(400).json({
        error: "El rango pedido es muy amplio (más de ~10 años). Prueba con un rango más acotado.",
      });
    }

    let todasLasFilas = [];
    for (const bloque of bloques) {
      // Dentro de cada bloque de 31 días, paginamos por si hay más
      // resultados de los que caben en una sola página.
      let pagina = 1;
      while (true) {
        const datos = await llamarKame(
          `/Documento/getInformeVentas?page=${pagina}&per_page=${per_page}&fechaDesde=${bloque.desde}&fechaHasta=${bloque.hasta}`
        );
        const filas = datos?.items ?? datos?.data ?? [];
        todasLasFilas = todasLasFilas.concat(filas);

        if (filas.length < Number(per_page)) break; // última página de este bloque
        pagina++;
        if (pagina > 20) break; // salvavidas para no loopear infinito
      }
    }

    res.json({ items: todasLasFilas, total: todasLasFilas.length });
  } catch (error) {
    res.status(500).json({ error: error.message, detalle: error.detalle });
  }
});

module.exports = { router };
