import { MigrationInterface, QueryRunner } from "typeorm";

export class AddObservacionDiferenciaCierreCaja1787878209912 implements MigrationInterface {
    name = 'AddObservacionDiferenciaCierreCaja1787878209912'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "cierres_caja" ADD "observacion_diferencia" character varying(120)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "cierres_caja" DROP COLUMN "observacion_diferencia"`);
    }

}
