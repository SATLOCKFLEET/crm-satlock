/* ═══════════════════════════════════════════════════════
   trm.js — TRM del día

   Fuente oficial: dataset de TRM de la Superfinanciera publicado en
   datos.gov.co (recurso 32sa-8pi3). Se consulta POR RANGO DE VIGENCIA,
   no por fecha exacta, porque la TRM del fin de semana y de los festivos
   viene como un solo registro que cubre varios días.

   Automática NO es viva: esto entrega la TRM de hoy para que quien cierre
   un negocio o apruebe una orden la CONGELE en ese registro. Volver a
   consultar mañana no debe cambiar lo ya guardado.

   Orden de resolución:
     1. Si fs_parametro.trm_automatica = false → la fijada a mano en
        trm_del_dia. Es una decisión explícita y manda.
     2. Consulta a datos.gov.co. Si el valor pasa el rango de
        plausibilidad, se guarda en fs_trm y se usa.
     3. Si la fuente falla, la última guardada en fs_trm (fs_trm_de),
        avisando de qué fecha es.
     4. Si tampoco hay, trm_del_dia como último recurso.
     5. Si nada sirve, valor 0 y aviso. Nunca inventa una cifra.

   El rango de plausibilidad existe para que un cambio de formato en la
   fuente (una coma por un punto, un campo renombrado) no entre como dato
   bueno y contamine los costos de todos los negocios.
   ═══════════════════════════════════════════════════════ */

import { sb } from './supabaseClient.js';
import { fechaHoyBogota } from './formato.js';

const RECURSO = 'https://www.datos.gov.co/resource/32sa-8pi3.json';
const MIN_PLAUSIBLE = 1000;
const MAX_PLAUSIBLE = 20000;
const DIAS_AVISO_ANTIGUEDAD = 3;

let _cache = null;          // { fecha, info }

/* ── parámetros ─────────────────────────────────────── */

async function leerParametros() {
  const { data, error } = await sb
    .from('fs_parametro')
    .select('clave,valor')
    .in('clave', ['trm_automatica', 'trm_del_dia']);

  if (error) return { automatica: true, manual: 0 };

  const mapa = Object.fromEntries((data || []).map((r) => [r.clave, r.valor]));
  const crudo = String(mapa.trm_automatica ?? 'true').trim().toLowerCase();

  return {
    automatica: !(crudo === 'false' || crudo === 'no' || crudo === '0'),
    manual: Number(mapa.trm_del_dia || 0) || 0,
  };
}

function plausible(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= MIN_PLAUSIBLE && n <= MAX_PLAUSIBLE;
}

/* ── fuente oficial ─────────────────────────────────── */

async function consultarOficial(fecha) {
  const marca = `${fecha}T00:00:00.000`;
  const where = `vigenciadesde <= '${marca}' AND vigenciahasta >= '${marca}'`;
  const url = `${RECURSO}?$where=${encodeURIComponent(where)}`
            + `&$order=${encodeURIComponent('vigenciadesde DESC')}&$limit=1`;

  const ctrl = new AbortController();
  const corte = setTimeout(() => ctrl.abort(), 8000);

  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;

    const filas = await res.json();
    if (!Array.isArray(filas) || filas.length === 0) return null;

    const f = filas[0];
    const valor = Number(String(f.valor ?? '').replace(',', '.'));
    if (!plausible(valor)) return null;

    return {
      valor,
      desde: String(f.vigenciadesde || '').slice(0, 10),
      hasta: String(f.vigenciahasta || '').slice(0, 10),
    };
  } catch (_) {
    return null;                       // sin red, CORS, timeout o JSON raro
  } finally {
    clearTimeout(corte);
  }
}

/* ── última guardada ────────────────────────────────── */

async function ultimaGuardada(fecha) {
  const { data, error } = await sb.rpc('fs_trm_de', { p_fecha: fecha });
  if (error) return null;

  const fila = Array.isArray(data) ? data[0] : data;
  if (!fila || !plausible(fila.valor)) return null;

  return {
    valor: Number(fila.valor),
    desde: fila.vigencia_desde,
    hasta: fila.vigencia_hasta,
    exacta: fila.exacta === true,
    diasAntiguedad: Number(fila.dias_antiguedad || 0),
    origenGuardado: fila.origen || null,
  };
}

/* ── API ────────────────────────────────────────────── */

/**
 * Devuelve la TRM a usar hoy.
 * @param {{refrescar?: boolean}} opciones
 * @returns {Promise<{valor:number, origen:string, aviso:string|null,
 *                    vigenciaDesde:string|null, vigenciaHasta:string|null,
 *                    diasAntiguedad:number, exacta:boolean}>}
 *
 * origen: 'manual' | 'oficial' | 'guardada' | 'manual_respaldo' | 'ninguna'
 */
