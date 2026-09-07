// Script standalone: NO pasa por Nest. Conecta directo a la base reusando
// databaseConfig (la misma config que usa data-source.ts para migraciones).
// Se corre vía `npm run seed:admin` (ver package.json), o manualmente:
//   npx ts-node -r tsconfig-paths/register src/database/seeds/create-admin.seed.ts
// Idempotente: si ya existe un usuario con ese email, no crea nada (ver
// más abajo) — correrlo de nuevo (ej. dentro de `npm run bootstrap`) es
// seguro.
import 'dotenv/config';
import { DataSource } from 'typeorm';
import { databaseConfig } from '../../config/database.config';
import { Usuario } from '../../usuarios/entities/usuario.entity';
import { RolUsuario } from '../../common/enums/rol-usuario.enum';
import { hashPassword } from '../../common/security/password.util';

async function main(): Promise<void> {
  const nombre = process.env.SEED_ADMIN_NOMBRE;
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!nombre || !email || !password) {
    console.error(
      'Faltan variables de entorno: SEED_ADMIN_NOMBRE, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD (revisá tu .env).',
    );
    process.exitCode = 1;
    return;
  }

  const dataSource = new DataSource(databaseConfig);
  await dataSource.initialize();

  try {
    const usuarioRepo = dataSource.getRepository(Usuario);

    const existente = await usuarioRepo.findOne({ where: { email } });
    if (existente) {
      console.log(
        `Ya existe un usuario con el email "${email}" (id ${existente.idUsuario}); no se creó ningún admin.`,
      );
      return;
    }

    const passwordHash = await hashPassword(password);
    const admin = usuarioRepo.create({
      nombre,
      email,
      passwordHash,
      rol: RolUsuario.ADMIN,
      activo: true,
    });
    const guardado = await usuarioRepo.save(admin);

    console.log(
      `Admin creado: "${guardado.email}" (id ${guardado.idUsuario}).`,
    );
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error('Error al sembrar el usuario admin:', error);
  process.exitCode = 1;
});
