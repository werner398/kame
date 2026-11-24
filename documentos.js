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
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
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

const { normalizarFicha } = require("./clientes");
async function fichaCliente(rut) {
  const r = await llamarKame(`/Maestro/getListFicha?rut=${encodeURIComponent(rut)}`);
  return normalizarFicha(lista(r)[0]);
}

async function buscarArticulo(sku) {
  const r = await llamarKame(`/Maestro/getListArticulo?Sku=${encodeURIComponent(sku)}`);
  const filas = lista(r);
  const norm = (s) => String(s ?? "").trim().toLowerCase();
  return filas.find((a) => norm(a.SKU ?? a.Sku) === norm(sku)) || filas[0] || null;
}

const resolvers = { listarVendedores, fichaCliente, buscarArticulo };

// ---------- Formas de pago ----------
// La colección Postman solo muestra FormaPago "1" (contado) y "2" (crédito,
// exige cuotas). Probamos los endpoints probables del maestro por si KAME
// entrega la lista configurada en la cuenta; si ninguno responde, quedan esas dos.
const FORMAS_PAGO_BASE = [
  { codigo: "1", nombre: "Contado", credito: false, dias: 0 },
  { codigo: "2", nombre: "Crédito", credito: true, dias: 30 },
];
// En la interfaz de KAME se llaman "Condición de Venta".
const RUTAS_FORMAS_PAGO = [
  "/Maestro/getListCondicionVenta",
  "/Maestro/getListCondicionesVenta",
  "/Maestro/getCondicionVenta",
  "/Maestro/getCondicionesVenta",
  "/Maestro/getListCondicionDeVenta",
  "/Maestro/getListCondicionPago",
  "/Maestro/getListFormaPago",
  "/Maestro/getFormaPago",
  "/Maestro/getListFormasPago",
  "/Ventas/getListCondicionVenta",
  "/Documento/getListCondicionVenta",
];
let cacheFormasPago = { datos: null, en: 0 };

// KAME solo acepta FormaPago "1" (contado) o "2" (crédito). Las condiciones
// de venta de la cuenta (con sus propios códigos internos) se traducen a eso:
// crédito si dice "crédito" o tiene días de plazo, salvo tarjeta, contado,
// débito, efectivo o transferencia, que van como contado.
function esCondicionCredito(nombre, dias) {
  const n = String(nombre || "");
  if (/tarjeta|contado|efectivo|d[eé]bito|transferencia|cheque al d[ií]a/i.test(n)) return false;
  return /cr[eé]dito/i.test(n) || Number(dias) > 0;
}

async function listarFormasPago({ forzar = false } = {}) {
  if (!forzar && cacheFormasPago.datos && Date.now() - cacheFormasPago.en < 30 * 60 * 1000) {
    return cacheFormasPago.datos;
  }
  const intentos = [];
  let formas = null;
  let origen = null;
  for (const ruta of RUTAS_FORMAS_PAGO) {
    try {
      const crudo = await llamarKame(ruta);
      const filas = lista(crudo);
      intentos.push({ ruta, ok: true, filas: filas.length, muestra: JSON.stringify(filas[0] ?? crudo)?.slice(0, 400) });
      const leidas = filas
        .map((f) => {
          if (typeof f === "string") return { codigo: f, nombre: f, dias: 0, credito: esCondicionCredito(f, 0) };
          const codigo = f.Codigo ?? f.codigo ?? f.Id ?? f.id ?? f.ID ?? f.FormaPago ?? f.CodFormaPago ?? f.CodigoFormaPago
            ?? f.CodCondicion ?? f.CodigoCondicion ?? f.IdCondicion ?? f.CondicionVenta ?? f.Condicion;
          const nombre = f.Descripcion ?? f.descripcion ?? f.Nombre ?? f.nombre ?? f.Glosa ?? f.NombreCondicion
            ?? f.CondicionVenta ?? f.Condicion ?? f.FormaPago;
          const diasNombre = Number(String(f.Descripcion ?? f.Nombre ?? "").match(/(\d+)\s*d[ií]as?/i)?.[1] || 0);
          const dias = Number(f.Dias ?? f.dias ?? f.Plazo ?? f.DiasVencimiento ?? f.DiasPlazo ?? 0) || diasNombre;
          return codigo != null && nombre ? { codigo: String(codigo), nombre: String(nombre), dias, credito: esCondicionCredito(nombre, dias) } : null;
        })
        .filter(Boolean);
      if (leidas.length) { formas = leidas; origen = ruta; break; }
    } catch (e) {
      intentos.push({ ruta, ok: false, status: e.status, detalle: JSON.stringify(e.detalle ?? "")?.slice(0, 200) });
    }
  }
  // La API entrega solo las condiciones agregadas en la cuenta (ej. "Tarjeta de
  // credito"); Contado y Crédito vienen de fábrica en KAME y no aparecen ahí,
  // así que siempre se incluyen.
  const nombresKame = new Set((formas || []).map((f) => f.nombre.trim().toLowerCase()));
  const combinadas = [
    ...FORMAS_PAGO_BASE.filter((b) => !nombresKame.has(b.nombre.toLowerCase()) && !nombresKame.has(b.nombre.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""))),
    ...(formas || []),
  ];
  cacheFormasPago = {
    datos: { formas: combinadas, desdeKame: !!formas, origen, intentos },
    en: Date.now(),
  };
  return cacheFormasPago.datos;
}

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

