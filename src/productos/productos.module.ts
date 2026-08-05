import { Module } from '@nestjs/common';
import { ProductosController } from './controllers/productos.controller';
import { AreasProductoController } from './controllers/areas-producto.controller';
import { CategoriasProductoController } from './controllers/categorias-producto.controller';
import { ProductosService } from './services/productos.service';
import { AreasProductoService } from './services/areas-producto.service';
import { CategoriasProductoService } from './services/categorias-producto.service';

@Module({
  controllers: [ProductosController, AreasProductoController, CategoriasProductoController],
  providers: [ProductosService, AreasProductoService, CategoriasProductoService]
})
export class ProductosModule {}
