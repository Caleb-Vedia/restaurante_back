import {
  Column,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

// Índice único parcial: mismo patrón que sesiones_mesa (idx_sesiones_mesa_id_mesa_abierta).
@Entity('areas_producto')
@Index('idx_areas_producto_codigo', ['codigo'], {
  unique: true,
  where: 'codigo IS NOT NULL',
})
export class AreaProducto {
  @PrimaryGeneratedColumn({ name: 'id_area_producto' })
  idAreaProducto: number;

  @Column({ name: 'nombre_area', type: 'varchar' })
  nombreArea: string;

  // Código interno estable para resolver el área desde código (ej. el KDS del
  // módulo Pedidos), independiente de `nombreArea`, que el admin puede
  // renombrar libremente sin afectar esa resolución. Nunca se setea vía API
  // (ver CreateAreaProductoDto/UpdateAreaProductoDto): solo por migración/seed.
  @Column({ name: 'codigo', type: 'varchar', nullable: true })
  codigo: string | null;

  @DeleteDateColumn({ name: 'borrado_el', type: 'timestamptz' })
  borradoEl: Date | null;
}
