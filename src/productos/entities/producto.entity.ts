import {
  Column,
  DeleteDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { decimalTransformer } from '../../common/transformers/decimal.transformer';
import { AreaProducto } from './area-producto.entity';
import { CategoriaProducto } from './categoria-producto.entity';
import { IngredienteProducto } from './ingrediente-producto.entity';

@Entity('productos')
export class Producto {
  @PrimaryGeneratedColumn({ name: 'id_producto' })
  idProducto: number;

  @Column({ name: 'id_area_producto' })
  idAreaProducto: number;

  @ManyToOne(() => AreaProducto)
  @JoinColumn({ name: 'id_area_producto' })
  areaProducto: AreaProducto;

  @Column({ name: 'id_categoria_producto' })
  idCategoriaProducto: number;

  @ManyToOne(() => CategoriaProducto)
  @JoinColumn({ name: 'id_categoria_producto' })
  categoriaProducto: CategoriaProducto;

  @Column({ name: 'nombre_producto', type: 'varchar' })
  nombreProducto: string;

  @Column({ name: 'descripcion', type: 'text', nullable: true })
  descripcion: string | null;

  @Column({
    name: 'precio',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: decimalTransformer,
  })
  precio: number;

  @Column({ name: 'url_imagen', type: 'varchar', nullable: true })
  urlImagen: string | null;

  @Column({ name: 'disponible', type: 'boolean', default: true })
  disponible: boolean;

  @DeleteDateColumn({ name: 'borrado_el', type: 'timestamptz' })
  borradoEl: Date | null;

  @OneToMany(() => IngredienteProducto, (ingrediente) => ingrediente.producto)
  ingredientes: IngredienteProducto[];
}
