import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PagosService } from '../services/pagos.service';
import { RegistrarPagoDto } from '../dto/registrar-pago.dto';
import {
  PagoResponse,
  RegistrarPagoResponse,
  TotalAdeudadoResponse,
} from '../dto/pago-response.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolUsuario } from '../../common/enums/rol-usuario.enum';

// Cobro y anulación: operativa de caja (admin incluido por completitud).
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RolUsuario.CAJA, RolUsuario.ADMIN)
@Controller('pagos')
export class PagosController {
  constructor(private readonly pagosService: PagosService) {}

  // Ruta estática antes que cualquier paramétrica del mismo prefijo.
  @Get('total/:idMesa')
  obtenerTotal(
    @Param('idMesa', ParseIntPipe) idMesa: number,
  ): Promise<TotalAdeudadoResponse> {
    return this.pagosService.obtenerTotalDeMesa(idMesa);
  }

  @Get()
  historial(
    @Query('idMesa', ParseIntPipe) idMesa: number,
  ): Promise<PagoResponse[]> {
    return this.pagosService.historialPorMesa(idMesa);
  }

  @Post()
  registrar(@Body() dto: RegistrarPagoDto): Promise<RegistrarPagoResponse> {
    return this.pagosService.registrarPago(dto);
  }

  @Patch(':id/anular')
  anular(@Param('id', ParseIntPipe) id: number): Promise<PagoResponse> {
    return this.pagosService.anularPago(id);
  }
}
