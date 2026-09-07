import {
  Column,
  DeleteDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Producto } from './producto.entity';

@Entity('ingredientes_producto')
export class IngredienteProducto {
  @PrimaryGeneratedColumn({ name: 'id_ingrediente' })
  idIngrediente: number;

  @Column({ name: 'id_producto' })
  idProducto: number;

  @ManyToOne(() => Producto, (producto) => producto.ingredientes)
  @JoinColumn({ name: 'id_producto' })
  producto: Producto;

  @Column({ name: 'nombre_ingrediente', type: 'varchar' })
  nombreIngrediente: string;

  @DeleteDateColumn({ name: 'borrado_el', type: 'timestamptz' })
  borradoEl: Date | null;
}
