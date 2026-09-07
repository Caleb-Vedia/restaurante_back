import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { Usuario } from '../entities/usuario.entity';
import { CreateUsuarioDto } from '../dto/create-usuario.dto';
import { UpdateUsuarioDto } from '../dto/update-usuario.dto';
import { ToggleActivoUsuarioDto } from '../dto/toggle-activo-usuario.dto';
import { ResetPasswordUsuarioDto } from '../dto/reset-password-usuario.dto';
import { UsuarioResponse } from '../dto/usuario-response.dto';
import { hashPassword } from '../../common/security/password.util';
import { RolUsuario } from '../../common/enums/rol-usuario.enum';
import { normalizarEmail } from '../../common/utils/normalizar-email.util';

@Injectable()
export class UsuariosService {
  constructor(
    @InjectRepository(Usuario)
    private readonly usuarioRepo: Repository<Usuario>,
  ) {}

  async create(dto: CreateUsuarioDto): Promise<UsuarioResponse> {
    const emailNormalizado = normalizarEmail(dto.email);
    await this.assertEmailDisponible(emailNormalizado);
    const passwordHash = await hashPassword(dto.password);
    const usuario = this.usuarioRepo.create({
      nombre: dto.nombre,
      email: emailNormalizado,
      passwordHash,
      rol: dto.rol,
      telefono: dto.telefono ?? null,
    });
    const saved = await this.usuarioRepo.save(usuario);
    return this.toUsuarioResponse(saved);
  }

  async findAll(): Promise<UsuarioResponse[]> {
    const usuarios = await this.usuarioRepo.find({
      order: { idUsuario: 'ASC' },
    });
    return usuarios.map((usuario) => this.toUsuarioResponse(usuario));
  }

  async findOne(id: number): Promise<UsuarioResponse> {
    const usuario = await this.getUsuarioOrFail(id);
    return this.toUsuarioResponse(usuario);
  }

  async update(id: number, dto: UpdateUsuarioDto): Promise<UsuarioResponse> {
    const usuario = await this.getUsuarioOrFail(id);

    if (dto.email !== undefined) {
      const emailNormalizado = normalizarEmail(dto.email);
      // Comparar contra el propio email ya normalizado: si el admin solo
      // cambió casing/espacios del email actual, no hay "otro" usuario que
      // chequear — se permite directo y queda guardado normalizado.
      if (emailNormalizado !== normalizarEmail(usuario.email)) {
        await this.assertEmailDisponible(emailNormalizado, usuario.idUsuario);
      }
      usuario.email = emailNormalizado;
    }
    if (dto.nombre !== undefined) {
      usuario.nombre = dto.nombre;
    }
    if (dto.telefono !== undefined) {
      usuario.telefono = dto.telefono;
    }
    if (dto.rol !== undefined) {
      // Bajar de rol a un admin activo puede dejar el sistema sin ningún
      // admin — mismo invariante que toggleActivo (ver
      // assertQuedaAlMenosUnAdminActivo).
      if (
        usuario.rol === RolUsuario.ADMIN &&
        usuario.activo &&
        dto.rol !== RolUsuario.ADMIN
      ) {
        await this.assertQuedaAlMenosUnAdminActivo(usuario.idUsuario);
      }
      usuario.rol = dto.rol;
    }

    await this.usuarioRepo.save(usuario);
    return this.toUsuarioResponse(usuario);
  }

  async toggleActivo(
    id: number,
    dto: ToggleActivoUsuarioDto,
  ): Promise<UsuarioResponse> {
    const usuario = await this.getUsuarioOrFail(id);
    // Desactivar al último admin activo dejaría el sistema sin nadie que
    // pueda gestionar usuarios (login circular, ver CLAUDE.md #16).
    if (!dto.activo && usuario.rol === RolUsuario.ADMIN && usuario.activo) {
      await this.assertQuedaAlMenosUnAdminActivo(usuario.idUsuario);
    }
    usuario.activo = dto.activo;
    await this.usuarioRepo.save(usuario);
    return this.toUsuarioResponse(usuario);
  }

  async resetPassword(
    id: number,
    dto: ResetPasswordUsuarioDto,
  ): Promise<UsuarioResponse> {
    const usuario = await this.getUsuarioOrFail(id);
    usuario.passwordHash = await hashPassword(dto.passwordNueva);
    await this.usuarioRepo.save(usuario);
    return this.toUsuarioResponse(usuario);
  }

  private async getUsuarioOrFail(id: number): Promise<Usuario> {
    const usuario = await this.usuarioRepo.findOne({
      where: { idUsuario: id },
    });
    if (!usuario) {
      throw new NotFoundException(`Usuario ${id} no encontrado`);
    }
    return usuario;
  }

  // Invariante server-side: siempre debe quedar al menos un admin activo.
  // Cuenta admins activos DISTINTOS del usuario en cuestión — no importa si
  // la operación es sobre el propio usuario autenticado o sobre otro; lo
  // único que se protege es que no quede cero.
  private async assertQuedaAlMenosUnAdminActivo(
    idUsuarioExcluido: number,
  ): Promise<void> {
    const otrosAdminsActivos = await this.usuarioRepo.count({
      where: {
        rol: RolUsuario.ADMIN,
        activo: true,
        idUsuario: Not(idUsuarioExcluido),
      },
    });
    if (otrosAdminsActivos === 0) {
      throw new ConflictException(
        'No se puede completar la operación: el sistema debe conservar al menos un administrador activo.',
      );
    }
  }

  // El email es el identificador real de la cuenta: la unicidad se evalúa
  // sobre el valor YA NORMALIZADO (ver normalizarEmail), comparando contra
  // LOWER(TRIM(email)) en SQL — así detecta un choque contra filas legacy
  // que pudieran no estar guardadas en minúsculas, no solo contra filas
  // creadas/editadas después de este cambio. `idExcluido` se pasa solo
  // desde update(): al editar, el propio usuario no cuenta como "otro"
  // usuario con ese email.
  private async assertEmailDisponible(
    emailNormalizado: string,
    idExcluido?: number,
  ): Promise<void> {
    const qb = this.usuarioRepo
      .createQueryBuilder('usuario')
      .where('LOWER(TRIM(usuario.email)) = :emailNormalizado', {
        emailNormalizado,
      });
    if (idExcluido !== undefined) {
      qb.andWhere('usuario.idUsuario != :idExcluido', { idExcluido });
    }
    const existente = await qb.getOne();
    if (existente) {
      throw new ConflictException(
        `Ya existe un usuario con el email "${emailNormalizado}".`,
      );
    }
  }

  private toUsuarioResponse(usuario: Usuario): UsuarioResponse {
    return {
      idUsuario: usuario.idUsuario,
      nombre: usuario.nombre,
      email: usuario.email,
      rol: usuario.rol,
      activo: usuario.activo,
      telefono: usuario.telefono,
    };
  }
}
