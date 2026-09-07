import { IsBoolean } from 'class-validator';

export class TogglePDisponibilidadDto {
  @IsBoolean()
  disponible: boolean;
}
