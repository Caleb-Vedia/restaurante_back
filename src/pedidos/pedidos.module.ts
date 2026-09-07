import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PedidosController } from './controllers/pedidos.controller';
import { PedidosClienteController } from './controllers/pedidos-cliente.controller';
import { PedidosService } from './services/pedidos.service';
import { Pedido } from './entities/pedido.entity';
import { DetallePedido } from './entities/detalle-pedido.entity';
import { Producto } from '../productos/entities/producto.entity';
import { AreaProducto } from '../productos/entities/area-producto.entity';
import { CierreCaja } from '../caja/entities/cierre-caja.entity';
import { MesasModule } from '../mesas/mesas.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    // Producto/AreaProducto/CierreCaja se registran como entity directo (no se
    // importan ProductosModule ni CajaModule): Pedidos solo necesita leerlas —
    // Producto/AreaProducto para validar el pedido y derivar su área, CierreCaja
    // para la regla "sin caja abierta no entran pedidos nuevos" (se lee con el
    // manager de la transacción, con lock; nunca se escribe desde acá). El
    // import directo evita acoplar los módulos — mismo patrón que AuthModule con
    // la entity Usuario (decisión #16) y que PagosModule con CierreCaja.
    TypeOrmModule.forFeature([
      Pedido,
      DetallePedido,
      Producto,
      AreaProducto,
      CierreCaja,
    ]),
    // MesasModule exporta SesionesMesaService (resolución de X-Table-Token) y
    // MesasService (obtenerConsumoActualDeMesa staff resuelve mesa+sesión
    // activa vía MesasService.findOne, sin duplicar esa query acá).
    MesasModule,
    // AuthModule exporta JwtAuthGuard/RolesGuard para el controller de staff.
    AuthModule,
  ],
  // Orden importa: PedidosController (rutas estáticas GET /pedidos/cocina y
  // GET /pedidos/bebidas) debe registrarse ANTES que PedidosClienteController
  // (GET /pedidos/:id) para que las estáticas ganen sobre la paramétrica —
  // mismo patrón que MesasModule con SesionesMesaController.
  controllers: [PedidosController, PedidosClienteController],
  providers: [PedidosService],
})
export class PedidosModule {}
