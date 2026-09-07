/* ═══════════════════════════════════════════════════════
   tablero.js — Fase 3B

   Embudo del pipeline, cierres del mes y del año, MRR nuevo por mes y
   el forecast a 6 meses con la demanda de SKU que implica.

   Sin meta, por decisión tomada: mientras no esté definida se muestra
   lo cerrado sin comparación, en vez de inventar un número contra el
   cual medir. Cuando la definas, se agrega.

   Todo lee de fs_negocio_vista, que ya trae los cálculos hechos en la
   base. Acá no se recalcula ningún total: si se recalculara, el tablero
   podría mostrar cifras distintas a las de la pantalla de negocios.

   Todos los valores van antes de IVA.
   ═══════════════════════════════════════════════════════ */

import { sb } from './supabaseClient.js';
import { escapeHtml, estadoCargando, hacerOrdenable } from './ui.js';
import { formatoCOP } from './formato.js';
import { MESES_FORECAST_DEFECTO } from './config.js';

/* ═══════════════════ Utilidades de fecha ═══════════════════ */

const MES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun',
  'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

// Clave 'AAAA-MM' de una fecha que viene como texto de Postgres.
const claveMes = (fecha) => (fecha ? String(fecha).slice(0, 7) : null);

const rotuloMes = (clave) => {
  if (!clave) return '—';
  const [a, m] = clave.split('-');
  return `${MES_CORTO[Number(m) - 1]} ${a.slice(2)}`;
};

/*
  Los próximos N meses desde hoy, como claves 'AAAA-MM'. Se arma con
  aritmética de números y no con Date para no depender de la zona
  horaria del navegador: un usuario en otra zona vería otro mes.
*/
function proximosMeses(n, desde) {
  const [a0, m0] = desde.split('-').map(Number);
  const out = [];
  for (let i = 0; i < n; i++) {
    const total = (a0 - 1) * 12 + (m0 - 1) + i;
    out.push(`${String(Math.floor(total / 12) + 1).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`);
  }
  return out;
}

/* ═══════════════════ Datos ═══════════════════ */

async function cargarTodo() {
  const [{ data: negocios, error: e1 }, { data: etapas }] = await Promise.all([
    sb.from('fs_negocio_vista').select('*'),
    sb.from('fs_etapa_pipeline').select('*').eq('activa', true).order('orden'),
  ]);
  // Antes acá se leía el parámetro trm_del_dia, con un comentario que
  // decía que servía para la fecha. Ni servía para la fecha ni se usaba
  // en ninguna parte del tablero: era una consulta de más. Y ahora sería
  // peor, porque trm_del_dia pasó a ser el valor fijado a mano y lo
  // normal es que esté en cero.
  if (e1) throw e1;

  // Demanda de SKU de los negocios que aún no están cerrados, para que
  // abastecimiento vea lo que viene.
  const { data: lineas } = await sb.from('fs_negocio_linea')
    .select('negocio_id,cantidad,producto_id,fs_productos(sku,nombre,marca)');

  return { negocios: negocios || [], etapas: etapas || [], lineas: lineas || [] };
}

/* ═══════════════════ Pantalla ═══════════════════ */

