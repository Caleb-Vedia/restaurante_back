import { Pedido } from '../entities/pedido.entity';
import { PedidoResponse } from './pedido-response.dto';

// Mapper del contrato de Pedido. Vive junto al DTO —función pura, sin
// decoradores Nest ni providers— porque lo consumen módulos distintos:
// PedidosService (cliente + staff) y ActividadTurnoService (Caja, actividad
// del turno). Si siguiera siendo un método privado del service, Caja habría
// tenido que reimplementar el mismo mapeo y las dos copias podrían divergir
// en qué campos expone el contrato — mismo criterio que saldo-sesion.util.
//
// PRECONDICIÓN: `pedido` tiene que venir con `detallesPedido` y, en cada
// detalle, su `producto` cargado (relations: { detallesPedido: { producto:
// true } }, normalmente con `withDeleted` para que un producto dado de baja
// después de pedirse no desaparezca del histórico).
export function toPedidoResponse(pedido: Pedido): PedidoResponse {
  return {
    idPedido: pedido.idPedido,
    nroOrden: pedido.nroOrden,
    nombreComensal: pedido.nombreComensal,
    estado: pedido.estado,
    creadoEl: pedido.creadoEl,
    detalles: pedido.detallesPedido.map((detalle) => ({
      idDetalle: detalle.idDetalle,
      idProducto: detalle.idProducto,
      nombreProducto: detalle.producto.nombreProducto,
      cantidad: detalle.cantidad,
      precioActual: detalle.precioActual,
      observacion: detalle.observacion,
    })),
  };
}
