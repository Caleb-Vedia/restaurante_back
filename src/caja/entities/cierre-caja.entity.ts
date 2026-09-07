import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { decimalTransformer } from '../../common/transformers/decimal.transformer';
import { Usuario } from '../../usuarios/entities/usuario.entity';
import { CierreCajaDetalle } from './cierre-caja-detalle.entity';

// ⚠️ Existe en la base el índice único parcial `idx_cierres_caja_abierto_unico`
// (migración AddCierreCajaAbiertoUnico), que garantiza UN SOLO cierre con
// `cerrado_el IS NULL` en toda la tabla. No se puede declarar acá con @Index
// porque va sobre una expresión constante — `ON cierres_caja ((true)) WHERE
// cerrado_el IS NULL` — y TypeORM solo soporta índices sobre columnas. Un
// índice sobre `id_cierre` NO serviría: cada fila tiene un id distinto, así que
// dos cierres abiertos no colisionarían.
// Al correr `migration:generate` en el futuro, revisar que no intente dropearlo
// por no encontrarlo declarado en esta entity.
@Entity('cierres_caja')
export class CierreCaja {
  @PrimaryGeneratedColumn({ name: 'id_cierre' })
  idCierre: number;

  @Column({ name: 'id_usuario' })
  idUsuario: number;

  @ManyToOne(() => Usuario)
  @JoinColumn({ name: 'id_usuario' })
  usuario: Usuario;

  @Column({ name: 'abierto_el', type: 'timestamptz' })
  abiertoEl: Date;

  @Column({ name: 'cerrado_el', type: 'timestamptz', nullable: true })
  cerradoEl: Date | null;

  @Column({
    name: 'monto_inicial_efectivo',
    type: 'decimal',
    precision: 10,
    scale: 2,
    transformer: decimalTransformer,
  })
  montoInicialEfectivo: number;

  // Explicación breve y opcional de la diferencia del arqueo (ej. "Faltan Bs
  // 5; se revisó efectivo."), capturada al CERRAR — nunca antes. `varchar(120)`
  // por el mismo criterio de "texto breve" que NOTA_MAX_LENGTH en Pedidos
  // (observacion-nota-max-length.validator); no hace falta más para una
  // explicación de una línea, y evitar `text` sin límite es la elección
  // deliberadamente simple acá.
  //
  // Se persiste UNA sola vez, dentro de la transacción de cerrarCaja, junto
  // con `cerradoEl`: un cierre histórico es inmutable, así que esta columna no
  // tiene ningún endpoint de edición posterior (decisión de esta etapa — no
  // reabrir sin pedido explícito).
  @Column({
    name: 'observacion_diferencia',
    type: 'varchar',
    length: 120,
    nullable: true,
  })
  observacionDiferencia: string | null;

  @OneToMany(() => CierreCajaDetalle, (detalle) => detalle.cierreCaja)
  detalles: CierreCajaDetalle[];
}
