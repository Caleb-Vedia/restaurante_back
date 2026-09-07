import { IsBoolean } from 'class-validator';

export class ToggleActivoUsuarioDto {
  @IsBoolean()
  activo: boolean;
}
