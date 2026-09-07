import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1786331196371 implements MigrationInterface {
    name = 'InitialSchema1786331196371'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."usuarios_rol_enum" AS ENUM('cocina', 'bebidas', 'caja', 'admin')`);
        await queryRunner.query(`CREATE TABLE "usuarios" ("id_usuario" SERIAL NOT NULL, "nombre" character varying NOT NULL, "email" character varying NOT NULL, "password_hash" character varying NOT NULL, "rol" "public"."usuarios_rol_enum" NOT NULL, "activo" boolean NOT NULL DEFAULT true, CONSTRAINT "UQ_446adfc18b35418aac32ae0b7b5" UNIQUE ("email"), CONSTRAINT "PK_dfe59db369749f9042499fd8107" PRIMARY KEY ("id_usuario"))`);
        await queryRunner.query(`CREATE TABLE "cierres_caja" ("id_cierre" SERIAL NOT NULL, "id_usuario" integer NOT NULL, "abierto_el" TIMESTAMP WITH TIME ZONE NOT NULL, "cerrado_el" TIMESTAMP WITH TIME ZONE, "monto_inicial_efectivo" numeric(10,2) NOT NULL, CONSTRAINT "PK_e866669b2e1bca47dfc8d09d5e1" PRIMARY KEY ("id_cierre"))`);
        await queryRunner.query(`CREATE TABLE "metodos_pago" ("id_metodo_pago" SERIAL NOT NULL, "nombre_metodo" character varying NOT NULL, "borrado_el" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_3bf47adc7d054330144de8a210e" PRIMARY KEY ("id_metodo_pago"))`);
        await queryRunner.query(`CREATE TABLE "cierres_caja_detalle" ("id_cierre" integer NOT NULL, "id_metodo_pago" integer NOT NULL, "monto_esperado" numeric(10,2) NOT NULL, "monto_contado" numeric(10,2), CONSTRAINT "PK_fb1faabbf44bf50ff789ccf988f" PRIMARY KEY ("id_cierre", "id_metodo_pago"))`);
        await queryRunner.query(`CREATE TABLE "areas_producto" ("id_area_producto" SERIAL NOT NULL, "nombre_area" character varying NOT NULL, "borrado_el" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_9634feb221b1895bcc7bf94505b" PRIMARY KEY ("id_area_producto"))`);
        await queryRunner.query(`CREATE TABLE "categorias_producto" ("id_categoria_producto" SERIAL NOT NULL, "nombre_categoria" character varying NOT NULL, "borrado_el" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_c784f840abc98be112c59910c98" PRIMARY KEY ("id_categoria_producto"))`);
        await queryRunner.query(`CREATE TABLE "productos" ("id_producto" SERIAL NOT NULL, "id_area_producto" integer NOT NULL, "id_categoria_producto" integer NOT NULL, "nombre_producto" character varying NOT NULL, "descripcion" text, "precio" numeric(10,2) NOT NULL, "url_imagen" character varying, "disponible" boolean NOT NULL DEFAULT true, "borrado_el" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_8c832a65b374c16cbd8135d6be5" PRIMARY KEY ("id_producto"))`);
        await queryRunner.query(`CREATE TABLE "detalles_pedidos" ("id_detalle" SERIAL NOT NULL, "id_pedido" integer NOT NULL, "id_producto" integer NOT NULL, "cantidad" integer NOT NULL, "precio_actual" numeric(10,2) NOT NULL, "observacion" character varying, CONSTRAINT "PK_ed3ca8b30fdb02db4c12967f18c" PRIMARY KEY ("id_detalle"))`);
        await queryRunner.query(`CREATE TYPE "public"."pedidos_estado_enum" AS ENUM('pendiente', 'preparacion', 'listo')`);
        await queryRunner.query(`CREATE TABLE "pedidos" ("id_pedido" SERIAL NOT NULL, "id_sesion" integer NOT NULL, "nombre_comensal" character varying, "estado" "public"."pedidos_estado_enum" NOT NULL DEFAULT 'pendiente', "nro_orden" integer NOT NULL, "creado_el" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_9a67e2a4917b3656d2d23fe8b5e" PRIMARY KEY ("id_pedido"))`);
        await queryRunner.query(`CREATE TABLE "pagos" ("id_pago" SERIAL NOT NULL, "id_sesion" integer NOT NULL, "id_metodo_pago" integer NOT NULL, "nro_recibo" character varying, "monto_pagado" numeric(10,2) NOT NULL, "anulado_el" TIMESTAMP WITH TIME ZONE, "creado_el" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_9de763d4d92bbba9933371456de" PRIMARY KEY ("id_pago"))`);
        await queryRunner.query(`CREATE TABLE "sesiones_mesa" ("id_sesion" SERIAL NOT NULL, "id_mesa" integer NOT NULL, "token" character varying NOT NULL, "abierta_el" TIMESTAMP WITH TIME ZONE NOT NULL, "cerrada_el" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_c1b3b7d3956cdce5eb854884925" UNIQUE ("token"), CONSTRAINT "PK_07d5329b204b4e87f4c98360711" PRIMARY KEY ("id_sesion"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_sesiones_mesa_id_mesa_abierta" ON "sesiones_mesa"  ("id_mesa") WHERE cerrada_el IS NULL`);
        await queryRunner.query(`CREATE TYPE "public"."mesas_estado_enum" AS ENUM('libre', 'ocupada', 'cuenta_solicitada')`);
        await queryRunner.query(`CREATE TABLE "mesas" ("id_mesa" SERIAL NOT NULL, "nombre_mesa" character varying NOT NULL, "estado" "public"."mesas_estado_enum" NOT NULL DEFAULT 'libre', "borrado_el" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_76daee4017b2a73686cd2f3ce32" PRIMARY KEY ("id_mesa"))`);
        await queryRunner.query(`ALTER TABLE "cierres_caja" ADD CONSTRAINT "FK_b301fbd61e89ce601213dcc1808" FOREIGN KEY ("id_usuario") REFERENCES "usuarios"("id_usuario") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "cierres_caja_detalle" ADD CONSTRAINT "FK_438ce2af82a4550e1d7fb64fda3" FOREIGN KEY ("id_cierre") REFERENCES "cierres_caja"("id_cierre") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "cierres_caja_detalle" ADD CONSTRAINT "FK_239651aaf614e4efb228740508a" FOREIGN KEY ("id_metodo_pago") REFERENCES "metodos_pago"("id_metodo_pago") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "productos" ADD CONSTRAINT "FK_91b618125d4aeabb23d55cc1879" FOREIGN KEY ("id_area_producto") REFERENCES "areas_producto"("id_area_producto") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "productos" ADD CONSTRAINT "FK_f3a53862ee6562cd3047042ad0e" FOREIGN KEY ("id_categoria_producto") REFERENCES "categorias_producto"("id_categoria_producto") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "detalles_pedidos" ADD CONSTRAINT "FK_3279552b278ae305988377f4dac" FOREIGN KEY ("id_pedido") REFERENCES "pedidos"("id_pedido") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "detalles_pedidos" ADD CONSTRAINT "FK_799e113e6af1aa80bdcd82e2e6a" FOREIGN KEY ("id_producto") REFERENCES "productos"("id_producto") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "pedidos" ADD CONSTRAINT "FK_34283de5dd9428672714ca92270" FOREIGN KEY ("id_sesion") REFERENCES "sesiones_mesa"("id_sesion") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "pagos" ADD CONSTRAINT "FK_0d897803244dbb07851c1c0647f" FOREIGN KEY ("id_sesion") REFERENCES "sesiones_mesa"("id_sesion") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "pagos" ADD CONSTRAINT "FK_8d941fe883bb982dd245810f592" FOREIGN KEY ("id_metodo_pago") REFERENCES "metodos_pago"("id_metodo_pago") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "sesiones_mesa" ADD CONSTRAINT "FK_94f1bd14f1adb779897581ab125" FOREIGN KEY ("id_mesa") REFERENCES "mesas"("id_mesa") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "sesiones_mesa" DROP CONSTRAINT "FK_94f1bd14f1adb779897581ab125"`);
        await queryRunner.query(`ALTER TABLE "pagos" DROP CONSTRAINT "FK_8d941fe883bb982dd245810f592"`);
        await queryRunner.query(`ALTER TABLE "pagos" DROP CONSTRAINT "FK_0d897803244dbb07851c1c0647f"`);
        await queryRunner.query(`ALTER TABLE "pedidos" DROP CONSTRAINT "FK_34283de5dd9428672714ca92270"`);
        await queryRunner.query(`ALTER TABLE "detalles_pedidos" DROP CONSTRAINT "FK_799e113e6af1aa80bdcd82e2e6a"`);
        await queryRunner.query(`ALTER TABLE "detalles_pedidos" DROP CONSTRAINT "FK_3279552b278ae305988377f4dac"`);
        await queryRunner.query(`ALTER TABLE "productos" DROP CONSTRAINT "FK_f3a53862ee6562cd3047042ad0e"`);
        await queryRunner.query(`ALTER TABLE "productos" DROP CONSTRAINT "FK_91b618125d4aeabb23d55cc1879"`);
        await queryRunner.query(`ALTER TABLE "cierres_caja_detalle" DROP CONSTRAINT "FK_239651aaf614e4efb228740508a"`);
        await queryRunner.query(`ALTER TABLE "cierres_caja_detalle" DROP CONSTRAINT "FK_438ce2af82a4550e1d7fb64fda3"`);
        await queryRunner.query(`ALTER TABLE "cierres_caja" DROP CONSTRAINT "FK_b301fbd61e89ce601213dcc1808"`);
        await queryRunner.query(`DROP TABLE "mesas"`);
        await queryRunner.query(`DROP TYPE "public"."mesas_estado_enum"`);
        await queryRunner.query(`DROP INDEX "public"."idx_sesiones_mesa_id_mesa_abierta"`);
        await queryRunner.query(`DROP TABLE "sesiones_mesa"`);
        await queryRunner.query(`DROP TABLE "pagos"`);
        await queryRunner.query(`DROP TABLE "pedidos"`);
        await queryRunner.query(`DROP TYPE "public"."pedidos_estado_enum"`);
        await queryRunner.query(`DROP TABLE "detalles_pedidos"`);
        await queryRunner.query(`DROP TABLE "productos"`);
        await queryRunner.query(`DROP TABLE "categorias_producto"`);
        await queryRunner.query(`DROP TABLE "areas_producto"`);
        await queryRunner.query(`DROP TABLE "cierres_caja_detalle"`);
        await queryRunner.query(`DROP TABLE "metodos_pago"`);
        await queryRunner.query(`DROP TABLE "cierres_caja"`);
        await queryRunner.query(`DROP TABLE "usuarios"`);
        await queryRunner.query(`DROP TYPE "public"."usuarios_rol_enum"`);
    }

}
