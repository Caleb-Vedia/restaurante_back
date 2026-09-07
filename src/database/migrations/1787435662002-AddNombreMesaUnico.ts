import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNombreMesaUnico1787435662002 implements MigrationInterface {
  name = 'AddNombreMesaUnico1787435662002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Refuerzo de integridad a nivel Postgres de la regla de negocio ya
    // validada en MesasService (assertNombreDisponible): dos mesas NO
    // soft-deleted no pueden compartir el mismo nombre normalizado
    // (case-insensitive + trim), sin importar `estado` (libre/ocupada/
    // cuenta_solicitada). Índice ÚNICO PARCIAL sobre la EXPRESIÓN
    // LOWER(TRIM(nombre_mesa)), no sobre la columna cruda — así
    // "Mesa 1"/"mesa 1"/"MESA 1" colisionan entre sí, pero el valor
    // guardado/visible sigue siendo el que tipeó el admin (esta expresión
    // no transforma nada, solo compara). Mismo patrón que las migraciones
    // AddNombreCategoriaProductoUnico / AddNombreProductoUnico.
    //
    // WHERE "borrado_el" IS NULL: la unicidad aplica SOLO entre mesas
    // activas. Una mesa soft-deleted no bloquea el nombre para una nueva:
    // el índice parcial ni siquiera la considera.
    //
    // TypeORM no puede declarar un índice sobre una expresión vía
    // decorators (@Index solo referencia columnas) — vive únicamente acá,
    // igual criterio que los demás índices parciales de este proyecto.
    //
    // Verificado ANTES de escribir esta migración (lectura directa sobre
    // la base real, sin modificar nada): 0 duplicados activos por nombre
    // normalizado en "mesas" hoy (la base fue saneada manualmente), así
    // que este CREATE no falla contra los datos existentes.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_mesas_nombre_activo" ON "mesas" ((LOWER(TRIM("nombre_mesa")))) WHERE "borrado_el" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_mesas_nombre_activo"`);
  }
}
