import { MigrationInterface, QueryRunner } from "typeorm";

export class AddNombreCategoriaProductoUnico1787431205136 implements MigrationInterface {
    name = 'AddNombreCategoriaProductoUnico1787431205136'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Refuerzo de integridad a nivel Postgres de la regla de negocio ya
        // validada en CategoriasProductoService (assertNombreDisponible):
        // dos categorías NO soft-deleted no pueden compartir el mismo nombre
        // normalizado (case-insensitive + trim). Índice ÚNICO PARCIAL sobre
        // la EXPRESIÓN LOWER(TRIM(nombre_categoria)), no sobre la columna
        // cruda — así "Entradas"/"entradas"/"ENTRADAS" colisionan entre sí,
        // pero el valor guardado/visible sigue siendo el que tipeó el admin
        // (esta expresión no transforma nada, solo compara).
        //
        // WHERE "borrado_el" IS NULL: mismo patrón que
        // idx_areas_producto_codigo / idx_metodos_pago_codigo / idx_sesiones_mesa_id_mesa_abierta
        // — la unicidad aplica SOLO entre categorías activas. Una categoría
        // soft-deleted no bloquea el nombre para una nueva: el índice
        // parcial ni siquiera la considera.
        //
        // TypeORM no puede declarar un índice sobre una expresión vía
        // decorators (@Index solo referencia columnas) — vive únicamente acá,
        // igual criterio que los demás índices parciales de este proyecto.
        //
        // Verificado ANTES de escribir esta migración (lectura directa sobre
        // la base real, sin modificar nada): no hay duplicados activos por
        // nombre normalizado en categorias_producto hoy, así que este CREATE
        // no puede fallar contra los datos existentes.
        await queryRunner.query(
            `CREATE UNIQUE INDEX "idx_categorias_producto_nombre_activo" ON "categorias_producto" ((LOWER(TRIM("nombre_categoria")))) WHERE "borrado_el" IS NULL`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_categorias_producto_nombre_activo"`);
    }

}
