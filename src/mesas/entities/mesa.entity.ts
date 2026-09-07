import {
  Column,
  DeleteDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { EstadoMesa } from '../../common/enums/estado-mesa.enum';
import { SesionMesa } from './sesion-mesa.entity';

@Entity('mesas')
export class Mesa {
  @PrimaryGeneratedColumn({ name: 'id_mesa' })
  idMesa: number;

  @Column({ name: 'nombre_mesa', type: 'varchar' })
  nombreMesa: string;

  @Column({
    name: 'estado',
    type: 'enum',
    enum: EstadoMesa,
    default: EstadoMesa.LIBRE,
  })
  estado: EstadoMesa;

  @DeleteDateColumn({ name: 'borrado_el', type: 'timestamptz' })
  borradoEl: Date | null;

  @OneToMany(() => SesionMesa, (sesionMesa) => sesionMesa.mesa)
  sesiones: SesionMesa[];
}
