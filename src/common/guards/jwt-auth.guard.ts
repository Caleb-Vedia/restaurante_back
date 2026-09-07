import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import { Repository } from 'typeorm';
import { Usuario } from '../../usuarios/entities/usuario.entity';
import { AUTH_COOKIE_NAME } from '../../auth/config/auth-cookie.config';

// Shape adjuntado a `request.usuario` una vez autenticado: el Usuario
// completo MENOS el hash de password (nunca debe viajar más allá del guard).
export type UsuarioAutenticado = Omit<Usuario, 'passwordHash'>;

export interface RequestConUsuario extends Request {
  usuario: UsuarioAutenticado;
}

interface JwtPayload {
  sub: number;
  rol: string;
}

// Autenticación de personal logueado (cocina/bebidas/caja/admin) vía la cookie
// httpOnly `access_token` (decisión #16). Mecanismo separado de X-Table-Token
// (decisión #15), que es exclusivo de clientes anónimos por sesión de mesa.
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    @InjectRepository(Usuario)
    private readonly usuarioRepo: Repository<Usuario>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestConUsuario>();
    const token = this.extraerToken(request);

    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
        secret: process.env.JWT_SECRET,
      });
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }

    const usuario = await this.usuarioRepo.findOne({
      where: { idUsuario: payload.sub },
    });
    // Revocación real: se valida contra la base en cada request (columna
    // `activo`), no solo la firma criptográfica del token.
    if (!usuario || !usuario.activo) {
      throw new UnauthorizedException('Usuario inválido o inactivo');
    }

    request.usuario = {
      idUsuario: usuario.idUsuario,
      nombre: usuario.nombre,
      email: usuario.email,
      rol: usuario.rol,
      activo: usuario.activo,
      telefono: usuario.telefono,
    };
    return true;
  }

  // El token llega en la cookie httpOnly, no en un header: el frontend nunca
  // lo manipula, lo adjunta el navegador solo. Requiere cookie-parser
  // registrado en main.ts (sin eso, `request.cookies` viene undefined).
  private extraerToken(request: Request): string {
    const cookies = request.cookies as Record<string, string | undefined>;
    const token = cookies?.[AUTH_COOKIE_NAME];
    if (!token) {
      throw new UnauthorizedException('No hay sesión activa');
    }
    return token;
  }
}
