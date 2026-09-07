/* ═══════════════════════════════════════════════════════
   compras.js — Fase 4A

   Dos pantallas:
   - Bandeja de requerimientos: todo lo que hay que comprar, con su
     negocio, cliente, proveedor y ruta. Se seleccionan varios y se
     genera UNA orden consolidada.
   - Órdenes de compra: el listado con su costeo y el flujo de estados.

   Lo que NO se hace acá:
   - La creación de la orden y sus asignaciones las hace
     fs_crear_oc_consolidada en la base, con bloqueo de fila. Si se
     armara en el navegador, dos personas de Comercio Exterior podrían
     asignar cada una las mismas 5 unidades del mismo requerimiento y
     el negocio quedaría contando 10 unidades compradas sobre 5.
   - La aprobación la hace fs_aprobar_oc, que verifica el rol en la
     base. Ocultar el botón no basta: el repositorio es público.

   Una orden = un proveedor + una ruta. Consolida varios negocios, no
   varios proveedores.

   Todos los valores van antes de IVA.
   ═══════════════════════════════════════════════════════ */

import { sb } from './supabaseClient.js';
import { perfilActual, tieneRol, rolFSActual } from './auth.js';
import {
  mostrarToast, confirmar, escapeHtml, estadoCargando,
  hacerOrdenable, hacerFiltrable,
} from './ui.js';
import { formatoCOP, formatoUSD, formatoFecha } from './formato.js';
import { ROLES_FS, RUTAS, esRutaImportacion } from './config.js';

const ESTADOS_OC = {
  borrador: 'Borrador',
  pendiente_aprobacion: 'Pendiente de aprobación',
  aprobada: 'Aprobada',
  en_ejecucion: 'En ejecución',
  recibida: 'Recibida',
  cancelada: 'Cancelada',
};

const PUEDE_ARMAR = [ROLES_FS.COMERCIO_EXTERIOR, ROLES_FS.JEFE_COMERCIAL, ROLES_FS.ADMIN];
const PUEDE_APROBAR = [ROLES_FS.FINANCIERA, ROLES_FS.ADMIN];

/* ═══════════════════ Datos ═══════════════════ */

async function cargarBandeja() {
  const { data, error } = await sb.from('fs_requerimiento_vista')
    .select('*').neq('estado', 'cancelado').order('fecha_necesidad');
  if (error) throw error;
  return (data || []).filter((q) => q.cantidad_sin_asignar > 0);
}

async function cargarOrdenes() {
  const { data, error } = await sb.from('fs_orden_compra')
    .select('*,fs_proveedor(nombre),fs_ruta(codigo,nombre,clave,modo)')
    .order('creado_en', { ascending: false });
  if (error) throw error;
  return data || [];
}

/*
  A qué negocios y clientes desbloquea cada orden. Es la pregunta que
  Financiera hace antes de aprobar, así que se trae de una en vez de
  obligar a abrir cada orden.
*/
async function cargarCoberturaOrdenes() {
  const { data, error } = await sb.from('fs_oc_requerimiento')
    .select('cantidad_asignada,fs_oc_item(orden_compra_id,fs_productos(sku)),fs_requerimiento(fs_negocio(codigo,empresa))');
  if (error) {
    console.error(error);
    return new Map();
  }
  const porOC = new Map();
  for (const r of data || []) {
    const oc = r.fs_oc_item?.orden_compra_id;
    if (!oc) continue;
    if (!porOC.has(oc)) porOC.set(oc, { negocios: new Map(), unidades: 0 });
    const e = porOC.get(oc);
    e.unidades += Number(r.cantidad_asignada || 0);
    const n = r.fs_requerimiento?.fs_negocio;
    if (n) e.negocios.set(n.codigo, n.empresa);
  }
  return porOC;
}

async function leerSupuestos() {
  const { data } = await sb.from('fs_parametro').select('clave,valor')
    .in('clave', ['trm_del_dia', 'colchon_trm_pct', 'costos_importacion_pct']);
  const m = new Map((data || []).map((r) => [r.clave, Number(r.valor)]));
  return {
    trm: m.get('trm_del_dia') || 0,
    colchonPct: m.get('colchon_trm_pct') ?? 0,
    importacionPct: m.get('costos_importacion_pct') ?? 0,
  };
}

