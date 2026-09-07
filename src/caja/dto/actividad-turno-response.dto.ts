import { PedidoResponse } from '../../pedidos/dto/pedido-response.dto';
import { PagoResponse } from '../../pagos/dto/pago-response.dto';

// Actividad del turno de caja en curso (Caja 2.0, Etapa 5B). Contrato JSON en
// camelCase (#14), organizado por VISITA (SesionMesa), no por Mesa: una misma
// mesa puede haber tenido dos visitas distintas dentro del mismo turno y cada
// una es una fila propia, con su propio consumo y sus propios pagos.
//
// `pedidos` y `pagos` reusan tal cual PedidoResponse/PagoResponse (los mismos
// shapes y los mismos mappers que ya usan Pedidos y Pagos) — no hay un DTO
// paralelo de pedido ni de pago en esta etapa.

export interface SesionActividadTurnoResponse {
  idSesion: number;
  idMesa: number;
  nombreMesa: string;
  abiertaEl: Date;
  // null = la visita sigue abierta al momento de generar el reporte.
  cerradaEl: Date | null;
  // true si la visita venía de un turno anterior (abiertaEl < abiertoEl del
  // cierre actual). Caja necesita distinguirlas: su consumo puede incluir
  // pedidos que este turno no vio entrar.
  comenzoEnTurnoAnterior: boolean;

  // Consumo COMPLETO de la visita (todos sus pedidos, sin recortar por la
  // ventana del turno), a precios congelados. Es el total que Caja tendría
  // que cobrar por esta mesa — NO es un ingreso del turno: los ingresos
  // salen exclusivamente de `pagos`/`totalIngresosTurno`.
  totalSesion: number;

  // Pedidos CREADOS dentro de la ventana del turno. Un pedido anterior al
  // turno no aparece acá, pero sí está contado en `totalSesion`.
  pedidos: PedidoResponse[];

  // Pagos CREADOS dentro de la ventana del turno, vigentes Y anulados (cada
  // uno trae su `anuladoEl`): la anulación es parte de la actividad del turno
  // y esconderla dejaría el movimiento sin explicación.
  pagos: PagoResponse[];
}

export interface ActividadTurnoResponse {
  idCierre: number;
  abiertoEl: Date;
  // Límite superior real de la ventana consultada (el "ahora" del reporte).
  generadoEl: Date;

  // Ingresos del turno = suma de los pagos de la ventana con `anuladoEl IS
  // NULL`, en todas las sesiones. Misma definición que usa el arqueo de
  // cerrarCaja (sin el fondo inicial de efectivo, que no es un ingreso).
  // NUNCA se suman los `totalSesion`: eso contaría consumo no cobrado, y
  // duplicaría lo ya cobrado en turnos anteriores de una visita larga.
  totalIngresosTurno: number;

  sesiones: SesionActividadTurnoResponse[];
}
