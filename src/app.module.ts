import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { dataSourceOptions } from './config/data-source';
import { MesasModule } from './modules/mesas/mesas.module';
import { PedidosModule } from './modules/pedidos/pedidos.module';
import { ProductosModule } from './modules/productos/productos.module';
import { PagosModule } from './modules/pagos/pagos.module';
import { UsuariosModule } from './modules/usuarios/usuarios.module';
import { CajaModule } from './modules/caja/caja.module';
import { MesasModule } from './mesas/mesas.module';
import { PedidosModule } from './pedidos/pedidos.module';
import { ProductosModule } from './productos/productos.module';
import { PagosModule } from './pagos/pagos.module';
import { UsuariosModule } from './usuarios/usuarios.module';
import { CajaModule } from './caja/caja.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    TypeOrmModule.forRoot(dataSourceOptions),

    MesasModule,

    PedidosModule,

    ProductosModule,

    PagosModule,

    UsuariosModule,

    CajaModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
