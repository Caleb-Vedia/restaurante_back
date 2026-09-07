import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTelefonoYEmailNormalizadoUsuarios1787433857074 implements MigrationInterface {
  name = 'AddTelefonoYEmailNormalizadoUsuarios1787433857074';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Teléfono / WhatsApp: string opcional, sin estructura impuesta (admite
    // prefijos "+", espacios, etc.) — mismo criterio de columna simple que
    // productos.descripcion.
    await queryRunner.query(
      `ALTER TABLE "usuarios" ADD "telefono" character varying`,
    );

    // Refuerzo de integridad a nivel Postgres de la regla de negocio ya
    // validada en UsuariosService (assertEmailDisponible): el email es el
    // identificador real de la cuenta y su unicidad debe ser
    // case-insensitive + trim, no la comparación exacta que daba el UNIQUE
    // crudo sobre la columna. Se reemplaza:
    //   - DROP del constraint UNIQUE original sobre "email" (exacto,
    //     case-sensitive: dejaba pasar "juan@gmail.com" y
    //     "JUAN@gmail.com" como filas distintas).
    //   - CREATE de un índice ÚNICO sobre la EXPRESIÓN
    //     LOWER(TRIM("email")) — igual patrón que
    //     idx_categorias_producto_nombre_activo / idx_productos_nombre_activo,
    //     salvo que acá NO es parcial: "usuarios" no tiene soft-delete
    //     (borrado_el) en este modelo, solo `activo`, y un usuario
    //     desactivado sigue siendo una cuenta real que no debe liberar su
    //     email.
    //
    // TypeORM no puede declarar un índice sobre una expresión vía
    // decorators (@Index solo referencia columnas) — vive únicamente acá.
    //
    // Verificado ANTES de escribir esta migración (lectura directa sobre
    // la base real, sin modificar ni fusionar usuarios): 0 duplicados por
    // email normalizado hoy — los 5 usuarios existentes ya están
    // guardados en minúsculas sin espacios extra, así que este CREATE no
    // falla contra los datos existentes.
    await queryRunner.query(
      `ALTER TABLE "usuarios" DROP CONSTRAINT "UQ_446adfc18b35418aac32ae0b7b5"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_usuarios_email_normalizado" ON "usuarios" ((LOWER(TRIM("email"))))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."idx_usuarios_email_normalizado"`,
    );
    await queryRunner.query(
      `ALTER TABLE "usuarios" ADD CONSTRAINT "UQ_446adfc18b35418aac32ae0b7b5" UNIQUE ("email")`,
    );
    await queryRunner.query(`ALTER TABLE "usuarios" DROP COLUMN "telefono"`);
  }
}
