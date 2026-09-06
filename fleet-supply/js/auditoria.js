/* ═══════════════════════════════════════════════════════
   auditoria.js
   Bitácora de cambios y comparación de valores.

   Vive aparte porque la usan varios módulos (catálogo,
   configuración y las fases que vienen). Regla del proyecto:
   nunca se borran datos y todo cambio queda registrado con
   usuario, fecha y valor anterior.
   ═══════════════════════════════════════════════════════ */

import { sb } from './supabaseClient.js';
import { perfilActual } from './auth.js';

/*
  Compara el valor que trae la base contra el que entrega el
  formulario. Hace falta porque Supabase devuelve las columnas
  numeric como número (1440000) mientras un input las entrega como
  texto ("1440000"): con !== estricto eso se ve como un cambio y
  ensucia la bitácora con modificaciones que nunca ocurrieron.
*/
export function mismoValor(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'number' || typeof b === 'number') {
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b);
  return String(a) === String(b);
}

/*
  Calcula qué cambió de verdad entre lo que está guardado y lo que
  se quiere guardar. Devuelve { campo: [antes, despues] }.
*/
export function calcularCambios(actual, nuevos) {
  const diffs = {};
  for (const campo of Object.keys(nuevos)) {
    if (!mismoValor(actual?.[campo], nuevos[campo])) {
      diffs[campo] = [actual?.[campo] ?? null, nuevos[campo]];
    }
  }
  return diffs;
}

/*
  Escribe los cambios en fs_auditoria.
  identificador: uuid del registro, o { clave: 'texto' } para las
  tablas que se identifican por texto, como fs_parametro.
*/
export async function registrarAuditoria(tabla, identificador, cambios) {
  const entradas = Object.entries(cambios || {});
  if (!entradas.length) return;

  const esClave = identificador && typeof identificador === 'object' && 'clave' in identificador;
  const usuarioId = perfilActual()?.id ?? null;

  const filas = entradas.map(([campo, [anterior, nuevo]]) => ({
    tabla,
    registro_id: esClave ? null : identificador,
    registro_clave: esClave ? String(identificador.clave) : null,
    campo,
    valor_anterior: anterior == null ? null : String(anterior),
    valor_nuevo: nuevo == null ? null : String(nuevo),
    usuario_id: usuarioId,
  }));

  const { error } = await sb.from('fs_auditoria').insert(filas);
  if (error) console.error('Error registrando auditoría:', error);
}

/*
  Últimos cambios de un registro, para mostrar su historia.
*/
export async function historial(tabla, identificador, limite = 20) {
  const esClave = identificador && typeof identificador === 'object' && 'clave' in identificador;
  let q = sb
    .from('fs_auditoria')
    .select('campo,valor_anterior,valor_nuevo,created_at,usuarios(nombre)')
    .eq('tabla', tabla)
    .order('created_at', { ascending: false })
    .limit(limite);
  q = esClave ? q.eq('registro_clave', String(identificador.clave)) : q.eq('registro_id', identificador);
  const { data, error } = await q;
  if (error) {
    console.error(error);
    return [];
  }
  return data;
}
