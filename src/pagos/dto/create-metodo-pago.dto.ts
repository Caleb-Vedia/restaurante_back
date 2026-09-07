import { IsNotEmpty, IsString } from 'class-validator';

// `codigo` NO se expone a propósito: es un campo interno que solo se escribe
// por migración/seed (mismo criterio que AreaProducto, decisión #17).
export class CreateMetodoPagoDto {
  @IsString()
  @IsNotEmpty()
  nombreMetodo: string;
}
