/* ═══════════════════════════════════════════════════════
   importador.js
   Carga del catálogo de SKU y precios desde Excel o CSV.

   Reglas que manda el negocio:
   - NUNCA falla la carga completa por un dato faltante. Las celdas
     vacías o con "por confirmar", "pendiente", "N/A" entran como
     nulas y el SKU queda marcado como incompleto.
   - Solo son errores de verdad los que impiden crear la fila: código
     repetido dentro del archivo, o falta de código o descripción.
   - Es idempotente: se identifica por el código del SKU. Volver a
     subir el mismo archivo no duplica nada.
   - Al actualizar, un dato del archivo NUNCA borra un dato que ya
     existía en el sistema: si la celda viene vacía se conserva lo que
     hay. Así una carga no pisa las correcciones hechas a mano.
   - Los precios llevan vigencia: si el valor cambió se cierra el
     anterior y se abre uno nuevo desde hoy. Si no cambió, no se toca.
     Un negocio ya cerrado nunca cambia de precio por una carga nueva.
   ═══════════════════════════════════════════════════════ */

import { sb } from './supabaseClient.js';
import { tieneRol, perfilActual } from './auth.js';
import { mostrarToast, escapeHtml, estadoCargando } from './ui.js';
import { formatoCOP, fechaHoyBogota } from './formato.js';
import { registrarAuditoria } from './auditoria.js';
import { ROLES_EDITAN_CATALOGO } from './config.js';

const CDN_SHEETJS = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
const CLAVE_MAPEO = 'mapeo_importador_catalogo';

/* ───────── Textos que significan "todavía no sé" ───────── */
const TEXTOS_VACIOS = new Set([
  '', '-', '--', 'n/a', 'na', 'n.a.', 'nd', 'n.d.', 'null', 'none',
  'por confirmar', 'porconfirmar', 'pendiente', 'por definir', 'pordefinir',
  'sin definir', 'sindefinir', 'tbd', 'por asignar', 'no aplica', 'noaplica',
]);

/* ───────── Campos del sistema y sus posibles encabezados ───────── */
const CAMPOS = {
  sku:                    ['sku', 'skunuevo', 'codigo', 'codigosku', 'referencia'],
  nombre:                 ['nombre', 'descripcion', 'descitem', 'desc', 'producto'],
  categoria:              ['categoria', 'tipo', 'tipoproducto'],
  linea:                  ['linea', 'lineanegocio'],
  marca:                  ['marca'],
  control_inventario:     ['controlinventario', 'serializable', 'control', 'manejaserie'],
  costo_usd:              ['costousd', 'costo', 'costoproveedor'],
  costo_moneda:           ['costomoneda', 'moneda', 'monedacosto'],
  ruta_habitual:          ['rutahabitual', 'ruta', 'rutaplaneacion'],
  aplica_comodato:        ['aplicacomodato', 'comodato'],
  requiere_sim:           ['requieresim', 'necesitasim', 'sim'],
  stock_minimo:           ['stockminimo', 'minimo', 'stockmin'],
  notas:                  ['notas', 'observaciones', 'nota'],
  item_legado:            ['item', 'itemlegado', 'consecutivo'],
  tipo_inventario_legado: ['tipoinventario', 'tipoinventariolegado'],
  tipo_item_legado:       ['tipoitem', 'tipoitemlegado'],
  precio_venta_hasta_10:  ['precioventahasta10', 'precioventa10', 'venta10', 'valorventahasta10', 'preciovenerta10'],
  precio_venta_11_mas:    ['precioventa11mas', 'precioventa11', 'venta11', 'valorventa11mas'],
  comodato_12_hasta_10:   ['comodato12hasta10', 'comodato1210', 'comodato12'],
  comodato_12_11_mas:     ['comodato1211mas', 'comodato1211'],
  comodato_24_hasta_10:   ['comodato24hasta10', 'comodato2410', 'comodato24'],
  comodato_24_11_mas:     ['comodato2411mas', 'comodato2411'],
  comodato_36_hasta_10:   ['comodato36hasta10', 'comodato3610', 'comodato36'],
  comodato_36_11_mas:     ['comodato3611mas', 'comodato3611'],
};

const OBLIGATORIOS = ['sku', 'nombre'];

// Campos cuya ausencia deja el SKU marcado como incompleto
const DESEABLES = [
  'categoria', 'marca', 'control_inventario', 'costo_usd',
  'precio_venta_hasta_10', 'precio_venta_11_mas',
];

