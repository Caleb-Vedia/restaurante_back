import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { unlink } from 'fs/promises';
import { join } from 'path';
import { Not, Repository } from 'typeorm';
import { Producto } from '../entities/producto.entity';
import { AreaProducto } from '../entities/area-producto.entity';
import { CategoriaProducto } from '../entities/categoria-producto.entity';
import { IngredienteProducto } from '../entities/ingrediente-producto.entity';
import { CreateProductoDto } from '../dto/create-producto.dto';
import { UpdateProductoDto } from '../dto/update-producto.dto';
import { TogglePDisponibilidadDto } from '../dto/toggle-p-disponibilidad.dto';
import { CreateIngredienteProductoDto } from '../dto/create-ingrediente-producto.dto';
import { UpdateIngredienteProductoDto } from '../dto/update-ingrediente-producto.dto';
import { normalizarNombre } from '../../common/utils/normalizar-nombre.util';

@Injectable()
export class ProductosService {
  constructor(
    @InjectRepository(Producto)
    private readonly productoRepo: Repository<Producto>,
    @InjectRepository(AreaProducto)
    private readonly areaRepo: Repository<AreaProducto>,
    @InjectRepository(CategoriaProducto)
    private readonly categoriaRepo: Repository<CategoriaProducto>,
    @InjectRepository(IngredienteProducto)
    private readonly ingredienteRepo: Repository<IngredienteProducto>,
  ) {}

  // Lista admin: productos activos con sus ingredientes activos anidados.
  // find()/relations excluye soft-deleted automáticamente (@DeleteDateColumn).
  findAll(): Promise<Producto[]> {
    return this.productoRepo.find({
      relations: { ingredientes: true },
      order: { idProducto: 'ASC' },
    });
  }

  async findOne(id: number): Promise<Producto> {
    const producto = await this.productoRepo.findOne({
      where: { idProducto: id },
      relations: { ingredientes: true },
    });
    if (!producto) {
      throw new NotFoundException(`Producto ${id} no encontrado`);
    }
    return producto;
  }

  async create(dto: CreateProductoDto): Promise<Producto> {
    await this.assertAreaExists(dto.idAreaProducto);
    await this.assertCategoriaExists(dto.idCategoriaProducto);
    await this.assertNombreDisponible(dto.nombreProducto);

    const producto = this.productoRepo.create({
      nombreProducto: dto.nombreProducto,
      descripcion: dto.descripcion ?? null,
      precio: dto.precio,
      idAreaProducto: dto.idAreaProducto,
      idCategoriaProducto: dto.idCategoriaProducto,
      urlImagen: dto.urlImagen ?? null,
    });
    const saved = await this.productoRepo.save(producto);
    return this.findOne(saved.idProducto);
  }

  async update(id: number, dto: UpdateProductoDto): Promise<Producto> {
    const producto = await this.findOne(id);

    if (dto.idAreaProducto !== undefined) {
      await this.assertAreaExists(dto.idAreaProducto);
      producto.idAreaProducto = dto.idAreaProducto;
    }
    if (dto.idCategoriaProducto !== undefined) {
      await this.assertCategoriaExists(dto.idCategoriaProducto);
      producto.idCategoriaProducto = dto.idCategoriaProducto;
    }
    if (dto.nombreProducto !== undefined) {
      await this.assertNombreDisponible(
        dto.nombreProducto,
        producto.idProducto,
      );
      producto.nombreProducto = dto.nombreProducto;
    }
    if (dto.descripcion !== undefined) {
      producto.descripcion = dto.descripcion;
    }
    if (dto.precio !== undefined) {
      producto.precio = dto.precio;
    }
    if (dto.urlImagen !== undefined) {
      producto.urlImagen = dto.urlImagen;
    }

    await this.productoRepo.save(producto);
    return this.findOne(id);
  }

  async toggleDisponibilidad(
    id: number,
    dto: TogglePDisponibilidadDto,
  ): Promise<Producto> {
    const producto = await this.findOne(id);
    producto.disponible = dto.disponible;
    await this.productoRepo.save(producto);
    return this.findOne(id);
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.productoRepo.softDelete(id);
  }

  // --- Imagen del producto ---

  async actualizarImagen(
    id: number,
    archivo?: Express.Multer.File,
  ): Promise<Producto> {
    if (!archivo) {
      throw new BadRequestException(
        'No se recibió ningún archivo de imagen (campo "imagen").',
      );
    }

    const nuevaUrl = `/uploads/productos/${archivo.filename}`;

    let producto: Producto;
    try {
      producto = await this.findOne(id);
    } catch (error) {
      // El archivo ya fue escrito a disco por multer antes de llegar acá;
      // si el producto no existe, limpiamos el huérfano y propagamos el 404.
      await this.borrarArchivoInterno(nuevaUrl);
      throw error;
    }

    // Reemplazo: borrar la imagen previa si era una subida interna.
    await this.borrarArchivoInterno(producto.urlImagen);

    producto.urlImagen = nuevaUrl;
    await this.productoRepo.save(producto);
    return this.findOne(id);
  }

