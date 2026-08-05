import { Module } from '@nestjs/common';
import { PagosController } from './controllers/pagos.controller';
import { MetodosPagoController } from './controllers/metodos-pago.controller';
import { PagosService } from './services/pagos.service';
import { MetodosPagoService } from './services/metodos-pago.service';

@Module({
  controllers: [PagosController, MetodosPagoController],
  providers: [PagosService, MetodosPagoService]
})
export class PagosModule {}
