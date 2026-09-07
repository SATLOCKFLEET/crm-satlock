/* ═══════════════════════════════════════════════════════
   cronograma.js — Fase 4B

   Tres vistas:
   - Gantt de las órdenes activas, con semáforo.
   - Hitos de una orden, para cumplirlos, ajustar días o marcar los
     que no aplican.
   - Por negocio: cuándo estará completo el material en Fontibón.

   El Gantt es CSS puro, sin librería. No por purismo: una librería de
   Gantt por CDN son cientos de kilobytes para dibujar barras
   posicionadas por fecha, y este módulo no tiene build.

   Lo que NO se calcula acá: el encadenamiento de fechas lo hace
   fs_recalcular_cronograma_oc en la base. Si un hito se cumple tarde,
   todo lo que viene detrás se recalcula desde la fecha REAL, y el
   atraso se mide contra la línea base congelada al aprobar. Si se
   calculara en el navegador, cada pantalla podría mostrar una fecha
   distinta de la misma orden.
   ═══════════════════════════════════════════════════════ */

import { sb } from './supabaseClient.js';
import { tieneRol } from './auth.js';
import {
  mostrarToast, confirmar, escapeHtml, estadoCargando, hacerOrdenable,
} from './ui.js';
import { formatoFecha, fechaHoyBogota } from './formato.js';
import { ROLES_FS } from './config.js';

const PUEDE_MOVER = [ROLES_FS.COMERCIO_EXTERIOR, ROLES_FS.ALMACENISTA, ROLES_FS.ADMIN];

const SEMAFORO = {
  en_tiempo:      { texto: 'En tiempo',      color: 'var(--green)',   fondo: 'var(--green-light)' },
  en_riesgo:      { texto: 'En riesgo',      color: 'var(--amber)',   fondo: 'var(--amber-light)' },
  atrasada:       { texto: 'Atrasada',       color: 'var(--red)',     fondo: 'var(--red-light)' },
  sin_cronograma: { texto: 'Sin cronograma', color: 'var(--text3)',   fondo: 'var(--surface2)' },
  cerrada:        { texto: 'Cerrada',        color: 'var(--text3)',   fondo: 'var(--surface2)' },
};

const ESTADO_HITO = {
  pendiente: 'Pendiente', en_curso: 'En curso', cumplido: 'Cumplido',
  atrasado: 'Atrasado', no_aplica: 'No aplica',
};

/* ═══════════════════ Utilidades de fecha ═══════════════════ */

