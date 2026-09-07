import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNombreMetodoPagoUnico1787586860324 implements MigrationInterface {
  name = 'AddNombreMetodoPagoUnico1787586860324';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Refuerzo de integridad a nivel Postgres de la regla de negocio ya
    // validada en MetodosPagoService (assertNombreDisponible): dos métodos
    // de pago NO soft-deleted no pueden compartir el mismo nombre
    // normalizado (case-insensitive + trim). Índice ÚNICO PARCIAL sobre la
    // EXPRESIÓN LOWER(TRIM(nombre_metodo)), no sobre la columna cruda — así
    // "QR"/"qr"/"Qr" colisionan entre sí, pero el valor guardado/visible
    // sigue siendo el que tipeó el admin (esta expresión no transforma
    // nada, solo compara). Mismo patrón que las migraciones
    // AddNombreCategoriaProductoUnico / AddNombreProductoUnico /
    // AddNombreMesaUnico.
    //
    // Totalmente independiente de `codigo` / idx_metodos_pago_codigo (índice
    // ya existente, sin tocar): esta regla no lee ni escribe `codigo`, y la
    // protección de 'efectivo' contra soft-delete (MetodosPagoService.remove)
    // tampoco se ve afectada.
    //
    // WHERE "borrado_el" IS NULL: la unicidad aplica SOLO entre métodos
    // activos. Un método soft-deleted no bloquea el nombre para uno nuevo:
    // el índice parcial ni siquiera lo considera.
    //
    // TypeORM no puede declarar un índice sobre una expresión vía
    // decorators (@Index solo referencia columnas) — vive únicamente acá,
    // igual criterio que los demás índices parciales de este proyecto.
    //
    // Verificado ANTES de escribir esta migración (lectura directa sobre la
    // base real, sin modificar nada): 0 duplicados activos por nombre
    // normalizado en "metodos_pago" hoy — existe un "efectivo" (id 4) con
    // distinto casing de "Efectivo" (id 1), pero id 4 está soft-deleted, así
    // que el índice parcial ni lo considera; este CREATE no falla contra
    // los datos existentes.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_metodos_pago_nombre_activo" ON "metodos_pago" ((LOWER(TRIM("nombre_metodo")))) WHERE "borrado_el" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."idx_metodos_pago_nombre_activo"`,
    );
  }
}
