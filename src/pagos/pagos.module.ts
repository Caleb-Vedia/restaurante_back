import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PagosController } from './controllers/pagos.controller';
import { MetodosPagoController } from './controllers/metodos-pago.controller';
import { PagosService } from './services/pagos.service';
import { MetodosPagoService } from './services/metodos-pago.service';
import { Pago } from './entities/pago.entity';
import { MetodoPago } from './entities/metodo-pago.entity';
import { CierreCaja } from '../caja/entities/cierre-caja.entity';
import { Mesa } from '../mesas/entities/mesa.entity';
import { SesionMesa } from '../mesas/entities/sesion-mesa.entity';
import { DetallePedido } from '../pedidos/entities/detalle-pedido.entity';
import { MesasModule } from '../mesas/mesas.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    // CierreCaja / SesionMesa / Mesa / DetallePedido se registran como entity
    // directo (sin importar CajaModule ni PedidosModule): el import directo
    // evita ciclos entre módulos (decisión #16). La mayoría solo se leen —
    // ¿hay caja abierta?, ¿a qué turno pertenece un pago?, ¿cuál es la sesión
    // activa?, ¿cuánto suma el consumo?
    //
    // SesionMesa y Mesa además se ESCRIBEN, y solo desde anularPago: reabrir
    // una sesión cerrada cuya deuda reapareció tiene que ocurrir en la misma
    // transacción que marca el pago como anulado (o queda una deuda sin sesión
    // donde cobrarla). Por eso ese caso NO delega en MesasService, que usa sus
    // propios repositorios y quedaría fuera de esa transacción — a diferencia
    // del cobro, donde liberar la mesa después del commit sí es aceptable.
    TypeOrmModule.forFeature([
      Pago,
      MetodoPago,
      CierreCaja,
      SesionMesa,
      Mesa,
      DetallePedido,
    ]),
    // MesasModule exporta MesasService (cerrarSesionActiva al cobrar). La
    // dependencia es de un solo sentido: PagosModule -> MesasModule; Mesas no
    // importa Pagos (solo referencia la entity Pago en una relación lazy).
    MesasModule,
    AuthModule,
  ],
  controllers: [PagosController, MetodosPagoController],
  providers: [PagosService, MetodosPagoService],
})
export class PagosModule {}
