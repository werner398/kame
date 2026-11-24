require("dotenv").config();
const express = require("express");
const cors = require("cors");

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend del dashboard KAME corriendo en el puerto ${PORT}`);
});

// Refrescamos la cache de stock cada 2 minutos, en vez de pedirle
// a KAME el stock cada vez que alguien abre el dashboard.
refrescarCacheStock();
setInterval(refrescarCacheStock, 2 * 60 * 1000);
