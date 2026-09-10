/* ═══════════════════════════════════════════════════════
   config.js
   Parámetros, catálogos de valores fijos y rutas de abastecimiento.
   No hay build tools: este archivo se importa con <script type="module">.

   Regla: todo valor que también viva en un CHECK de la base debe
   coincidir exactamente con él. Si aquí se agrega una marca o una ruta
   que la base no acepta, el formulario deja elegirla y el guardado
   falla con un error críptico.
   ═══════════════════════════════════════════════════════ */

/* ── Roles ──────────────────────────────────────────── */
// Roles de Fleet Supply (independientes de usuarios.rol, ver fs_usuarios_rol)
export const ROLES_FS = {
  JEFE_COMERCIAL: 'jefe_comercial',
  ALMACENISTA: 'almacenista',
  COMERCIO_EXTERIOR: 'comercio_exterior',
  FINANCIERA: 'financiera',
  GERENCIA: 'gerencia',
  SOLO_LECTURA: 'solo_lectura',
  ADMIN: 'admin',
};

// admin va en TODAS las listas de permisos. Si se agrega una lista
// nueva, hay que incluirlo ahí también.
export const ROLES_EDITAN_CATALOGO = [ROLES_FS.JEFE_COMERCIAL, ROLES_FS.ADMIN];
export const ROLES_EDITAN_NEGOCIOS = [ROLES_FS.JEFE_COMERCIAL, ROLES_FS.ADMIN];

// Comercio Exterior ajusta los días de los hitos; el Jefe Comercial es
// dueño del módulo.
export const ROLES_EDITAN_CONFIG = [
  ROLES_FS.COMERCIO_EXTERIOR, ROLES_FS.JEFE_COMERCIAL, ROLES_FS.ADMIN,
];

// Los parámetros mueven plata (TRM, colchón, % de importación), así que
// Financiera también entra.
export const ROLES_EDITAN_PARAMETROS = [
  ...ROLES_EDITAN_CONFIG, ROLES_FS.FINANCIERA,
];

/* ── Catálogo de productos ──────────────────────────── */
export const LINEAS = {
  fleet: 'Fleet',
  carga: 'Carga',
  ambas: 'Ambas',
};

// Coincide con fs_productos_marca_check
export const MARCAS = {
  JimiIoT: 'JimiIoT',
  Geotab: 'Geotab',
  GlobalStar: 'GlobalStar',
  M2M: 'M2M Dataglobal',
  Otro: 'Otro',
};

// Coincide con fs_productos_control_inventario_check
export const CONTROL_INVENTARIO = {
  serie: 'Por serie / IMEI',
  cantidad: 'Por cantidad',
};

// Coincide con fs_productos_costo_moneda_check
export const MONEDAS_COSTO = {
  USD: 'Dólares (USD)',
  COP: 'Pesos (COP)',
};

/* ── Rutas de abastecimiento ────────────────────────── */
// Coincide con fs_productos_ruta_habitual_check y con fs_ruta.clave.
// La ruta E (Claro) se eliminó: las SIM solo se le compran a M2M.
export const RUTAS = {
  m2m_local: 'M2M Dataglobal — stock local',
  m2m_importacion: 'M2M Dataglobal — con importación',
  jimiiot_china: 'JimiIoT China — compra directa',
  geotab_canada: 'Geotab Canadá',
  globalstar_importacion: 'GlobalStar — importación',
};

// En ruta local el proveedor colombiano ya factura la mercancía
// nacionalizada, así que el % de costos de importación NO aplica:
// sumarlo sería contarlo dos veces.
export const RUTAS_IMPORTACION = [
  'm2m_importacion', 'jimiiot_china', 'geotab_canada', 'globalstar_importacion',
];

export function esRutaImportacion(clave) {
  return RUTAS_IMPORTACION.includes(String(clave || ''));
}

/* ── Negocios ───────────────────────────────────────── */
// Coincide con fs_negocio_naturaleza_check
export const NATURALEZAS = {
  forecast: 'Forecast',
  pipeline: 'Pipeline',
  cerrado: 'Cerrado',
};

// Coincide con fs_negocio_modalidad_check.
// 'mixto' es derivado: lo calcula un disparador a partir de las líneas,
// no se elige a mano en el encabezado.
export const MODALIDADES = {
  venta: 'Venta',
  comodato: 'Comodato',
  mixto: 'Mixto',
};

// Modalidades elegibles por línea (fs_negocio_linea_modalidad_check)
export const MODALIDADES_LINEA = {
  venta: 'Venta',
  comodato: 'Comodato',
};

export const PLAZOS_COMODATO = [12, 24, 36];

// Con Geotab no hay puntos medios: o compra, o comodato a 36 meses con
// mensualidad en cero, porque regalan el equipo al firmar a ese plazo.
// Lo valida el disparador fs_validar_linea_geotab; esta constante existe
// para avisarlo en el formulario antes de que la base rechace el guardado.
export const PLAZO_UNICO_GEOTAB = 36;

// Coincide con fs_negocio_estado_ejecucion_check
export const ESTADOS_EJECUCION = {
  sin_iniciar: 'Sin iniciar',
  en_abastecimiento: 'En abastecimiento',
  parcial: 'Parcial',
  completo: 'Completo',
  anulado: 'Anulado',
};

// La escala la decide el NÚMERO DE VEHÍCULOS del negocio, no las
// unidades de cada SKU: 8 vehículos con 2 cámaras cada uno siguen
// siendo escala ≤10.
export const UMBRAL_ESCALA_VOLUMEN = 10;

// Con esto en true, un combo ya usado en un negocio no se edita en
// sitio: obliga a crear una versión nueva. Se puso en true al activar
// los negocios, para que un negocio cerrado conserve el combo con el
// que se vendió.
export const NEGOCIOS_ACTIVOS = true;

/* ── Planeación ─────────────────────────────────────── */
export const MESES_FORECAST_DEFECTO = 6;
export const FACTOR_SEGURIDAD_STOCK = 1.4;
export const DIAS_CONSUMO_PROMEDIO = 90;

/* ── Parámetros (pantalla de Configuración) ─────────── */
// Se ocultan de la pantalla porque no son números: esa pantalla valida
// que el valor sea numérico y los rechazaría.
export const PARAMETROS_INTERNOS = ['mapeo_importador_catalogo'];

// Se muestran como interruptor, no como campo de texto.
export const PARAMETROS_BOOLEANOS = ['trm_automatica'];

/* ── General ────────────────────────────────────────── */
export const TIMEZONE = 'America/Bogota';
