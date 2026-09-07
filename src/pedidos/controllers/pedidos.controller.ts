import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { PedidosService } from '../services/pedidos.service';
import { CambiarEstadoPedidoDto } from '../dto/cambiar-estado-pedido.dto';
import {
  ConsumoSesionResponse,
  PedidoKdsResponse,
  PedidoResponse,
} from '../dto/pedido-response.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { UsuarioAutenticado } from '../../common/guards/jwt-auth.guard';
import { RolUsuario } from '../../common/enums/rol-usuario.enum';

// Controller de personal (KDS de cocina/bebidas + cambio de estado). El alta de
// pedidos del cliente vive aparte en PedidosClienteController (público).
//
// El KDS son dos rutas explícitas por área, no un query param: así el guard de
// rol puede ser distinto en cada una (cocina no ve la cola de bebidas).
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('pedidos')
export class PedidosController {
  constructor(private readonly pedidosService: PedidosService) {}

  @Roles(RolUsuario.COCINA, RolUsuario.ADMIN)
  @Get('cocina')
  listarCocina(): Promise<PedidoKdsResponse[]> {
    return this.pedidosService.listarKdsCocina();
  }

  @Roles(RolUsuario.BEBIDAS, RolUsuario.ADMIN)
  @Get('bebidas')
  listarBebidas(): Promise<PedidoKdsResponse[]> {
    return this.pedidosService.listarKdsBebidas();
  }

  // Consumo actual de la mesa (Caja 2.0, Etapa 5A): de dónde sale el saldo de
  // su sesión activa. Staff autenticado por JWT — nunca X-Table-Token, que es
  // exclusivo del módulo cliente (decisión #15) y no una autoridad válida
  // para que Caja consulte una mesa ajena. Ruta de 4 segmentos
  // ('pedidos'/'mesa'/:idMesa/'consumo-actual'): no colisiona con ninguna
  // paramétrica de un segmento de este controller ni de
  // PedidosClienteController (GET /pedidos/:id, GET /pedidos/mis-pedidos).
  @Roles(RolUsuario.CAJA, RolUsuario.ADMIN)
  @Get('mesa/:idMesa/consumo-actual')
  consumoActualDeMesa(
    @Param('idMesa', ParseIntPipe) idMesa: number,
  ): Promise<ConsumoSesionResponse> {
    return this.pedidosService.obtenerConsumoActualDeMesa(idMesa);
  }

  // El service valida además que cocina/bebidas solo toque pedidos de su
  // propia área, y que la transición sea hacia adelante (admin exceptuado).
  @Roles(RolUsuario.COCINA, RolUsuario.BEBIDAS, RolUsuario.ADMIN)
  @Patch(':id/estado')
  cambiarEstado(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CambiarEstadoPedidoDto,
    @CurrentUser() usuario: UsuarioAutenticado,
  ): Promise<PedidoResponse> {
    return this.pedidosService.cambiarEstado(id, dto, usuario);
  }
}