/* ═══════════════════ Costeo, para mostrarlo en vivo ═══════════════════ */

/*
  El mismo cálculo que hace la base al guardar. Se replica acá solo
  para que Comercio Exterior vea el número antes de crear la orden.
  Desglosado a propósito: un costo que aparece como un total suelto no
  se puede discutir con Financiera.
*/
export function costearOrden(items, { trm = 0, colchonPct = 0, importacionPct = 0, esImportacion = false } = {}) {
  const subtotalUSD = items.reduce(
    (a, i) => a + Number(i.cantidad || 0) * Number(i.costo_unitario_usd || 0), 0);
  const trmEfectiva = Number(trm || 0) * (1 + Number(colchonPct || 0) / 100);
  const pct = esImportacion ? Number(importacionPct || 0) : 0;
  const productoCOP = Math.round(subtotalUSD * trmEfectiva);
  const importacionCOP = Math.round(productoCOP * pct / 100);
  const unidades = items.reduce((a, i) => a + Number(i.cantidad || 0), 0);
  const totalCOP = productoCOP + importacionCOP;
  return {
    subtotalUSD, trmEfectiva, pct, productoCOP, importacionCOP, totalCOP, unidades,
    unitarioEnBodega: unidades ? Math.round(totalCOP / unidades) : 0,
  };
}

/* ═══════════════════ Pantalla principal ═══════════════════ */

export async function renderCompras(container) {
  container.innerHTML = `
    <div class="fs-subtabs">
      <button class="fs-subtab active" data-vista="bandeja">Bandeja de requerimientos</button>
      <button class="fs-subtab" data-vista="ordenes">Órdenes de compra</button>
    </div>
    <div id="cmp-vista"></div>`;

  const vista = container.querySelector('#cmp-vista');
  const pintar = async (cual, boton) => {
    container.querySelectorAll('.fs-subtab').forEach((b) => b.classList.remove('active'));
    boton.classList.add('active');
    try {
      if (cual === 'ordenes') await renderOrdenes(vista);
      else await renderBandeja(vista);
    } catch (err) {
      console.error(err);
      vista.innerHTML = `<div class="fs-empty">No se pudo cargar: ${escapeHtml(err.message || err)}</div>`;
    }
  };
  container.querySelectorAll('.fs-subtab').forEach((b) => {
    b.addEventListener('click', () => pintar(b.dataset.vista, b));
  });
  await pintar('bandeja', container.querySelector('.fs-subtab'));
}

/* ═══════════════════ Bandeja ═══════════════════ */

