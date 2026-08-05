import { Module } from '@nestjs/common';
import { MesasController } from './controllers/mesas.controller';
import { SesionesMesaController } from './controllers/sesiones-mesa.controller';
import { MesasService } from './services/mesas.service';
import { SesionesMesaService } from './services/sesiones-mesa.service';

@Module({
  controllers: [MesasController, SesionesMesaController],
  providers: [MesasService, SesionesMesaService]
})
export class MesasModule {}
