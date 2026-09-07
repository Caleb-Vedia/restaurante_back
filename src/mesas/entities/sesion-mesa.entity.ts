import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Mesa } from './mesa.entity';
import { Pedido } from '../../pedidos/entities/pedido.entity';
import { Pago } from '../../pagos/entities/pago.entity';

@Entity('sesiones_mesa')
@Index('idx_sesiones_mesa_id_mesa_abierta', ['idMesa'], {
  unique: true,
  where: 'cerrada_el IS NULL',
})
export class SesionMesa {
  @PrimaryGeneratedColumn({ name: 'id_sesion' })
  idSesion: number;

  @Column({ name: 'id_mesa' })
  idMesa: number;

  @ManyToOne(() => Mesa, (mesa) => mesa.sesiones)
  @JoinColumn({ name: 'id_mesa' })
  mesa: Mesa;

  @Column({ name: 'token', type: 'varchar', unique: true })
  token: string;

  @Column({ name: 'abierta_el', type: 'timestamptz' })
  abiertaEl: Date;

  @Column({ name: 'cerrada_el', type: 'timestamptz', nullable: true })
  cerradaEl: Date | null;

  @OneToMany(() => Pedido, (pedido) => pedido.sesion)
  pedidos: Pedido[];

  @OneToMany(() => Pago, (pago) => pago.sesion)
  pagos: Pago[];
}