async function renderBandeja(cont) {
  estadoCargando(cont, 'Cargando requerimientos...');
  const puedeArmar = tieneRol(...PUEDE_ARMAR);
  const [reqs, sup] = await Promise.all([cargarBandeja(), leerSupuestos()]);

  if (!reqs.length) {
    cont.innerHTML = `
      <div class="fs-ayuda-modo">
        No hay requerimientos por comprar. Se crean solos cuando se cierra un negocio y
        el stock de Fontibón no alcanza a cubrirlo.
      </div>`;
    return;
  }

  const tarde = reqs.filter((q) => q.nace_tarde).length;
  const sinRuta = reqs.filter((q) => !q.ruta_id).length;
  const clientes = new Set(reqs.map((q) => q.cliente).filter(Boolean)).size;

  cont.innerHTML = `
    <div class="fs-ayuda-modo">
      Selecciona los requerimientos que van en la misma compra y genera <strong>una sola
      orden consolidada</strong>. Una orden es <strong>un proveedor y una ruta</strong>, y puede
      cubrir cuantos negocios haga falta. También puedes comprar unidades de más para
      reponer stock mínimo: esas no quedan asignadas a ningún negocio.
      ${sup.trm ? '' : '<br><span class="fs-faltante">No hay TRM cargada: sin ella no se puede costear la orden.</span>'}
    </div>

    <div class="fs-resumen">
      <div class="fs-resumen-caja"><span>${reqs.length}</span>requerimientos</div>
      <div class="fs-resumen-caja"><span>${clientes}</span>clientes esperando</div>
      <div class="fs-resumen-caja"><span>${reqs.reduce((a, q) => a + q.cantidad_sin_asignar, 0)}</span>unidades por comprar</div>
      <div class="fs-resumen-caja ${tarde ? 'error' : ''}"><span>${tarde}</span>nacen tarde</div>
      ${sinRuta ? `<div class="fs-resumen-caja aviso"><span>${sinRuta}</span>sin ruta definida</div>` : ''}
    </div>

    ${tarde ? `<div class="fs-nota-toolbar">
      <span class="fs-faltante">${tarde} requerimiento(s) nacen tarde</span>: el lead time de su ruta
      es mayor que los días que faltan para la fecha de necesidad. Por rápido que se compre, no
      alcanzan. Habría que avisarle al cliente o buscar otra ruta.</div>` : ''}

    <div class="fs-toolbar">
      <select id="bnd-agrupar" class="fs-input" style="max-width:200px">
        <option value="proveedor">Agrupar por proveedor</option>
        <option value="sku">Agrupar por SKU</option>
        <option value="ruta">Agrupar por ruta</option>
        <option value="">Sin agrupar</option>
      </select>
      <input type="text" id="bnd-buscar" class="fs-input" style="max-width:240px"
             placeholder="Buscar cliente, SKU, negocio...">
      <span class="fs-conteo-filas" id="bnd-conteo"></span>
      ${puedeArmar ? `<button id="bnd-generar" class="fs-btn-primary" disabled>
        Generar orden consolidada (<span id="bnd-sel">0</span>)</button>` : ''}
    </div>

    <div id="bnd-tabla"></div>`;

  const pintarTabla = () => {
    const agrupar = cont.querySelector('#bnd-agrupar').value;
    const clave = (q) => (agrupar === 'sku' ? q.sku
      : agrupar === 'ruta' ? (q.ruta_nombre || 'Sin ruta')
        : agrupar === 'proveedor' ? (q.proveedor || 'Sin proveedor') : '');

    const grupos = new Map();
    for (const q of reqs) {
      const k = clave(q);
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k).push(q);
    }

    cont.querySelector('#bnd-tabla').innerHTML = [...grupos.entries()].map(([k, lista]) => `
      ${k ? `<h4 class="fs-h4">${escapeHtml(k)} — ${lista.length} requerimiento(s),
             ${lista.reduce((a, q) => a + q.cantidad_sin_asignar, 0)} unidades</h4>` : ''}
      <table class="fs-tabla bnd-t">
        <thead><tr>
          <th style="width:36px"><input type="checkbox" class="bnd-todos" title="Seleccionar todo el grupo"></th>
          <th data-orden="texto" style="width:110px">Negocio</th>
          <th data-orden="texto">Cliente</th>
          <th data-orden="texto" style="width:130px">SKU</th>
          <th data-orden="numero" style="width:90px">Cantidad</th>
          <th data-orden="texto" style="width:150px">Proveedor</th>
          <th data-orden="texto" style="width:110px">Ruta</th>
          <th data-orden="numero" style="width:100px">Necesidad</th>
          <th data-orden="numero" style="width:110px">Días</th>
        </tr></thead>
        <tbody>
          ${lista.map((q) => `<tr data-id="${q.id}" ${q.nace_tarde ? 'style="background:var(--red-light)"' : ''}>
            <td><input type="checkbox" class="bnd-chk" data-id="${q.id}"></td>
            <td>${escapeHtml(q.negocio_codigo || '—')}</td>
            <td>${escapeHtml(q.cliente || '—')}</td>
            <td>${escapeHtml(q.sku)}<br><small class="fs-par-desc">${escapeHtml(q.producto || '')}</small></td>
            <td data-orden="${q.cantidad_sin_asignar}">${q.cantidad_sin_asignar}</td>
            <td>${escapeHtml(q.proveedor || '—')}</td>
            <td>${q.ruta_codigo ? `${escapeHtml(q.ruta_codigo)} · ${q.dias_ruta_estimados}d`
                  : '<span class="fs-faltante">sin ruta</span>'}</td>
            <td data-orden="${q.fecha_necesidad || ''}">${q.fecha_necesidad ? formatoFecha(q.fecha_necesidad) : '—'}</td>
            <td data-orden="${q.dias_restantes ?? 0}">${q.dias_restantes == null ? '—'
                  : q.nace_tarde ? `<span class="fs-faltante">${q.dias_restantes}d, ruta ${q.dias_ruta_estimados}d</span>`
                    : `${q.dias_restantes}d`}</td>
          </tr>`).join('')}
        </tbody>
      </table>`).join('');

    cont.querySelectorAll('.bnd-t').forEach((t) => hacerOrdenable(t));
    cont.querySelectorAll('.bnd-todos').forEach((c) => c.addEventListener('change', (e) => {
      e.target.closest('table').querySelectorAll('.bnd-chk').forEach((k) => { k.checked = e.target.checked; });
      refrescarSeleccion();
    }));
    cont.querySelectorAll('.bnd-chk').forEach((c) => c.addEventListener('change', refrescarSeleccion));
    refrescarSeleccion();
  };

  const seleccionados = () => [...cont.querySelectorAll('.bnd-chk')]
    .filter((c) => c.checked).map((c) => reqs.find((q) => q.id === c.dataset.id)).filter(Boolean);

  function refrescarSeleccion() {
    const sel = seleccionados();
    const spanSel = cont.querySelector('#bnd-sel');
    if (spanSel) spanSel.textContent = String(sel.length);
    const btn = cont.querySelector('#bnd-generar');
    if (!btn) return;

    // Una orden = un proveedor + una ruta. Si la selección mezcla, no
    // se puede consolidar y hay que decir por qué, no solo deshabilitar.
    const provs = new Set(sel.map((q) => q.proveedor_id || 'sin'));
    const rutas = new Set(sel.map((q) => q.ruta_id || 'sin'));
    const mezcla = provs.size > 1 || rutas.size > 1;
    const sinRutaSel = sel.some((q) => !q.ruta_id);

    btn.disabled = !sel.length || mezcla || sinRutaSel;
    const nota = cont.querySelector('#bnd-conteo');
    if (!sel.length) nota.textContent = `${reqs.length} requerimientos`;
    else if (mezcla) nota.innerHTML = '<span class="fs-faltante">La selección mezcla proveedores o rutas: una orden es de un solo proveedor y una sola ruta.</span>';
    else if (sinRutaSel) nota.innerHTML = '<span class="fs-faltante">Hay un requerimiento sin ruta: defínele la ruta al producto en el catálogo.</span>';
    else nota.textContent = `${sel.length} seleccionados · ${sel.reduce((a, q) => a + q.cantidad_sin_asignar, 0)} unidades · ${new Set(sel.map((q) => q.negocio_codigo)).size} negocio(s)`;
  }

  cont.querySelector('#bnd-agrupar').addEventListener('change', pintarTabla);
  if (puedeArmar) {
    cont.querySelector('#bnd-generar').addEventListener('click',
      () => abrirFormularioOC(seleccionados(), sup, () => renderBandeja(cont)));
  }
  pintarTabla();
  hacerFiltrable(cont.querySelector('#bnd-buscar'), cont.querySelector('.bnd-t'), null);
}

