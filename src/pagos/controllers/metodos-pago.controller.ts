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
import { MetodosPagoService } from '../services/metodos-pago.service';
import { CreateMetodoPagoDto } from '../dto/create-metodo-pago.dto';
import { UpdateMetodoPagoDto } from '../dto/update-metodo-pago.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolUsuario } from '../../common/enums/rol-usuario.enum';

// Catálogo de métodos de pago: lo administra admin, pero caja necesita LEERLO
// para armar el cobro — por eso el rol se define por método, no a nivel de
// clase (las mutaciones quedan solo para admin).
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('metodos-pago')
export class MetodosPagoController {
  constructor(private readonly metodosPagoService: MetodosPagoService) {}

  @Roles(RolUsuario.ADMIN, RolUsuario.CAJA)
  @Get()
  findAll() {
    return this.metodosPagoService.findAll();
  }

  @Roles(RolUsuario.ADMIN, RolUsuario.CAJA)
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.metodosPagoService.findOne(id);
  }

  @Roles(RolUsuario.ADMIN)
  @Post()
  create(@Body() dto: CreateMetodoPagoDto) {
    return this.metodosPagoService.create(dto);
  }

  @Roles(RolUsuario.ADMIN)
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateMetodoPagoDto,
  ) {
    return this.metodosPagoService.update(id, dto);
  }

  @Roles(RolUsuario.ADMIN)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.metodosPagoService.remove(id);
  }
}
