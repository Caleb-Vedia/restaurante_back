import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCodigoMetodoPago1787085861441 implements MigrationInterface {
    name = 'AddCodigoMetodoPago1787085861441'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "metodos_pago" ADD "codigo" character varying`);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_metodos_pago_codigo" ON "metodos_pago" ("codigo") WHERE codigo IS NOT NULL`);

        // Backfill: si ya existía una fila de efectivo (case-insensitive, sin
        // espacios extra), recibe el código estable.
        await queryRunner.query(
            `UPDATE "metodos_pago" SET "codigo" = 'efectivo' WHERE LOWER(TRIM("nombre_metodo")) = 'efectivo'`,
        );

        // Catálogo mínimo si la tabla está vacía (instalación nueva). Solo
        // 'efectivo' lleva código: es el único que el arqueo necesita
        // identificar (es al que se le suma el fondo inicial al cerrar caja).
        // Los nombres son editables después por el admin sin afectar nada.
        const filas: Array<{ total: string }> = await queryRunner.query(
            `SELECT COUNT(*) AS total FROM "metodos_pago"`,
        );
        if (Number(filas[0].total) === 0) {
            await queryRunner.query(
                `INSERT INTO "metodos_pago" ("nombre_metodo", "codigo") VALUES ('Efectivo', 'efectivo'), ('Tarjeta', NULL), ('QR / Transferencia', NULL)`,
            );
        }

        // El cierre de caja depende de que exista el método con codigo
        // 'efectivo' para saber a cuál sumarle el fondo inicial. Si después de
        // backfill + seed sigue faltando, fallar acá en vez de dejar el arqueo
        // silenciosamente mal calculado.
        const efectivo: Array<{ id_metodo_pago: number }> = await queryRunner.query(
            `SELECT "id_metodo_pago" FROM "metodos_pago" WHERE "codigo" = 'efectivo'`,
        );
        if (efectivo.length === 0) {
            throw new Error(
                `Migración AddCodigoMetodoPago: no quedó ninguna fila en "metodos_pago" con codigo='efectivo'. El cierre de caja necesita esa fila para sumar el fondo inicial. Renombrá el método de efectivo a "Efectivo" (o seteá el codigo a mano) y volvé a correr la migración.`,
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_metodos_pago_codigo"`);
        await queryRunner.query(`ALTER TABLE "metodos_pago" DROP COLUMN "codigo"`);
    }

}
