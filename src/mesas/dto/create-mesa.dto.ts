import { IsNotEmpty, IsString } from 'class-validator';

export class CreateMesaDto {
  @IsString()
  @IsNotEmpty()
  nombreMesa: string;
}
