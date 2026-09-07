import { EstadoMesa } from '../../common/enums/estado-mesa.enum';

// Shapes de respuesta del módulo Pagos (contrato JSON en camelCase, #14).

export interface PagoResponse {
  idPago: number;
  idSesion: number;
  idMetodoPago: number;
  nombreMetodo: string;
  nroRecibo: string | null;
  montoPagado: number;
  // null = pago vigente; con fecha = anulado (ajuste contable, ver #18).
  anuladoEl: Date | null;
  creadoEl: Date;
}

export interface TotalAdeudadoResponse {
  idMesa: number;
  nombreMesa: string;
  idSesion: number;
  abiertaEl: Date;
  totalAdeudado: number;
  // Pagos no anulados ya registrados contra esta sesión (normalmente 0: la
  // sesión se cierra apenas se cubre el total).
  totalPagado: number;
  saldoPendiente: number;
}

export interface RegistrarPagoResponse {
  idSesion: number;
  totalAdeudado: number;
  totalPagado: number;
  pagos: PagoResponse[];
  mesa: {
    idMesa: number;
    nombreMesa: string;
    estado: EstadoMesa;
  };
  // false solo si el cobro se registró pero el cierre de la sesión falló
  // después del commit; en ese caso la mesa se cierra reintentando
  // PATCH /mesas/:id/cerrar-sesion.
  mesaLiberada: boolean;
}
