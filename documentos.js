// Emisión de COTIZACIONES y NOTAS DE VENTA (pedidos) en KAME.
//
// Por decisión del negocio, desde aquí NO se emiten facturas ni boletas:
// esos documentos van al SII y no se pueden deshacer. Solo cotizaciones
// y notas de venta, que no son documentos tributarios.
//
// Para emitir hay que entrar como vendedor (nombre de KAME + clave propia)
// o como administrador (CLAVE_ADMIN). El vendedor solo emite a su nombre.
//
// KAME ya nos devolvió "200 OK" sin guardar nada (updArticulo), así que
// un documento solo se marca "confirmado" después de volver a leerlo.

const express = require("express");
const { llamarKame } = require("./kameClient");
const db = require("./db");
const { VentaPayloadError, payloadCotizacion, payloadPedido } = require("./ventaPayloadBuilder");

const router = express.Router();

const BODEGAS = ["Antofagasta", "Renca", "Concepcion"];

const TIPOS = {
  cotizacion: {
    nombre: "Cotización",
    construir: payloadCotizacion,
    rutaAlta: "/Documento/addCotizacion",
    rutasLectura: (f) => [
      `/Documento/getCotizacion/${f}`,
      `/Documento/getCotizacion?folio=${f}`,
      `/Documento/getCotizacion?Folio=${f}`,
    ],
  },
  pedido: {
    nombre: "Nota de venta",
    construir: payloadPedido,
    rutaAlta: "/Documento/addPedido",
    rutasLectura: (f) => [
      `/Documento/getPedido/${f}`,
      `/Documento/getPedido?folio=${f}`,
      `/Documento/getPedido?Folio=${f}`,
    ],
  },
};

// ---------- Acceso ----------
// Admin (CLAVE_ADMIN) o vendedor con sesión; ver vendedores.js.
const { exigirAcceso } = require("./vendedores");

// ---------- Consultas a KAME (resolvers) ----------

const lista = (r) => (Array.isArray(r) ? r : r?.items ?? r?.data ?? (r ? [r] : []));

let cacheVendedores = { nombres: null, intentos: [], en: 0 };

const nombreVendedor = (v) =>
  typeof v === "string"
    ? v
    : v?.NombreVendedor ?? v?.Nombre ?? v?.Vendedor ?? v?.nombre ?? v?.vendedor ?? v?.Descripcion ?? null;

// Probamos el endpoint con y sin paginación (los listados de KAME suelen
// pedir page/per_page) y guardamos la respuesta cruda para diagnóstico.
async function listarVendedores({ forzar = false } = {}) {
  if (!forzar && cacheVendedores.nombres && Date.now() - cacheVendedores.en < 10 * 60 * 1000) {
    return cacheVendedores.nombres;
  }
  const rutas = ["/Maestro/getListVendedor", "/Maestro/getListVendedor?page=1&per_page=500"];
  const intentos = [];
  let nombres = [];
  for (const ruta of rutas) {
    try {
      const crudo = await llamarKame(ruta);
      const encontrados = lista(crudo).map(nombreVendedor).filter(Boolean);
      intentos.push({ ruta, respuestaKame: JSON.stringify(crudo)?.slice(0, 1500) ?? null, encontrados: encontrados.length });
      if (encontrados.length) { nombres = encontrados; break; }
    } catch (e) {
      intentos.push({ ruta, status: e.status, error: e.detalle ?? e.message });
    }
  }
  cacheVendedores = { nombres: [...new Set(nombres)], intentos, en: Date.now() };
  return cacheVendedores.nombres;
}

async function fichaCliente(rut) {
  const r = await llamarKame(`/Maestro/getListFicha?rut=${encodeURIComponent(rut)}`);
  const filas = lista(r);
  return filas[0] || null;
}

async function buscarArticulo(sku) {
  const r = await llamarKame(`/Maestro/getListArticulo?Sku=${encodeURIComponent(sku)}`);
  const filas = lista(r);
  const norm = (s) => String(s ?? "").trim().toLowerCase();
  return filas.find((a) => norm(a.SKU ?? a.Sku) === norm(sku)) || filas[0] || null;
}

const resolvers = { listarVendedores, fichaCliente, buscarArticulo };

// ---------- Folio y verificación ----------

