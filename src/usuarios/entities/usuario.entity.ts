import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { RolUsuario } from '../../common/enums/rol-usuario.enum';

@Entity('usuarios')
export class Usuario {
  @PrimaryGeneratedColumn({ name: 'id_usuario' })
  idUsuario: number;

  @Column({ name: 'nombre', type: 'varchar' })
  nombre: string;

  // La unicidad real vive en el índice único parcial sobre
  // LOWER(TRIM(email)) (ver migración AddTelefonoYEmailNormalizadoUsuarios),
  // no en `unique: true` de esta columna — igual criterio que
  // nombre_categoria/nombre_producto: TypeORM no puede declarar un índice
  // sobre una expresión vía decorators, así que ese constraint vive
  // únicamente en la migración.
  @Column({ name: 'email', type: 'varchar' })
  email: string;

  @Column({ name: 'password_hash', type: 'varchar' })
  passwordHash: string;

  @Column({ name: 'rol', type: 'enum', enum: RolUsuario })
  rol: RolUsuario;

  @Column({ name: 'activo', type: 'boolean', default: true })
  activo: boolean;

  @Column({ name: 'telefono', type: 'varchar', nullable: true })
  telefono: string | null;
}
