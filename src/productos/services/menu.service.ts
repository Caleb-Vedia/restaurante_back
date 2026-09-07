import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Producto } from '../entities/producto.entity';
import {
  MenuCategoriaResponse,
  MenuProductoResponse,
} from '../dto/menu-response.dto';

@Injectable()
export class MenuService {
  constructor(
    @InjectRepository(Producto)
    private readonly productoRepo: Repository<Producto>,
  ) {}

  // Menú público: categorías activas con al menos un producto visible, cada
  // producto disponible con sus ingredientes activos. `area` filtra por KDS.
  async getMenu(area?: number): Promise<MenuCategoriaResponse[]> {
    const qb = this.productoRepo
      .createQueryBuilder('producto')
      .innerJoinAndSelect(
        'producto.categoriaProducto',
        'categoria',
        'categoria.borradoEl IS NULL',
      )
      .leftJoinAndSelect(
        'producto.ingredientes',
        'ingrediente',
        'ingrediente.borradoEl IS NULL',
      )
      .where('producto.borradoEl IS NULL')
      .andWhere('producto.disponible = :disponible', { disponible: true });

    if (area !== undefined) {
      qb.andWhere('producto.idAreaProducto = :area', { area });
    }

    qb.orderBy('categoria.idCategoriaProducto', 'ASC')
      .addOrderBy('producto.nombreProducto', 'ASC')
      .addOrderBy('ingrediente.idIngrediente', 'ASC');

    const productos = await qb.getMany();

    // Agrupa por categoría preservando el orden ya aplicado en la query.
    const categoriasPorId = new Map<number, MenuCategoriaResponse>();

    for (const producto of productos) {
      const categoria = producto.categoriaProducto;
      let menuCategoria = categoriasPorId.get(categoria.idCategoriaProducto);
      if (!menuCategoria) {
        menuCategoria = {
          id: categoria.idCategoriaProducto,
          nombre: categoria.nombreCategoria,
          productos: [],
        };
        categoriasPorId.set(categoria.idCategoriaProducto, menuCategoria);
      }
      menuCategoria.productos.push(this.toMenuProducto(producto));
    }

    return Array.from(categoriasPorId.values());
  }

  private toMenuProducto(producto: Producto): MenuProductoResponse {
    return {
      id: producto.idProducto,
      nombre: producto.nombreProducto,
      descripcion: producto.descripcion,
      precio: producto.precio,
      urlImagen: producto.urlImagen,
      idAreaProducto: producto.idAreaProducto,
      ingredientes: (producto.ingredientes ?? []).map((ingrediente) => ({
        id: ingrediente.idIngrediente,
        nombre: ingrediente.nombreIngrediente,
      })),
    };
  }
}