export async function renderTablero(container) {
  estadoCargando(container, 'Armando el tablero...');
  let datos;
  try {
    datos = await cargarTodo();
  } catch (err) {
    console.error(err);
    container.innerHTML = `<div class="fs-empty">No se pudo armar el tablero: ${escapeHtml(err.message || err)}</div>`;
    return;
  }

  const { negocios, etapas, lineas } = datos;
  if (!negocios.length) {
    container.innerHTML = `
      <div class="fs-ayuda-modo">
        Todavía no hay negocios cargados. El tablero se llena solo a medida que
        registres forecast, pipeline y cierres en la pestaña <strong>Negocios</strong>.
      </div>`;
    return;
  }

  const hoy = new Date().toISOString().slice(0, 10);
  const mesActual = hoy.slice(0, 7);
  const anioActual = hoy.slice(0, 4);

  const pipeline = negocios.filter((n) => n.naturaleza === 'pipeline');
  const forecast = negocios.filter((n) => n.naturaleza === 'forecast');
  const cerrados = negocios.filter((n) => n.naturaleza === 'cerrado');
  const cerradosMes = cerrados.filter((n) => claveMes(n.fecha_cierre_real) === mesActual);
  const cerradosAnio = cerrados.filter((n) => String(n.fecha_cierre_real || '').slice(0, 4) === anioActual);

  const sum = (arr, campo) => arr.reduce((a, x) => a + Number(x[campo] || 0), 0);
  const meses = proximosMeses(MESES_FORECAST_DEFECTO, mesActual);

  container.innerHTML = `
    <div class="fs-ayuda-modo">
      Todo antes de IVA. Los totales salen de los mismos cálculos que usa la pantalla de
      Negocios, para que las dos pantallas nunca muestren cifras distintas del mismo negocio.
      <strong>Sin meta definida</strong>: se muestra lo cerrado sin comparación.
    </div>

    <div class="fs-resumen">
      <div class="fs-resumen-caja"><span>${formatoCOP(sum(pipeline, 'valor_ponderado_cop'))}</span>pipeline ponderado</div>
      <div class="fs-resumen-caja"><span>${formatoCOP(sum(pipeline, 'valor_total_venta_cop'))}</span>pipeline sin ponderar</div>
      <div class="fs-resumen-caja"><span>${formatoCOP(sum(cerradosMes, 'valor_total_venta_cop'))}</span>cerrado este mes</div>
      <div class="fs-resumen-caja"><span>${formatoCOP(sum(cerradosAnio, 'valor_total_venta_cop'))}</span>cerrado en el año</div>
      <div class="fs-resumen-caja"><span>${formatoCOP(sum(cerradosMes, 'mrr_total_cop'))}</span>MRR nuevo del mes</div>
      <div class="fs-resumen-caja"><span>${sum(cerradosAnio, 'cantidad_vehiculos')}</span>vehículos cerrados en el año</div>
    </div>

    <h4 class="fs-h4">Embudo del pipeline</h4>
    <div id="tb-embudo"></div>

    <h4 class="fs-h4">MRR nuevo por mes de cierre</h4>
    <div id="tb-mrr"></div>

    <h4 class="fs-h4">Forecast a ${MESES_FORECAST_DEFECTO} meses</h4>
    <div id="tb-forecast"></div>

    <h4 class="fs-h4">Demanda de SKU que implica lo no cerrado</h4>
    <div id="tb-demanda"></div>
  `;

  pintarEmbudo(container.querySelector('#tb-embudo'), pipeline, etapas);
  pintarMrr(container.querySelector('#tb-mrr'), cerrados);
  pintarForecast(container.querySelector('#tb-forecast'), forecast, pipeline, meses);
  pintarDemanda(container.querySelector('#tb-demanda'), negocios, lineas);
}

/* ─────────── Embudo por etapa, en unidades y en dinero ─────────── */

