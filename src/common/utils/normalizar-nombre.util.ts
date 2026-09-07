// Normalización mínima para COMPARAR nombres de catálogo ignorando
// mayúsculas/minúsculas y espacios accidentales al inicio/final —
// "Entradas" / "entradas" / "ENTRADAS" / "  EnTrAdAs  " se consideran el
// mismo nombre. Única fuente de verdad: la usa tanto la validación de
// unicidad en capa de negocio (CategoriasProductoService) como el índice
// único parcial a nivel Postgres (ver migración
// AddNombreCategoriaProductoUnico), que aplica la MISMA regla —
// LOWER(TRIM(...)) — directo en SQL.
//
// Esta función NUNCA se usa para decidir qué se guarda o se muestra: el
// nombre almacenado/visible conserva exactamente el formato que ingresó el
// admin. Solo sirve para la comparación de igualdad.
export function normalizarNombre(nombre: string): string {
  return nombre.trim().toLowerCase();
}
