import { Test, TestingModule } from '@nestjs/testing';
import { SesionesMesaController } from './sesiones-mesa.controller';

describe('SesionesMesaController', () => {
  let controller: SesionesMesaController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SesionesMesaController],
    }).compile();

    controller = module.get<SesionesMesaController>(SesionesMesaController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
