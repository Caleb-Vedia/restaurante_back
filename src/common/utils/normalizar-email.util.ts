// Normalización de email para IDENTIDAD de cuenta: a diferencia de
// normalizarNombre (que solo sirve para COMPARAR sin alterar lo guardado),
// acá el resultado es también lo que se persiste — el email es el
// identificador real de la cuenta, no un texto de catálogo cuyo formato
// visible importa conservar. "JUAN@gmail.com" / "juan@gmail.com" /
// "  Juan@Gmail.com" se guardan y comparan siempre como
// "juan@gmail.com".
//
// Única fuente de verdad: la usa tanto UsuariosService (normalización al
// guardar + validación de unicidad) como el índice único a nivel Postgres
// (ver migración AddTelefonoYEmailNormalizadoUsuarios), que aplica la MISMA
// regla — LOWER(TRIM(...)) — directo en SQL.
export function normalizarEmail(email: string): string {
  return email.trim().toLowerCase();
}
