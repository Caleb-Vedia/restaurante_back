import {
  Controller,
  Headers,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { SesionesMesaService } from '../services/sesiones-mesa.service';
import {
  AbrirSesionResponse,
  PedirCuentaResponse,
} from '../dto/mesa-response.dto';

// Controller PÚBLICO del cliente (acceso vía QR de mesa, sin login). Estos
// endpoints NUNCA llevan guard de rol — a diferencia de MesasController, que es
// backoffice. No agregar TODO(auth) acá: la ausencia de guard es intencional.
//
// Comparte el prefijo `mesas` con MesasController. En mesas.module.ts este
// controller se registra ANTES que MesasController para que la ruta estática
// `PATCH /mesas/pedir-cuenta` gane sobre la paramétrica `PATCH /mesas/:id`
// (Express 5 no soporta regex inline en el param, así que el orden importa).
@Controller('mesas')
export class SesionesMesaController {
  constructor(private readonly sesionesMesaService: SesionesMesaService) {}

  @Post(':id/sesion')
  abrirSesion(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<AbrirSesionResponse> {
    return this.sesionesMesaService.abrirSesion(id);
  }

  @Patch('pedir-cuenta')
  pedirCuenta(
    @Headers('x-table-token') token?: string,
  ): Promise<PedirCuentaResponse> {
    return this.sesionesMesaService.pedirCuenta(token);
  }
}
