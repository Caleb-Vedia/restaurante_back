import { Test, TestingModule } from '@nestjs/testing';
import { CierresCajaController } from './cierres-caja.controller';

describe('CierresCajaController', () => {
  let controller: CierresCajaController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CierresCajaController],
    }).compile();

    controller = module.get<CierresCajaController>(CierresCajaController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
