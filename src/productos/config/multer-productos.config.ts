import { BadRequestException } from '@nestjs/common';
import { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { randomUUID } from 'crypto';
import type { Request } from 'express';
import { diskStorage } from 'multer';
import { extname } from 'path';

// Carpeta física de destino (en la raíz del proyecto, fuera de src/). main.ts
// la sirve como estática bajo el prefijo /uploads.
const DESTINO_PRODUCTOS = 'uploads/productos';

const TIPOS_IMAGEN_PERMITIDOS = ['image/jpeg', 'image/png', 'image/webp'];

// MulterOptions reutilizable para la subida de imagen de un producto.
// Nombre de archivo: producto-{idProducto}-{uuid}.{ext}, con el idProducto
// tomado del param de ruta (:id) y el uuid de crypto.randomUUID() nativo.
export const multerProductosConfig: MulterOptions = {
  storage: diskStorage({
    destination: DESTINO_PRODUCTOS,
    filename: (
      req: Request,
      file: Express.Multer.File,
      callback: (error: Error | null, filename: string) => void,
    ) => {
      const idProducto = String(req.params.id);
      const nombreArchivo = `producto-${idProducto}-${randomUUID()}${extname(
        file.originalname,
      )}`;
      callback(null, nombreArchivo);
    },
  }),
  fileFilter: (
    req: Request,
    file: Express.Multer.File,
    callback: (error: Error | null, acceptFile: boolean) => void,
  ) => {
    if (!TIPOS_IMAGEN_PERMITIDOS.includes(file.mimetype)) {
      callback(
        new BadRequestException(
          `Tipo de archivo no permitido (${file.mimetype}). Solo se aceptan imágenes JPEG, PNG o WebP.`,
        ),
        false,
      );
      return;
    }
    callback(null, true);
  },
  limits: { fileSize: 5 * 1024 * 1024 },
};