function pintarEmbudo(el, pipeline, etapas) {
  if (!pipeline.length) {
    el.innerHTML = '<div class="fs-empty-inline">No hay negocios en pipeline.</div>';
    return;
  }
  const filas = etapas.map((e) => {
    const enEtapa = pipeline.filter((n) => n.etapa_id === e.id);
    return {
      nombre: e.nombre,
      prob: e.probabilidad_default,
      negocios: enEtapa.length,
      vehiculos: enEtapa.reduce((a, n) => a + Number(n.cantidad_vehiculos || 0), 0),
      valor: enEtapa.reduce((a, n) => a + Number(n.valor_total_venta_cop || 0), 0),
      ponderado: enEtapa.reduce((a, n) => a + Number(n.valor_ponderado_cop || 0), 0),
    };
  });
  // Negocios en pipeline sin etapa: existen y no pueden desaparecer del
  // total, así que se muestran aparte en vez de ignorarse.
  const huerfanos = pipeline.filter((n) => !n.etapa_id);

  const maxValor = Math.max(...filas.map((f) => f.valor), 1);

  el.innerHTML = `
    <table class="fs-tabla">
      <thead><tr><th>Etapa</th><th style="width:80px">Prob.</th><th style="width:90px">Negocios</th>
        <th style="width:100px">Vehículos</th><th style="width:140px">Valor</th>
        <th style="width:140px">Ponderado</th><th>Peso</th></tr></thead>
      <tbody>
        ${filas.map((f) => `<tr>
          <td>${escapeHtml(f.nombre)}</td>
          <td>${f.prob}%</td>
          <td>${f.negocios || '—'}</td>
          <td>${f.vehiculos || '—'}</td>
          <td>${f.valor ? formatoCOP(f.valor) : '—'}</td>
          <td>${f.ponderado ? formatoCOP(f.ponderado) : '—'}</td>
          <td><div style="background:var(--sat-blue);height:12px;border-radius:6px;
               width:${Math.round((f.valor / maxValor) * 100)}%;min-width:${f.valor ? 4 : 0}px"></div></td>
        </tr>`).join('')}
        ${huerfanos.length ? `<tr>
          <td><span class="fs-faltante">sin etapa</span></td><td>—</td>
          <td>${huerfanos.length}</td>
          <td>${huerfanos.reduce((a, n) => a + Number(n.cantidad_vehiculos || 0), 0)}</td>
          <td>${formatoCOP(huerfanos.reduce((a, n) => a + Number(n.valor_total_venta_cop || 0), 0))}</td>
          <td>—</td><td></td></tr>` : ''}
      </tbody>
    </table>
    ${huerfanos.length ? `<div class="fs-nota-toolbar">
      Hay ${huerfanos.length} negocio(s) en pipeline sin etapa asignada: no entran al ponderado.
      Asígnales etapa desde Negocios.</div>` : ''}`;
}

/* ─────────── MRR nuevo por mes ─────────── */