const aFecha = (s) => (s ? new Date(`${String(s).slice(0, 10)}T12:00:00`) : null);
const diasEntre = (a, b) => Math.round((aFecha(b) - aFecha(a)) / 86400000);
const sumarDias = (s, n) => {
  const d = aFecha(s);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

/* ═══════════════════ Datos ═══════════════════ */

async function cargarOrdenes() {
  const { data, error } = await sb.from('fs_oc_cronograma_vista').select('*')
    .order('fecha_estimada_llegada');
  if (error) throw error;
  return data || [];
}

async function cargarHitos(ocIds) {
  if (!ocIds.length) return new Map();
  const { data, error } = await sb.from('fs_oc_hito').select('*')
    .in('orden_compra_id', ocIds).order('orden');
  if (error) throw error;
  const m = new Map();
  for (const h of data || []) {
    if (!m.has(h.orden_compra_id)) m.set(h.orden_compra_id, []);
    m.get(h.orden_compra_id).push(h);
  }
  return m;
}

async function cargarMaterialNegocios() {
  const { data, error } = await sb.from('fs_negocio_material_vista').select('*').order('codigo');
  if (error) throw error;
  return data || [];
}

/* ═══════════════════ Pantalla ═══════════════════ */

export async function renderCronograma(container) {
  container.innerHTML = `
    <div class="fs-subtabs">
      <button class="fs-subtab active" data-vista="gantt">Gantt de órdenes</button>
      <button class="fs-subtab" data-vista="negocios">Por negocio</button>
    </div>
    <div id="crn-vista"></div>`;

  const vista = container.querySelector('#crn-vista');
  const pintar = async (cual, boton) => {
    container.querySelectorAll('.fs-subtab').forEach((b) => b.classList.remove('active'));
    boton.classList.add('active');
    try {
      if (cual === 'negocios') await renderPorNegocio(vista);
      else await renderGantt(vista);
    } catch (err) {
      console.error(err);
      vista.innerHTML = `<div class="fs-empty">No se pudo cargar: ${escapeHtml(err.message || err)}</div>`;
    }
  };
  container.querySelectorAll('.fs-subtab').forEach((b) => {
    b.addEventListener('click', () => pintar(b.dataset.vista, b));
  });
  await pintar('gantt', container.querySelector('.fs-subtab'));
}

/* ─────────── Gantt ─────────── */

async function renderGantt(cont) {
  estadoCargando(cont, 'Armando el cronograma...');
  const todas = await cargarOrdenes();
  const activas = todas.filter((o) => !['sin_cronograma', 'cerrada'].includes(o.semaforo));

  if (!activas.length) {
    cont.innerHTML = `<div class="fs-ayuda-modo">
      No hay órdenes con cronograma. Los hitos se generan <strong>al aprobar</strong> una orden
      de compra, encadenados desde la fecha de aprobación.
      ${todas.length ? `Hay ${todas.length} orden(es), pero ninguna aprobada todavía.` : ''}
    </div>`;
    return;
  }

  const hitos = await cargarHitos(activas.map((o) => o.id));
  const atrasadas = activas.filter((o) => o.semaforo === 'atrasada');
  const riesgo = activas.filter((o) => o.semaforo === 'en_riesgo');

  // Ventana del Gantt: de la aprobación más vieja a la llegada más
  // lejana, con un margen para que las barras no toquen el borde.
  const fechas = activas.flatMap((o) => [o.fecha_aprobacion, o.fecha_estimada_llegada]).filter(Boolean);
  const hoy = fechaHoyBogota();
  const inicio = [...fechas, hoy].map((f) => String(f).slice(0, 10)).sort()[0];
  const fin = [...fechas, hoy].map((f) => String(f).slice(0, 10)).sort().slice(-1)[0];
  const total = Math.max(diasEntre(inicio, fin), 1);
  const pos = (f) => Math.max(0, Math.min(100, (diasEntre(inicio, f) / total) * 100));

  // Marcas de mes para el encabezado del Gantt.
  const marcas = [];
  let cursor = `${inicio.slice(0, 7)}-01`;
  for (let i = 0; i < 24; i++) {
    if (cursor > fin) break;
    if (cursor >= inicio) marcas.push(cursor);
    const [a, m] = cursor.split('-').map(Number);
    cursor = m === 12 ? `${a + 1}-01-01` : `${a}-${String(m + 1).padStart(2, '0')}-01`;
  }

  cont.innerHTML = `
    ${atrasadas.length ? `
      <div class="fs-ayuda-modo" style="background:var(--red-light);border-left-color:var(--red)">
        <strong>${atrasadas.length} orden(es) atrasada(s).</strong>
        ${atrasadas.map((o) => `<br>· <strong>${escapeHtml(o.codigo)}</strong>
          ${o.hito_mas_atrasado ? `se atrasó en "${escapeHtml(o.hito_mas_atrasado)}"` : ''}
          ${o.dias_desviacion ? `y la llegada se corrió <strong>${o.dias_desviacion} días</strong>
            (de ${formatoFecha(o.fecha_llegada_baseline)} a ${formatoFecha(o.fecha_estimada_llegada)})` : ''}.
          Afecta a ${o.negocios_afectados} negocio(s): ${escapeHtml(o.clientes_afectados || '—')}`).join('')}
      </div>` : ''}

    <div class="fs-resumen">
      <div class="fs-resumen-caja"><span>${activas.length}</span>órdenes activas</div>
      <div class="fs-resumen-caja ${atrasadas.length ? 'error' : ''}"><span>${atrasadas.length}</span>atrasadas</div>
      <div class="fs-resumen-caja ${riesgo.length ? 'aviso' : ''}"><span>${riesgo.length}</span>en riesgo</div>
      <div class="fs-resumen-caja"><span>${activas.reduce((a, o) => a + (o.negocios_afectados || 0), 0)}</span>negocios en juego</div>
    </div>

    <div class="fs-gantt">
      <div class="fs-gantt-cab">
        <div class="fs-gantt-rotulo">Orden</div>
        <div class="fs-gantt-pista">
          ${marcas.map((m) => `<span class="fs-gantt-mes" style="left:${pos(m)}%">${
            ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][Number(m.slice(5, 7)) - 1]
          } ${m.slice(2, 4)}</span>`).join('')}
          <span class="fs-gantt-hoy" style="left:${pos(hoy)}%" title="Hoy"></span>
        </div>
      </div>

      ${activas.map((o) => {
        const s = SEMAFORO[o.semaforo] || SEMAFORO.en_tiempo;
        const lista = hitos.get(o.id) || [];
        const iniBarra = pos(o.fecha_aprobacion || inicio);
        const finBarra = pos(o.fecha_estimada_llegada || fin);
        const base = o.fecha_llegada_baseline ? pos(o.fecha_llegada_baseline) : null;
        return `
          <div class="fs-gantt-fila" data-id="${o.id}">
            <div class="fs-gantt-rotulo">
              <strong>${escapeHtml(o.codigo)}</strong>
              <span class="fs-gantt-chip" style="color:${s.color};background:${s.fondo}">${s.texto}</span>
              <br><small class="fs-par-desc">${escapeHtml(o.proveedor || '—')} · ${escapeHtml(o.ruta_codigo || '')}
              · ${o.avance_pct ?? 0}%</small>
              <br><small class="fs-par-desc">${o.negocios_afectados || 0} negocio(s)</small>
            </div>
            <div class="fs-gantt-pista">
              <span class="fs-gantt-hoy" style="left:${pos(hoy)}%"></span>
              ${base != null && o.dias_desviacion > 0
                ? `<span class="fs-gantt-base" style="left:${base}%" title="Llegada prometida: ${formatoFecha(o.fecha_llegada_baseline)}"></span>` : ''}
              <div class="fs-gantt-barra" style="left:${iniBarra}%;width:${Math.max(finBarra - iniBarra, 0.7)}%;
                   background:${s.fondo};border-color:${s.color}">
                ${lista.filter((h) => h.estado !== 'no_aplica').map((h) => {
                  const f = h.fecha_real || h.fecha_estimada;
                  if (!f) return '';
                  const rel = ((pos(f) - iniBarra) / Math.max(finBarra - iniBarra, 0.01)) * 100;
                  const tarde = h.fecha_real && h.fecha_estimada_baseline && h.fecha_real > h.fecha_estimada_baseline;
                  return `<span class="fs-gantt-hito ${h.estado === 'cumplido' ? 'cumplido' : ''} ${tarde ? 'tarde' : ''}"
                    style="left:${Math.max(0, Math.min(100, rel))}%"
                    title="${escapeHtml(h.nombre)} — ${ESTADO_HITO[h.estado] || h.estado}: ${formatoFecha(f)}${
                      tarde ? ` (tarde: se estimaba ${formatoFecha(h.fecha_estimada_baseline)})` : ''}"></span>`;
                }).join('')}
              </div>
              <span class="fs-gantt-fin" style="left:${finBarra}%">${formatoFecha(o.fecha_estimada_llegada)}</span>
            </div>
          </div>`;
      }).join('')}
    </div>

    <div class="fs-nota-toolbar">
      La línea vertical punteada es hoy. Los puntos sobre la barra son los hitos: rellenos los
      cumplidos, en rojo los que se cumplieron después de lo previsto. La marca gris vertical
      es la <strong>llegada que se prometió al aprobar</strong>, para que se vea cuánto se corrió.
      Haz clic en una orden para abrir sus hitos.
    </div>`;

  cont.querySelectorAll('.fs-gantt-fila').forEach((f) => {
    f.addEventListener('click', () => abrirHitos(f.dataset.id, () => renderGantt(cont)));
  });
}

