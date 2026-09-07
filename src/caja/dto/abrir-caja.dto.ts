import { IsNumber, Min } from 'class-validator';

export class AbrirCajaDto {
  // Fondo inicial de efectivo en el cajón al empezar el turno. Puede ser 0.
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  montoInicialEfectivo: number;
}
