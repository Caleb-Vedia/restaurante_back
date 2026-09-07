import * as argon2 from 'argon2';

// Fuente única de verdad para hashing de contraseñas (AuthService,
// UsuariosService, seed script). No duplicar esta lógica en ningún otro lado.

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifyPassword(
  hash: string,
  plain: string,
): Promise<boolean> {
  return argon2.verify(hash, plain);
}