/* ═══════════════════ Formulario de la orden ═══════════════════ */

async function abrirFormularioOC(sel, sup, alGuardar) {
  if (!sel.length) return;

  // Los requerimientos del mismo SKU se juntan en un solo ítem: al
  // proveedor se le compra una cantidad, no una por negocio.
  const porSku = new Map();
  for (const q of sel) {
    if (!porSku.has(q.producto_id)) {
      porSku.set(q.producto_id, {
        producto_id: q.producto_id, sku: q.sku, nombre: q.producto,
        costo_unitario_usd: q.costo_usd ?? null,
        asignado: 0, extra: 0, asignaciones: [],
      });
    }
    const it = porSku.get(q.producto_id);
    it.asignado += q.cantidad_sin_asignar;
    it.asignaciones.push({
      requerimiento_id: q.id, cantidad: q.cantidad_sin_asignar,
      negocio: q.negocio_codigo, cliente: q.cliente,
    });
  }
  const items = [...porSku.values()];
  const esImp = esRutaImportacion(sel[0].ruta_estimada) || sel[0].ruta_modo === 'importacion';

  const ov = document.createElement('div');
  ov.className = 'fs-modal-overlay show';
  ov.innerHTML = `
    <div class="fs-modal fs-modal-ancho">
      <div class="fs-modal-title">Orden de compra consolidada</div>
      <div class="fs-ayuda-modo">
        Consolida <strong>${new Set(sel.map((q) => q.negocio_codigo)).size} negocio(s)</strong>
        de ${new Set(sel.map((q) => q.cliente)).size} cliente(s) en una sola orden a
        <strong>${escapeHtml(sel[0].proveedor || '—')}</strong> por la ruta
        <strong>${escapeHtml(sel[0].ruta_nombre || '—')}</strong>.
        ${esImp ? 'Es ruta de importación, así que se suma el porcentaje de costos de importación.'
          : 'Es ruta local: el proveedor factura la mercancía ya nacionalizada, así que <strong>no</strong> se suma el porcentaje de importación.'}
      </div>

      <div class="fs-form-grid">
        <label>TRM presupuestada
          <input type="number" id="oc-trm" step="0.01" value="${sup.trm || ''}">
          <small class="fs-par-desc">Viene de la TRM del día. Editable.</small>
        </label>
        <label>Colchón sobre la TRM (%)
          <input type="number" id="oc-colchon" step="0.1" value="${sup.colchonPct}">
        </label>
        <label>Costos de importación (%)
          <input type="number" id="oc-imp" step="0.1" value="${esImp ? sup.importacionPct : 0}" ${esImp ? '' : 'disabled'}>
          ${esImp ? '' : '<small class="fs-par-desc">Deshabilitado: la ruta es local.</small>'}
        </label>
        <label>Moneda
          <select id="oc-moneda">
            <option value="USD">USD</option><option value="COP">COP</option><option value="EUR">EUR</option>
          </select>
        </label>
        <label class="fs-full">Observaciones
          <textarea id="oc-obs" placeholder="Ej: pactado 15 días de producción con el proveedor"></textarea>
        </label>
      </div>

      <h4 class="fs-h4">Ítems y a qué negocios se asignan</h4>
      <div id="oc-items"></div>

      <h4 class="fs-h4">Costeo</h4>
      <div id="oc-costeo"></div>

      <div class="fs-modal-actions">
        <button class="fs-btn-secundario" id="oc-cancelar">Cancelar</button>
        <button class="fs-btn-primary" id="oc-guardar">Crear orden en borrador</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const $ = (s) => ov.querySelector(s);

  function pintarItems() {
    $('#oc-items').innerHTML = `
      <table class="fs-tabla fs-tabla-hitos">
        <thead><tr>
          <th>SKU</th><th style="width:110px">Para negocios</th>
          <th style="width:120px">Extra reposición</th><th style="width:90px">Total compra</th>
          <th style="width:130px">Costo unit. USD</th><th>Asignaciones</th>
        </tr></thead>
        <tbody>
          ${items.map((it, i) => `<tr data-i="${i}">
            <td>${escapeHtml(it.sku)}<br><small class="fs-par-desc">${escapeHtml(it.nombre || '')}</small></td>
            <td>${it.asignado}</td>
            <td><input type="number" min="0" class="oc-extra" value="${it.extra}"></td>
            <td><strong>${it.asignado + Number(it.extra || 0)}</strong></td>
            <td><input type="number" min="0" step="0.01" class="oc-costo"
                       value="${it.costo_unitario_usd ?? ''}" placeholder="sin costo"></td>
            <td><small class="fs-par-desc">${it.asignaciones.map((a) =>
                  `${escapeHtml(a.negocio || '?')} (${escapeHtml(a.cliente || '?')}): ${a.cantidad}`).join('<br>')}</small></td>
          </tr>`).join('')}
        </tbody>
      </table>`;

    $('#oc-items').querySelectorAll('.oc-extra').forEach((inp) => inp.addEventListener('input', (e) => {
      items[Number(e.target.closest('tr').dataset.i)].extra = Math.max(0, Number(e.target.value) || 0);
      pintarItems(); pintarCosteo();
    }));
    $('#oc-items').querySelectorAll('.oc-costo').forEach((inp) => inp.addEventListener('input', (e) => {
      const v = e.target.value.trim();
      items[Number(e.target.closest('tr').dataset.i)].costo_unitario_usd = v === '' ? null : Number(v);
      pintarCosteo();
    }));
  }

  function paraCostear() {
    return items.map((it) => ({
      cantidad: it.asignado + Number(it.extra || 0),
      costo_unitario_usd: it.costo_unitario_usd,
    }));
  }

  function pintarCosteo() {
    const c = costearOrden(paraCostear(), {
      trm: Number($('#oc-trm').value) || 0,
      colchonPct: Number($('#oc-colchon').value) || 0,
      importacionPct: Number($('#oc-imp').value) || 0,
      esImportacion: esImp,
    });
    const sinCosto = items.filter((it) => !Number(it.costo_unitario_usd)).length;

    $('#oc-costeo').innerHTML = `
      <table class="fs-tabla">
        <tbody>
          <tr><td>Subtotal del proveedor</td><td style="width:180px;text-align:right"><strong>${formatoUSD(c.subtotalUSD)}</strong></td></tr>
          <tr><td>TRM efectiva (TRM + colchón)</td><td style="text-align:right">${c.trmEfectiva ? c.trmEfectiva.toLocaleString('es-CO', { maximumFractionDigits: 2 }) : '—'}</td></tr>
          <tr><td>Costo del producto en pesos</td><td style="text-align:right">${formatoCOP(c.productoCOP)}</td></tr>
          <tr><td>Costos de importación estimados (${c.pct}%)</td><td style="text-align:right">${formatoCOP(c.importacionCOP)}</td></tr>
          <tr><td><strong>Costo total estimado</strong></td><td style="text-align:right"><strong>${formatoCOP(c.totalCOP)}</strong></td></tr>
          <tr><td>Unidades</td><td style="text-align:right">${c.unidades}</td></tr>
          <tr><td><strong>Costo unitario puesto en bodega</strong></td><td style="text-align:right"><strong>${formatoCOP(c.unitarioEnBodega)}</strong></td></tr>
        </tbody>
      </table>
      <div class="fs-nota-toolbar">
        Los costos de importación son un <strong>estimado por porcentaje</strong>. Los reales se
        liquidan por concepto cuando llegue la mercancía, y ahí se compara estimado contra real.
        Todo antes de IVA.
        ${sinCosto ? `<br><span class="fs-faltante">${sinCosto} ítem(s) sin costo unitario: el total va a quedar incompleto.</span>` : ''}
      </div>`;
  }

  ['#oc-trm', '#oc-colchon', '#oc-imp'].forEach((s) => $(s).addEventListener('input', pintarCosteo));
  $('#oc-cancelar').addEventListener('click', () => ov.remove());

  $('#oc-guardar').addEventListener('click', async () => {
    const trm = Number($('#oc-trm').value) || 0;
    if (trm <= 0) { mostrarToast('La orden necesita TRM presupuestada.', 'aviso'); return; }
    const sinCosto = items.filter((it) => !Number(it.costo_unitario_usd));
    if (sinCosto.length && !confirmar(
      `${sinCosto.length} ítem(s) van sin costo unitario: ${sinCosto.map((i) => i.sku).join(', ')}.\n\n`
      + 'El costo total de la orden va a quedar incompleto y Financiera no va a poder evaluarla. '
      + '¿Crear la orden de todas formas?')) return;

    const payload = {
      proveedor_id: sel[0].proveedor_id,
      ruta_id: sel[0].ruta_id,
      moneda: $('#oc-moneda').value,
      trm_presupuestada: trm,
      colchon_trm_pct: Number($('#oc-colchon').value) || 0,
      costos_importacion_pct: Number($('#oc-imp').value) || 0,
      observaciones: $('#oc-obs').value.trim() || null,
      creado_por: perfilActual()?.id ?? null,
      items: items.map((it) => ({
        producto_id: it.producto_id,
        cantidad: it.asignado + Number(it.extra || 0),
        costo_unitario_usd: it.costo_unitario_usd,
        asignaciones: it.asignaciones.map((a) => ({
          requerimiento_id: a.requerimiento_id, cantidad: a.cantidad,
        })),
      })),
    };

    const { data, error } = await sb.rpc('fs_crear_oc_consolidada', { p_datos: payload });
    if (error) {
      console.error(error);
      mostrarToast(`No se pudo crear la orden: ${error.message || error}`, 'error');
      return;
    }
    const r = (data || [])[0] || {};
    ov.remove();
    mostrarResumenOC(r);
    alGuardar();
  });

  pintarItems();
  pintarCosteo();
}

function mostrarResumenOC(r) {
  const ov = document.createElement('div');
  ov.className = 'fs-modal-overlay show';
  ov.innerHTML = `
    <div class="fs-modal">
      <div class="fs-modal-title">Orden ${escapeHtml(r.codigo || '')} creada en borrador</div>
      <div class="fs-resumen">
        <div class="fs-resumen-caja"><span>${r.negocios_cubiertos ?? 0}</span>negocios cubiertos</div>
        <div class="fs-resumen-caja"><span>${r.requerimientos_cubiertos ?? 0}</span>requerimientos</div>
        <div class="fs-resumen-caja"><span>${formatoCOP(r.costo_total_cop || 0)}</span>costo total estimado</div>
      </div>
      <div class="fs-ayuda-modo">
        Queda en <strong>borrador</strong>. Revísala en la pestaña Órdenes de compra y envíala a
        aprobación financiera cuando esté lista. El cronograma de hitos se genera al aprobarla.
      </div>
      <div class="fs-modal-actions"><button class="fs-btn-primary" data-cerrar>Entendido</button></div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-cerrar]').addEventListener('click', () => ov.remove());
}

