import type { CookieOptions } from 'express';

// Nombre de la cookie httpOnly que transporta el JWT de personal (decisión #16).
export const AUTH_COOKIE_NAME = 'access_token';

// Única fuente de verdad de los flags de la cookie de auth. Login y logout
// DEBEN usar exactamente los mismos: el navegador identifica una cookie por
// (nombre, dominio, path), así que si al limpiarla difiere alguno, la cookie
// vieja sobrevive y la sesión no se cierra de verdad.
//
// - httpOnly: el JS del frontend no puede leerla (mitiga robo por XSS).
// - secure: solo en producción — en dev sobre http el navegador descartaría
//   la cookie si fuera siempre true.
// - sameSite 'strict': frontend y backend viven bajo el mismo dominio (el
//   backend detrás de /api), así que no hay escenario cross-site que soportar.
export function opcionesCookieAuth(maxAgeMs?: number): CookieOptions {
  const opciones: CookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
  };
  return maxAgeMs === undefined ? opciones : { ...opciones, maxAge: maxAgeMs };
}
