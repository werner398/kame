require("dotenv").config();

// Un error no controlado en una consulta (por ejemplo, KAME respondiendo algo
// inesperado) no debe botar todo el servidor: se registra en los logs de
// Railway y el backend sigue atendiendo.
process.on("unhandledRejection", (motivo) => {
  console.error("[unhandledRejection]", motivo instanceof Error ? motivo.stack : motivo);
});
process.on("uncaughtException", (error) => {
  console.error("[uncaughtException]", error.stack || error);
});
const express = require("express");
const cors = require("cors");

// Express 4 no captura los errores de las rutas async (quedan como promesa
// rechazada). Este parche, aplicado ANTES de cargar las rutas, los envía al
// manejador de errores del final, que responde 500 sin botar el servidor.
{
  const protoRouter = Object.getPrototypeOf(express.Router());
  for (const metodo of ["get", "post", "put", "delete", "patch"]) {
    const original = protoRouter[metodo];
    protoRouter[metodo] = function (ruta, ...handlers) {
      const envueltos = handlers.map((h) =>
        typeof h === "function" && h.length < 4
          ? function (req, res, next) {
              try {
                const r = h(req, res, next);
                if (r && typeof r.catch === "function") r.catch(next);
              } catch (error) {
                next(error);
              }
            }
          : h
      );
      return original.call(this, ruta, ...envueltos);
    };
  }
}

const { router: stockRouter, refrescarCacheStock } = require("./stock");
const { router: ventasRouter } = require("./ventas");
const { router: cobrosRouter } = require("./cobros");
const { router: clientesRouter } = require("./clientes");
const { router: productosRouter } = require("./productos");
const { router: proveedoresRouter } = require("./proveedores");
const { router: movimientosRouter } = require("./movimientos");
const { router: documentosRouter, listarVendedores } = require("./documentos");
const { crearRutas: rutasVendedores } = require("./vendedores");

const app = express();

app.use(cors());
// Los adjuntos (OC en PDF o foto) llegan en base64: límite mayor solo en esa ruta
app.use("/api/documentos/registro", express.json({ limit: "15mb" }));
app.use(express.json());

// Chequeo simple para saber si el servidor está vivo (útil al hostear)
const db = require("./db");
app.get("/health", (req, res) =>
  res.json({
    ok: true,
    hora: new Date().toISOString(),
    baseDatosPersistente: db.persistente,
    claveAdminConfigurada: Boolean(String(process.env.CLAVE_ADMIN || "").trim()),
  })
);

app.use("/api/stock", stockRouter);
app.use("/api/ventas", ventasRouter);
app.use("/api/cobros", cobrosRouter);
app.use("/api/clientes", clientesRouter);
app.use("/api/productos", productosRouter);
app.use("/api/proveedores", proveedoresRouter);
app.use("/api/movimientos", movimientosRouter);
app.use("/api/documentos", documentosRouter);
app.use("/api/vendedores", rutasVendedores(listarVendedores));

// Errores dentro de las rutas: respuesta 500 con el motivo, sin caer el servidor
// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  console.error("[error en ruta]", req.method, req.originalUrl, error.stack || error);
  if (!res.headersSent) res.status(error.status || 500).json({ error: error.message || "Error interno" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend del dashboard KAME corriendo en el puerto ${PORT}`);
});

// Refrescamos la cache de stock cada 2 minutos, en vez de pedirle
// a KAME el stock cada vez que alguien abre el dashboard.
refrescarCacheStock();
setInterval(refrescarCacheStock, 2 * 60 * 1000);
