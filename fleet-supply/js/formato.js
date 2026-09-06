/* ═══════════════════════════════════════════════════════
   formato.js
   Formato de moneda (COP/USD), fechas y TRM para toda la app.
   Interfaz en español de Colombia, zona horaria America/Bogota.
   ═══════════════════════════════════════════════════════ */

import { TIMEZONE } from './config.js';

const fmtCOP = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const fmtUSD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const fmtFechaLarga = new Intl.DateTimeFormat('es-CO', {
  timeZone: TIMEZONE,
  day: '2-digit',
  month: 'long',
  year: 'numeric',
});

export function formatoCOP(valor) {
  const n = Number(valor);
  if (Number.isNaN(n)) return '—';
  return fmtCOP.format(n);
}

export function formatoUSD(valor) {
  const n = Number(valor);
  if (Number.isNaN(n)) return '—';
  return fmtUSD.format(n);
}

// Recibe 'YYYY-MM-DD' o un Date, entrega 'dd/mm/aaaa'
export function formatoFecha(valor) {
  if (!valor) return '—';
  const d = valor instanceof Date ? valor : new Date(valor + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return '—';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const aaaa = d.getFullYear();
  return `${dd}/${mm}/${aaaa}`;
}

export function formatoFechaLarga(valor) {
  if (!valor) return '—';
  const d = valor instanceof Date ? valor : new Date(valor + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return '—';
  return fmtFechaLarga.format(d);
}

// Fecha de HOY en America/Bogota como 'YYYY-MM-DD' (para inputs date)
export function fechaHoyBogota() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const obj = Object.fromEntries(partes.map((p) => [p.type, p.value]));
  return `${obj.year}-${obj.month}-${obj.day}`;
}

// TRM: se ingresa manualmente (decisión confirmada), esto solo la
// formatea para mostrarla junto al colchón aplicado.
export function formatoTRM(valor) {
  const n = Number(valor);
  if (Number.isNaN(n)) return '—';
  return n.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatoPorcentaje(valor) {
  const n = Number(valor);
  if (Number.isNaN(n)) return '—';
  return `${n.toFixed(1)}%`;
}
