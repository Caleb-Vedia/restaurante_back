import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { databaseConfig } from './config/database.config';
import { MesasModule } from './mesas/mesas.module';
import { PedidosModule } from './pedidos/pedidos.module';
import { ProductosModule } from './productos/productos.module';
import { PagosModule } from './pagos/pagos.module';
import { UsuariosModule } from './usuarios/usuarios.module';
import { CajaModule } from './caja/caja.module';
import { ReportesModule } from './reportes/reportes.module';

@Module({
  imports: [
    TypeOrmModule.forRoot(databaseConfig),
    MesasModule,
    PedidosModule,
    ProductosModule,
    PagosModule,
    UsuariosModule,
    CajaModule,
    ReportesModule,
  ],
})
export class AppModule {}