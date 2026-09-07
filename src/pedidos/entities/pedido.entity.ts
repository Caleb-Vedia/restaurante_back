import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { EstadoPedido } from '../../common/enums/estado-pedido.enum';
import { SesionMesa } from '../../mesas/entities/sesion-mesa.entity';
import { DetallePedido } from './detalle-pedido.entity';

@Entity('pedidos')
export class Pedido {
  @PrimaryGeneratedColumn({ name: 'id_pedido' })
  idPedido: number;

  @Column({ name: 'id_sesion' })
  idSesion: number;

  @ManyToOne(() => SesionMesa, (sesionMesa) => sesionMesa.pedidos)
  @JoinColumn({ name: 'id_sesion' })
  sesion: SesionMesa;

  @Column({ name: 'nombre_comensal', type: 'varchar', nullable: true })
  nombreComensal: string | null;

  @Column({
    name: 'estado',
    type: 'enum',
    enum: EstadoPedido,
    default: EstadoPedido.PENDIENTE,
  })
  estado: EstadoPedido;

  @Column({ name: 'nro_orden', type: 'int' })
  nroOrden: number;

  @CreateDateColumn({ name: 'creado_el', type: 'timestamptz' })
  creadoEl: Date;

  @OneToMany(() => DetallePedido, (detalle) => detalle.pedido)
  detallesPedido: DetallePedido[];
}