/* ─────────── Hitos de una orden ─────────── */

async function abrirHitos(ocId, alCambiar) {
  const puedeMover = tieneRol(...PUEDE_MOVER);
  const [{ data: oc }, { data: hitos }] = await Promise.all([
    sb.from('fs_oc_cronograma_vista').select('*').eq('id', ocId).maybeSingle(),
    sb.from('fs_oc_hito').select('*').eq('orden_compra_id', ocId).order('orden'),
  ]);
  if (!oc) { mostrarToast('No se encontró la orden.', 'error'); return; }

  const s = SEMAFORO[oc.semaforo] || SEMAFORO.en_tiempo;
  const ov = document.createElement('div');
  ov.className = 'fs-modal-overlay show';
  ov.innerHTML = `
    <div class="fs-modal fs-modal-ancho">
      <div class="fs-modal-title">${escapeHtml(oc.codigo)} — hitos
        <span class="fs-gantt-chip" style="color:${s.color};background:${s.fondo}">${s.texto}</span></div>

      <div class="fs-ayuda-modo">
        ${escapeHtml(oc.proveedor || '')} · ruta ${escapeHtml(oc.ruta_nombre || '')}.
        Aprobada el ${formatoFecha(oc.fecha_aprobacion)}.
        ${oc.dias_desviacion > 0
          ? `<br><strong>La llegada se corrió ${oc.dias_desviacion} día(s)</strong>: se prometió
             ${formatoFecha(oc.fecha_llegada_baseline)} y hoy se estima ${formatoFecha(oc.fecha_estimada_llegada)}.`
          : `<br>Llegada estimada: <strong>${formatoFecha(oc.fecha_estimada_llegada)}</strong>, igual a lo prometido.`}
        ${oc.negocios_afectados ? `<br>Afecta a ${oc.negocios_afectados} negocio(s):
          ${escapeHtml(oc.clientes_afectados || '')}` : ''}
      </div>

      <table class="fs-tabla fs-tabla-hitos">
        <thead><tr>
          <th style="width:34px">#</th><th>Hito</th>
          <th style="width:70px">Días</th><th style="width:110px">Estimada</th>
          <th style="width:110px">Real</th><th style="width:100px">Estado</th>
          ${puedeMover ? '<th style="width:170px"></th>' : ''}
        </tr></thead>
        <tbody>
          ${(hitos || []).map((h) => {
            const tarde = h.fecha_real && h.fecha_estimada_baseline && h.fecha_real > h.fecha_estimada_baseline;
            const dias = h.dias_pactados ?? h.dias_estandar;
            return `<tr data-id="${h.id}" ${h.estado === 'no_aplica' ? 'style="opacity:.55"' : ''}>
              <td>${h.orden}</td>
              <td>${escapeHtml(h.nombre)}
                  ${h.responsable ? `<br><small class="fs-par-desc">${escapeHtml(h.responsable)}</small>` : ''}
                  ${h.nota ? `<br><small class="fs-par-desc">${escapeHtml(h.nota)}</small>` : ''}</td>
              <td>${dias}${h.dias_pactados != null
                    ? `<br><small class="fs-par-desc">pactado</small>` : ''}</td>
              <td>${h.fecha_estimada ? formatoFecha(h.fecha_estimada) : '—'}</td>
              <td>${h.fecha_real
                    ? (tarde ? `<span class="fs-faltante">${formatoFecha(h.fecha_real)}</span>` : formatoFecha(h.fecha_real))
                    : '—'}</td>
              <td>${ESTADO_HITO[h.estado] || h.estado}</td>
              ${puedeMover ? `<td>
                ${h.estado === 'cumplido' ? '<small class="fs-par-desc">cumplido</small>' : `
                  <button class="fs-btn-link h-cumplir">Cumplir</button>
                  · <button class="fs-btn-link h-dias">Días</button>
                  ${h.omitible && h.estado !== 'no_aplica' ? ' · <button class="fs-btn-link h-na">No aplica</button>' : ''}`}
              </td>` : ''}
            </tr>`;
          }).join('')}
        </tbody>
      </table>

      <div class="fs-nota-toolbar">
        Al cumplir un hito, <strong>todo lo que viene detrás se recalcula desde la fecha real</strong>,
        no desde la estimada. Los días pactados sobrescriben los de la ruta solo en esta orden.
        Los hitos marcados "no aplica" no consumen días: es lo que pasa cuando la carga entra por
        mensajería expresa y no pasa por nacionalización.
      </div>

      <div class="fs-modal-actions">
        <button class="fs-btn-primary" data-cerrar>Cerrar</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const cerrar = () => ov.remove();
  ov.querySelector('[data-cerrar]').addEventListener('click', cerrar);

  const idDe = (e) => e.target.closest('tr').dataset.id;
  const tras = async (fn, args) => {
    const { data, error } = await sb.rpc(fn, args);
    if (error) {
      console.error(error);
      mostrarToast(error.message || String(error), 'error');
      return;
    }
    const r = (data || [])[0] || {};
    if (r.dias_movidos > 0) {
      mostrarToast(`Listo. La llegada se corrió ${r.dias_movidos} día(s), a ${formatoFecha(r.llegada_estimada)}.`, 'aviso');
    } else if (r.dias_ahorrados > 0) {
      mostrarToast(`Listo. Se adelantó ${r.dias_ahorrados} día(s), a ${formatoFecha(r.llegada_estimada)}.`, 'exito');
    } else {
      mostrarToast(`Listo. Llegada estimada: ${formatoFecha(r.llegada_estimada)}.`, 'exito');
    }
    cerrar();
    alCambiar();
  };

  if (!puedeMover) return;

  ov.querySelectorAll('.h-cumplir').forEach((b) => b.addEventListener('click', (e) => {
    const h = (hitos || []).find((x) => x.id === idDe(e));
    const f = window.prompt(
      `¿En qué fecha se cumplió "${h.nombre}"?\n`
      + `Estimada: ${h.fecha_estimada || 'sin fecha'}\n\n`
      + 'Formato AAAA-MM-DD. Si se cumplió tarde, todo lo que viene detrás se recorre.',
      h.fecha_estimada || fechaHoyBogota());
    if (f === null) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.trim())) { mostrarToast('La fecha va como AAAA-MM-DD.', 'aviso'); return; }
    tras('fs_cumplir_hito', { p_hito: h.id, p_fecha: f.trim(), p_nota: null });
  }));

  ov.querySelectorAll('.h-dias').forEach((b) => b.addEventListener('click', (e) => {
    const h = (hitos || []).find((x) => x.id === idDe(e));
    const d = window.prompt(
      `Días pactados para "${h.nombre}".\n`
      + `La ruta dice ${h.dias_estandar}. Ej: "con este proveedor pacté 15 días de producción".\n\n`
      + 'Solo afecta esta orden; la plantilla de la ruta no se toca.',
      String(h.dias_pactados ?? h.dias_estandar));
    if (d === null) return;
    const n = Number(d);
    if (!Number.isInteger(n) || n < 0) { mostrarToast('Los días van como un entero de 0 o más.', 'aviso'); return; }
    tras('fs_ajustar_dias_hito', { p_hito: h.id, p_dias: n, p_nota: null });
  }));

  ov.querySelectorAll('.h-na').forEach((b) => b.addEventListener('click', (e) => {
    const h = (hitos || []).find((x) => x.id === idDe(e));
    const m = window.prompt(
      `¿Por qué no aplica "${h.nombre}" en esta orden?\n\n`
      + 'Ej: entró por mensajería expresa, sin nacionalización formal.\n'
      + 'Se ahorran sus días y la llegada se adelanta.');
    if (m === null) return;
    if (!m.trim()) { mostrarToast('El motivo es obligatorio: cambia la fecha de toda la orden.', 'aviso'); return; }
    tras('fs_marcar_hito_no_aplica', { p_hito: h.id, p_motivo: m.trim() });
  }));
}

/* ─────────── Por negocio ─────────── */

async function renderPorNegocio(cont) {
  estadoCargando(cont, 'Cargando negocios...');
  const negocios = await cargarMaterialNegocios();

  if (!negocios.length) {
    cont.innerHTML = `<div class="fs-ayuda-modo">
      No hay negocios cerrados. Esta vista responde, para cada uno, cuándo estará completo su
      material en Fontibón considerando el stock reservado y todas las órdenes que lo alimentan.
    </div>`;
    return;
  }

  const sinFecha = negocios.filter((n) => !n.material_completo_estimado && n.unidades_sin_orden > 0);

  cont.innerHTML = `
    <div class="fs-ayuda-modo">
      La fecha de un negocio es la de <strong>su componente más tardío</strong>. Lo reservado en
      Fontibón cuenta como disponible hoy; lo comprado depende de la llegada de su orden.
      ${sinFecha.length ? `<br><span class="fs-faltante">${sinFecha.length} negocio(s) no tienen fecha
        porque les faltan unidades sin orden de compra: a esos no se les puede prometer nada todavía.</span>` : ''}
    </div>

    <table class="fs-tabla" id="crn-neg">
      <thead><tr>
        <th data-orden="texto" style="width:110px">Negocio</th>
        <th data-orden="texto">Cliente</th>
        <th data-orden="texto" style="width:130px">Abastecimiento</th>
        <th data-orden="numero" style="width:100px">Reservado</th>
        <th data-orden="numero" style="width:100px">En orden</th>
        <th data-orden="numero" style="width:110px">Sin orden</th>
        <th data-orden="numero" style="width:130px">Material listo</th>
        <th>Situación</th>
      </tr></thead>
      <tbody>
        ${negocios.map((n) => `<tr ${n.unidades_sin_orden > 0 ? 'style="background:var(--red-light)"' : ''}>
          <td>${escapeHtml(n.codigo)}</td>
          <td>${escapeHtml(n.empresa || '—')}</td>
          <td>${escapeHtml(n.estado_ejecucion || '—')}</td>
          <td data-orden="${n.unidades_reservadas || 0}">${n.unidades_reservadas || '—'}</td>
          <td data-orden="${n.unidades_en_orden || 0}">${n.unidades_en_orden || '—'}</td>
          <td data-orden="${n.unidades_sin_orden || 0}">${n.unidades_sin_orden
                ? `<span class="fs-faltante">${n.unidades_sin_orden}</span>` : '—'}</td>
          <td data-orden="${n.material_completo_estimado || '9999-99-99'}">${n.material_completo_estimado
                ? formatoFecha(n.material_completo_estimado)
                : '<span class="fs-faltante">sin fecha</span>'}</td>
          <td><small class="fs-par-desc">${escapeHtml(n.situacion || '')}</small></td>
        </tr>`).join('')}
      </tbody>
    </table>`;

  hacerOrdenable(cont.querySelector('#crn-neg'));
}
