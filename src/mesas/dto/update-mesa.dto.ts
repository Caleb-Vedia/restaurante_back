import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class UpdateMesaDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  nombreMesa?: string;
}
