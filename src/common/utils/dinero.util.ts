// Comparaciones de dinero SIEMPRE en centavos (enteros): comparar montos
// decimales como floats produce falsos negativos por representación binaria
// (ej. 0.1 + 0.2 !== 0.3). Única fuente de verdad para esa conversión.

export function aCentavos(monto: number): number {
  return Math.round(monto * 100);
}

export function desdeCentavos(centavos: number): number {
  return centavos / 100;
}
