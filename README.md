# Backend del dashboard KAME ERP

Este programa se conecta a la API de KAME ERP, cachea datos de stock,
ventas y cobranza, y expone la única escritura habilitada por ahora:
actualizar nombre, precio de lista, y mínimo/máximo de un producto —
todo con validaciones y registro de auditoría propio.

## Qué endpoints expone (para el dashboard)

- `GET /api/stock` — stock general (cacheado, se refresca cada 2 min)
- `GET /api/stock/bodega/:nombreBodega`
- `GET /api/stock/articulo/:nombreArticulo`
- `GET /api/ventas?fechaDesde=&fechaHasta=`
- `GET /api/cobros?fechaVencimientoDesde=&fechaVencimientoHasta=` — sirve para Saldo clientes y Facturas Vencidas
- `POST /api/cobros/:numeroDocumento/revisado` — body: `{ "usuario": "..." }`
- `GET /api/clientes/:rut` — ficha + comentarios
- `POST /api/clientes/:rut/comentarios` — body: `{ "usuario": "...", "comentario": "..." }`
- `GET /api/productos/:sku`
- `PUT /api/productos/:sku` — body: `{ "usuario": "...", "cambios": { "nombre"?, "precioLista"?, "stockMin"?, "stockMax"? } }`
- `GET /api/productos/:sku/auditoria` — historial de cambios

## Cómo desplegarlo en la nube (Railway — sin conocimientos técnicos)

Railway es de las opciones más simples: subes el código, le pones las
credenciales, y queda corriendo con una URL propia, sin tocar servidores.

### Paso 1: Crear cuenta

Entra a [railway.app](https://railway.app) y crea una cuenta (puedes usar
tu cuenta de GitHub para entrar más rápido).

### Paso 2: Subir el código

La forma más simple es subir esta carpeta a un repositorio de GitHub:

1. Crea un repositorio nuevo en [github.com](https://github.com) (puede ser privado)
2. Sube todos los archivos de esta carpeta ahí (GitHub tiene un botón
   "Upload files" que permite arrastrar la carpeta completa, sin usar
   la línea de comandos)

### Paso 3: Conectar Railway con tu repositorio

1. En Railway, click en **"New Project"**
2. Elige **"Deploy from GitHub repo"**
3. Autoriza el acceso y selecciona el repositorio que acabas de crear
4. Railway detecta solo que es un proyecto Node.js y lo empieza a construir

### Paso 4: Configurar las credenciales

Este es el paso más importante — nunca subas tu archivo `.env` real a
GitHub, las credenciales se configuran directo en Railway:

1. Dentro del proyecto en Railway, ve a la pestaña **"Variables"**
2. Agrega una por una las mismas variables que están en `.env.example`:
   - `KAME_CLIENT_ID`
   - `KAME_CLIENT_SECRET`
   - `KAME_AUDIENCE`
   - `KAME_TOKEN_URL`
   - `KAME_API_URL`
   - `KAME_USUARIO_SISTEMA`
3. Railway va a reiniciar el servicio solo, con esas credenciales activas

### Paso 5: Obtener la URL pública

1. En la pestaña **"Settings"** del proyecto, busca **"Networking"**
2. Click en **"Generate Domain"**
3. Railway te da una URL tipo `tu-proyecto.up.railway.app` — esa es la
   dirección que el dashboard va a usar para hablarle a este backend

### Verificar que funciona

Abre en el navegador: `https://tu-proyecto.up.railway.app/health`

Si ves `{"ok":true,"hora":"..."}`, el backend está corriendo correctamente.

## Correrlo en tu computador primero (recomendado antes de desplegar)

Si tienes Node.js instalado, puedes probarlo localmente antes de subirlo
a la nube:

```
npm install
cp .env.example .env
# Edita .env y pon tus credenciales reales
npm start
```

Luego abre `http://localhost:3000/health` para confirmar que responde.
