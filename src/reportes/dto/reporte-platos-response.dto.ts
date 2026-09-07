// Shapes de respuesta del módulo Reportes (contrato JSON en camelCase, #14).

export interface PlatoMasVendidoResponse {
  idProducto: number;
  // Nombre del producto al momento de generar el reporte (incluye productos
  // soft-deleted que tuvieron ventas en el rango — decisión #19).
  nombreProducto: string;
  cantidadVendida: number;
  ingresoGenerado: number;
}

export interface ReportePlatosMasVendidosResponse {
  desde: string;
  hasta: string;
  platos: PlatoMasVendidoResponse[];
}
