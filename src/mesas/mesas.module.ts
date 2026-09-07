import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MesasController } from './controllers/mesas.controller';
import { SesionesMesaController } from './controllers/sesiones-mesa.controller';
import { MesasService } from './services/mesas.service';
import { SesionesMesaService } from './services/sesiones-mesa.service';
import { Mesa } from './entities/mesa.entity';
import { SesionMesa } from './entities/sesion-mesa.entity';
import { Pedido } from '../pedidos/entities/pedido.entity';
import { DetallePedido } from '../pedidos/entities/detalle-pedido.entity';
import { Pago } from '../pagos/entities/pago.entity';
import { CierreCaja } from '../caja/entities/cierre-caja.entity';
import { AuthModule } from '../auth/auth.module';

@Module({
  // `Pedido`, `DetallePedido` y `Pago` se registran acá solo como features de
  // TypeORM, de SOLO LECTURA:
  //   - Pedido            -> SesionesMesaService.pedirCuenta (¿la sesión tiene
  //                          al menos un pedido?)
  //   - DetallePedido/Pago -> saldo-sesion.util, que MesasService consume para
  //                          exigir saldo 0 antes de liberar una mesa.
  //   - CierreCaja        -> SesionesMesaService.pedirCuenta lo lockea (sin
  //                          escribirlo) para sincronizar el paso a
  //                          `cuenta_solicitada` con el cierre de caja, que
  //                          toma esa misma fila. Ver el comentario largo en
  //                          pedirCuenta y lockearCajaAbierta.
  // Esto NO importa PedidosModule ni PagosModule ni sus providers — la
  // dependencia entre MÓDULOS sigue siendo de un solo sentido (Pedidos/Pagos
  // -> Mesas, ver comentario de `exports` más abajo). Importar PagosModule
  // acá para calcular saldo sería justamente el ciclo que el util compartido
  // existe para evitar. Registrar la misma entity como feature en dos módulos
  // es un patrón normal de TypeORM/Nest (Pago ya está en PagosModule y en
  // ReportesModule) y no crea ningún ciclo.
  imports: [
    TypeOrmModule.forFeature([
      Mesa,
      SesionMesa,
      Pedido,
      DetallePedido,
      Pago,
      CierreCaja,
    ]),
    AuthModule,
  ],

  // SesionesMesaController va PRIMERO a propósito: registra la ruta estática
  // `PATCH /mesas/pedir-cuenta` antes que la paramétrica `PATCH /mesas/:id` de
  // MesasController. En Express 5 el matching es por orden de registro y no hay
  // regex inline en el param, así que este orden evita que "pedir-cuenta" caiga
  // en `:id`. No reordenar sin tener esto en cuenta.
  controllers: [SesionesMesaController, MesasController],

  providers: [MesasService, SesionesMesaService],

  // PedidosModule consume SesionesMesaService.obtenerSesionActivaPorToken()
  // para resolver el X-Table-Token del cliente; PagosModule consume
  // MesasService.cerrarSesionActiva() al cobrar la cuenta. La dependencia es de
  // un solo sentido: Pedidos/Pagos -> Mesas. Mesas no importa ninguno de los
  // dos (solo referencia las entities Pedido/Pago en relaciones lazy), así que
  // no hay ciclo.
  exports: [SesionesMesaService, MesasService],
})
export class MesasModule {}
