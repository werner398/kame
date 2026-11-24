// Arma y valida el JSON que KAME espera en addCotizacion y addPedido.
//
// Reglas:
//  - El backend SIEMPRE calcula neto, IVA y total. Nunca confiamos en
//    montos que mande el navegador.
//  - Artículo y vendedor se validan contra el maestro de KAME antes de
//    enviar, para no descubrir el error recién en la respuesta de KAME.
//  - Este archivo NO llama a KAME directamente: recibe "resolvers"
//    (funciones que sí consultan KAME) para poder probarlo sin red.
//
// Basado en la colección Postman "API Kame ERP", carpeta Ventas.

const IVA = 0.19;

class VentaPayloadError extends Error {
  constructor(message, campo) {
    super(message);
    this.name = "VentaPayloadError";
    this.campo = campo;
  }
}

const clp = (n) => Math.round(n);

function sumarDias(fechaISO, dias) {
  const d = new Date(`${fechaISO}T12:00:00`);
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

function hoyChile() {
  // Fecha local de Chile (YYYY-MM-DD), no la UTC del servidor
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(new Date());
}

function construirLinea(item) {
  const cantidad = Number(item.cantidad);
  const precio = Number(item.precioUnitario);
  const descuentoPct = Number(item.descuentoPct || 0);

  if (!item.articulo) throw new VentaPayloadError("Falta el artículo (SKU)", "articulo");
  if (!(cantidad > 0)) throw new VentaPayloadError(`Cantidad inválida para ${item.articulo}`, "cantidad");
  if (!(precio >= 0)) throw new VentaPayloadError(`Precio inválido para ${item.articulo}`, "precioUnitario");
  if (descuentoPct < 0 || descuentoPct > 100) {
    throw new VentaPayloadError(`Descuento inválido para ${item.articulo}`, "descuentoPct");
  }

  const bruto = cantidad * precio;
  const descuento = clp(bruto * (descuentoPct / 100));

  return {
    Descripcion: item.descripcion || item.articulo,
    Cantidad: cantidad,
    PrecioUnitario: precio,
    Descuento: descuento,
    Total: clp(bruto - descuento),
    UnidadMedida: item.unidadMedida || "UN",
    // Codimet tiene un solo centro de costo: Casa Matriz
    UnidadNegocio: item.unidadNegocio || process.env.KAME_UNIDAD_NEGOCIO || "CASA MATRIZ",
    Articulo: item.articulo,
    PorcDescuento: descuentoPct,
    DescripcionDetallada: item.descripcionDetallada || "",
    Exento: "",
    TipoArticulo: "",
  };
}

function calcularTotales(lineas) {
  const afecto = lineas.reduce((a, l) => a + l.Total, 0);
  const descuento = lineas.reduce((a, l) => a + l.Descuento, 0);
  const iva = clp(afecto * IVA);
  return {
    Afecto: afecto,
    Exento: 0,
    Descuento: descuento,
    TipoImpto1: "IVA",
    ValorImpto1: iva,
    total: afecto + iva,
  };
}

function construirCuotas(cuotas, total) {
  if (!Array.isArray(cuotas) || cuotas.length === 0) {
    throw new VentaPayloadError("Pago a crédito requiere al menos una cuota", "cuotas");
  }
  const lista = cuotas.map((c) => ({
    FechaPago: `${c.fechaPago}T00:00:00`,
    MontoPago: clp(Number(c.montoPago)),
  }));
  const suma = lista.reduce((a, c) => a + c.MontoPago, 0);
  if (Math.abs(suma - total) > 1) {
    throw new VentaPayloadError(`Las cuotas suman ${suma} pero el total es ${total}`, "cuotas");
  }
  return lista;
}

// resolvers: {
//   buscarArticulo(sku)   -> { SKU, Descripcion, ... } | null
//   listarVendedores()    -> [ "Nombre", ... ]  (nombres tal cual en KAME)
//   fichaCliente(rut)     -> { RznSocial, Giro, Direccion, ... } | null
// }
async function construirBase(input, resolvers, tipo) {
  const {
    usuario, documento, rut, vendedor, bodega, formaPago = "1",
    items, cuotas, comentario = "", contacto = "", folio = "", sucursal = "",
  } = input;
  const fecha = input.fecha || hoyChile();

  if (!usuario) throw new VentaPayloadError("Falta el usuario KAME (KAME_USUARIO_SISTEMA)", "usuario");
  if (!documento) throw new VentaPayloadError("Falta el tipo de documento", "documento");
  if (!rut) throw new VentaPayloadError("Falta el RUT del cliente", "rut");
  if (!bodega) throw new VentaPayloadError("Falta la bodega", "bodega");
  if (!String(formaPago).trim()) throw new VentaPayloadError("Falta la forma de pago", "formaPago");
  // Crédito: el navegador lo indica según la forma elegida; si no, se
  // asume crédito solo para el código "2" (el que muestra la doc de KAME).
  const esCredito = input.esCredito != null ? Boolean(input.esCredito) : String(formaPago) === "2";
  if (!Array.isArray(items) || items.length === 0) {
    throw new VentaPayloadError("El documento no tiene productos", "items");
  }

  // Vendedor: obligatorio si KAME tiene vendedores creados, y debe existir
  // tal cual en KAME (se compara sin mayúsculas).
  let vendedorKame = "";
  const vendedores = await resolvers.listarVendedores();
  if (!String(vendedor || "").trim() && vendedores.length > 0) {
    throw new VentaPayloadError("Elige el vendedor que está vendiendo", "vendedor");
  }
  if (String(vendedor || "").trim()) {
    vendedorKame = vendedores.find(
      (v) => String(v).trim().toLowerCase() === String(vendedor).trim().toLowerCase()
    );
    if (!vendedorKame) {
      throw new VentaPayloadError(`El vendedor "${vendedor}" no existe en KAME`, "vendedor");
    }
  }

  // Cliente: los datos salen de la ficha de KAME, no del navegador
  const ficha = await resolvers.fichaCliente(rut);
  if (!ficha) throw new VentaPayloadError(`No existe un cliente con RUT ${rut} en KAME`, "rut");

  // Productos: cada SKU debe existir en el maestro
  const detalle = [];
  for (const item of items) {
    const art = await resolvers.buscarArticulo(item.articulo);
    if (!art) throw new VentaPayloadError(`El artículo "${item.articulo}" no existe en KAME`, "articulo");
    detalle.push(
      construirLinea({
        ...item,
        articulo: art.SKU || art.Sku || item.articulo,
        descripcion: item.descripcion || art.Descripcion,
        unidadMedida: item.unidadMedida || art.UnidadMedida,
      })
    );
  }

  const totales = calcularTotales(detalle);
  // Varias condiciones de pago (ej. mitad contado, mitad a 30 días): cada
  // línea se envía como una cuota con su monto y su fecha (hoy si es
  // contado, fecha + días si es crédito). FormaPago queda como la primera
  // condición a crédito, porque KAME exige cuotas solo en crédito.
  let formaPagoFinal = String(formaPago);
  let cuotasKame = null;
  const pagos = Array.isArray(input.pagos) ? input.pagos.filter((p) => p && p.codigo) : [];
  if (pagos.length > 1 || (pagos.length === 1 && pagos[0].credito)) {
    let montos = pagos.map((p) => (p.monto == null || p.monto === "" ? null : clp(Number(p.monto))));
    if (pagos.length === 1) montos = [totales.total];
    if (montos.some((m) => m == null || !(m > 0))) {
      throw new VentaPayloadError("Cada condición de pago debe tener un monto mayor a 0", "pagos");
    }
    const suma = montos.reduce((a, m) => a + m, 0);
    const diferencia = totales.total - suma;
    // Diferencias de redondeo de pocos pesos se ajustan en la última línea
    if (Math.abs(diferencia) > pagos.length * 2) {
      throw new VentaPayloadError(`Las condiciones de pago suman ${suma} pero el total es ${totales.total}`, "pagos");
    }
    montos[montos.length - 1] += diferencia;
    const credito = pagos.find((p) => p.credito);
    formaPagoFinal = String((credito || pagos[0]).codigo);
    cuotasKame = construirCuotas(
      pagos.map((p, i) => ({ fechaPago: sumarDias(fecha, p.credito ? Number(p.dias) || 30 : 0), montoPago: montos[i] })),
      totales.total
    );
  } else if (pagos.length === 1) {
    formaPagoFinal = String(pagos[0].codigo);
  } else if (esCredito) {
    const lista =
      Array.isArray(cuotas) && cuotas.length
        ? cuotas
        : [{ fechaPago: sumarDias(fecha, Number(input.diasCredito) > 0 ? Number(input.diasCredito) : 30), montoPago: totales.total }];
    cuotasKame = construirCuotas(lista, totales.total);
  }

  // Nota de venta basada en una cotización: queda la referencia en el comentario
  const comentarioFinal = input.cotizacionOrigen
    ? `Según cotización N° ${input.cotizacionOrigen}${comentario ? ". " + comentario : ""}`
    : comentario;

  return {
    Usuario: usuario,
    Documento: documento,
    Sucursal: sucursal,
    Rut: ficha.Rut || rut,
    TipoDocumento: tipo,
    Folio: folio,
    RznSocial: ficha.RznSocial || ficha.RazonSocial || "",
    Giro: ficha.Giro || "",
    Direccion: ficha.Direccion || "",
    Ciudad: ficha.Ciudad || "",
    Comuna: ficha.Comuna || "",
    Telefono: ficha.Telefono || "",
    Email: ficha.Email || "",
    Fecha: `${fecha}T00:00:00`,
    Comentario: comentarioFinal,
    FormaPago: formaPagoFinal,
    ...totales,
    Bodega: bodega,
    EsInventariable: "S",
    Vendedor: vendedorKame,
    Recargo: 0,
    PorcDescuento: 0,
    PorcRecargo: 0,
    Contacto: contacto,
    Comision: null,
    Detalle: detalle,
    ...(cuotasKame ? { Cuotas: cuotasKame } : {}),
  };
}

// POST /Documento/addCotizacion — lleva además FechaVigencia
async function payloadCotizacion(input, resolvers) {
  const base = await construirBase(input, resolvers, "COTIZACION");
  const fecha = base.Fecha.slice(0, 10);
  const vigencia = input.fechaVigencia || sumarDias(fecha, Number(input.diasVigencia || 15));
  return { ...base, FechaVigencia: `${vigencia}T00:00:00` };
}

// POST /Documento/addPedido — nota de venta. Si KAME no acepta Folio ""
// (autonumeración no confirmada para pedidos), la primera prueba lo dirá.
async function payloadPedido(input, resolvers) {
  return construirBase(input, resolvers, "PEDIDO");
}

module.exports = {
  VentaPayloadError,
  construirLinea,
  calcularTotales,
  construirCuotas,
  payloadCotizacion,
  payloadPedido,
  hoyChile,
};
