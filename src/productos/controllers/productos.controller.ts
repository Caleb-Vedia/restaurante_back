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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ProductosService } from '../services/productos.service';
import { CreateProductoDto } from '../dto/create-producto.dto';
import { UpdateProductoDto } from '../dto/update-producto.dto';
import { TogglePDisponibilidadDto } from '../dto/toggle-p-disponibilidad.dto';
import { CreateIngredienteProductoDto } from '../dto/create-ingrediente-producto.dto';
import { UpdateIngredienteProductoDto } from '../dto/update-ingrediente-producto.dto';
import { multerProductosConfig } from '../config/multer-productos.config';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolUsuario } from '../../common/enums/rol-usuario.enum';

// El menú público del cliente vive aparte en MenuController (GET /menu, sin
// guard). Este controller es enteramente de administración.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RolUsuario.ADMIN)
@Controller('productos')
export class ProductosController {
  constructor(private readonly productosService: ProductosService) {}

  @Get()
  findAll() {
    return this.productosService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.productosService.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateProductoDto) {
    return this.productosService.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateProductoDto,
  ) {
    return this.productosService.update(id, dto);
  }

  @Patch(':id/disponibilidad')
  toggleDisponibilidad(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: TogglePDisponibilidadDto,
  ) {
    return this.productosService.toggleDisponibilidad(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.productosService.remove(id);
  }

  // --- Imagen del producto ---

  @Post(':id/imagen')
  @UseInterceptors(FileInterceptor('imagen', multerProductosConfig))
  subirImagen(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() imagen?: Express.Multer.File,
  ) {
    return this.productosService.actualizarImagen(id, imagen);
  }

  @Delete(':id/imagen')
  eliminarImagen(@Param('id', ParseIntPipe) id: number) {
    return this.productosService.eliminarImagen(id);
  }

  // --- Ingredientes anidados bajo el producto ---

  @Post(':id/ingredientes')
  addIngrediente(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateIngredienteProductoDto,
  ) {
    return this.productosService.addIngrediente(id, dto);
  }

  @Patch(':id/ingredientes/:ingredienteId')
  updateIngrediente(
    @Param('id', ParseIntPipe) id: number,
    @Param('ingredienteId', ParseIntPipe) ingredienteId: number,
    @Body() dto: UpdateIngredienteProductoDto,
  ) {
    return this.productosService.updateIngrediente(id, ingredienteId, dto);
  }

  @Delete(':id/ingredientes/:ingredienteId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeIngrediente(
    @Param('id', ParseIntPipe) id: number,
    @Param('ingredienteId', ParseIntPipe) ingredienteId: number,
  ) {
    return this.productosService.removeIngrediente(id, ingredienteId);
  }
}
