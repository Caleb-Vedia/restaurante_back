import { Module } from '@nestjs/common';
import { CierresCajaController } from './controllers/cierres-caja.controller';
import { CierresCajaService } from './services/cierres-caja.service';

@Module({
  controllers: [CierresCajaController],
  providers: [CierresCajaService]
})
export class CajaModule {}
