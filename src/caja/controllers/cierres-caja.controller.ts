import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { CierresCajaService } from '../services/cierres-caja.service';
import { ActividadTurnoService } from '../services/actividad-turno.service';
import { AbrirCajaDto } from '../dto/abrir-caja.dto';
import { CerrarCajaDto } from '../dto/cerrar-caja.dto';
import {
  CajaAbiertaResponse,
  CierreCajaResumenResponse,
} from '../dto/cierre-caja-response.dto';
import { ActividadTurnoResponse } from '../dto/actividad-turno-response.dto';
import { CierrePreviewResponse } from '../dto/cierre-preview-response.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { UsuarioAutenticado } from '../../common/guards/jwt-auth.guard';
import { RolUsuario } from '../../common/enums/rol-usuario.enum';

// Apertura/cierre de caja: operativa de caja (admin incluido por completitud).
// El prefijo de ruta es `caja`; la clase conserva el nombre del scaffold
// (CierresCajaController) para no romper su .spec.ts.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RolUsuario.CAJA, RolUsuario.ADMIN)
@Controller('caja')
export class CierresCajaController {
  constructor(
    private readonly cierresCajaService: CierresCajaService,
    private readonly actividadTurnoService: ActividadTurnoService,
  ) {}

  @Post('abrir')
  abrir(
    @Body() dto: AbrirCajaDto,
    @CurrentUser() usuario: UsuarioAutenticado,
  ): Promise<CajaAbiertaResponse> {
    return this.cierresCajaService.abrirCaja(dto, usuario.idUsuario);
  }

  // 200 con null cuando no hay caja abierta (estado normal, no error).
  @Get('actual')
  actual(): Promise<CajaAbiertaResponse | null> {
    return this.cierresCajaService.obtenerCajaActual();
  }

  // Actividad del turno en curso, agrupada por visita (SesionMesa). Lectura
  // pura: no abre ni cierra nada. Reusable después por Operación y por el
  // Paso 1 del cierre — por eso es un GET propio y no un campo más del
  // resumen de PATCH /caja/cerrar, que solo existe una vez cerrado el turno.
  // Ruta estática, sin colisión con 'abrir'/'actual'/'cerrar'.
  @Get('actividad')
  actividad(): Promise<ActividadTurnoResponse> {
    return this.actividadTurnoService.obtenerActividadDelTurno();
  }

  // --- Cierre en 4 pasos ---
  // Paso 1 es GET /caja/actividad (arriba). Los pasos 2 y 3 son lecturas puras
  // que NO persisten nada y pueden repetirse; el paso 4 es el único
  // irreversible.

  // Paso 2: qué se espera en caja y en qué estado quedaron las mesas, sin
  // montos verificados todavía. GET porque no tiene entrada ni efectos.
  @Get('cierre/contexto')
  contextoCierre(): Promise<CierrePreviewResponse> {
    return this.cierresCajaService.obtenerContextoCierre();
  }

  // Paso 3: mismo cálculo, ahora con los montos verificados, para ver
  // diferencias. Es POST por el body, no porque cree algo — no persiste nada
  // (ver CierresCajaService.previsualizarCierre).
  //
  // Reusa CerrarCajaDto a propósito: el body que se previsualiza es
  // EXACTAMENTE el que después se manda a PATCH /caja/cerrar, así que no hay
  // forma de que el preview y el cierre acepten contratos distintos.
  @Post('cierre/preview')
  previewCierre(@Body() dto: CerrarCajaDto): Promise<CierrePreviewResponse> {
    return this.cierresCajaService.previsualizarCierre(dto);
  }

  // Paso 4: la ÚNICA operación irreversible. Revalida todo por su cuenta —
  // no confía en el preview.
  @Patch('cerrar')
  cerrar(@Body() dto: CerrarCajaDto): Promise<CierreCajaResumenResponse> {
    return this.cierresCajaService.cerrarCaja(dto);
  }
}
