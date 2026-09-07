// Shapes de respuesta del módulo Caja (contrato JSON en camelCase, #14).

export interface CajaAbiertaResponse {
  idCierre: number;
  idUsuario: number;
  abiertoEl: Date;
  montoInicialEfectivo: number;
}

export interface CierreCajaDetalleResponse {
  idMetodoPago: number;
  nombreMetodo: string;
  // Para el método con codigo 'efectivo' incluye el fondo inicial; para el
  // resto es solo la suma de pagos no anulados del turno (decisión #18).
  montoEsperado: number;
  montoContado: number | null;
  // null cuando no se declaró conteo para ese método.
  diferencia: number | null;
}

export interface CierreCajaResumenResponse {
  idCierre: number;
  idUsuario: number;
  abiertoEl: Date;
  cerradoEl: Date;
  montoInicialEfectivo: number;
  totalEsperado: number;
  totalContado: number | null;
  detalle: CierreCajaDetalleResponse[];
  // Explicación breve de la diferencia, ya trimeada (null si no se declaró o
  // quedó vacía tras el trim). Parte del snapshot histórico: un cierre ya
  // cerrado no tiene ningún endpoint para editarla después.
  observacionDiferencia: string | null;
}
