import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCodigoAreaProducto1787082902865 implements MigrationInterface {
    name = 'AddCodigoAreaProducto1787082902865'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "areas_producto" ADD "codigo" character varying`);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_areas_producto_codigo" ON "areas_producto" ("codigo") WHERE codigo IS NOT NULL`);

        // Backfill: la fila cuyo nombre_area matchea 'cocina'/'bebidas' (case-insensitive,
        // sin espacios extra) recibe el código estable correspondiente.
        await queryRunner.query(
            `UPDATE "areas_producto" SET "codigo" = 'cocina' WHERE LOWER(TRIM("nombre_area")) = 'cocina'`,
        );
        await queryRunner.query(
            `UPDATE "areas_producto" SET "codigo" = 'bebidas' WHERE LOWER(TRIM("nombre_area")) = 'bebidas'`,
        );

        // Bootstrap: en una base VACÍA (instalación nueva) no hay ninguna fila
        // que el backfill de arriba pueda matchear por nombre — antes de este
        // cambio, eso hacía fallar la migración incondicionalmente (el check
        // final de abajo tiraba error sí o sí). Mismo patrón que
        // AddCodigoMetodoPago: para cada código que siga faltando después del
        // backfill, se crea la fila usando las columnas reales de la tabla
        // (nombre_area + codigo). En una base existente donde 'Cocina'/
        // 'Bebidas' ya fueron backfillonadas por nombre, el SELECT ya las
        // encuentra y no se inserta nada — no duplica filas.
        const areasBootstrap: ReadonlyArray<readonly [string, string]> = [
            ['cocina', 'Cocina'],
            ['bebidas', 'Bebidas'],
        ];
        for (const [codigo, nombreArea] of areasBootstrap) {
            const existente: Array<{ id_area_producto: number }> = await queryRunner.query(
                `SELECT "id_area_producto" FROM "areas_producto" WHERE "codigo" = $1`,
                [codigo],
            );
            if (existente.length === 0) {
                await queryRunner.query(
                    `INSERT INTO "areas_producto" ("nombre_area", "codigo") VALUES ($1, $2)`,
                    [nombreArea, codigo],
                );
            }
        }

        // El KDS (módulo Pedidos) depende de que ambas áreas existan con su código
        // seteado. Después del backfill + bootstrap de arriba esto ya debería
        // cumplirse siempre en cualquier escenario (base vacía o base
        // existente) — se deja como red de seguridad final por si algo
        // insólito lo impidiera.
        const filas: Array<{ codigo: string | null }> = await queryRunner.query(
            `SELECT "codigo" FROM "areas_producto" WHERE "codigo" IN ('cocina', 'bebidas')`,
        );
        const codigosEncontrados = new Set(filas.map((fila) => fila.codigo));
        const faltantes = ['cocina', 'bebidas'].filter(
            (codigo) => !codigosEncontrados.has(codigo),
        );
        if (faltantes.length > 0) {
            throw new Error(
                `Migración AddCodigoAreaProducto: no se pudo garantizar en "areas_producto" una fila con codigo "${faltantes.join('" o "')}". El KDS de Pedidos necesita ambas áreas creadas.`,
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_areas_producto_codigo"`);
        await queryRunner.query(`ALTER TABLE "areas_producto" DROP COLUMN "codigo"`);
    }

}
