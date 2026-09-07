// Shape de respuesta público del menú (consumo del frontend del cliente).
// Intencionalmente NO expone campos internos (borrado_el, disponible, timestamps).

export interface MenuIngredienteResponse {
  id: number;
  nombre: string;
}

export interface MenuProductoResponse {
  id: number;
  nombre: string;
  descripcion: string | null;
  precio: number;
  urlImagen: string | null;
  idAreaProducto: number;
  ingredientes: MenuIngredienteResponse[];
}

export interface MenuCategoriaResponse {
  id: number;
  nombre: string;
  productos: MenuProductoResponse[];
}
