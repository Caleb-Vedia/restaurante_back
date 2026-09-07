import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { decimalTransformer } from '../../common/transformers/decimal.transformer';
import { Pedido } from './pedido.entity';
import { Producto } from '../../productos/entities/producto.entity';

@Entity('detalles_pedidos')
export class DetallePedido {
  @PrimaryGeneratedColumn({ name: 'id_detalle' })
  idDetalle: number;

  @Column({ name: 'id_pedido' })
  idPedido: number;

  @ManyToOne(() => Pedido, (pedido) => pedido.detallesPedido)
  @JoinColumn({ name: 'id_pedido' })
  pedido: Pedido;

  @Column({ name: 'id_producto' })
  idProducto: number;

  @ManyToOne(() => Producto)
  @JoinColumn({ name: 'id_producto' })
  producto: Producto;

  @Column({ name: 'cantidad', type: 'int' })
  cantidad: number;

  @Column({
    name: 'precio_actual',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: decimalTransformer,
  })
  precioActual: number;

  @Column({ name: 'observacion', type: 'varchar', nullable: true })
  observacion: string | null;
}
