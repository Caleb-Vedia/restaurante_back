import {
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';
import { Usuario } from '../../usuarios/entities/usuario.entity';
import { verifyPassword } from '../../common/security/password.util';
import { LoginDto } from '../dto/login.dto';
import { LoginResultado } from '../dto/login-response.dto';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(Usuario)
    private readonly usuarioRepo: Repository<Usuario>,
    private readonly jwtService: JwtService,
  ) {}

  async login(dto: LoginDto): Promise<LoginResultado> {
    const usuario = await this.usuarioRepo.findOne({
      where: { email: dto.email },
    });

    // Mensaje genérico a propósito: no revela si el email existe, si está
    // inactivo, o si la contraseña es incorrecta.
    if (!usuario || !usuario.activo) {
      throw new UnauthorizedException('Email o contraseña incorrectos');
    }

    const passwordValida = await verifyPassword(
      usuario.passwordHash,
      dto.password,
    );
    if (!passwordValida) {
      throw new UnauthorizedException('Email o contraseña incorrectos');
    }

    const accessToken = await this.jwtService.signAsync({
      sub: usuario.idUsuario,
      rol: usuario.rol,
    });

    return {
      accessToken,
      maxAgeMs: this.calcularMaxAgeMs(accessToken),
      usuario: {
        idUsuario: usuario.idUsuario,
        nombre: usuario.nombre,
        email: usuario.email,
        rol: usuario.rol,
      },
    };
  }

  // La vida útil de la cookie se deriva del `exp` real del token recién
  // firmado, en vez de re-parsear JWT_EXPIRES_IN: así cookie y JWT caducan
  // siempre juntos, aunque se cambie esa env var.
  private calcularMaxAgeMs(accessToken: string): number {
    const { exp } = this.jwtService.decode<{ exp?: number }>(accessToken);
    if (exp === undefined) {
      // Inalcanzable con la config actual (JwtModule siempre firma con
      // expiresIn); si pasara, la cookie quedaría desalineada del token.
      throw new InternalServerErrorException(
        'El JWT emitido no tiene claim `exp`; no se puede alinear la expiración de la cookie de sesión.',
      );
    }
    return exp * 1000 - Date.now();
  }
}
