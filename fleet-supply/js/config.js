/* ═══════════════════════════════════════════════════════
   config.js
   Parámetros, catálogos de valores fijos y rutas de abastecimiento.
   No hay build tools: este archivo se importa con <script type="module">.
   ═══════════════════════════════════════════════════════ */

// Roles de Fleet Supply (independientes de usuarios.rol, ver fs_usuarios_rol)
export const ROLES_FS = {
  JEFE_COMERCIAL: 'jefe_comercial',
  ALMACENISTA: 'almacenista',
  COMERCIO_EXTERIOR: 'comercio_exterior',
  FINANCIERA: 'financiera',
  GERENCIA: 'gerencia',
  SOLO_LECTURA: 'solo_lectura',
};

// Roles que pueden crear/editar el catálogo y los combos.
// El resto (almacenista, comercio_exterior, financiera, gerencia,
// solo_lectura) solo consulta en esta fase.
export const ROLES_EDITAN_CATALOGO = [ROLES_FS.JEFE_COMERCIAL];

// Líneas de negocio
export const LINEAS = {
  fleet: 'Fleet',
  carga: 'Carga',
  ambas: 'Ambas',
};

// Marcas / proveedores de origen del producto
export const MARCAS = {
  JimiIoT: 'JimiIoT',
  Geotab: 'Geotab',
  Claro: 'Claro',
  GlobalStar: 'GlobalStar',
  Otro: 'Otro',
};

// Categoría del producto. Además de servir para agrupar reportes, es lo
// que permite reconocer una SIM y avisar cuando un combo lleve un equipo
// que necesita conectividad sin la línea de SIM correspondiente.
export const CATEGORIAS = {
  equipo: 'Equipo GPS',
  camara: 'Cámara',
  sim: 'SIM card',
  accesorio: 'Accesorio',
  servicio: 'Servicio',
};

// Moneda en que factura el proveedor. La TRM y el colchón solo aplican
// a los costos en USD; Claro y otros proveedores locales facturan en COP.
export const MONEDAS_COSTO = {
  USD: 'USD',
  COP: 'COP',
};

// Tipo de control de inventario por producto
export const CONTROL_INVENTARIO = {
  serie: 'Por serie / IMEI',
  cantidad: 'Por cantidad',
};

// Rutas de abastecimiento (la tabla completa de hitos y días
// estándar por ruta se define en cronograma.js, en una fase
// posterior; aquí solo van las etiquetas para el selector del
// catálogo).
export const RUTAS = {
  m2m_local: 'M2M Dataglobal — stock local',
  m2m_importacion: 'M2M Dataglobal — con importación',
  jimiiot_china: 'JimiIoT China — compra directa',
  geotab_canada: 'Geotab Canadá',
  claro_local: 'Claro — compra local',
  globalstar_importacion: 'GlobalStar — con importación',
};

// Escalas de precio por volumen (regla de negocio: ≤10 unidades
// usa una escala, ≥11 usa otra, automático según cantidad del
// negocio — esto se usa desde negocios.js en una fase posterior;
// aquí solo se deja el umbral centralizado para no repetirlo).
export const UMBRAL_ESCALA_VOLUMEN = 10; // hasta 10 = escala 1; 11+ = escala 2

// Factor de seguridad del stock mínimo sugerido:
// consumo promedio diario (últimos 90 días) × días de lead time de la
// ruta de planeación × este factor, redondeado hacia arriba. El valor
// sugerido se muestra al lado del mínimo definido a mano, nunca lo
// reemplaza.
export const FACTOR_SEGURIDAD_STOCK = 1.4;
export const DIAS_CONSUMO_PROMEDIO = 90;

// Zona horaria y formato usados en toda la app
export const TIMEZONE = 'America/Bogota';

// Fase 2: cuando exista la tabla de pedidos internos (fs_pedido_items),
// poner esto en true. A partir de ahí el módulo bloquea la edición en
// sitio de un combo que ya se usó en un negocio cerrado y obliga a
// guardar una nueva versión, para que el negocio conserve el combo con
// el que se vendió. Mientras esté en false, los combos se pueden editar
// libremente porque todavía no hay negocios que dependan de ellos.
export const PEDIDOS_INTERNOS_ACTIVOS = false;
