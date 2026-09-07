import { RolUsuario } from '../../common/enums/rol-usuario.enum';

export interface UsuarioLoginResponse {
  idUsuario: number;
  nombre: string;
  email: string;
  rol: RolUsuario;
}

// Body público de POST /auth/login. NO incluye el JWT: viaja en la cookie
// httpOnly `access_token` (decisión #16), que el frontend no puede ni necesita
// leer — el navegador la manda sola en cada request.
export interface LoginResponse {
  usuario: UsuarioLoginResponse;
}

// Resultado interno del service hacia el controller: además del usuario lleva
// el token crudo y su vida útil, para que el controller arme la cookie. No
// cruza la API.
export interface LoginResultado {
  accessToken: string;
  maxAgeMs: number;
  usuario: UsuarioLoginResponse;
}
