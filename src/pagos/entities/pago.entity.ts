import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { decimalTransformer } from '../../common/transformers/decimal.transformer';
import { SesionMesa } from '../../mesas/entities/sesion-mesa.entity';
import { MetodoPago } from './metodo-pago.entity';

@Entity('pagos')
export class Pago {
  @PrimaryGeneratedColumn({ name: 'id_pago' })
  idPago: number;

  @Column({ name: 'id_sesion' })
  idSesion: number;

  @ManyToOne(() => SesionMesa, (sesionMesa) => sesionMesa.pagos)
  @JoinColumn({ name: 'id_sesion' })
  sesion: SesionMesa;

  @Column({ name: 'id_metodo_pago' })
  idMetodoPago: number;

  @ManyToOne(() => MetodoPago)
  @JoinColumn({ name: 'id_metodo_pago' })
  metodoPago: MetodoPago;

  @Column({ name: 'nro_recibo', type: 'varchar', nullable: true })
  nroRecibo: string | null;

  @Column({
    name: 'monto_pagado',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: decimalTransformer,
  })
  montoPagado: number;

  @Column({ name: 'anulado_el', type: 'timestamptz', nullable: true })
  anuladoEl: Date | null;

  @CreateDateColumn({ name: 'creado_el', type: 'timestamptz' })
  creadoEl: Date;
}