/* ═══════════════════ Listado de órdenes ═══════════════════ */

async function renderOrdenes(cont) {
  estadoCargando(cont, 'Cargando órdenes...');
  const [ordenes, cobertura] = await Promise.all([cargarOrdenes(), cargarCoberturaOrdenes()]);
  const puedeArmar = tieneRol(...PUEDE_ARMAR);
  const puedeAprobar = tieneRol(...PUEDE_APROBAR);

  if (!ordenes.length) {
    cont.innerHTML = `<div class="fs-ayuda-modo">
      Todavía no hay órdenes de compra. Se crean desde la bandeja de requerimientos,
      seleccionando los que van en la misma compra.</div>`;
    return;
  }

  const porEstado = (e) => ordenes.filter((o) => o.estado === e);
  cont.innerHTML = `
    <div class="fs-resumen">
      <div class="fs-resumen-caja"><span>${porEstado('borrador').length}</span>en borrador</div>
      <div class="fs-resumen-caja ${porEstado('pendiente_aprobacion').length ? 'aviso' : ''}">
        <span>${porEstado('pendiente_aprobacion').length}</span>esperan a Financiera</div>
      <div class="fs-resumen-caja"><span>${porEstado('aprobada').length + porEstado('en_ejecucion').length}</span>aprobadas o en curso</div>
      <div class="fs-resumen-caja"><span>${formatoCOP(ordenes
        .filter((o) => o.estado === 'pendiente_aprobacion')
        .reduce((a, o) => a + Number(o.costo_total_estimado_cop || 0), 0))}</span>monto por aprobar</div>
    </div>

    <div class="fs-toolbar">
      <input type="text" id="oc-buscar" class="fs-input" style="max-width:260px"
             placeholder="Buscar orden, proveedor, cliente...">
      <span class="fs-conteo-filas" id="oc-conteo"></span>
      ${puedeAprobar ? '' : `<span class="fs-nota-toolbar">Tu rol (${escapeHtml(rolFSActual() || 'sin rol')}) no aprueba órdenes: eso es de Financiera.</span>`}
    </div>

    <table class="fs-tabla" id="oc-tabla">
      <thead><tr>
        <th data-orden="texto" style="width:110px">Orden</th>
        <th data-orden="texto">Proveedor y ruta</th>
        <th data-orden="texto" style="width:160px">Estado</th>
        <th data-orden="numero" style="width:110px">USD</th>
        <th data-orden="numero" style="width:140px">Total COP</th>
        <th>Desbloquea</th>
        <th style="width:190px"></th>
      </tr></thead>
      <tbody>
        ${ordenes.map((o) => {
          const cob = cobertura.get(o.id);
          const negs = cob ? [...cob.negocios.entries()] : [];
          return `<tr data-id="${o.id}">
            <td>${escapeHtml(o.codigo)}<br><small class="fs-par-desc">${formatoFecha(o.creado_en)}</small></td>
            <td>${escapeHtml(o.fs_proveedor?.nombre || '—')}
                <br><small class="fs-par-desc">${escapeHtml(o.fs_ruta?.nombre || 'sin ruta')}</small></td>
            <td>${ESTADOS_OC[o.estado] || o.estado}
                ${o.estado === 'aprobada' && o.fecha_aprobacion
                  ? `<br><small class="fs-par-desc">${formatoFecha(o.fecha_aprobacion)}</small>` : ''}</td>
            <td data-orden="${o.subtotal_usd || 0}">${o.subtotal_usd ? formatoUSD(o.subtotal_usd) : '—'}</td>
            <td data-orden="${o.costo_total_estimado_cop || 0}">${o.costo_total_estimado_cop ? formatoCOP(o.costo_total_estimado_cop) : '<span class="fs-faltante">sin costear</span>'}</td>
            <td><small class="fs-par-desc">${negs.length
                  ? negs.map(([c, e]) => `${escapeHtml(c)} · ${escapeHtml(e)}`).join('<br>')
                  : 'solo reposición de stock'}</small></td>
            <td>
              ${o.estado === 'borrador' && puedeArmar ? '<button class="fs-btn-link oc-enviar">Enviar a aprobación</button>' : ''}
              ${o.estado === 'pendiente_aprobacion' && puedeAprobar ? '<button class="fs-btn-link oc-aprobar">Aprobar</button>' : ''}
              ${['pendiente_aprobacion', 'aprobada'].includes(o.estado) && (puedeAprobar || puedeArmar)
                ? ' · <button class="fs-btn-link oc-devolver">Devolver</button>' : ''}
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;

  const tabla = cont.querySelector('#oc-tabla');
  hacerOrdenable(tabla);
  hacerFiltrable(cont.querySelector('#oc-buscar'), tabla, cont.querySelector('#oc-conteo'));

  const idDe = (e) => e.target.closest('tr').dataset.id;
  const llamar = async (fn, args, exito) => {
    const { data, error } = await sb.rpc(fn, args);
    if (error) {
      console.error(error);
      mostrarToast(error.message || String(error), 'error');
      return false;
    }
    mostrarToast(data || exito, 'exito');
    await renderOrdenes(cont);
    return true;
  };

  cont.querySelectorAll('.oc-enviar').forEach((b) => b.addEventListener('click', (e) => {
    llamar('fs_enviar_oc_a_aprobacion', { p_oc: idDe(e) }, 'Enviada a aprobación.');
  }));
  cont.querySelectorAll('.oc-aprobar').forEach((b) => b.addEventListener('click', async (e) => {
    const id = idDe(e);
    const o = ordenes.find((x) => x.id === id);
    const cob = cobertura.get(id);
    const negs = cob ? [...cob.negocios.entries()] : [];
    if (!confirmar(
      `Aprobar la orden ${o.codigo} por ${formatoCOP(o.costo_total_estimado_cop || 0)}.\n\n`
      + (negs.length ? `Desbloquea: ${negs.map(([c, em]) => `${c} (${em})`).join(', ')}.\n\n`
        : 'No cubre ningún negocio: es solo reposición de stock.\n\n')
      + '¿Confirmar la aprobación?')) return;
    llamar('fs_aprobar_oc', { p_oc: id, p_nota: null }, 'Orden aprobada.');
  }));
  cont.querySelectorAll('.oc-devolver').forEach((b) => b.addEventListener('click', (e) => {
    const motivo = window.prompt('¿Por qué se devuelve a borrador?\n(queda en las observaciones y en la bitácora)');
    if (motivo === null) return;
    if (!motivo.trim()) { mostrarToast('El motivo es obligatorio.', 'aviso'); return; }
    llamar('fs_devolver_oc_a_borrador', { p_oc: idDe(e), p_motivo: motivo.trim() }, 'Devuelta a borrador.');
  }));
}
