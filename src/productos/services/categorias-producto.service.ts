import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { CategoriaProducto } from '../entities/categoria-producto.entity';
import { CreateCategoriaProductoDto } from '../dto/create-categoria-producto.dto';
import { UpdateCategoriaProductoDto } from '../dto/update-categoria-producto.dto';
import { normalizarNombre } from '../../common/utils/normalizar-nombre.util';

@Injectable()
export class CategoriasProductoService {
  constructor(
    @InjectRepository(CategoriaProducto)
    private readonly categoriaRepo: Repository<CategoriaProducto>,
  ) {}

  // find() excluye soft-deleted automáticamente por la columna @DeleteDateColumn.
  findAll(): Promise<CategoriaProducto[]> {
    return this.categoriaRepo.find({ order: { idCategoriaProducto: 'ASC' } });
  }

  async findOne(id: number): Promise<CategoriaProducto> {
    const categoria = await this.categoriaRepo.findOne({
      where: { idCategoriaProducto: id },
    });
    if (!categoria) {
      throw new NotFoundException(`Categoría de producto ${id} no encontrada`);
    }
    return categoria;
  }

  async create(dto: CreateCategoriaProductoDto): Promise<CategoriaProducto> {
    await this.assertNombreDisponible(dto.nombreCategoria);
    const categoria = this.categoriaRepo.create({
      nombreCategoria: dto.nombreCategoria,
    });
    return this.categoriaRepo.save(categoria);
  }

  async update(
    id: number,
    dto: UpdateCategoriaProductoDto,
  ): Promise<CategoriaProducto> {
    const categoria = await this.findOne(id);
    if (dto.nombreCategoria !== undefined) {
      await this.assertNombreDisponible(
        dto.nombreCategoria,
        categoria.idCategoriaProducto,
      );
      categoria.nombreCategoria = dto.nombreCategoria;
    }
    return this.categoriaRepo.save(categoria);
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.categoriaRepo.softDelete(id);
  }

  // Unicidad de nombre entre categorías ACTIVAS, comparando por nombre
  // normalizado (case-insensitive + trim, ver normalizarNombre) — nunca por
  // el nombre crudo. El valor guardado/mostrado conserva el formato
  // ingresado por el admin; esta comparación es solo para decidir si "ya
  // existe" otra categoría con ese mismo nombre.
  //
  // `find()` ya excluye soft-deleted por la columna @DeleteDateColumn (igual
  // que findAll()/findOne()) — por eso una categoría dada de baja NUNCA
  // bloquea su nombre para una nueva: ni siquiera entra en `activas`.
  //
  // `idExcluido` se pasa solo desde update(): al editar, la propia
  // categoría no debe contar como "otra" categoría con ese nombre — permite
  // guardar sin cambios, o solo cambiar el casing/formato del propio
  // nombre, siempre que ninguna OTRA categoría activa lo tenga ya.
  private async assertNombreDisponible(
    nombreCategoria: string,
    idExcluido?: number,
  ): Promise<void> {
    const normalizado = normalizarNombre(nombreCategoria);

    const activas = await this.categoriaRepo.find(
      idExcluido === undefined
        ? {}
        : { where: { idCategoriaProducto: Not(idExcluido) } },
    );

    const yaExiste = activas.some(
      (categoria) =>
        normalizarNombre(categoria.nombreCategoria) === normalizado,
    );

    if (yaExiste) {
      throw new ConflictException(
        `Ya existe una categoría activa con el nombre "${nombreCategoria.trim()}".`,
      );
    }
  }
}
