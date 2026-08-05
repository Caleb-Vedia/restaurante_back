import { Test, TestingModule } from '@nestjs/testing';
import { MetodosPagoController } from './metodos-pago.controller';

describe('MetodosPagoController', () => {
  let controller: MetodosPagoController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MetodosPagoController],
    }).compile();

    controller = module.get<MetodosPagoController>(MetodosPagoController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
