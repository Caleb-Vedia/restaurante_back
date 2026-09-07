import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';
import { AuthService } from '../services/auth.service';
import { LoginDto } from '../dto/login.dto';
import { LoginResponse } from '../dto/login-response.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { UsuarioAutenticado } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  AUTH_COOKIE_NAME,
  opcionesCookieAuth,
} from '../config/auth-cookie.config';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // Throttling solo acá (no global): 5 intentos por minuto contra fuerza bruta.
  @UseGuards(ThrottlerGuard)
  @Throttle({ login: { limit: 5, ttl: 60000 } })
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    // passthrough: se setea la cookie a mano pero Nest sigue serializando el
    // valor retornado como body normalmente.
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    const { accessToken, maxAgeMs, usuario } =
      await this.authService.login(dto);

    res.cookie(AUTH_COOKIE_NAME, accessToken, opcionesCookieAuth(maxAgeMs));

    // El token NO va en el body: vive solo en la cookie httpOnly.
    return { usuario };
  }

  // Sin guard a propósito: cerrar sesión con un token ya expirado o inválido
  // tiene que poder limpiar igual la cookie del navegador, no responder 401.
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@Res({ passthrough: true }) res: Response): { mensaje: string } {
    // Mismos flags que al setearla (sin maxAge): si difirieran, el navegador
    // trataría la cookie como otra y la sesión no se cerraría.
    res.clearCookie(AUTH_COOKIE_NAME, opcionesCookieAuth());
    return { mensaje: 'Sesión cerrada' };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() usuario: UsuarioAutenticado): UsuarioAutenticado {
    return usuario;
  }
}
