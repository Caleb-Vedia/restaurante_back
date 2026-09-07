import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { MesasService } from '../services/mesas.service';
import { CreateMesaDto } from '../dto/create-mesa.dto';
import { UpdateMesaDto } from '../dto/update-mesa.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolUsuario } from '../../common/enums/rol-usuario.enum';

// Controller de administración/caja de mesas. Todos sus endpoints son de
// backoffice y deben ir protegidos por rol (a diferencia de los del cliente en
// SesionesMesaController).
@Controller('mesas')
export class MesasController {
  constructor(private readonly mesasService: MesasService) {}

  // CRUD de mesas físicas: exclusivo admin.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RolUsuario.ADMIN)
  @Post()
  create(@Body() dto: CreateMesaDto) {
    return this.mesasService.create(dto);
  }

  // Lectura: caja necesita ver mesas y su estado para el flujo de cobro; admin
  // también por completitud.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RolUsuario.ADMIN, RolUsuario.CAJA)
  @Get()
  findAll() {
    return this.mesasService.findAll();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RolUsuario.ADMIN, RolUsuario.CAJA)
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.mesasService.findOne(id);
  }

  // Edita la mesa física (nombreMesa): exclusivo admin.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RolUsuario.ADMIN)
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateMesaDto) {
    return this.mesasService.update(id, dto);
  }

  // Elimina (soft delete) una mesa física: exclusivo admin.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RolUsuario.ADMIN)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.mesasService.remove(id);
  }

  // Override manual de cierre de sesión de mesa (el camino normal de cobro
  // llama directo a MesasService.cerrarSesionActiva() desde Pagos+Caja).
  // Caja puede usarlo operativamente; admin por completitud.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RolUsuario.ADMIN, RolUsuario.CAJA)
  @Patch(':id/cerrar-sesion')
  cerrarSesion(@Param('id', ParseIntPipe) id: number) {
    return this.mesasService.cerrarSesionActiva(id);
  }
}
