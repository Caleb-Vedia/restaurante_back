import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCierreCajaAbiertoUnico1787085657619 implements MigrationInterface {
    name = 'AddCierreCajaAbiertoUnico1787085657619'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Un solo cierre de caja abierto a la vez en TODO el restaurante (no por
        // usuario). El índice va sobre la expresión constante `(true)`, no sobre
        // una columna: todas las filas con cerrado_el IS NULL colisionan en la
        // misma clave. Un índice sobre "id_cierre" NO serviría — cada fila tiene
        // un id distinto, así que dos cierres abiertos no chocarían nunca.
        await queryRunner.query(
            `CREATE UNIQUE INDEX "idx_cierres_caja_abierto_unico" ON "cierres_caja" ((true)) WHERE cerrado_el IS NULL`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_cierres_caja_abierto_unico"`);
    }

}
