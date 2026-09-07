import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { decimalTransformer } from '../../common/transformers/decimal.transformer';
import { CierreCaja } from './cierre-caja.entity';
import { MetodoPago } from '../../pagos/entities/metodo-pago.entity';

@Entity('cierres_caja_detalle')
export class CierreCajaDetalle {
  @PrimaryColumn({ name: 'id_cierre' })
  idCierre: number;

  @ManyToOne(() => CierreCaja, (cierreCaja) => cierreCaja.detalles)
  @JoinColumn({ name: 'id_cierre' })
  cierreCaja: CierreCaja;

  @PrimaryColumn({ name: 'id_metodo_pago' })
  idMetodoPago: number;

  @ManyToOne(() => MetodoPago)
  @JoinColumn({ name: 'id_metodo_pago' })
  metodoPago: MetodoPago;

  @Column({
    name: 'monto_esperado',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: decimalTransformer,
  })
  montoEsperado: number;

  @Column({
    name: 'monto_contado',
    type: 'decimal',
    precision: 10,
    scale: 2,
    nullable: true,
    transformer: decimalTransformer,
  })
  montoContado: number | null;
}
