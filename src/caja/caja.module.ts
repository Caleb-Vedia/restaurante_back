import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CierresCajaController } from './controllers/cierres-caja.controller';
import { CierresCajaService } from './services/cierres-caja.service';
import { ActividadTurnoService } from './services/actividad-turno.service';
import { ConciliacionCajaService } from './services/conciliacion-caja.service';
import { CierreCaja } from './entities/cierre-caja.entity';
import { CierreCajaDetalle } from './entities/cierre-caja-detalle.entity';
import { MetodoPago } from '../pagos/entities/metodo-pago.entity';
import { Pago } from '../pagos/entities/pago.entity';
import { SesionMesa } from '../mesas/entities/sesion-mesa.entity';
import { Mesa } from '../mesas/entities/mesa.entity';
import { Pedido } from '../pedidos/entities/pedido.entity';
import { DetallePedido } from '../pedidos/entities/detalle-pedido.entity';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    // MetodoPago/Pago se registran como entity directo (no se importa
    // PagosModule): Caja solo los lee para calcular el arqueo del turno, y el
    // import directo evita acoplar los módulos entre sí — mismo patrón que
    // AuthModule con la entity Usuario (decisión #16). Nótese que PagosModule
    // hace lo simétrico con CierreCaja, así que un import mutuo de módulos
    // habría sido un ciclo.
    //
    // SesionMesa/Pedido/DetallePedido se agregan por el mismo criterio, para
    // la actividad del turno (ActividadTurnoService, Etapa 5B): agrupa las
    // visitas del turno con sus pedidos y pagos, TODO de solo lectura. No se
    // importan MesasModule ni PedidosModule — ambos ya dependen de otros
    // módulos y meterlos acá sería acoplar Caja a media aplicación; es el
    // mismo enfoque de ReportesModule (decisión #19), que lee Pago/
    // DetallePedido/Producto sin importar sus módulos.
    //
    // Mesa se suma en la Etapa 6: las reglas A/B/C del cierre necesitan el
    // `estado` de la mesa de cada sesión todavía abierta. También de solo
    // lectura — el cierre NUNCA libera mesas ni cambia su estado.
    TypeOrmModule.forFeature([
      CierreCaja,
      CierreCajaDetalle,
      MetodoPago,
      Pago,
      SesionMesa,
      Mesa,
      Pedido,
      DetallePedido,
    ]),
    AuthModule,
  ],
  controllers: [CierresCajaController],
  providers: [
    CierresCajaService,
    ActividadTurnoService,
    ConciliacionCajaService,
  ],
})
export class CajaModule {}
