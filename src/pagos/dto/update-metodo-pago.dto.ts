import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class UpdateMetodoPagoDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  nombreMetodo?: string;
}