const VALORES = {
  linea: { fleet: 'fleet', carga: 'carga', ambas: 'ambas', ambos: 'ambas' },
  marca: {
    jimiiot: 'JimiIoT', jimi: 'JimiIoT', geotab: 'Geotab',
    globalstar: 'GlobalStar', m2m: 'M2M', claro: 'M2M', otro: 'Otro', otra: 'Otro',
  },
  categoria: {
    equipo: 'equipo', gps: 'equipo', camara: 'camara', sim: 'sim',
    simcard: 'sim', accesorio: 'accesorio', licencia: 'licencia', servicio: 'servicio',
  },
  control_inventario: {
    serie: 'serie', serial: 'serie', imei: 'serie', si: 'serie', sí: 'serie',
    cantidad: 'cantidad', no: 'cantidad', granel: 'cantidad',
  },
  ruta_habitual: {
    m2mlocal: 'm2m_local', m2mimportacion: 'm2m_importacion',
    jimiiotchina: 'jimiiot_china', china: 'jimiiot_china',
    geotabcanada: 'geotab_canada', canada: 'geotab_canada',
    globalstarimportacion: 'globalstar_importacion', globalstar: 'globalstar_importacion',
  },
  costo_moneda: { usd: 'USD', dolar: 'USD', cop: 'COP', peso: 'COP', pesos: 'COP' },
};

/* ───────────────────── Utilidades ───────────────────── */

function normalizar(txt) {
  if (txt == null) return '';
  return String(txt)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function esVacio(valor) {
  if (valor == null) return true;
  const t = String(valor).trim().toLowerCase();
  return TEXTOS_VACIOS.has(t) || TEXTOS_VACIOS.has(normalizar(t));
}

/*
  Convierte a número tolerando cómo escribe la gente el dinero.
  Maneja '$1,848,875', '1.848.875', '68,47' y '68.47'.
  Regla: si hay punto y coma, el último de los dos es el decimal. Si
  hay uno solo y lo siguen exactamente 3 dígitos, es separador de
  miles; si no, es decimal.
*/
export function aNumero(valor) {
  if (esVacio(valor)) return null;
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;

  let t = String(valor).trim().replace(/[^\d.,-]/g, '');
  if (t === '' || t === '-') return null;

  const iPunto = t.lastIndexOf('.');
  const iComa = t.lastIndexOf(',');

  if (iPunto !== -1 && iComa !== -1) {
    const decimal = iPunto > iComa ? '.' : ',';
    const miles = decimal === '.' ? ',' : '.';
    t = t.split(miles).join('').replace(decimal, '.');
  } else if (iPunto !== -1 || iComa !== -1) {
    const sep = iPunto !== -1 ? '.' : ',';
    const partes = t.split(sep);
    const ultima = partes[partes.length - 1];
    if (partes.length > 2 || ultima.length === 3) {
      t = partes.join('');           // separador de miles
    } else {
      t = partes.slice(0, -1).join('') + '.' + ultima;  // decimal
    }
  }

  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/*
  Devuelve null —no false— cuando la celda viene vacía. Si devolviera
  false, una celda en blanco apagaría un "aplica comodato" que alguien
  ya había activado a mano, y eso rompe la regla de que el archivo
  nunca borra lo que ya existe.
*/
function aBooleano(valor) {
  if (esVacio(valor)) return null;
  const t = normalizar(valor);
  if (['si', 'true', '1', 'x', 'verdadero', 'v', 'yes'].includes(t)) return true;
  if (['no', 'false', '0', 'falso', 'f'].includes(t)) return false;
  return null;
}

function aValorPermitido(campo, valor) {
  if (esVacio(valor)) return null;
  const tabla = VALORES[campo];
  if (!tabla) return String(valor).trim();
  return tabla[normalizar(valor)] ?? null;
}

/* ───────────────────── Carga de SheetJS ───────────────────── */

let cargandoSheet = null;
function cargarSheetJS() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (cargandoSheet) return cargandoSheet;
  cargandoSheet = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = CDN_SHEETJS;
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error('No se pudo cargar la librería de Excel.'));
    document.head.appendChild(s);
  });
  return cargandoSheet;
}

/* ───────────────────── Mapeo de columnas ───────────────────── */

async function leerMapeoGuardado() {
  const { data } = await sb.from('fs_parametro').select('valor').eq('clave', CLAVE_MAPEO).maybeSingle();
  try {
    return JSON.parse(data?.valor || '{}');
  } catch {
    return {};
  }
}

