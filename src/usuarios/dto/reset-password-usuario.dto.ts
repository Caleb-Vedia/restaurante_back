import { IsString, MinLength } from 'class-validator';

export class ResetPasswordUsuarioDto {
  @IsString()
  @MinLength(8)
  passwordNueva: string;
}
