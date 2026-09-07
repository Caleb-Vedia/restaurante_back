import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { UsuariosService } from '../services/usuarios.service';
import { CreateUsuarioDto } from '../dto/create-usuario.dto';
import { UpdateUsuarioDto } from '../dto/update-usuario.dto';
import { ToggleActivoUsuarioDto } from '../dto/toggle-activo-usuario.dto';
import { ResetPasswordUsuarioDto } from '../dto/reset-password-usuario.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolUsuario } from '../../common/enums/rol-usuario.enum';

// Gestión de usuarios de personal: exclusivamente admin. Guards reales (no
// TODO) — requiere JWT válido (JwtAuthGuard) + rol admin (RolesGuard/@Roles).
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RolUsuario.ADMIN)
@Controller('usuarios')
export class UsuariosController {
  constructor(private readonly usuariosService: UsuariosService) {}

  @Post()
  create(@Body() dto: CreateUsuarioDto) {
    return this.usuariosService.create(dto);
  }

  @Get()
  findAll() {
    return this.usuariosService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.usuariosService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateUsuarioDto) {
    return this.usuariosService.update(id, dto);
  }

  @Patch(':id/activo')
  toggleActivo(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ToggleActivoUsuarioDto,
  ) {
    return this.usuariosService.toggleActivo(id, dto);
  }

  @Patch(':id/password')
  resetPassword(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ResetPasswordUsuarioDto,
  ) {
    return this.usuariosService.resetPassword(id, dto);
  }
}
