/* ═══════════════════════════════════════════════════════
   formato.js
   Formateo de dinero, fechas y porcentajes, y normalización de SKU.

   Todo el módulo trabaja en zona horaria de Bogotá y en formato
   colombiano (punto de miles, coma decimal). Un valor vacío o no
   numérico se muestra como raya, nunca como "NaN" ni como cero:
   cero es una cifra y significa otra cosa.
   ═══════════════════════════════════════════════════════ */

import { TIMEZONE } from './config.js';

const RAYA = '—';

function aNumeroValido(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

/* ── Dinero ─────────────────────────────────────────── */

/** Pesos colombianos, sin decimales. */
export function formatoCOP(valor) {
  const n = aNumeroValido(valor);
  if (n === null) return RAYA;
  return n.toLocaleString('es-CO', {
    style: 'currency', currency: 'COP',
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  });
}

/** Dólares, siempre con dos decimales. */
export function formatoUSD(valor) {
  const n = aNumeroValido(valor);
  if (n === null) return RAYA;
  return n.toLocaleString('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

/** TRM con dos decimales, sin símbolo de moneda. */
export function formatoTRM(valor) {
  const n = aNumeroValido(valor);
  if (n === null) return RAYA;
  return n.toLocaleString('es-CO', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

/* ── Porcentajes ────────────────────────────────────── */

/**
 * Porcentaje con un decimal. Recibe el número tal cual se guarda
 * (25 = 25%), no una fracción.
 */
export function formatoPorcentaje(valor) {
  const n = aNumeroValido(valor);
  if (n === null) return RAYA;
  return `${n.toLocaleString('es-CO', {
    minimumFractionDigits: 1, maximumFractionDigits: 1,
  })}%`;
}

/* ── Fechas ─────────────────────────────────────────── */

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/**
 * Una fecha sin hora ('2026-09-09') NO debe pasar por Date: el motor la
 * interpreta como medianoche UTC y al mostrarla en Bogotá retrocede un
 * día. Estas se parten como texto y se arman a mano.
 */
function partesFechaSimple(valor) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(valor ?? '').trim());
  return m ? { anio: m[1], mes: m[2], dia: m[3] } : null;
}

function aFecha(valor) {
  if (!valor) return null;
  const d = valor instanceof Date ? valor : new Date(valor);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** DD/MM/AAAA */
export function formatoFecha(valor) {
  const p = partesFechaSimple(valor);
  if (p) return `${p.dia}/${p.mes}/${p.anio}`;

  const d = aFecha(valor);
  if (!d) return RAYA;
  return d.toLocaleDateString('es-CO', {
    timeZone: TIMEZONE, day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

/** 15 de enero de 2026 */
export function formatoFechaLarga(valor) {
  const p = partesFechaSimple(valor);
  if (p) return `${Number(p.dia)} de ${MESES[Number(p.mes) - 1]} de ${p.anio}`;

  const d = aFecha(valor);
  if (!d) return RAYA;
  return d.toLocaleDateString('es-CO', {
    timeZone: TIMEZONE, day: 'numeric', month: 'long', year: 'numeric',
  });
}

/**
 * Hoy en Bogotá, como AAAA-MM-DD, lista para un <input type="date">.
 * Se arma con formatToParts y no con toISOString, porque toISOString
 * pasa a UTC y en Colombia eso adelanta la fecha desde las 7 p.m.
 */
export function fechaHoyBogota() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());

  const p = Object.fromEntries(partes.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/* ── SKU ────────────────────────────────────────────── */

/**
 * Deja un SKU en la forma que acepta la base: mayúsculas, sin acentos,
 * espacios convertidos en guion. Devuelve el código ajustado y, si no
 * sirve, el motivo.
 *
 * Un SKU no se renombra nunca después de creado: renombrarlo es crear
 * un producto nuevo. Por eso conviene normalizarlo al escribirlo y no
 * después.
 *
 * @returns {{sku: string, cambiado: boolean, error: string|null}}
 */
export function normalizarSku(valor) {
  const original = String(valor ?? '').trim();
  if (!original) return { sku: '', cambiado: false, error: 'El SKU está vacío.' };

  const sku = original
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // quita acentos
    .toUpperCase()
    .replace(/\s+/g, '-');

  if (sku.length > 30) {
    return {
      sku, cambiado: sku !== original,
      error: `El SKU tiene ${sku.length} caracteres y el máximo es 30. `
           + 'Suele pasar cuando queda la descripción en la columna del SKU.',
    };
  }

  if (!/^[A-Z0-9][A-Z0-9._/+-]*$/.test(sku)) {
    return {
      sku, cambiado: sku !== original,
      error: 'El SKU solo admite letras, números y los signos . _ / + - '
           + 'y debe empezar por letra o número.',
    };
  }

  return { sku, cambiado: sku !== original, error: null };
}
