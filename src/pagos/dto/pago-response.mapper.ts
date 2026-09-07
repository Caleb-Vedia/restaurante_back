import { Pago } from '../entities/pago.entity';
import { PagoResponse } from './pago-response.dto';

// Mapper del contrato de Pago. Mismo criterio que pedido-response.mapper:
// función pura junto al DTO, porque la consumen PagosService (cobro,
// anulación, historial) y ActividadTurnoService (Caja, actividad del turno)
// sin que ninguno de los dos módulos tenga que importar al otro.
//
// PRECONDICIÓN: `pago` viene con su `metodoPago` cargado (normalmente con
// `withDeleted`: un método dado de baja después del cobro igual tiene que
// mostrar su nombre en el histórico).
export function toPagoResponse(pago: Pago): PagoResponse {
  return {
    idPago: pago.idPago,
    idSesion: pago.idSesion,
    idMetodoPago: pago.idMetodoPago,
    nombreMetodo: pago.metodoPago.nombreMetodo,
    nroRecibo: pago.nroRecibo,
    montoPagado: pago.montoPagado,
    anuladoEl: pago.anuladoEl,
    creadoEl: pago.creadoEl,
  };
}