  async eliminarImagen(id: number): Promise<Producto> {
    const producto = await this.findOne(id);
    await this.borrarArchivoInterno(producto.urlImagen);
    producto.urlImagen = null;
    await this.productoRepo.save(producto);
    return this.findOne(id);
  }

  // Borra del disco un archivo subido internamente. Solo actúa sobre rutas que
  // apuntan a /uploads/ (una subida nuestra); ignora valores externos/vacíos.
  private async borrarArchivoInterno(urlImagen: string | null): Promise<void> {
    if (!urlImagen || !urlImagen.startsWith('/uploads/')) {
      return;
    }
    const rutaFisica = join(process.cwd(), urlImagen);
    try {
      await unlink(rutaFisica);
    } catch {
      // El archivo pudo no existir ya en disco; no frenamos la operación por eso.
    }
  }

  // --- Ingredientes (anidados bajo producto) ---

  async addIngrediente(
    productoId: number,
    dto: CreateIngredienteProductoDto,
  ): Promise<Producto> {
    await this.findOne(productoId);
    const ingrediente = this.ingredienteRepo.create({
      idProducto: productoId,
      nombreIngrediente: dto.nombreIngrediente,
    });
    await this.ingredienteRepo.save(ingrediente);
    return this.findOne(productoId);
  }

  async updateIngrediente(
    productoId: number,
    ingredienteId: number,
    dto: UpdateIngredienteProductoDto,
  ): Promise<Producto> {
    const ingrediente = await this.findIngrediente(productoId, ingredienteId);
    if (dto.nombreIngrediente !== undefined) {
      ingrediente.nombreIngrediente = dto.nombreIngrediente;
    }
    await this.ingredienteRepo.save(ingrediente);
    return this.findOne(productoId);
  }

  async removeIngrediente(
    productoId: number,
    ingredienteId: number,
  ): Promise<void> {
    await this.findIngrediente(productoId, ingredienteId);
    await this.ingredienteRepo.softDelete(ingredienteId);
  }

  private async findIngrediente(
    productoId: number,
    ingredienteId: number,
  ): Promise<IngredienteProducto> {
    const ingrediente = await this.ingredienteRepo.findOne({
      where: { idIngrediente: ingredienteId, idProducto: productoId },
    });
    if (!ingrediente) {
      throw new NotFoundException(
        `Ingrediente ${ingredienteId} no encontrado para el producto ${productoId}`,
      );
    }
    return ingrediente;
  }

  private async assertAreaExists(idArea: number): Promise<void> {
    // count() ignora soft-deleted: un área borrada cuenta como inexistente.
    const total = await this.areaRepo.count({
      where: { idAreaProducto: idArea },
    });
    if (total === 0) {
      throw new NotFoundException(`Área de producto ${idArea} no existe`);
    }
  }

  private async assertCategoriaExists(idCategoria: number): Promise<void> {
    const total = await this.categoriaRepo.count({
      where: { idCategoriaProducto: idCategoria },
    });
    if (total === 0) {
      throw new NotFoundException(
        `Categoría de producto ${idCategoria} no existe`,
      );
    }
  }

  // Unicidad GLOBAL de nombre entre productos NO soft-deleted, sin importar
  // categoría, área o disponibilidad — comparando por nombre normalizado
  // (case-insensitive + trim, ver normalizarNombre), nunca por el nombre
  // crudo. Mismo criterio que CategoriasProductoService.assertNombreDisponible.
  //
  // `find()` ya excluye soft-deleted por la columna @DeleteDateColumn: un
  // producto dado de baja NUNCA bloquea su nombre para uno nuevo. En
  // cambio `disponible: false` (desactivado) SÍ sigue reservando el
  // nombre — ni siquiera se filtra acá, porque `disponible` es ajeno a
  // esta consulta.
  //
  // `idExcluido` se pasa solo desde update(): al editar, el propio
  // producto no cuenta como "otro" producto con ese nombre — permite
  // guardar sin cambios, o solo cambiar el casing/formato del propio
  // nombre, siempre que ningún OTRO producto activo lo tenga ya.
  private async assertNombreDisponible(
    nombreProducto: string,
    idExcluido?: number,
  ): Promise<void> {
    const normalizado = normalizarNombre(nombreProducto);

    const activos = await this.productoRepo.find(
      idExcluido === undefined
        ? {}
        : { where: { idProducto: Not(idExcluido) } },
    );

    const duplicado = activos.find(
      (producto) => normalizarNombre(producto.nombreProducto) === normalizado,
    );

    if (duplicado) {
      throw new ConflictException(
        `Ya existe un producto llamado "${duplicado.nombreProducto}".`,
      );
    }
  }
}
