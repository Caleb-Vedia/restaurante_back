// dotenv debe estar cargado ANTES de que JwtModule.register() lea
// process.env.JWT_SECRET, ya que ese valor se evalúa de forma síncrona al
// construir el @Module (no en un factory async). ConfigModule.forRoot() en
// AppModule también carga el .env, pero no podemos asumir que corra primero
// (depende del orden de imports de módulos JS) — mismo patrón defensivo que
// ya usa src/config/database.config.ts.
import 'dotenv/config';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import type { StringValue } from 'ms';
import { Usuario } from '../usuarios/entities/usuario.entity';
import { AuthController } from './controllers/auth.controller';
import { AuthService } from './services/auth.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';

@Module({
  imports: [
    // Import DIRECTO de la entity Usuario (no de UsuariosModule): evita la
    // dependencia circular, ya que UsuariosModule importa AuthModule para
    // usar los guards. El flujo es de un solo sentido:
    // UsuariosModule -> AuthModule, nunca al revés.
    TypeOrmModule.forFeature([Usuario]),
    JwtModule.register({
      secret: process.env.JWT_SECRET,
      signOptions: {
        expiresIn:
          (process.env.JWT_EXPIRES_IN as StringValue | undefined) ?? '1d',
      },
    }),
    // ThrottlerModule es @Global() en @nestjs/throttler: registrarlo acá (no
    // en app.module.ts) alcanza para que ThrottlerGuard sea inyectable en
    // toda la app, PERO no lo convierte en guard global — eso requeriría
    // APP_GUARD en app.module.ts, que no tocamos. Se aplica explícitamente
    // solo en POST /auth/login vía @UseGuards(ThrottlerGuard).
    ThrottlerModule.forRoot([{ name: 'login', ttl: 60000, limit: 5 }]),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, RolesGuard],
  // Se exporta también TypeOrmModule (con la feature Usuario) además de
  // JwtModule: al usar `@UseGuards(JwtAuthGuard)` Nest instancia el guard en el
  // contexto del módulo que declara el controller, así que ese módulo tiene que
  // poder resolver AMBAS dependencias del guard (JwtService y UsuarioRepository),
  // no alcanza con exportar la clase del guard.
  exports: [JwtAuthGuard, RolesGuard, JwtModule, TypeOrmModule],
})
export class AuthModule {}