export async function obtenerTRM({ refrescar = false } = {}) {
  const hoy = fechaHoyBogota();
  if (!refrescar && _cache && _cache.fecha === hoy) return _cache.info;

  const base = {
    valor: 0, origen: 'ninguna', aviso: null,
    vigenciaDesde: null, vigenciaHasta: null,
    diasAntiguedad: 0, exacta: false,
  };

  const { automatica, manual } = await leerParametros();

  // 1. Fijada a mano
  if (!automatica) {
    const info = plausible(manual)
      ? { ...base, valor: manual, origen: 'manual', exacta: true,
          vigenciaDesde: hoy, vigenciaHasta: hoy }
      : { ...base, origen: 'ninguna',
          aviso: 'La TRM está en modo manual pero el valor fijado no es válido. '
               + 'Corríjalo en Configuración → Parámetros (trm_del_dia).' };
    _cache = { fecha: hoy, info };
    return info;
  }

  // 2. Fuente oficial
  const oficial = await consultarOficial(hoy);
  if (oficial) {
    let aviso = null;
    try {
      const { error } = await sb.rpc('fs_guardar_trm', {
        p_desde: oficial.desde,
        p_hasta: oficial.hasta,
        p_valor: oficial.valor,
        p_origen: 'datos.gov.co',
      });
      if (error) aviso = 'La TRM se consultó bien pero no se pudo guardar en la base.';
    } catch (_) {
      aviso = 'La TRM se consultó bien pero no se pudo guardar en la base.';
    }

    const info = {
      ...base, valor: oficial.valor, origen: 'oficial', exacta: true,
      vigenciaDesde: oficial.desde, vigenciaHasta: oficial.hasta, aviso,
    };
    _cache = { fecha: hoy, info };
    return info;
  }

  // 3. Última guardada
  const guardada = await ultimaGuardada(hoy);
  if (guardada) {
    const viejo = guardada.diasAntiguedad > DIAS_AVISO_ANTIGUEDAD;
    const info = {
      ...base,
      valor: guardada.valor,
      origen: 'guardada',
      exacta: guardada.exacta,
      vigenciaDesde: guardada.desde,
      vigenciaHasta: guardada.hasta,
      diasAntiguedad: guardada.diasAntiguedad,
      aviso: 'No se pudo consultar la TRM oficial; se está usando la última guardada'
           + (guardada.desde ? ` (${guardada.desde})` : '')
           + (viejo ? `, de hace ${guardada.diasAntiguedad} días. Verifíquela antes de cerrar.` : '.'),
    };
    _cache = { fecha: hoy, info };
    return info;
  }

  // 4. Manual como respaldo
  if (plausible(manual)) {
    const info = {
      ...base, valor: manual, origen: 'manual_respaldo', exacta: false,
      aviso: 'No se pudo consultar la TRM oficial ni hay ninguna guardada; '
           + 'se está usando el valor fijado a mano. Verifíquelo antes de cerrar.',
    };
    _cache = { fecha: hoy, info };
    return info;
  }

  // 5. Sin TRM
  const info = {
    ...base,
    aviso: 'No hay TRM disponible. Los costos en dólares quedarán en cero '
         + 'hasta que se resuelva. Fije una en Configuración → Parámetros.',
  };
  _cache = { fecha: hoy, info };
  return info;
}

/**
 * Texto corto que explica de dónde salió la TRM. Se muestra siempre,
 * al lado del valor: una TRM sin procedencia visible es la forma más
 * fácil de costear mal un negocio sin que nadie se entere.
 */
export function etiquetaOrigenTRM(info) {
  if (!info || !Number(info.valor)) return 'TRM no disponible';

  const valor = Number(info.valor).toLocaleString('es-CO', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });

  switch (info.origen) {
    case 'manual':
      return `TRM $${valor} · fijada a mano`;
    case 'oficial':
      return `TRM $${valor} · oficial${info.vigenciaDesde ? ` del ${info.vigenciaDesde}` : ''}`;
    case 'guardada':
      return `TRM $${valor} · última guardada${info.vigenciaDesde ? ` del ${info.vigenciaDesde}` : ''}`;
    case 'manual_respaldo':
      return `TRM $${valor} · fijada a mano (la oficial no respondió)`;
    default:
      return `TRM $${valor}`;
  }
}

/** Limpia la caché del día. Úselo detrás de un botón "Actualizar TRM". */
export function limpiarCacheTRM() {
  _cache = null;
}