function pintarMrr(el, cerrados) {
  const conFecha = cerrados.filter((n) => n.fecha_cierre_real);
  if (!conFecha.length) {
    el.innerHTML = '<div class="fs-empty-inline">Todavía no hay negocios cerrados con fecha.</div>';
    return;
  }
  const porMes = new Map();
  for (const n of conFecha) {
    const k = claveMes(n.fecha_cierre_real);
    const a = porMes.get(k) || { servicio: 0, comodato: 0, venta: 0, negocios: 0, vehiculos: 0 };
    a.servicio += Number(n.mrr_servicio_cop || 0);
    a.comodato += Number(n.mrr_comodato_cop || 0);
    a.venta += Number(n.valor_total_venta_cop || 0);
    a.negocios += 1;
    a.vehiculos += Number(n.cantidad_vehiculos || 0);
    porMes.set(k, a);
  }
  const claves = [...porMes.keys()].sort();
  let acumulado = 0;

  el.innerHTML = `
    <table class="fs-tabla">
      <thead><tr><th style="width:90px">Mes</th><th style="width:90px">Negocios</th>
        <th style="width:100px">Vehículos</th><th style="width:140px">Venta</th>
        <th style="width:130px">MRR servicio</th><th style="width:130px">MRR comodato</th>
        <th style="width:140px">MRR nuevo</th><th style="width:150px">MRR acumulado</th></tr></thead>
      <tbody>
        ${claves.map((k) => {
          const a = porMes.get(k);
          const nuevo = a.servicio + a.comodato;
          acumulado += nuevo;
          return `<tr>
            <td>${rotuloMes(k)}</td><td>${a.negocios}</td><td>${a.vehiculos}</td>
            <td>${formatoCOP(a.venta)}</td>
            <td>${formatoCOP(a.servicio)}</td>
            <td>${formatoCOP(a.comodato)}</td>
            <td><strong>${formatoCOP(nuevo)}</strong></td>
            <td>${formatoCOP(acumulado)}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    <div class="fs-nota-toolbar">
      El acumulado suma los MRR nuevos de cada mes: es lo que se factura cada mes si nadie
      se retira. No descuenta cancelaciones ni comodatos que terminaron su plazo — eso
      necesita la fecha de fin de cada contrato, que todavía no se registra.
    </div>`;
}

/* ─────────── Forecast a 6 meses ─────────── */

function pintarForecast(el, forecast, pipeline, meses) {
  const candidatos = [...forecast, ...pipeline].filter((n) => n.mes_estimado_cierre);
  if (!candidatos.length) {
    el.innerHTML = `<div class="fs-empty-inline">
      No hay negocios con mes estimado de cierre. Llena ese campo en los negocios de
      forecast y pipeline para que el forecast tenga con qué proyectar.</div>`;
    return;
  }

  const porMes = new Map(meses.map((m) => [m, { veh: 0, valor: 0, ponderado: 0, negocios: 0 }]));
  let fuera = 0;
  for (const n of candidatos) {
    const k = claveMes(n.mes_estimado_cierre);
    if (!porMes.has(k)) { fuera++; continue; }
    const a = porMes.get(k);
    a.veh += Number(n.cantidad_vehiculos || 0);
    a.valor += Number(n.valor_total_venta_cop || 0);
    // El forecast no tiene etapa, así que no tiene ponderado: se usa el
    // valor completo solo para el pipeline y se deja aparte el forecast.
    a.ponderado += Number(n.valor_ponderado_cop || 0);
    a.negocios += 1;
  }

  el.innerHTML = `
    <table class="fs-tabla">
      <thead><tr><th style="width:90px">Mes</th><th style="width:90px">Negocios</th>
        <th style="width:110px">Vehículos</th><th style="width:150px">Valor proyectado</th>
        <th style="width:150px">Ponderado (pipeline)</th></tr></thead>
      <tbody>
        ${meses.map((m) => {
          const a = porMes.get(m);
          return `<tr>
            <td>${rotuloMes(m)}</td>
            <td>${a.negocios || '—'}</td>
            <td>${a.veh || '—'}</td>
            <td>${a.valor ? formatoCOP(a.valor) : '—'}</td>
            <td>${a.ponderado ? formatoCOP(a.ponderado) : '—'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    ${fuera ? `<div class="fs-nota-toolbar">
      ${fuera} negocio(s) tienen mes estimado fuera de esta ventana de ${meses.length} meses
      (ya pasó, o está más allá). No se cuentan acá.</div>` : ''}`;
}

/* ─────────── Demanda de SKU de lo no cerrado ─────────── */

function pintarDemanda(el, negocios, lineas) {
  const noCerrados = new Set(negocios.filter((n) => n.naturaleza !== 'cerrado').map((n) => n.id));
  const relevantes = lineas.filter((l) => noCerrados.has(l.negocio_id));
  if (!relevantes.length) {
    el.innerHTML = `<div class="fs-empty-inline">
      No hay líneas en negocios de forecast o pipeline. Esta tabla existe para que
      abastecimiento vea la demanda que viene antes de que se cierre.</div>`;
    return;
  }

  const porSku = new Map();
  for (const l of relevantes) {
    const p = l.fs_productos || {};
    const k = p.sku || l.producto_id;
    const a = porSku.get(k) || { sku: p.sku || '?', nombre: p.nombre || '', marca: p.marca || '', cantidad: 0, negocios: new Set() };
    a.cantidad += Number(l.cantidad || 0);
    a.negocios.add(l.negocio_id);
    porSku.set(k, a);
  }
  const filas = [...porSku.values()].sort((a, b) => b.cantidad - a.cantidad);

  el.innerHTML = `
    <table class="fs-tabla" id="tb-tabla-demanda">
      <thead><tr><th data-orden="texto" style="width:140px">SKU</th>
        <th data-orden="texto">Producto</th>
        <th data-orden="texto" style="width:110px">Marca</th>
        <th data-orden="numero" style="width:110px">Unidades</th>
        <th data-orden="numero" style="width:100px">Negocios</th></tr></thead>
      <tbody>
        ${filas.map((f) => `<tr>
          <td>${escapeHtml(f.sku)}</td>
          <td>${escapeHtml(f.nombre)}</td>
          <td>${escapeHtml(f.marca || '—')}</td>
          <td data-orden="${f.cantidad}">${f.cantidad}</td>
          <td data-orden="${f.negocios.size}">${f.negocios.size}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div class="fs-nota-toolbar">
      Unidades de negocios en forecast y pipeline, o sea demanda que <strong>todavía no está
      cerrada y no reserva stock</strong>. Sirve para anticipar compras, no para comprometerlas.
    </div>`;

  hacerOrdenable(el.querySelector('#tb-tabla-demanda'));
}
