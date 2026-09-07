import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { PedidosService } from '../services/pedidos.service';
import { CreatePedidoDto } from '../dto/create-pedido.dto';
import { PedidoResponse } from '../dto/pedido-response.dto';

// Controller PÚBLICO del cliente (pide desde la mesa vía QR, sin login). Estos
// endpoints NUNCA llevan guard de rol — la identificación es el header
// X-Table-Token (decisión #15), igual que en SesionesMesaController. La
// ausencia de guard es intencional, no un TODO.
@Controller('pedidos')
export class PedidosClienteController {
  constructor(private readonly pedidosService: PedidosService) {}

  @Post()
  crear(
    @Headers('x-table-token') token: string | undefined,
    @Body() dto: CreatePedidoDto,
  ): Promise<PedidoResponse> {
    return this.pedidosService.crearPedido(token, dto);
  }

  // Mis pedidos: TODOS los pedidos de la sesión activa del token. Ruta
  // ESTÁTICA — debe declararse ANTES que la paramétrica GET /pedidos/:id de
  // acá abajo, por el mismo motivo que PedidosController se registra antes
  // que este controller en pedidos.module.ts: si "mis-pedidos" quedara
  // después, Express intentaría matchear ":id" primero y ParseIntPipe
  // rechazaría "mis-pedidos" como id inválido.
  @Get('mis-pedidos')
  misPedidos(
    @Headers('x-table-token') token: string | undefined,
  ): Promise<PedidoResponse[]> {
    return this.pedidosService.listarPedidosDeSesion(token);
  }

  // Tracking: el mismo token de la sesión que lo creó. Debe registrarse
  // DESPUÉS de PedidosController en pedidos.module.ts para que las rutas
  // estáticas GET /pedidos/cocina y GET /pedidos/bebidas ganen sobre esta
  // GET /pedidos/:id (ver comentario en pedidos.module.ts) — y DESPUÉS de
  // GET /pedidos/mis-pedidos de acá arriba, por el mismo motivo.
  @Get(':id')
  obtenerPedido(
    @Headers('x-table-token') token: string | undefined,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<PedidoResponse> {
    return this.pedidosService.obtenerPedidoDeCliente(token, id);
  }
}
