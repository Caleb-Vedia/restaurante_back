import { Module } from '@nestjs/common';
import { PedidosController } from './controllers/pedidos.controller';
import { PedidosService } from './services/pedidos.service';

@Module({
  controllers: [PedidosController],
  providers: [PedidosService]
})
export class PedidosModule {}
