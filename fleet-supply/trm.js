/* ═══════════════════════════════════════════════════════
   trm.js — TRM oficial automática

   Fuente: dataset de la Superintendencia Financiera publicado en
   datos.gov.co. Es la MISMA TRM con la que se liquida en aduana, no
   una tasa de mercado, y por eso sirve para costear de verdad.

   Tres reglas que gobiernan este archivo:

   1. Automática NO es viva. Esto entrega el valor SUGERIDO al momento
      de costear. La TRM de un negocio cerrado y de una orden aprobada
      queda escrita en su registro y no se vuelve a leer de acá; si se
      refrescara sola, los márgenes de negocios ya cerrados se moverían
      cada mañana.

   2. Si la consulta falla, se costea con la última guardada Y SE DICE
      DE QUÉ FECHA ES. Nunca un número viejo disfrazado de número de
      hoy.

   3. Un valor fijado a mano en el parámetro trm_del_dia le gana a la
      automática, y la pantalla lo dice. Es la salida para cuando
      Financiera quiere costear con un supuesto distinto al oficial.
   ═══════════════════════════════════════════════════════ */

import { sb } from './supabaseClient.js';
import { fechaHoyBogota } from './formato.js';

// Dataset "Tasa de Cambio Representativa del Mercado (TRM)".
const FUENTE = 'https://www.datos.gov.co/resource/32sa-8pi3.json';

// Si la fuente no contesta en este tiempo, se sigue con lo guardado.
// Costear no puede quedarse esperando a que un servidor externo
// despierte.
const ESPERA_MAX_MS = 6000;

// El mismo rango que valida la base. Se comprueba también acá para no
// mandar basura a guardar y para que el mensaje salga antes.
const MINIMO = 1000;
const MAXIMO = 20000;

// Memoria de la pestaña: dentro de una misma sesión no tiene sentido
// volver a preguntar por la misma fecha.
const cache = new Map();

/* ─── Origen del dato, para que la pantalla pueda explicarse ───
   'oficial'   la trajimos de la fuente ahora mismo
   'guardada'  la fuente no respondió; es la última que teníamos
   'manual'    alguien la fijó a mano en los parámetros
   'ninguna'   no hay ni fuente ni respaldo: no se puede costear
*/

async function conTiempoLimite(promesa, ms) {
  let reloj;
  try {
    return await Promise.race([
      promesa,
      new Promise((_, rechazar) => {
        reloj = setTimeout(() => rechazar(new Error('tiempo agotado')), ms);
      }),
    ]);
  } finally {
    clearTimeout(reloj);
  }
}

/*
  Consulta la fuente para una fecha. El dataset publica rangos de
  vigencia (un registro de viernes a lunes cubre el fin de semana), así
  que se pregunta por el rango que contiene la fecha, no por la fecha
  exacta. Sin esto, un sábado no devolvería nada.
*/
async function consultarFuente(fecha) {
  const donde =
    `vigenciadesde <= '${fecha}T00:00:00' AND vigenciahasta >= '${fecha}T00:00:00'`;
  const url = `${FUENTE}?$where=${encodeURIComponent(donde)}&$limit=1`;

  const res = await conTiempoLimite(fetch(url, { headers: { Accept: 'application/json' } }), ESPERA_MAX_MS);
  if (!res.ok) throw new Error(`la fuente respondió ${res.status}`);

  const filas = await res.json();
  if (!Array.isArray(filas) || filas.length === 0) {
    throw new Error(`la fuente no tiene TRM publicada para ${fecha}`);
  }

  const f = filas[0];
  const valor = Number(f.valor);
  if (!Number.isFinite(valor) || valor < MINIMO || valor > MAXIMO) {
    // Esto es lo que atrapa un cambio de formato en la fuente: si
    // algún día "3126.08" llega como "3.126,08", el número entra como
    // 3,126 y envenenaría todo el costeo sin que nadie lo note.
    throw new Error(`la fuente devolvió un valor implausible (${f.valor})`);
  }

  return {
    valor,
    desde: String(f.vigenciadesde || '').slice(0, 10),
    hasta: String(f.vigenciahasta || '').slice(0, 10),
  };
}

async function leerGuardada(fecha) {
  const { data, error } = await sb.rpc('fs_trm_de', { p_fecha: fecha });
  if (error) throw error;
  const fila = Array.isArray(data) ? data[0] : data;
  return fila || null;
}

