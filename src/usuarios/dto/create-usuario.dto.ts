import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { RolUsuario } from '../../common/enums/rol-usuario.enum';

export class CreateUsuarioDto {
  @IsString()
  @IsNotEmpty()
  nombre: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsEnum(RolUsuario)
  rol: RolUsuario;

  @IsOptional()
  @IsString()
  telefono?: string;
}