// Devuelve la lista de mensajes de error si KAME rechazó (aunque haya
// respondido HTTP 200), o null si no hay error.
function erroresDeRespuesta(resp) {
  if (!resp || typeof resp !== "object") return null;
  const estado = String(resp.Estado ?? resp.estado ?? "").toLowerCase();
  const lista = resp.Error ?? resp.Errores ?? resp.errors ?? resp.error;
  const mensajes = (Array.isArray(lista) ? lista : lista ? [lista] : []).map((e) =>
    typeof e === "string"
      ? e
      : [e.MemberNames?.join?.(", "), e.ErrorMessage ?? e.Mensaje ?? e.message].filter(Boolean).join(": ")
  ).filter(Boolean);
  if (estado === "error" || mensajes.length) return mensajes.length ? mensajes : ["KAME respondió con estado Error"];
  return null;
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

// GET /api/documentos/formas-pago — lista para el desplegable (y diagnóstico)
router.get("/formas-pago", async (req, res) => {
  try {
    res.json(await listarFormasPago({ forzar: req.query.refrescar === "1" }));
  } catch (error) {
    res.json({ formas: FORMAS_PAGO_BASE, desdeKame: false, error: error.message });
  }
});

// GET /api/documentos/historial — últimos documentos emitidos desde aquí
router.get("/historial", exigirAcceso, (req, res) => {
  const columnas = `id, tipo, folio, vendedor, rut, rzn_social, total, estado, emitido_por, error, fecha,
    (SELECT json_group_array(json_object('id', a.id, 'nombre', a.nombre)) FROM adjuntos_documento a WHERE a.documento_id = documentos_emitidos.id) AS adjuntos`;
  const filas =
    req.acceso.rol === "vendedor"
      ? db.prepare(`SELECT ${columnas} FROM documentos_emitidos WHERE vendedor = ? ORDER BY id DESC LIMIT 50`).all(req.acceso.vendedor)
      : db.prepare(`SELECT ${columnas} FROM documentos_emitidos ORDER BY id DESC LIMIT 50`).all();
  res.json({ items: filas.map((f) => ({ ...f, adjuntos: JSON.parse(f.adjuntos || "[]") })) });
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

  // KAME puede rechazar respondiendo HTTP 200 con { Estado: "Error", Error: [...] }
  const erroresKame = erroresDeRespuesta(respuesta);
  if (erroresKame) {
    const texto = erroresKame.join(" · ");
    insertarRegistro.run({
      ...base, folio: null, estado: "rechazado", respuesta: json(respuesta), verificacion: null, error: texto,
    });
    return res.status(422).json({
      error: `KAME rechazó la ${def.nombre.toLowerCase()}: ${texto}`,
      respuestaKame: respuesta,
      payload,
    });
  }

  const folio = extraerFolio(respuesta);
  if (!folio) {
    const registroSinFolio = insertarRegistro.run({
      ...base, folio: null, estado: "sin_folio", respuesta: json(respuesta),
      verificacion: null, error: "KAME respondió sin folio",
    });
    return res.status(202).json({
      estado: "sin_folio",
      registroId: Number(registroSinFolio.lastInsertRowid),
      mensaje: "KAME respondió OK pero sin un folio reconocible. Revisar en el ERP si el documento existe.",
      respuestaKame: respuesta,
      payload,
    });
  }

  const ver = await verificar(req.params.tipo, folio, payload.total);
  const estado = ver.confirmado ? "confirmado" : "sin_confirmar";
  const registro = insertarRegistro.run({
    ...base, folio, estado, respuesta: json(respuesta), verificacion: json(ver),
    error: ver.confirmado ? null : "No se pudo leer de vuelta el documento",
  });

  res.status(ver.confirmado ? 200 : 202).json({
    estado,
    tipo: def.nombre,
    folio,
    registroId: Number(registro.lastInsertRowid),
    total: payload.total,
    mensaje: ver.confirmado
      ? `${def.nombre} N° ${folio} creada y confirmada en KAME.`
      : `KAME respondió OK con folio ${folio}, pero no se pudo leer de vuelta. Revisar en el ERP antes de darla por hecha.`,
    verificacion: ver,
    respuestaKame: respuesta,
  });
});

// ---------- Adjuntos (ej. la OC del cliente) ----------
// KAME no muestra en su API cómo adjuntar archivos a un documento, así que
// el archivo se guarda en nuestro sistema, asociado al documento emitido.
const TIPOS_ADJUNTO = {
  "application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
};
const MAX_ADJUNTO = 10 * 1024 * 1024; // 10 MB

function documentoPermitido(req, id) {
  const fila = db.prepare("SELECT id, vendedor FROM documentos_emitidos WHERE id = ?").get(id);
  if (!fila) return null;
  if (req.acceso.rol === "vendedor" && fila.vendedor !== req.acceso.vendedor) return null;
  return fila;
}

// POST /api/documentos/registro/:id/adjunto  { nombre, tipo, base64 }
router.post("/registro/:id/adjunto", exigirAcceso, (req, res) => {
  const doc = documentoPermitido(req, Number(req.params.id));
  if (!doc) return res.status(404).json({ error: "Documento no encontrado" });
  const { nombre, tipo, base64 } = req.body || {};
  const extension = TIPOS_ADJUNTO[tipo];
  if (!extension) return res.status(400).json({ error: "Solo se aceptan PDF o imágenes (JPG, PNG, WEBP)" });
  const datos = Buffer.from(String(base64 || ""), "base64");
  if (!datos.length) return res.status(400).json({ error: "El archivo está vacío" });
  if (datos.length > MAX_ADJUNTO) return res.status(413).json({ error: "El archivo supera 10 MB" });

  const archivo = `${doc.id}-${crypto.randomBytes(8).toString("hex")}${extension}`;
  fs.writeFileSync(path.join(db.carpetaAdjuntos, archivo), datos);
  const r = db
    .prepare("INSERT INTO adjuntos_documento (documento_id, nombre, tipo_mime, tamano, archivo, subido_por) VALUES (?, ?, ?, ?, ?, ?)")
    .run(doc.id, String(nombre || "adjunto" + extension).slice(0, 150), tipo, datos.length, archivo,
      req.acceso.rol === "vendedor" ? req.acceso.vendedor : "admin");
  res.json({ ok: true, id: Number(r.lastInsertRowid), persistente: db.persistente });
});

// GET /api/documentos/registro/:id/adjunto/:adjuntoId — descarga el archivo
router.get("/registro/:id/adjunto/:adjuntoId", exigirAcceso, (req, res) => {
  const doc = documentoPermitido(req, Number(req.params.id));
  if (!doc) return res.status(404).json({ error: "Documento no encontrado" });
  const adj = db.prepare("SELECT * FROM adjuntos_documento WHERE id = ? AND documento_id = ?").get(Number(req.params.adjuntoId), doc.id);
  const ruta = adj && path.join(db.carpetaAdjuntos, path.basename(adj.archivo));
  if (!adj || !fs.existsSync(ruta)) {
    return res.status(404).json({ error: "El archivo ya no existe (si no hay volumen en Railway, se pierde al redesplegar)" });
  }
  res.setHeader("Content-Type", adj.tipo_mime);
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(adj.nombre)}"`);
  res.sendFile(ruta);
});

module.exports = { router, listarVendedores, extraerFolio, extraerDocumento };