async function guardar({ valor, desde, hasta }) {
  const { error } = await sb.rpc('fs_guardar_trm', {
    p_desde: desde,
    p_hasta: hasta,
    p_valor: valor,
    p_origen: 'datos.gov.co',
  });
  // Que no se pueda guardar no debe tumbar el costeo: ya tenemos el
  // número bueno en la mano. Solo se pierde el respaldo para la
  // próxima vez.
  if (error) console.warn('No se pudo guardar la TRM consultada:', error.message);
}

async function leerParametros() {
  const { data } = await sb.from('fs_parametro').select('clave,valor')
    .in('clave', ['trm_del_dia', 'trm_automatica']);
  const m = new Map((data || []).map((r) => [r.clave, r.valor]));
  const manual = Number(m.get('trm_del_dia'));
  return {
    manual: Number.isFinite(manual) && manual > 0 ? manual : null,
    automatica: String(m.get('trm_automatica') ?? 'true').toLowerCase() !== 'false',
  };
}

/*
  La función que usa todo el módulo.

  Devuelve siempre un objeto, nunca lanza: costear tiene que poder
  seguir aunque no haya internet. Quien la llama decide qué hacer con
  origen === 'ninguna'.

    { valor, origen, desde, hasta, exacta, diasAntiguedad, aviso }
*/
export async function obtenerTRM(fecha = fechaHoyBogota(), { forzar = false } = {}) {
  if (!forzar && cache.has(fecha)) return cache.get(fecha);

  const { manual, automatica } = await leerParametros().catch(() => ({ manual: null, automatica: true }));

  // Un valor fijado a mano gana. Es explícito y alguien lo puso a
  // propósito.
  if (manual) {
    const r = {
      valor: manual, origen: 'manual', desde: null, hasta: null,
      exacta: true, diasAntiguedad: 0,
      aviso: 'TRM fijada a mano en Configuración, no es la oficial del día.',
    };
    cache.set(fecha, r);
    return r;
  }

  if (automatica) {
    try {
      const traida = await consultarFuente(fecha);
      await guardar(traida);
      const r = {
        valor: traida.valor, origen: 'oficial',
        desde: traida.desde, hasta: traida.hasta,
        exacta: true, diasAntiguedad: 0, aviso: null,
      };
      cache.set(fecha, r);
      return r;
    } catch (err) {
      console.warn('TRM oficial no disponible, se usa la última guardada:', err.message);
    }
  }

  // Respaldo: lo último que alcanzamos a guardar, diciendo su fecha.
  try {
    const g = await leerGuardada(fecha);
    if (g && Number(g.valor) > 0) {
      const dias = Number(g.dias_antiguedad) || 0;
      const r = {
        valor: Number(g.valor), origen: 'guardada',
        desde: g.vigencia_desde, hasta: g.vigencia_hasta,
        exacta: !!g.exacta, diasAntiguedad: dias,
        aviso: g.exacta
          ? `No se pudo consultar la fuente. Se usa la TRM guardada, vigente ${g.vigencia_desde}.`
          : `No se pudo consultar la fuente. Se usa la TRM del ${g.vigencia_hasta}, ${dias} día(s) más vieja que la fecha pedida.`,
      };
      cache.set(fecha, r);
      return r;
    }
  } catch (err) {
    console.warn('No se pudo leer la TRM guardada:', err.message);
  }

  return {
    valor: 0, origen: 'ninguna', desde: null, hasta: null,
    exacta: false, diasAntiguedad: null,
    aviso: 'No hay TRM: la fuente no responde y no hay ninguna guardada. No se puede costear.',
  };
}

/*
  Para la liquidación real: la TRM de la fecha de la declaración, que
  es la que la ley manda usar y no la de hoy. Misma mecánica, pero
  exige que sea EXACTA — costear un negocio con una TRM estirada es
  aceptable, liquidar una importación con una TRM que no es la del día
  de la declaración no lo es.
*/
export async function obtenerTRMdeFecha(fecha) {
  const r = await obtenerTRM(fecha, { forzar: true });
  if (r.origen === 'ninguna') return r;
  if (!r.exacta) {
    return {
      ...r,
      aviso: `No hay TRM publicada para el ${fecha}. La más cercana es del ${r.hasta}. ` +
             'Para liquidar hay que usar la del día de la declaración: verifícala antes de guardar.',
    };
  }
  return r;
}

// Etiqueta corta para poner al lado del número en pantalla.
export function etiquetaOrigenTRM(r) {
  if (!r) return '';
  if (r.origen === 'oficial')  return `oficial · vigente ${r.desde}`;
  if (r.origen === 'guardada') return `guardada · ${r.hasta}`;
  if (r.origen === 'manual')   return 'fijada a mano';
  return 'sin TRM';
}

export function limpiarCacheTRM() {
  cache.clear();
}
