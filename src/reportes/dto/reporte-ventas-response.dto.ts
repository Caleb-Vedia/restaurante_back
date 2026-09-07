// Shapes de respuesta del módulo Reportes (contrato JSON en camelCase, #14).

export interface IngresoPorMetodoPagoResponse {
  idMetodoPago: number;
  nombreMetodo: string;
  ingresos: number;
  cantidadPagos: number;
}

// `fecha` en formato YYYY-MM-DD, día calendario en TIMEZONE_RESTAURANTE.
export interface VentaDiariaResponse {
  fecha: string;
  ingresos: number;
  cantidadTickets: number;
}

export interface ReporteVentasResponse {
  desde: string;
  hasta: string;
  resumen: {
    ingresosTotales: number;
    // Sesiones distintas pagadas (COUNT DISTINCT id_sesion), no filas de pago.
    cantidadTickets: number;
    ticketPromedio: number;
  };
  porMetodoPago: IngresoPorMetodoPagoResponse[];
  serieDiaria: VentaDiariaResponse[];
}
