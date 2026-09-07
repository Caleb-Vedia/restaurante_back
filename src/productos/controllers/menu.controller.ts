import { Controller, Get, ParseIntPipe, Query } from '@nestjs/common';
import { MenuService } from '../services/menu.service';
import { MenuCategoriaResponse } from '../dto/menu-response.dto';

// Endpoint público del cliente (acceso vía QR de mesa, sin login). A propósito
// separado de los controllers de admin para que el futuro guard de rol no lo
// alcance por accidente.
@Controller('menu')
export class MenuController {
  constructor(private readonly menuService: MenuService) {}

  @Get()
  getMenu(
    @Query('area', new ParseIntPipe({ optional: true })) area?: number,
  ): Promise<MenuCategoriaResponse[]> {
    return this.menuService.getMenu(area);
  }
}
