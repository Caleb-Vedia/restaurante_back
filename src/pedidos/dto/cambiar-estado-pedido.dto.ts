import { IsEnum } from 'class-validator';
import { EstadoPedido } from '../../common/enums/estado-pedido.enum';

export class CambiarEstadoPedidoDto {
  @IsEnum(EstadoPedido)
  estado: EstadoPedido;
}
