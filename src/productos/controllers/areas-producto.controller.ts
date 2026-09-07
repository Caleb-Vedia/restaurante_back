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
import { AreasProductoService } from '../services/areas-producto.service';
import { CreateAreaProductoDto } from '../dto/create-area-producto.dto';
import { UpdateAreaProductoDto } from '../dto/update-area-producto.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolUsuario } from '../../common/enums/rol-usuario.enum';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RolUsuario.ADMIN)
@Controller('areas-producto')
export class AreasProductoController {
  constructor(private readonly areasProductoService: AreasProductoService) {}

  @Get()
  findAll() {
    return this.areasProductoService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.areasProductoService.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateAreaProductoDto) {
    return this.areasProductoService.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateAreaProductoDto,
  ) {
    return this.areasProductoService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.areasProductoService.remove(id);
  }
}
