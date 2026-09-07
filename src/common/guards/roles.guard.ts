import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { RolUsuario } from '../enums/rol-usuario.enum';
import { RequestConUsuario } from './jwt-auth.guard';

// Debe ir DESPUÉS de JwtAuthGuard en @UseGuards(...): lee `request.usuario`,
// que JwtAuthGuard es quien lo adjunta.
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const rolesRequeridos = this.reflector.getAllAndOverride<RolUsuario[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Sin @Roles(...) en el endpoint: solo exige estar autenticado, no un rol
    // específico.
    if (!rolesRequeridos || rolesRequeridos.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestConUsuario>();
    if (!rolesRequeridos.includes(request.usuario.rol)) {
      throw new ForbiddenException(
        'No tenés permiso para acceder a este recurso',
      );
    }
    return true;
  }
}
