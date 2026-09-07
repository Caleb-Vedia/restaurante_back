import { ValueTransformer } from 'typeorm';

// Postgres devuelve columnas `decimal`/`numeric` como string; este transformer
// las expone como number en el lado de la aplicación (columnas de monto).
export const decimalTransformer: ValueTransformer = {
  to: (value?: number | null): number | null | undefined => value,
  from: (value?: string | null): number | null | undefined =>
    value === null || value === undefined ? value : parseFloat(value),
};
