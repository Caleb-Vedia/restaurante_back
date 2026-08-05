import { Test, TestingModule } from '@nestjs/testing';
import { MetodosPagoService } from './metodos-pago.service';

describe('MetodosPagoService', () => {
  let service: MetodosPagoService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MetodosPagoService],
    }).compile();

    service = module.get<MetodosPagoService>(MetodosPagoService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
