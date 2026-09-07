import { EstadoMesa } from '../../common/enums/estado-mesa.enum';

// Shapes de respuesta del módulo Mesas (contrato JSON en camelCase, decisión #14).

export interface SesionActivaResponse {
  idSesion: number;
  abiertaEl: Date;
}

export interface MesaResponse {
  idMesa: number;
  nombreMesa: string;
  estado: EstadoMesa;
  sesionActiva: SesionActivaResponse | null;
}

// Respuesta pública al abrir/recuperar la sesión de una mesa (cliente vía QR).
export interface AbrirSesionResponse {
  token: string;
  idMesa: number;
  nombreMesa: string;
  estado: EstadoMesa;
}

export interface PedirCuentaResponse {
  idMesa: number;
  estado: EstadoMesa;
}
