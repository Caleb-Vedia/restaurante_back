import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsuariosController } from './controllers/usuarios.controller';
import { UsuariosService } from './services/usuarios.service';
import { Usuario } from './entities/usuario.entity';
import { AuthModule } from '../auth/auth.module';

@Module({
  // AuthModule provee JwtAuthGuard/RolesGuard (los exporta). El flujo de
  // dependencia es de un solo sentido: UsuariosModule -> AuthModule. AuthModule
  // NUNCA importa UsuariosModule (importa la entity Usuario directo) para no
  // generar un ciclo entre ambos módulos.
  imports: [TypeOrmModule.forFeature([Usuario]), AuthModule],
  controllers: [UsuariosController],
  providers: [UsuariosService],
})
export class UsuariosModule {}
