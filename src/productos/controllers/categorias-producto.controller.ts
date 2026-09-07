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
import { CategoriasProductoService } from '../services/categorias-producto.service';
import { CreateCategoriaProductoDto } from '../dto/create-categoria-producto.dto';
import { UpdateCategoriaProductoDto } from '../dto/update-categoria-producto.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolUsuario } from '../../common/enums/rol-usuario.enum';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RolUsuario.ADMIN)
@Controller('categorias-producto')
export class CategoriasProductoController {
  constructor(
    private readonly categoriasProductoService: CategoriasProductoService,
  ) {}

  @Get()
  findAll() {
    return this.categoriasProductoService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.categoriasProductoService.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateCategoriaProductoDto) {
    return this.categoriasProductoService.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCategoriaProductoDto,
  ) {
    return this.categoriasProductoService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.categoriasProductoService.remove(id);
  }
}
