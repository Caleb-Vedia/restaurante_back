import { EstadoPedido } from '../../common/enums/estado-pedido.enum';

// Shapes de respuesta del módulo Pedidos (contrato JSON en camelCase, #14).
// No exponen campos internos (borradoEl, idSesion del token, etc.).

// --- Confirmación al cliente que acaba de crear el pedido ---

export interface DetallePedidoResponse {
  idDetalle: number;
  idProducto: number;
  nombreProducto: string;
  cantidad: number;
  // Precio congelado al momento del pedido: cambios posteriores del catálogo
  // no alteran lo que el comensal ya pidió.
  precioActual: number;
  observacion: string | null;
}

export interface PedidoResponse {
  idPedido: number;
  nroOrden: number;
  nombreComensal: string | null;
  estado: EstadoPedido;
  creadoEl: Date;
  detalles: DetallePedidoResponse[];
}

// --- Consumo actual de una mesa (staff: Caja/Admin) ---

// Reusa PedidoResponse/DetallePedidoResponse tal cual (mismos campos que ya
// ve el cliente en "Mis pedidos" y en el tracking): idPedido, nroOrden,
// estado, creadoEl y, por detalle, idProducto/nombreProducto/cantidad/
// precioActual/observacion ya alcanzan para que Caja entienda de dónde sale
// el saldo, sin reconstruir relaciones ni inventar un DTO paralelo casi
// idéntico. `subtotal` se omite a propósito: es cantidad * precioActual, un
// producto de dos campos que ya viajan acá — no hace falta que el backend
// lo precalcule para que el frontend "reconstruya relaciones" (no hay
// relación que reconstruir, es aritmética simple).
export interface ConsumoSesionResponse {
  idMesa: number;
  nombreMesa: string;
  idSesion: number;
  abiertaEl: Date;
  pedidos: PedidoResponse[];
}

// --- Listado del KDS (cocina / bebidas) ---

export interface DetallePedidoKdsResponse {
  idDetalle: number;
  nombreProducto: string;
  cantidad: number;
  observacion: string | null;
}

export interface PedidoKdsResponse {
  idPedido: number;
  nroOrden: number;
  nombreMesa: string;
  nombreComensal: string | null;
  estado: EstadoPedido;
  creadoEl: Date;
  detalles: DetallePedidoKdsResponse[];
}
