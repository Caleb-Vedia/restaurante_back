import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const logger = new Logger('Bootstrap');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  // Necesario para que JwtAuthGuard pueda leer la cookie httpOnly
  // `access_token` (decisión #16): sin esto `req.cookies` viene undefined.
  app.use(cookieParser());

  // CORS con credenciales: el navegador solo manda la cookie de sesión si
  // `credentials: true` Y el origin es explícito. Un wildcard '*' es
  // incompatible con credenciales — el navegador rechaza la respuesta.
  app.enableCors({
      origin: [
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        'http://192.168.0.15:5173',
      ],
      credentials: true,
    });


  app.useStaticAssets(join(__dirname, '..', 'uploads'), {
    prefix: '/uploads',
  });

  const port = process.env.PORT ?? 3000;

  await app.listen(port, '127.0.0.1');
  logger.log(`App running on port ${port}`);
}

bootstrap();