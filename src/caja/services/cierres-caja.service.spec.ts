import { Test, TestingModule } from '@nestjs/testing';
import { CierresCajaService } from './cierres-caja.service';

describe('CierresCajaService', () => {
  let service: CierresCajaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CierresCajaService],
    }).compile();

    service = module.get<CierresCajaService>(CierresCajaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
