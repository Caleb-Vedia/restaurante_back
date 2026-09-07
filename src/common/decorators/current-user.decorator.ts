import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import {
  RequestConUsuario,
  UsuarioAutenticado,
} from '../guards/jwt-auth.guard';

// Requiere que JwtAuthGuard haya corrido antes en la cadena de guards.
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): UsuarioAutenticado => {
    const request = ctx.switchToHttp().getRequest<RequestConUsuario>();
    return request.usuario;
  },
);
