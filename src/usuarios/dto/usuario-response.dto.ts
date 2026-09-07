import { RolUsuario } from '../../common/enums/rol-usuario.enum';

// Usuario completo MENOS password_hash (nunca sale de la base hacia la API).
export interface UsuarioResponse {
  idUsuario: number;
  nombre: string;
  email: string;
  rol: RolUsuario;
  activo: boolean;
  telefono: string | null;
}
