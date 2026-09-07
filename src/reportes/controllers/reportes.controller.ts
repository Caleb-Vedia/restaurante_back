import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ReportesService } from '../services/reportes.service';
import { ReporteRangoQueryDto } from '../dto/reporte-rango-query.dto';
import { PlatosMasVendidosQueryDto } from '../dto/platos-mas-vendidos-query.dto';
import { ReporteVentasResponse } from '../dto/reporte-ventas-response.dto';
import { ReportePlatosMasVendidosResponse } from '../dto/reporte-platos-response.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolUsuario } from '../../common/enums/rol-usuario.enum';

// Módulo exclusivo admin, sin excepciones. Solo lectura: sin POST/PATCH/DELETE,
// sin transacciones, sin locks.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RolUsuario.ADMIN)
@Controller('reportes')
export class ReportesController {
  constructor(private readonly reportesService: ReportesService) {}

  @Get('ventas')
  ventas(@Query() query: ReporteRangoQueryDto): Promise<ReporteVentasResponse> {
    return this.reportesService.obtenerReporteVentas(query.desde, query.hasta);
  }

  @Get('platos-mas-vendidos')
  platosMasVendidos(
    @Query() query: PlatosMasVendidosQueryDto,
  ): Promise<ReportePlatosMasVendidosResponse> {
    return this.reportesService.obtenerPlatosMasVendidos(
      query.desde,
      query.hasta,
      query.limite,
    );
  }
}
