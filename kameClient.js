// Este archivo es el ÚNICO lugar del sistema que le habla a KAME.
// Se encarga de pedir el token a Auth0, guardarlo en memoria, y renovarlo
// automáticamente antes de que expire. Nadie más necesita saber cómo
// funciona la autenticación: solo llaman a las funciones de este archivo.

let cachedToken = null;
let tokenExpiraEn = 0; // timestamp en milisegundos

async function obtenerToken() {
  const ahora = Date.now();

  // Si tenemos un token guardado y todavía no expira, lo reusamos
  // (con 60 segundos de margen de seguridad)
  if (cachedToken && ahora < tokenExpiraEn - 60_000) {
    return cachedToken;
  }

  const respuesta = await fetch(process.env.KAME_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.KAME_CLIENT_ID,
      client_secret: process.env.KAME_CLIENT_SECRET,
      audience: process.env.KAME_AUDIENCE,
      grant_type: "client_credentials",
    }),
  });

  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    throw new Error(`No se pudo obtener el token de Auth0: ${detalle}`);
  }

  const data = await respuesta.json();
  cachedToken = data.access_token;
  // expires_in viene en segundos, lo convertimos a un timestamp futuro
  tokenExpiraEn = ahora + data.expires_in * 1000;

  return cachedToken;
}

// Wrapper genérico para llamar a cualquier endpoint de KAME.
// Agrega automáticamente el token de autorización.
async function llamarKame(ruta, opciones = {}) {
  const token = await obtenerToken();

  const respuesta = await fetch(`${process.env.KAME_API_URL}${ruta}`, {
    ...opciones,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(opciones.headers || {}),
    },
  });

  const texto = await respuesta.text();
  let cuerpo;
  try {
    cuerpo = texto ? JSON.parse(texto) : null;
  } catch {
    cuerpo = texto;
  }

  if (!respuesta.ok) {
    const error = new Error(`KAME respondió ${respuesta.status} en ${ruta}`);
    error.status = respuesta.status;
    error.detalle = cuerpo;
    throw error;
  }

  return cuerpo;
}

module.exports = { llamarKame };
