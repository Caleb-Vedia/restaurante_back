import {
  Column,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

// Índice único parcial: mismo patrón que areas_producto e idx_sesiones_mesa_id_mesa_abierta.
@Entity('metodos_pago')
@Index('idx_metodos_pago_codigo', ['codigo'], {
  unique: true,
  where: 'codigo IS NOT NULL',
})
export class MetodoPago {
  @PrimaryGeneratedColumn({ name: 'id_metodo_pago' })
  idMetodoPago: number;

  @Column({ name: 'nombre_metodo', type: 'varchar' })
  nombreMetodo: string;

  // Código interno estable (decisión #17), independiente de `nombreMetodo` que
  // el admin puede renombrar. Hoy solo se usa `'efectivo'`, para saber a qué
  // método sumarle el fondo inicial al cerrar caja. Nunca se setea vía API
  // (ver Create/UpdateMetodoPagoDto): solo por migración/seed.
  @Column({ name: 'codigo', type: 'varchar', nullable: true })
  codigo: string | null;

  @DeleteDateColumn({ name: 'borrado_el', type: 'timestamptz' })
  borradoEl: Date | null;
}