async function guardarMapeo(mapeo) {
  const { error } = await sb.from('fs_parametro')
    .update({ valor: JSON.stringify(mapeo) })
    .eq('clave', CLAVE_MAPEO);
  if (error) console.error('No se pudo recordar el mapeo:', error);
}

/*
  Empareja los encabezados del archivo con los campos del sistema.
  Primero por el mapeo recordado, después por los sinónimos conocidos.
*/
function emparejar(encabezados, mapeoGuardado) {
  const mapa = {};       // campo del sistema -> encabezado del archivo
  const usados = new Set();

  for (const [campo, encabezado] of Object.entries(mapeoGuardado || {})) {
    if (encabezados.includes(encabezado)) {
      mapa[campo] = encabezado;
      usados.add(encabezado);
    }
  }

  for (const [campo, sinonimos] of Object.entries(CAMPOS)) {
    if (mapa[campo]) continue;
    const hallado = encabezados.find(
      (h) => !usados.has(h) && sinonimos.includes(normalizar(h))
    );
    if (hallado) {
      mapa[campo] = hallado;
      usados.add(hallado);
    }
  }
  return mapa;
}

/* ───────────────────── Lectura del archivo ───────────────────── */

async function leerArchivo(file) {
  const XLSX = await cargarSheetJS();
  const buffer = await file.arrayBuffer();
  const libro = XLSX.read(buffer, { type: 'array', cellDates: false });
  const hoja = libro.Sheets[libro.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(hoja, { defval: '', raw: false });
  return { filas, hojas: libro.SheetNames };
}

/* ───────────────────── Análisis previo ───────────────────── */

export function analizarFilas(filas, mapa) {
  const val = (fila, campo) => {
    const col = mapa[campo];
    return col === undefined ? '' : fila[col];
  };

  const vistos = new Map();
  const listos = [];
  const errores = [];

  filas.forEach((fila, idx) => {
    const nFila = idx + 2; // +2: encabezado y base 1, como lo ve Excel
    const sku = esVacio(val(fila, 'sku')) ? null : String(val(fila, 'sku')).trim();
    const nombre = esVacio(val(fila, 'nombre')) ? null : String(val(fila, 'nombre')).trim();

    if (!sku && !nombre) return; // fila en blanco, se ignora sin ruido

    const faltanObligatorios = OBLIGATORIOS.filter((c) => (c === 'sku' ? !sku : !nombre));
    if (faltanObligatorios.length) {
      errores.push({ fila: nFila, sku: sku || '(sin código)',
        motivo: `Falta ${faltanObligatorios.join(' y ')}. Sin eso no se puede crear el producto.` });
      return;
    }

    // La comparación ignora mayúsculas y espacios: "jc450" y "JC450"
    // son el mismo producto para cualquiera que mire el archivo, y si
    // se dejaran pasar quedarían como dos SKU distintos en la base.
    const claveSku = sku.toUpperCase().replace(/\s+/g, '');
    if (vistos.has(claveSku)) {
      errores.push({ fila: nFila, sku,
        motivo: `Código repetido en el archivo (ya venía en la fila ${vistos.get(claveSku)}).` });
      return;
    }
    vistos.set(claveSku, nFila);

    const producto = {
      sku,
      nombre,
      categoria: aValorPermitido('categoria', val(fila, 'categoria')),
      linea: aValorPermitido('linea', val(fila, 'linea')),
      marca: aValorPermitido('marca', val(fila, 'marca')),
      control_inventario: aValorPermitido('control_inventario', val(fila, 'control_inventario')),
      costo_usd: aNumero(val(fila, 'costo_usd')),
      costo_moneda: aValorPermitido('costo_moneda', val(fila, 'costo_moneda')),
      ruta_habitual: aValorPermitido('ruta_habitual', val(fila, 'ruta_habitual')),
      aplica_comodato: aBooleano(val(fila, 'aplica_comodato')),
      requiere_sim: aBooleano(val(fila, 'requiere_sim')),
      stock_minimo: aNumero(val(fila, 'stock_minimo')),
      notas: esVacio(val(fila, 'notas')) ? null : String(val(fila, 'notas')).trim(),
      item_legado: esVacio(val(fila, 'item_legado')) ? null : String(val(fila, 'item_legado')).trim(),
      tipo_inventario_legado: esVacio(val(fila, 'tipo_inventario_legado')) ? null : String(val(fila, 'tipo_inventario_legado')).trim(),
      tipo_item_legado: esVacio(val(fila, 'tipo_item_legado')) ? null : String(val(fila, 'tipo_item_legado')).trim(),
      precio_venta_hasta_10: aNumero(val(fila, 'precio_venta_hasta_10')),
      precio_venta_11_mas: aNumero(val(fila, 'precio_venta_11_mas')),
    };

    const comodatos = [
      { plazo: 12, escala: '1-10', valor: aNumero(val(fila, 'comodato_12_hasta_10')) },
      { plazo: 12, escala: '11+',  valor: aNumero(val(fila, 'comodato_12_11_mas')) },
      { plazo: 24, escala: '1-10', valor: aNumero(val(fila, 'comodato_24_hasta_10')) },
      { plazo: 24, escala: '11+',  valor: aNumero(val(fila, 'comodato_24_11_mas')) },
      { plazo: 36, escala: '1-10', valor: aNumero(val(fila, 'comodato_36_hasta_10')) },
      { plazo: 36, escala: '11+',  valor: aNumero(val(fila, 'comodato_36_11_mas')) },
    ].filter((c) => c.valor != null);

    // Regla Geotab: solo 36 meses y en cero. La base lo rechaza, así que
    // se avisa acá antes de intentar escribir.
    if (producto.marca === 'Geotab') {
      const malPlazo = comodatos.filter((c) => c.plazo !== 36);
      const malValor = comodatos.filter((c) => c.plazo === 36 && c.valor !== 0);
      if (malPlazo.length) {
        errores.push({ fila: nFila, sku,
          motivo: `Geotab solo admite comodato a 36 meses, y este SKU trae valores a ${[...new Set(malPlazo.map((c) => c.plazo))].join(' y ')} meses. Déjalos vacíos.` });
        return;
      }
      if (malValor.length) {
        errores.push({ fila: nFila, sku,
          motivo: 'Geotab no cobra mensualidad de comodato: el valor a 36 meses debe ser 0.' });
        return;
      }
    }

    const faltantes = DESEABLES.filter((c) => producto[c] == null);
    listos.push({ fila: nFila, producto, comodatos, faltantes });
  });

  return { listos, errores };
}

/* ───────────────────── Escritura ───────────────────── */

function trozos(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function traerExistentes(skus) {
  const mapa = new Map();
  for (const grupo of trozos(skus, 200)) {
    const { data, error } = await sb.from('fs_productos').select('*').in('sku', grupo);
    if (error) throw error;
    (data || []).forEach((p) => mapa.set(p.sku, p));
  }
  return mapa;
}

/*
  Columnas que viaja el upsert, en un orden fijo.
  Tiene que ser una lista explícita y siempre la misma: PostgREST
  exige que todos los objetos del lote traigan las mismas llaves
  ("All object keys must match"), así que no se puede armar cada fila
  con solo los campos que tengan dato.
*/
const COLUMNAS = [
  'sku', 'nombre', 'categoria', 'linea', 'marca', 'control_inventario',
  'costo_usd', 'costo_moneda', 'ruta_habitual', 'aplica_comodato',
  'requiere_sim', 'stock_minimo', 'notas',
  'item_legado', 'tipo_inventario_legado', 'tipo_item_legado',
  'activo', 'creado_por', 'incompleto', 'faltantes',
];

// Valores por defecto de las columnas NOT NULL, para un SKU nuevo que
// llegue sin ese dato. Si la columna ya tiene valor en la base, gana
// el valor de la base.
const POR_DEFECTO = {
  linea: 'fleet', costo_moneda: 'USD',
  aplica_comodato: false, requiere_sim: false, activo: true,
};

export async function ejecutarCarga(listos, alAvanzar = () => {}) {
  const hoy = fechaHoyBogota();
  const usuarioId = perfilActual()?.id ?? null;

  alAvanzar('Revisando qué ya existe...');
  const existentes = await traerExistentes(listos.map((l) => l.producto.sku));

  // Se arma la fila final combinando lo que hay con lo que trae el
  // archivo. Un vacío del archivo NO borra lo que ya estaba.
  const paraGuardar = [];
  let nuevos = 0;
  let actualizados = 0;

  for (const l of listos) {
    const previo = existentes.get(l.producto.sku);
    const combinado = { ...(previo || {}) };
    for (const [k, v] of Object.entries(l.producto)) {
      if (v != null) combinado[k] = v;
    }
    if (!previo) {
      combinado.creado_por = usuarioId;
      nuevos++;
    } else {
      actualizados++;
    }
    for (const [k, v] of Object.entries(POR_DEFECTO)) {
      if (combinado[k] == null) combinado[k] = v;
    }
    // El incompleto se evalúa sobre el resultado combinado, no sobre el archivo
    const faltanAhora = DESEABLES.filter((c) => combinado[c] == null);
    combinado.incompleto = faltanAhora.length > 0;
    combinado.faltantes = faltanAhora.length ? faltanAhora.join(', ') : null;

    const fila = {};
    for (const c of COLUMNAS) fila[c] = combinado[c] ?? null;
    paraGuardar.push(fila);
  }

  alAvanzar(`Guardando ${paraGuardar.length} productos...`);
  for (const grupo of trozos(paraGuardar, 100)) {
    const { error } = await sb.from('fs_productos').upsert(grupo, { onConflict: 'sku' });
    if (error) throw error;
  }

  // Se releen para tener los id de los nuevos
  alAvanzar('Actualizando precios...');
  const porSku = await traerExistentes(listos.map((l) => l.producto.sku));

  const resultado = await actualizarPrecios(listos, porSku, hoy);

  await registrarAuditoria('fs_productos', { clave: 'importacion_catalogo' }, {
    importacion: [null, `${nuevos} nuevos, ${actualizados} actualizados, ` +
      `${resultado.preciosNuevos} precios de venta y ${resultado.comodatosNuevos} de comodato con vigencia ${hoy}`],
  }).catch(() => {});

  return { nuevos, actualizados, ...resultado };
}

/*
  Precios con vigencia. Solo se abre una versión nueva si el valor
  cambió: si es igual, no se toca nada. Si cambió, se cierra la
  anterior con vigente_hasta = hoy y se inserta la nueva desde hoy.
*/
async function actualizarPrecios(listos, porSku, hoy) {
  const ids = listos.map((l) => porSku.get(l.producto.sku)?.id).filter(Boolean);

  const abiertosVenta = new Map();   // `${id}|${escala}` -> fila
  const abiertosComod = new Map();   // `${id}|${escala}|${plazo}` -> fila

  for (const grupo of trozos(ids, 150)) {
    const { data: pv } = await sb.from('fs_precio_lista')
      .select('id,producto_id,escala,precio_venta_cop')
      .in('producto_id', grupo).is('vigente_hasta', null);
    (pv || []).forEach((r) => abiertosVenta.set(`${r.producto_id}|${r.escala}`, r));

    const { data: pc } = await sb.from('fs_precio_comodato')
      .select('id,producto_id,escala,plazo_meses,mensualidad_comodato_cop')
      .in('producto_id', grupo).is('vigente_hasta', null);
    (pc || []).forEach((r) => abiertosComod.set(`${r.producto_id}|${r.escala}|${r.plazo_meses}`, r));
  }

  const cerrarVenta = [];
  const insertarVenta = [];
  const cerrarComod = [];
  const insertarComod = [];
  let sinCambio = 0;

  for (const l of listos) {
    const prod = porSku.get(l.producto.sku);
    if (!prod) continue;

    const ventas = [
      { escala: '1-10', valor: l.producto.precio_venta_hasta_10 },
      { escala: '11+',  valor: l.producto.precio_venta_11_mas },
    ];
    for (const v of ventas) {
      if (v.valor == null) continue;
      const abierto = abiertosVenta.get(`${prod.id}|${v.escala}`);
      if (abierto && Number(abierto.precio_venta_cop) === Number(v.valor)) { sinCambio++; continue; }
      if (abierto) cerrarVenta.push(abierto.id);
      insertarVenta.push({
        producto_id: prod.id, escala: v.escala,
        precio_venta_cop: v.valor, vigente_desde: hoy,
      });
    }

    for (const c of l.comodatos) {
      const abierto = abiertosComod.get(`${prod.id}|${c.escala}|${c.plazo}`);
      if (abierto && Number(abierto.mensualidad_comodato_cop) === Number(c.valor)) { sinCambio++; continue; }
      if (abierto) cerrarComod.push(abierto.id);
      insertarComod.push({
        producto_id: prod.id, escala: c.escala, plazo_meses: c.plazo,
        mensualidad_comodato_cop: c.valor, vigente_desde: hoy,
      });
    }
  }

  for (const grupo of trozos(cerrarVenta, 200)) {
    const { error } = await sb.from('fs_precio_lista').update({ vigente_hasta: hoy }).in('id', grupo);
    if (error) throw error;
  }
  for (const grupo of trozos(cerrarComod, 200)) {
    const { error } = await sb.from('fs_precio_comodato').update({ vigente_hasta: hoy }).in('id', grupo);
    if (error) throw error;
  }
  for (const grupo of trozos(insertarVenta, 200)) {
    const { error } = await sb.from('fs_precio_lista').insert(grupo);
    if (error) throw error;
  }
  for (const grupo of trozos(insertarComod, 200)) {
    const { error } = await sb.from('fs_precio_comodato').insert(grupo);
    if (error) throw error;
  }

  return {
    preciosNuevos: insertarVenta.length,
    comodatosNuevos: insertarComod.length,
    preciosSinCambio: sinCambio,
    preciosCerrados: cerrarVenta.length + cerrarComod.length,
  };
}

/* ───────────────────── Plantilla ───────────────────── */

async function descargarPlantilla() {
  const XLSX = await cargarSheetJS();
  const encabezados = [
    'sku', 'nombre', 'categoria', 'linea', 'marca', 'control_inventario',
    'costo_usd', 'costo_moneda', 'ruta_habitual', 'aplica_comodato',
    'requiere_sim', 'stock_minimo', 'notas',
    'precio_venta_hasta_10', 'precio_venta_11_mas',
    'comodato_12_hasta_10', 'comodato_12_11_mas',
    'comodato_24_hasta_10', 'comodato_24_11_mas',
    'comodato_36_hasta_10', 'comodato_36_11_mas',
  ];
  const ejemplo = {
    sku: 'JC450', nombre: 'Cámara GPS JimiIoT JC450', categoria: 'camara',
    linea: 'fleet', marca: 'JimiIoT', control_inventario: 'serie',
    costo_usd: 150, costo_moneda: 'USD', ruta_habitual: 'jimiiot_china',
    aplica_comodato: 'si', requiere_sim: 'si', stock_minimo: 10,
    notas: 'Todos los valores van antes de IVA',
    precio_venta_hasta_10: 1848875, precio_venta_11_mas: 1607717,
    comodato_12_hasta_10: 171423, comodato_12_11_mas: 149063,
    comodato_24_hasta_10: 94333, comodato_24_11_mas: 82029,
    comodato_36_hasta_10: 68468, comodato_36_11_mas: 59537,
  };
  const hoja = XLSX.utils.json_to_sheet([ejemplo], { header: encabezados });
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hoja, 'Catalogo');
  XLSX.writeFile(libro, 'plantilla_catalogo_fleet_supply.xlsx');
}

/* ───────────────────── Pantalla ───────────────────── */

export async function renderImportador(container) {
  if (!tieneRol(...ROLES_EDITAN_CATALOGO)) {
    container.innerHTML = '<div class="fs-empty">No tienes permiso para importar el catálogo.</div>';
    return;
  }

  container.innerHTML = `
    <div class="fs-ayuda-modo">
      Carga el catálogo desde Excel o CSV. <strong>Ninguna celda vacía tumba la carga:</strong>
      lo que venga sin dato —o diga "por confirmar", "pendiente", "N/A"— entra como vacío y el SKU
      queda marcado para completar. Se identifica por el código del SKU, así que puedes volver a
      subir el mismo archivo sin duplicar nada. Y una celda vacía nunca borra un dato que ya exista
      en el sistema. Todos los valores van antes de IVA.
    </div>

    <div class="fs-toolbar">
      <input type="file" id="imp-archivo" accept=".xlsx,.xls,.csv" class="fs-input" style="max-width:340px">
      <button id="imp-plantilla" class="fs-btn-secundario">Descargar plantilla</button>
      <button id="imp-incompletos" class="fs-btn-secundario">SKUs por completar</button>
    </div>

    <div id="imp-cuerpo"></div>
  `;

  const cuerpo = container.querySelector('#imp-cuerpo');

  container.querySelector('#imp-plantilla').addEventListener('click', async () => {
    try {
      await descargarPlantilla();
    } catch (e) {
      console.error(e);
      mostrarToast('No se pudo generar la plantilla.', 'error');
    }
  });

  container.querySelector('#imp-incompletos').addEventListener('click', () => listarIncompletos(cuerpo));

  container.querySelector('#imp-archivo').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    estadoCargando(cuerpo, 'Leyendo el archivo...');
    try {
      const { filas } = await leerArchivo(file);
      if (!filas.length) {
        cuerpo.innerHTML = '<div class="fs-empty">El archivo no tiene filas de datos.</div>';
        return;
      }
      const encabezados = Object.keys(filas[0]);
      const mapeoGuardado = await leerMapeoGuardado();
      const mapa = emparejar(encabezados, mapeoGuardado);
      pintarMapeo(cuerpo, { filas, encabezados, mapa });
    } catch (err) {
      console.error(err);
      cuerpo.innerHTML = `<div class="fs-empty">No se pudo leer el archivo: ${escapeHtml(err.message)}</div>`;
    }
  });
}

