import { MigrationInterface, QueryRunner } from "typeorm";

export class AddIngredientesProducto1786570552190 implements MigrationInterface {
    name = 'AddIngredientesProducto1786570552190'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "ingredientes_producto" ("id_ingrediente" SERIAL NOT NULL, "id_producto" integer NOT NULL, "nombre_ingrediente" character varying NOT NULL, "borrado_el" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_2711117c9f60e4fc319b28af5a6" PRIMARY KEY ("id_ingrediente"))`);
        await queryRunner.query(`ALTER TABLE "ingredientes_producto" ADD CONSTRAINT "FK_66531b1c849a4e7de4f6da0aacb" FOREIGN KEY ("id_producto") REFERENCES "productos"("id_producto") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ingredientes_producto" DROP CONSTRAINT "FK_66531b1c849a4e7de4f6da0aacb"`);
        await queryRunner.query(`DROP TABLE "ingredientes_producto"`);
    }

}
