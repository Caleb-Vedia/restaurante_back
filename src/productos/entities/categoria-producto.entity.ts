import {
  Column,
  DeleteDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('categorias_producto')
export class CategoriaProducto {
  @PrimaryGeneratedColumn({ name: 'id_categoria_producto' })
  idCategoriaProducto: number;

  @Column({ name: 'nombre_categoria', type: 'varchar' })
  nombreCategoria: string;

  @DeleteDateColumn({ name: 'borrado_el', type: 'timestamptz' })
  borradoEl: Date | null;
}
