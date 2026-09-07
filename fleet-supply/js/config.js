/* ═══════════════════════════════════════════════════════
   config.js
   Parámetros, catálogos de valores fijos y rutas de abastecimiento.
   No hay build tools: este archivo se importa con <script type="module">.
   ═══════════════════════════════════════════════════════ */

// Roles de Fleet Supply (independientes de usuarios.rol, ver fs_usuarios_rol).
// 'admin' es el súper usuario: va incluido en TODAS las listas de permisos
// de abajo. Si se agrega una lista nueva, hay que acordarse de incluirlo.
export const ROLES_FS = {
  JEFE_COMERCIAL: 'jefe_comercial',
  ALMACENISTA: 'almacenista',
  COMERCIO_EXTERIOR: 'comercio_exterior',
  FINANCIERA: 'financiera',
  GERENCIA: 'gerencia',
  SOLO_LECTURA: 'solo_lectura',
  ADMIN: 'admin',
};

// Roles que pueden crear/editar el catálogo y los combos.
// El resto (almacenista, comercio_exterior, financiera, gerencia,
// solo_lectura) solo consulta en esta fase.
export const ROLES_EDITAN_CATALOGO = [ROLES_FS.JEFE_COMERCIAL, ROLES_FS.ADMIN];

// Quién puede crear y editar negocios. El Jefe Comercial es quien cierra
// el negocio y define el combo; los demás consultan (el Almacenista
// actuará sobre el negocio cuando exista la reserva de stock, en la fase
// de inventario).
export const ROLES_EDITAN_NEGOCIOS = [ROLES_FS.JEFE_COMERCIAL, ROLES_FS.ADMIN];

// Quién edita los maestros: proveedores, rutas y sus hitos.
// Comercio Exterior porque es quien cotiza, coloca los pedidos y
// conoce los tiempos reales de cada ruta —Carolina es la que ajusta
// los días de los hitos—, y el Jefe Comercial porque es dueño del
// módulo y define los mínimos de stock.
export const ROLES_EDITAN_CONFIG = [
  ROLES_FS.COMERCIO_EXTERIOR, ROLES_FS.JEFE_COMERCIAL, ROLES_FS.ADMIN,
];

// Los parámetros (TRM, colchón, porcentajes) los toca además
// Financiera, porque de la TRM depende lo que se desembolsa.
export const ROLES_EDITAN_PARAMETROS = [
  ROLES_FS.COMERCIO_EXTERIOR, ROLES_FS.FINANCIERA, ROLES_FS.ADMIN,
];

// Parámetros que usa el sistema por dentro y que nadie edita a mano.
// Se guardan en fs_parametro para no crear una tabla por cada cosa,
// pero no salen en la pantalla de Parámetros: esa pantalla valida que
// todo sea un número y estos no lo son.
export const PARAMETROS_INTERNOS = ['mapeo_importador_catalogo'];

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
  GlobalStar: 'GlobalStar',
  M2M: 'M2M',
  Otro: 'Otro',
};

// Modalidad comercial del pedido. El plazo de comodato solo aplica
// cuando hay comodato: 12, 24 o 36 meses para JimiIoT, y ÚNICAMENTE 36
// para Geotab (la marca entrega los equipos gratis y no se cobra
// mensualidad de comodato, solo la de servicio).
export const MODALIDADES = {
  venta: 'Venta del equipo',
  comodato: 'Comodato',
  mixto: 'Mixto',
};

export const PLAZOS_COMODATO = [12, 24, 36];
export const PLAZO_UNICO_GEOTAB = 36;

// Naturaleza del negocio: la misma estructura sirve para proyectar
// (forecast), para el pipeline con probabilidad, y para lo ya cerrado.
// Solo los negocios 'cerrado' reservan stock.
export const NATURALEZAS = {
  forecast: 'Forecast',
  pipeline: 'Pipeline',
  cerrado: 'Cerrado',
};

// Estado de ejecución del abastecimiento de un negocio
export const ESTADOS_EJECUCION = {
  sin_iniciar: 'Sin iniciar',
  en_abastecimiento: 'En abastecimiento',
  parcial: 'Parcial',
  completo: 'Completo',
  anulado: 'Anulado',
};

// Escalas de precio por volumen, tal como se guardan en fs_precio_lista
export const ESCALAS = { '1-10': 'Hasta 10 unidades', '11+': '11 unidades o más' };

// Categoría del producto. Además de servir para agrupar reportes, es lo
// que permite reconocer una SIM y avisar cuando un combo lleve un equipo
// que necesita conectividad sin la línea de SIM correspondiente.
export const CATEGORIAS = {
  equipo: 'Equipo GPS',
  camara: 'Cámara',
  sim: 'SIM card',
  accesorio: 'Accesorio',
  licencia: 'Licencia',
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

// Rutas de abastecimiento. Los hitos y días de cada una viven ahora en
// las tablas fs_ruta y fs_hito_plantilla, que Comercio Exterior edita.
// Estas etiquetas son solo para el selector del catálogo; pendiente
// migrar fs_productos.ruta_habitual a una FK contra fs_ruta cuando se
// construya el módulo de compras.
export const RUTAS = {
  m2m_local: 'M2M Dataglobal — stock local',
  m2m_importacion: 'M2M Dataglobal — con importación',
  jimiiot_china: 'JimiIoT China — compra directa',
  geotab_canada: 'Geotab Canadá',
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

// Cuando ya haya negocios cargados en fs_negocio, poner esto en true.
// A partir de ahí el módulo bloquea la edición en sitio de un combo que
// ya se usó en un negocio y obliga a guardar una nueva versión, para que
// el negocio conserve el combo con el que se vendió. Mientras esté en
// false los combos se editan libremente, porque todavía no hay negocios
// que dependan de ellos.
export const NEGOCIOS_ACTIVOS = true;
