import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReportesController } from './controllers/reportes.controller';
import { ReportesService } from './services/reportes.service';
import { Pago } from '../pagos/entities/pago.entity';
import { DetallePedido } from '../pedidos/entities/detalle-pedido.entity';
import { Producto } from '../productos/entities/producto.entity';
import { MetodoPago } from '../pagos/entities/metodo-pago.entity';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    // Entities directo, sin importar PagosModule/ProductosModule/PedidosModule
    // completos (decisión #19, mismo patrón que #16-#18): Reportes solo LEE
    // estas tablas para agregaciones de solo lectura.
    TypeOrmModule.forFeature([Pago, DetallePedido, Producto, MetodoPago]),
    AuthModule,
  ],
  controllers: [ReportesController],
  providers: [ReportesService],
})
export class ReportesModule {}
