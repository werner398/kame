require("dotenv").config();
const express = require("express");
const cors = require("cors");

const { router: stockRouter, refrescarCacheStock } = require("./routes/stock");
const { router: ventasRouter } = require("./routes/ventas");
const { router: cobrosRouter } = require("./routes/cobros");
const { router: clientesRouter } = require("./routes/clientes");
const { router: productosRouter } = require("./routes/productos");

const app = express();

app.use(cors());
app.use(express.json());

// Chequeo simple para saber si el servidor está vivo (útil al hostear)
app.get("/health", (req, res) => res.json({ ok: true, hora: new Date().toISOString() }));

app.use("/api/stock", stockRouter);
app.use("/api/ventas", ventasRouter);
app.use("/api/cobros", cobrosRouter);
app.use("/api/clientes", clientesRouter);
app.use("/api/productos", productosRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend del dashboard KAME corriendo en el puerto ${PORT}`);
});

// Refrescamos la cache de stock cada 2 minutos, en vez de pedirle
// a KAME el stock cada vez que alguien abre el dashboard.
refrescarCacheStock();
setInterval(refrescarCacheStock, 2 * 60 * 1000);
