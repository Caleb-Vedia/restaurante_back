import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNombreProductoUnico1787432119876 implements MigrationInterface {
  name = 'AddNombreProductoUnico1787432119876';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Refuerzo de integridad a nivel Postgres de la regla de negocio ya
    // validada en ProductosService (assertNombreDisponible): dos
    // productos NO soft-deleted no pueden compartir el mismo nombre
    // normalizado (case-insensitive + trim), sin importar categoría,
    // área o disponibilidad. Índice ÚNICO PARCIAL sobre la EXPRESIÓN
    // LOWER(TRIM(nombre_producto)), no sobre la columna cruda — así
    // "Sopa de Mani"/"sopa de mani"/"SOPA DE MANI" colisionan entre sí,
    // pero el valor guardado/visible sigue siendo el que tipeó el admin
    // (esta expresión no transforma nada, solo compara). Igual patrón
    // que la migración AddNombreCategoriaProductoUnico.
    //
    // WHERE "borrado_el" IS NULL: la unicidad aplica SOLO entre
    // productos activos (no soft-deleted). Un producto desactivado
    // (disponible = false) SIGUE bloqueando su nombre — `disponible`
    // no aparece en esta condición a propósito, solo `borrado_el`. Un
    // producto soft-deleted no bloquea el nombre para uno nuevo: el
    // índice parcial ni siquiera lo considera.
    //
    // TypeORM no puede declarar un índice sobre una expresión vía
    // decorators (@Index solo referencia columnas) — vive únicamente
    // acá, igual criterio que los demás índices parciales del proyecto.
    //
    // Verificado ANTES de escribir esta migración (lectura directa
    // sobre la base real, sin modificar nada): hoy existen dos filas
    // "Sopa de Mani" en productos (id 12 activa, id 16 soft-deleted el
    // 2026-08-22). Como el índice es parcial WHERE borrado_el IS NULL,
    // la fila soft-deleted (id 16) queda fuera de la comparación — no
    // hay ningún duplicado ACTIVO por nombre normalizado, así que este
    // CREATE no falla contra los datos existentes.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_productos_nombre_activo" ON "productos" ((LOWER(TRIM("nombre_producto")))) WHERE "borrado_el" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."idx_productos_nombre_activo"`,
    );
  }
}