function pintarMapeo(cuerpo, ctx) {
  const { encabezados, mapa } = ctx;
  const sinMapear = Object.keys(CAMPOS).filter((c) => !mapa[c]);

  cuerpo.innerHTML = `
    <h3 class="fs-h3">1. Columnas detectadas</h3>
    <div class="fs-ayuda-modo">
      Se emparejaron ${Object.keys(mapa).length} de ${Object.keys(CAMPOS).length} campos.
      Corrige lo que haga falta: el mapeo se recuerda para la próxima vez.
      ${sinMapear.length ? `<br>Sin encontrar: <strong>${sinMapear.join(', ')}</strong>.
        Si tu archivo no los trae, déjalos en "(ninguna)".` : ''}
    </div>
    <table class="fs-tabla">
      <thead><tr><th style="width:260px">Campo del sistema</th><th>Columna del archivo</th></tr></thead>
      <tbody>
        ${Object.keys(CAMPOS).map((campo) => `
          <tr>
            <td><code>${campo}</code>${OBLIGATORIOS.includes(campo) ? ' <strong>*</strong>' : ''}</td>
            <td>
              <select data-campo="${campo}" class="imp-sel">
                <option value="">(ninguna)</option>
                ${encabezados.map((h) => `<option value="${escapeHtml(h)}" ${mapa[campo] === h ? 'selected' : ''}>${escapeHtml(h)}</option>`).join('')}
              </select>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>
    <div class="fs-modal-actions">
      <button id="imp-analizar" class="fs-btn-primary">Analizar archivo</button>
    </div>
  `;

  cuerpo.querySelector('#imp-analizar').addEventListener('click', async () => {
    const nuevoMapa = {};
    cuerpo.querySelectorAll('.imp-sel').forEach((sel) => {
      if (sel.value) nuevoMapa[sel.dataset.campo] = sel.value;
    });
    if (!nuevoMapa.sku || !nuevoMapa.nombre) {
      mostrarToast('Hay que mapear al menos el código (sku) y el nombre.', 'aviso');
      return;
    }
    await guardarMapeo(nuevoMapa);
    pintarVistaPrevia(cuerpo, { ...ctx, mapa: nuevoMapa });
  });
}

async function pintarVistaPrevia(cuerpo, ctx) {
  estadoCargando(cuerpo, 'Analizando...');
  const { listos, errores } = analizarFilas(ctx.filas, ctx.mapa);

  const skus = listos.map((l) => l.producto.sku);
  const existentes = await traerExistentes(skus);
  const nuevos = skus.filter((s) => !existentes.has(s)).length;
  const actualiza = skus.length - nuevos;
  const incompletos = listos.filter((l) => l.faltantes.length).length;
  const conComodato = listos.filter((l) => l.comodatos.length).length;

  const muestra = listos.slice(0, 8);

  cuerpo.innerHTML = `
    <h3 class="fs-h3">2. Vista previa</h3>
    <div class="fs-resumen">
      <div class="fs-resumen-caja"><span>${nuevos}</span>SKU nuevos</div>
      <div class="fs-resumen-caja"><span>${actualiza}</span>se actualizan</div>
      <div class="fs-resumen-caja ${incompletos ? 'aviso' : ''}"><span>${incompletos}</span>con datos faltantes</div>
      <div class="fs-resumen-caja ${errores.length ? 'error' : ''}"><span>${errores.length}</span>con errores</div>
      <div class="fs-resumen-caja"><span>${conComodato}</span>traen comodato</div>
    </div>

    ${errores.length ? `
      <h4 class="fs-h4">Filas con errores — estas NO se van a cargar</h4>
      <table class="fs-tabla">
        <thead><tr><th style="width:70px">Fila</th><th style="width:160px">SKU</th><th>Motivo</th></tr></thead>
        <tbody>${errores.map((e) => `<tr><td>${e.fila}</td><td>${escapeHtml(e.sku)}</td><td>${escapeHtml(e.motivo)}</td></tr>`).join('')}</tbody>
      </table>` : ''}

    <h4 class="fs-h4">Cómo se están leyendo los primeros registros</h4>
    <div class="fs-nota-toolbar">Revisa que los valores estén bien interpretados antes de confirmar.</div>
    <table class="fs-tabla">
      <thead><tr>
        <th>SKU</th><th>Nombre</th><th>Marca</th><th>Categoría</th>
        <th>Venta ≤10</th><th>Comodato 24 ≤10</th><th>Faltantes</th>
      </tr></thead>
      <tbody>
        ${muestra.map((l) => {
          const c24 = l.comodatos.find((c) => c.plazo === 24 && c.escala === '1-10');
          return `<tr>
            <td>${escapeHtml(l.producto.sku)}</td>
            <td>${escapeHtml(l.producto.nombre)}</td>
            <td>${escapeHtml(l.producto.marca || '—')}</td>
            <td>${escapeHtml(l.producto.categoria || '—')}</td>
            <td>${l.producto.precio_venta_hasta_10 != null ? formatoCOP(l.producto.precio_venta_hasta_10) : '—'}</td>
            <td>${c24 ? formatoCOP(c24.valor) : '—'}</td>
            <td>${l.faltantes.length ? `<span class="fs-faltante">${l.faltantes.join(', ')}</span>` : '—'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>

    <div class="fs-modal-actions">
      <button id="imp-cancelar" class="fs-btn-secundario">Cancelar</button>
      <button id="imp-confirmar" class="fs-btn-primary" ${listos.length ? '' : 'disabled'}>
        Cargar ${listos.length} SKU
      </button>
    </div>
    <div id="imp-progreso" class="fs-nota-toolbar"></div>
  `;

  cuerpo.querySelector('#imp-cancelar').addEventListener('click', () => {
    cuerpo.innerHTML = '<div class="fs-empty">Carga cancelada. No se escribió nada.</div>';
  });

  cuerpo.querySelector('#imp-confirmar').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    const prog = cuerpo.querySelector('#imp-progreso');
    try {
      const res = await ejecutarCarga(listos, (msg) => { prog.textContent = msg; });
      cuerpo.innerHTML = `
        <h3 class="fs-h3">3. Listo</h3>
        <div class="fs-resumen">
          <div class="fs-resumen-caja"><span>${res.nuevos}</span>SKU creados</div>
          <div class="fs-resumen-caja"><span>${res.actualizados}</span>actualizados</div>
          <div class="fs-resumen-caja"><span>${res.preciosNuevos}</span>precios de venta nuevos</div>
          <div class="fs-resumen-caja"><span>${res.comodatosNuevos}</span>comodatos nuevos</div>
          <div class="fs-resumen-caja"><span>${res.preciosSinCambio}</span>precios sin cambio</div>
        </div>
        <div class="fs-ayuda-modo">
          ${res.preciosCerrados
            ? `Se cerró la vigencia de ${res.preciosCerrados} precio(s) anterior(es): el histórico queda intacto y
               los negocios ya cerrados conservan el precio con el que se vendieron.`
            : 'No había precios anteriores que cerrar.'}
        </div>`;
      mostrarToast('Catálogo cargado.', 'exito');
    } catch (err) {
      console.error(err);
      prog.textContent = '';
      btn.disabled = false;
      mostrarToast(`La carga falló: ${err.message || err}`, 'error');
    }
  });
}

async function listarIncompletos(cuerpo) {
  estadoCargando(cuerpo, 'Buscando SKUs por completar...');
  const { data, error } = await sb.from('fs_productos')
    .select('sku,nombre,faltantes')
    .eq('incompleto', true).eq('activo', true)
    .order('sku');
  if (error) {
    console.error(error);
    cuerpo.innerHTML = '<div class="fs-empty">No se pudo consultar.</div>';
    return;
  }
  if (!data?.length) {
    cuerpo.innerHTML = '<div class="fs-empty">No hay SKUs por completar. El catálogo está completo.</div>';
    return;
  }
  cuerpo.innerHTML = `
    <h3 class="fs-h3">SKUs por completar (${data.length})</h3>
    <div class="fs-nota-toolbar">Se cargaron con datos faltantes. Complétalos en la pestaña Catálogo o vuelve a subir el archivo con los datos.</div>
    <table class="fs-tabla">
      <thead><tr><th style="width:160px">SKU</th><th>Nombre</th><th>Qué le falta</th></tr></thead>
      <tbody>
        ${data.map((p) => `<tr>
          <td>${escapeHtml(p.sku)}</td>
          <td>${escapeHtml(p.nombre)}</td>
          <td><span class="fs-faltante">${escapeHtml(p.faltantes || '')}</span></td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}
