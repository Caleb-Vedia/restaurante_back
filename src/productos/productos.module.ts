import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductosController } from './controllers/productos.controller';
import { AreasProductoController } from './controllers/areas-producto.controller';
import { CategoriasProductoController } from './controllers/categorias-producto.controller';
import { MenuController } from './controllers/menu.controller';
import { ProductosService } from './services/productos.service';
import { AreasProductoService } from './services/areas-producto.service';
import { CategoriasProductoService } from './services/categorias-producto.service';
import { MenuService } from './services/menu.service';
import { Producto } from './entities/producto.entity';
import { AreaProducto } from './entities/area-producto.entity';
import { CategoriaProducto } from './entities/categoria-producto.entity';
import { IngredienteProducto } from './entities/ingrediente-producto.entity';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Producto,
      AreaProducto,
      CategoriaProducto,
      IngredienteProducto,
    ]),
    // AuthModule provee JwtAuthGuard/RolesGuard, que los tres controllers de
    // admin usan vía @UseGuards. Sin este import Nest no puede resolver las
    // dependencias del guard en el contexto de este módulo y la app no arranca.
    AuthModule,
  ],
  controllers: [
    ProductosController,
    AreasProductoController,
    CategoriasProductoController,
    MenuController,
  ],
  providers: [
    ProductosService,
    AreasProductoService,
    CategoriasProductoService,
    MenuService,
  ],
})
export class ProductosModule {}