// KAME no documenta la forma exacta de la respuesta de addCotizacion /
// addPedido, así que buscamos el folio en todos los lugares razonables.
function extraerFolio(resp) {
  if (resp == null) return null;
  if (typeof resp === "number") return String(resp);
  if (typeof resp === "string") {
    const m = resp.match(/(\d{1,12})/);
    return /^\s*\d+\s*$/.test(resp) ? resp.trim() : m && /folio/i.test(resp) ? m[1] : null;
  }
  const directo =
    resp.Folio ?? resp.folio ?? resp.items?.[0]?.Folio ?? resp.items?.[0]?.folio ?? resp.data?.Folio;
  if (directo != null && directo !== "") return String(directo);
  const m = JSON.stringify(resp).match(/folio"?\s*[:=]?\s*"?(\d{1,12})/i);
  return m ? m[1] : null;
}

// Un documento cuenta como encontrado solo si trae datos reales:
// { items: [] } o un objeto vacío NO es un documento.
function extraerDocumento(resp) {
  if (resp == null) return null;
  if (Array.isArray(resp.items)) return resp.items[0] || null;
  if (Array.isArray(resp)) return resp[0] || null;
  if (typeof resp === "object" && (resp.Folio != null || resp.folio != null || resp.Total != null || resp.total != null || resp.Detalle)) {
    return resp;
  }
  return null;
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Prueba las rutas de lectura conocidas (la doc no deja claro si el folio
// va en la ruta o como parámetro). Devuelve el documento y la ruta que
// funcionó, más el detalle de cada intento para diagnóstico.
async function leerDocumento(tipo, folio) {
  const intentos = [];
  for (const ruta of TIPOS[tipo].rutasLectura(encodeURIComponent(folio))) {
    try {
      const resp = await llamarKame(ruta);
      const doc = extraerDocumento(resp);
      intentos.push({ ruta, ok: true, encontrado: !!doc });
      if (doc) return { doc, ruta, intentos };
    } catch (e) {
      intentos.push({ ruta, ok: false, status: e.status, error: e.detalle ?? e.message });
    }
  }
  return { doc: null, ruta: null, intentos };
}

async function verificar(tipo, folio, totalEsperado) {
  let ultimo = null;
  for (const pausa of [1500, 3000, 5000]) {
    await esperar(pausa);
    ultimo = await leerDocumento(tipo, folio);
    if (ultimo.doc) {
      const totalKame = Number(ultimo.doc.Total ?? ultimo.doc.total);
      const totalCuadra = Number.isFinite(totalKame) ? Math.abs(totalKame - totalEsperado) <= 1 : null;
      return { confirmado: true, totalKame, totalCuadra, ...ultimo };
    }
  }
  return { confirmado: false, ...ultimo };
}

// ---------- Registro propio ----------

const insertarRegistro = db.prepare(`
  INSERT INTO documentos_emitidos
    (tipo, folio, vendedor, rut, rzn_social, total, estado, emitido_por, payload, respuesta, verificacion, error)
  VALUES (@tipo, @folio, @vendedor, @rut, @rzn_social, @total, @estado, @emitido_por, @payload, @respuesta, @verificacion, @error)
`);

const json = (x) => (x === undefined ? null : JSON.stringify(x));

// ---------- Rutas ----------

// GET /api/documentos/opciones — vendedores (desde KAME) y bodegas
router.get("/opciones", async (req, res) => {
  try {
    const vendedores = await listarVendedores({ forzar: req.query.refrescar === "1" });
    res.json({
      vendedores,
      bodegas: BODEGAS,
      // Respuesta tal cual llega de KAME, para revisar nombres de campos
      diagnosticoVendedores: cacheVendedores.intentos,
    });
  } catch (error) {
    res.status(502).json({ error: error.message, detalle: error.detalle, bodegas: BODEGAS });
  }
});

// GET /api/documentos/historial — últimos documentos emitidos desde aquí
router.get("/historial", exigirAcceso, (req, res) => {
  const columnas = "id, tipo, folio, vendedor, rut, rzn_social, total, estado, emitido_por, error, fecha";
  const filas =
    req.acceso.rol === "vendedor"
      ? db.prepare(`SELECT ${columnas} FROM documentos_emitidos WHERE vendedor = ? ORDER BY id DESC LIMIT 50`).all(req.acceso.vendedor)
      : db.prepare(`SELECT ${columnas} FROM documentos_emitidos ORDER BY id DESC LIMIT 50`).all();
  res.json({ items: filas });
});

// GET /api/documentos/:tipo/:folio — leer una cotización o nota de venta de KAME
router.get("/:tipo/:folio", async (req, res) => {
  const { tipo, folio } = req.params;
  if (!TIPOS[tipo]) return res.status(404).json({ error: "Tipo debe ser cotizacion o pedido" });
  try {
    const r = await leerDocumento(tipo, folio);
    res.status(r.doc ? 200 : 404).json(r);
  } catch (error) {
    res.status(502).json({ error: error.message, detalle: error.detalle });
  }
});

// POST /api/documentos/:tipo   (tipo = cotizacion | pedido)
// Body: { rut, vendedor, bodega, formaPago?, cuotas?, items:[{articulo, cantidad, precioUnitario, descuentoPct?}],
//         comentario?, documento?, diasVigencia?, emitidoPor?, enviar: boolean }
// Con enviar=false (por defecto) solo devuelve la vista previa, sin tocar KAME.
router.post("/:tipo", exigirAcceso, async (req, res) => {
  const def = TIPOS[req.params.tipo];
  if (!def) return res.status(404).json({ error: "Tipo debe ser cotizacion o pedido" });

  const body = { ...(req.body || {}) };
  const enviar = body.enviar === true;
  // Un vendedor con sesión SOLO emite a su propio nombre, venga lo que venga
  if (req.acceso.rol === "vendedor") body.vendedor = req.acceso.vendedor;
  const emitidoPor =
    req.acceso.rol === "vendedor" ? req.acceso.vendedor : `admin: ${String(body.emitidoPor || body.vendedor || "").slice(0, 70)}`;

  let payload;
  try {
    payload = await def.construir(
      {
        ...body,
        usuario: process.env.KAME_USUARIO_SISTEMA,
        documento: body.documento || "Factura Electrónica",
      },
      resolvers
    );
  } catch (error) {
    if (error instanceof VentaPayloadError) {
      return res.status(400).json({ error: error.message, campo: error.campo });
    }
    return res.status(502).json({ error: error.message, detalle: error.detalle });
  }

  if (!enviar) {
    return res.json({ vistaPrevia: true, tipo: def.nombre, payload });
  }

  const base = {
    tipo: req.params.tipo,
    vendedor: payload.Vendedor,
    rut: payload.Rut,
    rzn_social: payload.RznSocial,
    total: payload.total,
    emitido_por: emitidoPor,
    payload: json(payload),
  };

  let respuesta;
  try {
    respuesta = await llamarKame(def.rutaAlta, { method: "POST", body: JSON.stringify(payload) });
  } catch (error) {
    insertarRegistro.run({
      ...base, folio: null, estado: "rechazado", respuesta: json(error.detalle),
      verificacion: null, error: error.message,
    });
    return res.status(502).json({
      error: `KAME rechazó la ${def.nombre.toLowerCase()}: ${error.message}`,
      detalle: error.detalle,
      payload,
    });
  }

  const folio = extraerFolio(respuesta);
  if (!folio) {
    insertarRegistro.run({
      ...base, folio: null, estado: "sin_folio", respuesta: json(respuesta),
      verificacion: null, error: "KAME respondió sin folio",
    });
    return res.status(202).json({
      estado: "sin_folio",
      mensaje: "KAME respondió OK pero sin un folio reconocible. Revisar en el ERP si el documento existe.",
      respuestaKame: respuesta,
      payload,
    });
  }

  const ver = await verificar(req.params.tipo, folio, payload.total);
  const estado = ver.confirmado ? "confirmado" : "sin_confirmar";
  insertarRegistro.run({
    ...base, folio, estado, respuesta: json(respuesta), verificacion: json(ver),
    error: ver.confirmado ? null : "No se pudo leer de vuelta el documento",
  });

  res.status(ver.confirmado ? 200 : 202).json({
    estado,
    tipo: def.nombre,
    folio,
    total: payload.total,
    mensaje: ver.confirmado
      ? `${def.nombre} N° ${folio} creada y confirmada en KAME.`
      : `KAME respondió OK con folio ${folio}, pero no se pudo leer de vuelta. Revisar en el ERP antes de darla por hecha.`,
    verificacion: ver,
    respuestaKame: respuesta,
  });
});

module.exports = { router, listarVendedores, extraerFolio, extraerDocumento };
