  const express = require("express");
const { llamarKame } = require("./kameClient");
const db = require("./db");

const router = express.Router();

// Lista de clientes (rut + nombre) para el buscador. KAME no tiene un
// endpoint de búsqueda por nombre, así que juntamos tres fuentes y
// filtramos localmente:
//   1. Fichas de clientes (getListFicha paginado, sin rut) — la más completa,
//      si KAME la entrega así.
//   2. Ventas de los últimos 6 meses (getInformeVentas, bloques de 31 días).
//   3. Cuentas por cobrar de los últimos 2 años (getCuentaxCobrar).
// Una fuente que falle no bloquea a las demás. Cache de 10 minutos.
//
// OJO: en KAME el "Código Cliente" es el mismo RUT, así que la búsqueda
// cubre nombre, código y RUT a la vez.
let cacheClientes = { lista: null, actualizadoEn: null, fuentes: null };

const filasDe = (r) => (Array.isArray(r) ? r : r?.items ?? r?.data ?? []);
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

async function clientesDesdeFichas() {
  const todos = [];
  let primerRutAnterior = null;
  for (let pagina = 1; pagina <= 40; pagina++) {
    const filas = filasDe(await llamarKame(`/Maestro/getListFicha?page=${pagina}&per_page=500`));
    if (!filas.length) break;
    // Si KAME ignora la paginación y repite la misma página, cortamos
    const primerRut = filas[0]?.Rut ?? filas[0]?.rut;
    if (pagina > 1 && primerRut === primerRutAnterior) break;
    primerRutAnterior = primerRut;
    todos.push(...filas);
    if (filas.length < 500) break;
  }
  return todos;
}

async function clientesDesdeVentas() {
  const filas = [];
  const hoy = Date.now();
  for (let i = 0; i < 6; i++) {
    const hasta = iso(hoy - i * 31 * 86400000);
    const desde = iso(hoy - (i + 1) * 31 * 86400000 + 86400000);
    filas.push(...filasDe(await llamarKame(`/Documento/getInformeVentas?page=1&per_page=1000&fechaDesde=${desde}&fechaHasta=${hasta}`)));
  }
  return filas;
}

async function clientesDesdeCobranza() {
  const ahora = Date.now();
  return filasDe(
    await llamarKame(
      `/Contabilidad/getCuentaxCobrar?page=1&per_page=1000&fechaVencimientoDesde=${iso(ahora - 730 * 86400000)}&fechaVencimientoHasta=${iso(ahora + 365 * 86400000)}`
    )
  );
}

async function obtenerListaClientes() {
  const ahora = Date.now();
  if (cacheClientes.lista && ahora - cacheClientes.actualizadoEn < 10 * 60 * 1000) {
    return cacheClientes.lista;
  }

  const vistos = new Map();
  const fuentes = {};
  for (const [nombre, fn] of [
    ["fichas", clientesDesdeFichas],
    ["ventas", clientesDesdeVentas],
    ["cobranza", clientesDesdeCobranza],
  ]) {
    try {
      const filas = await fn();
      let n = 0;
      for (const f of filas) {
        const rut = f.Rut ?? f.rut;
        const razon = f.RznSocial ?? f.RazonSocial ?? f.Nombre ?? f.rznSocial;
        if (rut && razon && !vistos.has(rut)) { vistos.set(rut, razon); n++; }
      }
      fuentes[nombre] = { filas: filas.length, clientesNuevos: n };
    } catch (error) {
      fuentes[nombre] = { error: error.message };
    }
  }

  cacheClientes.lista = Array.from(vistos, ([rut, nombre]) => ({ rut, nombre }));
  cacheClientes.actualizadoEn = ahora;
  cacheClientes.fuentes = fuentes;
  return cacheClientes.lista;
}

// La ficha de KAME trae la razón social en "RazonSocial" y la dirección y los
// contactos dentro de listas (Direcciones[], Contactos[]). Esto la deja en un
// formato plano, tomando la primera dirección y el primer contacto.
function normalizarFicha(f) {
  if (!f) return null;
  const dir = (Array.isArray(f.Direcciones) && f.Direcciones[0]) || {};
  const con = (Array.isArray(f.Contactos) && f.Contactos[0]) || {};
  const primero = (...v) => v.find((x) => x != null && String(x).trim() !== "") ?? "";
  return {
    Rut: f.Rut ?? f.rut ?? "",
    RznSocial: primero(f.RznSocial, f.RazonSocial, f.Nombre),
    Giro: primero(f.Giro, f.Actividad, f.GiroComercial, dir.Giro),
    Direccion: primero(f.Direccion, dir.Direccion, dir.Calle, dir.DireccionCompleta),
    Comuna: primero(f.Comuna, dir.Comuna),
    Ciudad: primero(f.Ciudad, dir.Ciudad, dir.Region),
    Telefono: primero(f.Telefono, con.Telefono, con.Celular, dir.Telefono),
    Email: primero(f.Email, con.Email, con.Correo, dir.Email),
    Contacto: primero(f.Contacto, con.Nombre, con.NombreContacto),
    CondicionVenta: primero(f.CondicionVenta, f.CondicionPago, f.FormaPago),
  };
}

// GET /api/clientes/fuentes — diagnóstico: cuántos clientes aporta cada fuente
router.get("/fuentes", async (req, res) => {
  if (req.query.refrescar === "1") cacheClientes.actualizadoEn = 0;
  try {
    const lista = await obtenerListaClientes();
    res.json({ total: lista.length, fuentes: cacheClientes.fuentes, actualizadoEn: new Date(cacheClientes.actualizadoEn).toISOString() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/clientes/buscar?nombre=angelica  (o un RUT/código parcial, ej: 10264643)
// OJO: esta ruta va ANTES de "/:rut" para que Express no la confunda
// con una búsqueda de ficha por RUT.
router.get("/buscar", async (req, res) => {
  try {
    const q = (req.query.nombre || "").trim().toLowerCase();
    if (q.length < 2) {
      return res.status(400).json({ error: "Escribe al menos 2 letras o números para buscar" });
    }
    const lista = await obtenerListaClientes();
    const coincidencias = lista
      .filter(
        (c) =>
          c.nombre.toLowerCase().includes(q) ||
          c.rut.toLowerCase().replace(/\./g, "").includes(q.replace(/\./g, ""))
      )
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

    const filas = Array.isArray(ficha) ? ficha : ficha?.items ?? ficha?.data ?? (ficha ? [ficha] : []);
    res.json({ ficha, fichaNormalizada: normalizarFicha(filas[0]), comentarios });
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

module.exports = { router, normalizarFicha };
