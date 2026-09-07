/* ═══════════════════════════════════════════════════════
   negocios.js — Fase 3A

   Una sola entidad para las tres naturalezas, para que un forecast
   se convierta en pipeline y un pipeline en cerrado sin volver a
   digitar nada:
     forecast → cliente probable, combo, vehículos, mes estimado
     pipeline → además etapa y probabilidad
     cerrado  → además fecha real y documento soporte

   Reglas que manda el negocio:
   - La escala de precio la decide el NÚMERO DE VEHÍCULOS, no las
     unidades de cada SKU: 8 vehículos con 2 cámaras cada uno siguen
     siendo escala "hasta 10".
   - La modalidad es POR LÍNEA: el cliente puede comprar las cámaras y
     tomar los GPS en comodato. El encabezado queda "mixto" y lo
     recalcula la base sola.
   - Geotab no tiene puntos medios: o compra, o comodato a 36 meses sin
     mensualidad de comodato. Lo valida la base, y acá se avisa antes.
   - La mensualidad de servicio siempre existe, en venta y en comodato,
     y es por vehículo, no por SKU.
   - Los precios y los costos se congelan al armar el negocio. Si mañana
     cambia la lista o la TRM, este negocio no se mueve.
   - Todos los valores son antes de IVA.
   ═══════════════════════════════════════════════════════ */

import { sb } from './supabaseClient.js';
import { perfilActual, tieneRol } from './auth.js';
import {
  mostrarToast, confirmar, escapeHtml, estadoCargando,
  hacerOrdenable, hacerFiltrable,
} from './ui.js';
import { formatoCOP, formatoFecha, fechaHoyBogota } from './formato.js';
import { obtenerTRM, etiquetaOrigenTRM } from './trm.js';
import { calcularCambios, registrarAuditoria } from './auditoria.js';
import {
  ROLES_EDITAN_NEGOCIOS, NATURALEZAS, MODALIDADES, PLAZOS_COMODATO,
  PLAZO_UNICO_GEOTAB, UMBRAL_ESCALA_VOLUMEN, RUTAS, ESTADOS_EJECUCION,
  esRutaImportacion,
} from './config.js';

/* ═══════════════════ Reglas de cálculo ═══════════════════ */

/*
  La escala sale de los vehículos (combos), no de las unidades.
  Está acá y no repetida en cada pantalla porque es la regla que más
  fácil se aplica mal.
*/
export function escalaPorVehiculos(vehiculos) {
  return Number(vehiculos) > UMBRAL_ESCALA_VOLUMEN ? '11+' : '1-10';
}

/*
  Costo del SKU en pesos, completo. Tres pasos, y cada uno tiene su
  razón:

  1. La moneda. Solo lo que se factura en USD pasa por la TRM; lo que
     el proveedor factura en pesos entra tal cual.
  2. El colchón sobre la TRM. Se cotiza con la TRM un poco arriba
     porque entre cotizar y pagar el dólar se mueve, y quedarse corto
     se come el margen.
  3. Los costos de importación, SOLO si el producto viene por una ruta
     de importación. En la ruta local el proveedor colombiano ya
     factura la mercancía nacionalizada: sumarle el porcentaje ahí
     sería cobrar el flete y la aduana dos veces.

  Devuelve el desglose además del total, porque un costo que aparece
  como un solo número y nadie sabe de dónde salió no se puede discutir
  con Financiera.
*/
export function costearProducto(producto, { trm = 0, colchonPct = 0, importacionPct = 0 } = {}) {
  const base = Number(producto?.costo_usd ?? 0);
  const enCOP = producto?.costo_moneda === 'COP';
  const importado = esRutaImportacion(producto?.ruta_habitual);

  if (!base) {
    return { total: 0, base: 0, enCOP, importado, trmEfectiva: null, sinCosto: true };
  }

  const trmEfectiva = enCOP ? null : Number(trm || 0) * (1 + Number(colchonPct || 0) / 100);
  const enPesos = enCOP ? base : base * trmEfectiva;
  const conImportacion = importado ? enPesos * (1 + Number(importacionPct || 0) / 100) : enPesos;

  return {
    total: Math.round(conImportacion),
    base,
    enCOP,
    importado,
    trmEfectiva,
    sinTRM: !enCOP && !Number(trm),
    antesDeImportacion: Math.round(enPesos),
    sinCosto: false,
  };
}

// Se conserva la firma vieja para no romper nada que la llame; internamente
// usa la de arriba.
export function costoEnCOP(producto, trm) {
  return costearProducto(producto, { trm }).total;
}

/*
  Explota el combo por la cantidad de vehículos: cada ítem del combo
  se multiplica por los vehículos. Es lo que convierte "combo básico ×
  8 vehículos" en "8 cámaras, 8 SIM, 8 GO9".
*/
export function explotarCombo(items, vehiculos) {
  const veh = Math.max(1, Number(vehiculos) || 1);
  return (items || []).map((it) => ({
    producto_id: it.producto_id,
    producto: it.fs_productos,
    cantidad: Number(it.cantidad) * veh,
    cantidad_por_vehiculo: Number(it.cantidad),
  }));
}

/*
  Avisa cuando el negocio lleva equipo que necesita conectividad pero
  no tiene línea de SIM. El requerimiento de SIM no se inventa contando
  equipos: se cuenta la línea de SIM, que es la que se le compra a M2M.
  Este chequeo solo señala el olvido.
*/
export function revisarConectividad(lineas) {
  const sims = lineas
    .filter((l) => l.producto?.categoria === 'sim')
    .reduce((n, l) => n + Number(l.cantidad || 0), 0);
  const equiposConSim = lineas
    .filter((l) => l.producto?.requiere_sim)
    .reduce((n, l) => n + Number(l.cantidad || 0), 0);
  return {
    sims,
    equiposConSim,
    falta: equiposConSim > sims ? equiposConSim - sims : 0,
    sobran: sims > equiposConSim ? sims - equiposConSim : 0,
  };
}

/*
  Totales para mostrar en vivo mientras se arma. La base recalcula lo
  mismo al guardar (fs_recalcular_totales_negocio); acá se replica solo
  para que el usuario vea el resultado antes de guardar.
*/
export function totalesDeLineas(lineas, vehiculos, mensualidadServicioUnitaria) {
  let venta = 0;
  let mrrComodato = 0;
  let costo = 0;
  for (const l of lineas) {
    const cant = Number(l.cantidad || 0);
    costo += cant * Number(l.costo_unitario_cop || 0);
    if (l.modalidad === 'comodato') {
      mrrComodato += cant * Number(l.mensualidad_comodato_cop || 0);
    } else {
      venta += cant * Number(l.precio_unitario_cop || 0);
    }
  }
  const mrrServicio = Number(mensualidadServicioUnitaria || 0) * Math.max(0, Number(vehiculos) || 0);
  return {
    venta, mrrComodato, mrrServicio, costo,
    margen: venta - costo,
    margenPct: venta > 0 ? Math.round(((venta - costo) / venta) * 1000) / 10 : null,
    mrrTotal: mrrServicio + mrrComodato,
  };
}

/* ═══════════════════ Datos ═══════════════════ */

/*
  Los tres supuestos con los que se costea: TRM del día, colchón sobre
  la TRM y porcentaje de costos de importación. Se leen juntos porque
  los tres se guardan en el negocio para poder reconstruir el costo
  después, aunque mañana alguien cambie los parámetros.

  La TRM ya no se teclea: la trae trm.js de la fuente oficial. Los dos
  porcentajes sí siguen siendo decisión de Financiera y viven en los
  parámetros.
*/
async function leerSupuestos() {
  const [{ data }, trmInfo] = await Promise.all([
    sb.from('fs_parametro').select('clave,valor')
      .in('clave', ['colchon_trm_pct', 'costos_importacion_pct']),
    obtenerTRM(),
  ]);
  const m = new Map((data || []).map((r) => [r.clave, Number(r.valor)]));
  return {
    trm: Number(trmInfo.valor) > 0 ? Number(trmInfo.valor) : 0,
    trmOrigen: trmInfo.origen,
    trmEtiqueta: etiquetaOrigenTRM(trmInfo),
    trmAviso: trmInfo.aviso,
    colchonPct: Number.isFinite(m.get('colchon_trm_pct')) ? m.get('colchon_trm_pct') : 0,
    importacionPct: Number.isFinite(m.get('costos_importacion_pct')) ? m.get('costos_importacion_pct') : 0,
  };
}

async function cargarNegocios() {
  const { data, error } = await sb.from('fs_negocio_vista').select('*').order('creado_en', { ascending: false });
  if (error) {
    console.error(error);
    mostrarToast('No se pudieron cargar los negocios.', 'error');
    return [];
  }
  return data || [];
}

async function cargarEtapas() {
  const { data } = await sb.from('fs_etapa_pipeline').select('*').eq('activa', true).order('orden');
  return data || [];
}

async function cargarCombosVigentes() {
  const { data } = await sb.from('fs_combos').select('*').eq('vigente', true).order('nombre');
  return data || [];
}

async function cargarItemsCombo(comboId) {
  const { data, error } = await sb.from('fs_combo_items')
    .select('cantidad,producto_id,fs_productos(id,sku,nombre,marca,categoria,costo_usd,costo_moneda,requiere_sim,aplica_comodato)')
    .eq('combo_id', comboId);
  if (error) {
    console.error(error);
    return [];
  }
  return data || [];
}

/*
  Precios vigentes de varios SKU en una sola consulta. Se piden las
  versiones abiertas (vigente_hasta nulo), que desde el script 21 son
  únicas por SKU y escala.
*/
async function preciosVigentes(productoIds) {
  if (!productoIds.length) return { venta: new Map(), comodato: new Map() };
  const [{ data: pv }, { data: pc }] = await Promise.all([
    sb.from('fs_precio_lista').select('producto_id,escala,precio_venta_cop')
      .in('producto_id', productoIds).is('vigente_hasta', null),
    sb.from('fs_precio_comodato').select('producto_id,escala,plazo_meses,mensualidad_comodato_cop')
      .in('producto_id', productoIds).is('vigente_hasta', null),
  ]);
  const venta = new Map();
  (pv || []).forEach((r) => venta.set(`${r.producto_id}|${r.escala}`, Number(r.precio_venta_cop)));
  const comodato = new Map();
  (pc || []).forEach((r) => comodato.set(`${r.producto_id}|${r.escala}|${r.plazo_meses}`, Number(r.mensualidad_comodato_cop)));
  return { venta, comodato };
}

async function buscarClientes(texto) {
  if (!texto || texto.trim().length < 2) return [];
  const t = texto.trim();
  const { data } = await sb.from('fs_cliente')
    .select('id,nit_formateado,nit_normalizado,razon_social,nombre_comercial')
    .or(`razon_social.ilike.%${t}%,nombre_comercial.ilike.%${t}%,nit_normalizado.ilike.%${t}%`)
    .eq('activo', true).limit(20);
  return data || [];
}

const nombreCliente = (c) => c?.nombre_comercial || c?.razon_social || '(sin nombre)';

/* ═══════════════════ Pantalla: listado ═══════════════════ */

export async function renderNegocios(container) {
  estadoCargando(container, 'Cargando negocios...');
  const puedeEditar = tieneRol(...ROLES_EDITAN_NEGOCIOS);
  const [negocios, etapas] = await Promise.all([cargarNegocios(), cargarEtapas()]);

  container.innerHTML = `
    <div class="fs-ayuda-modo">
      El mismo negocio recorre las tres naturalezas sin volver a digitarse:
      <strong>forecast</strong> para proyectar, <strong>pipeline</strong> cuando ya hay etapa y
      probabilidad, y <strong>cerrado</strong> cuando hay documento soporte. La escala de precio
      la decide el número de vehículos, y cada línea puede ser venta o comodato por separado.
      Todos los valores van antes de IVA.
    </div>

    <div class="fs-toolbar">
      ${puedeEditar ? '<button id="neg-nuevo" class="fs-btn-primary">+ Nuevo negocio</button>' : ''}
      <input type="text" id="neg-buscar" class="fs-input" style="max-width:260px"
             placeholder="Buscar cliente, código, combo...">
      <select id="neg-f-naturaleza" class="fs-input" style="max-width:150px">
        <option value="">Toda naturaleza</option>
        ${Object.entries(NATURALEZAS).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
      </select>
      <select id="neg-f-etapa" class="fs-input" style="max-width:150px">
        <option value="">Toda etapa</option>
        ${etapas.map((e) => `<option value="${e.id}">${escapeHtml(e.nombre)}</option>`).join('')}
      </select>
      <select id="neg-f-modalidad" class="fs-input" style="max-width:150px">
        <option value="">Toda modalidad</option>
        ${Object.entries(MODALIDADES).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
      </select>
      <span class="fs-conteo-filas" id="neg-conteo"></span>
    </div>

    <div id="neg-resumen"></div>
    <div id="neg-tabla"></div>
  `;

  const cuerpo = container.querySelector('#neg-tabla');
  const filtrar = () => {
    const nat = container.querySelector('#neg-f-naturaleza').value;
    const et = container.querySelector('#neg-f-etapa').value;
    const mod = container.querySelector('#neg-f-modalidad').value;
    const visibles = negocios.filter((n) =>
      (!nat || n.naturaleza === nat) && (!et || n.etapa_id === et) && (!mod || n.modalidad === mod));
    pintarResumen(container.querySelector('#neg-resumen'), visibles);
    pintarTabla(cuerpo, visibles, puedeEditar, container, () => renderNegocios(container));
    // El filtro de texto se re-arma sobre la tabla recién pintada
    hacerFiltrable(container.querySelector('#neg-buscar'),
      cuerpo.querySelector('#neg-tabla-datos'), container.querySelector('#neg-conteo'));
  };

  ['#neg-f-naturaleza', '#neg-f-etapa', '#neg-f-modalidad'].forEach((sel) => {
    container.querySelector(sel).addEventListener('change', filtrar);
  });

  if (puedeEditar) {
    container.querySelector('#neg-nuevo').addEventListener('click',
      () => abrirFormulario(null, () => renderNegocios(container)));
  }

  filtrar();
}

function pintarResumen(el, negocios) {
  const suma = (f, filtro) => negocios.filter(filtro).reduce((n, x) => n + Number(f(x) || 0), 0);
  const esPipe = (n) => n.naturaleza === 'pipeline';
  const esCerrado = (n) => n.naturaleza === 'cerrado';
  const esFc = (n) => n.naturaleza === 'forecast';

  el.innerHTML = `
    <div class="fs-resumen">
      <div class="fs-resumen-caja"><span>${negocios.filter(esFc).length}</span>en forecast</div>
      <div class="fs-resumen-caja"><span>${negocios.filter(esPipe).length}</span>en pipeline</div>
      <div class="fs-resumen-caja"><span>${formatoCOP(suma((n) => n.valor_ponderado_cop, esPipe))}</span>pipeline ponderado</div>
      <div class="fs-resumen-caja"><span>${negocios.filter(esCerrado).length}</span>cerrados</div>
      <div class="fs-resumen-caja"><span>${formatoCOP(suma((n) => n.valor_total_venta_cop, esCerrado))}</span>venta cerrada</div>
      <div class="fs-resumen-caja"><span>${formatoCOP(suma((n) => n.mrr_total_cop, esCerrado))}</span>MRR cerrado</div>
    </div>`;
}

function pintarTabla(cuerpo, negocios, puedeEditar, contenedorRaiz, alGuardar) {
  if (!negocios.length) {
    cuerpo.innerHTML = '<div class="fs-empty">No hay negocios que coincidan con el filtro.</div>';
    return;
  }

  cuerpo.innerHTML = `
    <table class="fs-tabla" id="neg-tabla-datos">
      <thead><tr>
        <th data-orden="texto" style="width:110px">Código</th>
        <th data-orden="texto">Cliente</th>
        <th data-orden="texto" style="width:100px">Naturaleza</th>
        <th data-orden="texto" style="width:120px">Etapa</th>
        <th data-orden="texto" style="width:110px">Modalidad</th>
        <th data-orden="numero" style="width:70px">Veh.</th>
        <th data-orden="texto" style="width:80px">Escala</th>
        <th data-orden="numero" style="width:130px">Venta</th>
        <th data-orden="numero" style="width:120px">MRR</th>
        <th data-orden="numero" style="width:90px">Margen</th>
        <th data-orden="texto" style="width:130px">Abastecimiento</th>
        ${puedeEditar ? '<th style="width:170px"></th>' : ''}
      </tr></thead>
      <tbody>
        ${negocios.map((n) => {
          const plazo = n.plazo_comodato ? ` ${n.plazo_comodato}m`
            : (n.modalidad !== 'venta' ? ' varios' : '');
          return `<tr data-id="${n.id}">
            <td>${escapeHtml(n.codigo)}</td>
            <td>${escapeHtml(n.cliente_nombre_comercial || n.cliente_razon_social || n.empresa)}
                ${n.combo_nombre ? `<br><small class="fs-par-desc">${escapeHtml(n.combo_nombre)}</small>` : ''}</td>
            <td>${NATURALEZAS[n.naturaleza] || n.naturaleza}</td>
            <td>${escapeHtml(n.etapa_nombre || '—')}${n.probabilidad != null && n.naturaleza === 'pipeline' ? ` <span class="fs-badge">${n.probabilidad}%</span>` : ''}</td>
            <td>${(MODALIDADES[n.modalidad] || n.modalidad)}${plazo}</td>
            <td data-orden="${n.cantidad_vehiculos}">${n.cantidad_vehiculos}</td>
            <td>${n.escala_aplicada || '—'}</td>
            <td data-orden="${n.valor_total_venta_cop || 0}">${n.valor_total_venta_cop ? formatoCOP(n.valor_total_venta_cop) : '—'}</td>
            <td data-orden="${n.mrr_total_cop || 0}">${n.mrr_total_cop ? formatoCOP(n.mrr_total_cop) : '—'}</td>
            <td data-orden="${n.margen_pct ?? -999}">${n.margen_pct != null ? `${n.margen_pct}%` : '—'}</td>
            <td>${n.naturaleza === 'cerrado'
                  ? (ESTADOS_EJECUCION[n.estado_ejecucion] || n.estado_ejecucion)
                  : '—'}</td>
            ${puedeEditar ? `<td>
                <button class="fs-btn-link neg-editar">Abrir</button>
                ${n.naturaleza === 'cerrado' ? `
                  · <button class="fs-btn-link neg-reservar">Reservar</button>
                  · <button class="fs-btn-link neg-liberar">Liberar</button>` : ''}
              </td>` : ''}
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;

  hacerOrdenable(cuerpo.querySelector('#neg-tabla-datos'));

  if (!puedeEditar) return;
  cuerpo.querySelectorAll('.neg-editar').forEach((b) => {
    b.addEventListener('click', async (e) => {
      const id = e.target.closest('tr').dataset.id;
      const { data } = await sb.from('fs_negocio').select('*').eq('id', id).single();
      if (data) abrirFormulario(data, alGuardar);
    });
  });

  const porFila = (e) => negocios.find((n) => n.id === e.target.closest('tr').dataset.id);
  cuerpo.querySelectorAll('.neg-reservar').forEach((b) => {
    b.addEventListener('click', async (e) => {
      if (await reservarDesdeListado(porFila(e))) alGuardar();
    });
  });
  cuerpo.querySelectorAll('.neg-liberar').forEach((b) => {
    b.addEventListener('click', async (e) => {
      if (await liberarDesdeListado(porFila(e))) alGuardar();
    });
  });
}

/* ═══════════════════ Formulario ═══════════════════ */

async function abrirFormulario(negocio, alGuardar) {
  const existente = !!negocio;
  const [etapas, combos, sup] = await Promise.all([
    cargarEtapas(), cargarCombosVigentes(), leerSupuestos(),
  ]);

  // Estado del formulario mientras se arma. Las líneas viven acá hasta
  // que se guarda: así se puede explotar el combo, ajustar cantidades y
  // ver los totales sin escribir nada en la base.
  const est = {
    cliente: null,
    lineas: [],
    trm: existente ? Number(negocio.trm_usada || sup.trm || 0) : sup.trm,
    // La procedencia de la TRM, para poder decirla en pantalla. En un
    // negocio ya guardado no aplica: esa TRM quedó congelada y no se
    // volvió a consultar la fuente.
    trmEtiqueta: existente ? null : sup.trmEtiqueta,
    trmAviso: existente ? null : sup.trmAviso,
    // Un negocio ya guardado conserva los porcentajes con los que se
    // costeó; uno nuevo toma los de hoy.
    colchonPct: existente && negocio.colchon_trm_pct_usado != null
      ? Number(negocio.colchon_trm_pct_usado) : sup.colchonPct,
    importacionPct: existente && negocio.costos_importacion_pct_usado != null
      ? Number(negocio.costos_importacion_pct_usado) : sup.importacionPct,
    comboId: existente ? negocio.combo_id : null,
    comboVersion: existente ? negocio.combo_version : null,
    servicioUnit: existente ? Number(negocio.mensualidad_servicio_unitaria_cop || 0) : 0,
    // Para cuántos vehículos están armadas las líneas de verdad. Sin
    // esto, el campo y las líneas se desincronizan sin que nadie lo vea.
    vehiculosAplicados: existente ? Number(negocio.cantidad_vehiculos || 1) : 1,
  };

  if (existente) {
    const { data } = await sb.from('fs_negocio_linea')
      .select('*,fs_productos(id,sku,nombre,marca,categoria,costo_usd,costo_moneda,requiere_sim,aplica_comodato)')
      .eq('negocio_id', negocio.id);
    // _precioFijado: esta línea trae el precio con el que se vendió.
    // Abrir el negocio NO puede reprecificarlo con la lista de hoy: el
    // precio de un negocio cerrado no se mueve nunca.
    est.lineas = (data || []).map((l) => ({ ...l, producto: l.fs_productos, _precioFijado: true }));
    if (negocio.cliente_id) {
      const { data: c } = await sb.from('fs_cliente').select('*').eq('id', negocio.cliente_id).maybeSingle();
      est.cliente = c || null;
    }
  }

  const ov = document.createElement('div');
  ov.className = 'fs-modal-overlay show';
  ov.innerHTML = `
    <div class="fs-modal fs-modal-ancho">
      <div class="fs-modal-title">${existente ? `Negocio ${escapeHtml(negocio.codigo)}` : 'Nuevo negocio'}</div>

      ${est.trm ? '' : `<div class="fs-ayuda-modo" style="background:var(--amber-light);border-left-color:var(--amber)">
        <strong>No hay TRM.</strong> No se pudo consultar la TRM oficial y no hay ninguna guardada,
        así que el costo y el margen van a salir en cero. Revisa tu conexión, o fija una a mano
        en Configuración → Parámetros.
      </div>`}
      ${est.trm && est.trmAviso ? `<div class="fs-ayuda-modo" style="background:var(--amber-light);border-left-color:var(--amber)">
        <strong>Atención con la TRM.</strong> ${escapeHtml(est.trmAviso)}
      </div>` : ''}

      <div class="fs-form-grid">
        <label class="fs-full">Cliente
          <input type="text" id="n-cliente-busca" placeholder="Escribe NIT o nombre y elige de la lista..."
                 value="${existente ? escapeHtml(negocio.empresa) : ''}">
          <div id="n-cliente-res"></div>
        </label>

        <label>Naturaleza
          <select id="n-naturaleza">
            ${Object.entries(NATURALEZAS).map(([v, l]) =>
              `<option value="${v}" ${(existente ? negocio.naturaleza : 'pipeline') === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>

        <label>Responsable
          <input type="text" id="n-responsable" disabled
                 value="${escapeHtml(perfilActual()?.nombre || '')}">
        </label>

        <label id="n-w-etapa">Etapa
          <select id="n-etapa">
            <option value="">—</option>
            ${etapas.map((e) => `<option value="${e.id}" data-prob="${e.probabilidad_default}"
              ${existente && negocio.etapa_id === e.id ? 'selected' : ''}>${escapeHtml(e.nombre)}</option>`).join('')}
          </select>
        </label>

        <label id="n-w-prob">Probabilidad (%)
          <input type="number" id="n-prob" min="0" max="100" value="${existente ? (negocio.probabilidad ?? '') : ''}">
          <small class="fs-par-desc">Viene de la etapa; puedes ajustarla.</small>
        </label>

        <label id="n-w-mes">Mes estimado de cierre
          <input type="month" id="n-mes" value="${existente && negocio.mes_estimado_cierre ? String(negocio.mes_estimado_cierre).slice(0, 7) : ''}">
        </label>

        <label id="n-w-fecha">Fecha real de cierre
          <input type="date" id="n-fecha" value="${existente ? (negocio.fecha_cierre_real || '') : ''}">
        </label>

        <label class="fs-full" id="n-w-soporte">Documento soporte (OC del cliente o contrato)
          <input type="text" id="n-soporte" placeholder="Nombre del documento, o enlace a Drive"
                 value="">
          <small class="fs-par-desc">Obligatorio para cerrar. Queda registrado en la bitácora del negocio.</small>
        </label>

        <label>Combo
          <select id="n-combo">
            <option value="">— sin combo, líneas a mano —</option>
            ${combos.map((c) => `<option value="${c.id}" data-version="${c.version}"
              data-s10="${c.mensualidad_servicio_hasta_10 ?? ''}" data-s11="${c.mensualidad_servicio_11_mas ?? ''}"
              ${existente && negocio.combo_id === c.id ? 'selected' : ''}>${escapeHtml(c.nombre)} v${c.version}</option>`).join('')}
          </select>
        </label>

        <label>Cantidad de vehículos
          <input type="number" id="n-veh" min="1" value="${existente ? negocio.cantidad_vehiculos : 1}">
        </label>

        <div class="fs-full" id="n-escala-aviso"></div>

        <label class="fs-full">Observaciones
          <textarea id="n-obs">${existente ? escapeHtml(negocio.observaciones || '') : ''}</textarea>
        </label>
      </div>

      <h4 class="fs-h4">Líneas del negocio</h4>
      <div class="fs-toolbar">
        <button id="n-reprecio" class="fs-btn-secundario">Traer precios de hoy</button>
        <span class="fs-nota-toolbar">Los precios de este negocio están congelados como se vendió.
          Solo se actualizan si lo pides aquí.</span>
      </div>
      <div class="fs-nota-toolbar" id="n-conectividad"></div>
      <div id="n-lineas"></div>

      <h4 class="fs-h4">Totales</h4>
      <div id="n-totales"></div>

      <div class="fs-modal-actions">
        <button class="fs-btn-secundario" id="n-cancelar">Cancelar</button>
        <button class="fs-btn-primary" id="n-guardar">Guardar</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const $ = (s) => ov.querySelector(s);

  /* ── mostrar solo los campos de la naturaleza elegida ── */
  const aplicarNaturaleza = () => {
    const nat = $('#n-naturaleza').value;
    $('#n-w-etapa').hidden = nat === 'forecast';
    $('#n-w-prob').hidden = nat !== 'pipeline';
    $('#n-w-mes').hidden = nat === 'cerrado';
    $('#n-w-fecha').hidden = nat !== 'cerrado';
    $('#n-w-soporte').hidden = nat !== 'cerrado';
    if (nat === 'cerrado' && !$('#n-fecha').value) $('#n-fecha').value = fechaHoyBogota();
  };

  /* ── escala y su aviso ── */
  const escalaActual = () => escalaPorVehiculos($('#n-veh').value);
  const pintarEscala = () => {
    const esc = escalaActual();
    const trmEf = est.trm * (1 + (est.colchonPct || 0) / 100);
    // Se lee de la RUTA del producto, no del recosteo: las líneas con
    // precio congelado no pasan por reprecificar(), así que no tienen
    // desglose, y el aviso decía "ninguna importada" con líneas
    // importadas en pantalla.
    const importadas = est.lineas.filter((l) => esRutaImportacion(l.producto?.ruta_habitual)).length;

    $('#n-escala-aviso').innerHTML = `
      <div class="fs-ayuda-modo" style="margin:0">
        Con <strong>${$('#n-veh').value || 0} vehículo(s)</strong> aplica la escala
        <strong>${esc === '11+' ? '11 unidades o más' : 'hasta 10 unidades'}</strong>.
        La decide el número de vehículos, no las unidades de cada SKU.
        <div class="fs-referencia-precio">
          <strong>Cómo se está costeando</strong><br>
          ${est.trm
            ? `TRM ${est.trm.toLocaleString('es-CO')} + ${est.colchonPct}% de colchón =
               <strong>${Math.round(trmEf).toLocaleString('es-CO')}</strong> por dólar.
               ${existente
                 ? '<span class="fs-nota-trm">TRM congelada al armar este negocio.</span>'
                 : `<span class="fs-nota-trm">${escapeHtml(est.trmEtiqueta || '')}</span>`}`
            : '<span class="fs-faltante">No hay TRM: los costos en dólares van a salir en cero.</span>'}
          ${importadas
            ? `<br>${importadas} línea(s) de ruta importada llevan además
               <strong>+${est.importacionPct}%</strong> de costos de importación
               (flete, aduana, agente). Las de ruta local no: el proveedor colombiano
               ya factura la mercancía nacionalizada.`
            : '<br>Ninguna línea viene por ruta de importación, así que no se suma el porcentaje de importación.'}
        </div>
      </div>`;
  };

  /* ── traer precios y costos de las líneas según la escala ── */
  async function reprecificar(forzar = false) {
    if (!est.lineas.length) return;
    const pendientes = est.lineas.filter((l) => forzar || !l._precioFijado);
    if (!pendientes.length) return;

    const ids = [...new Set(pendientes.map((l) => l.producto_id))];
    const { venta, comodato } = await preciosVigentes(ids);
    const esc = escalaActual();
    for (const l of pendientes) {
      l._precioFijado = false;
      l.escala_aplicada = esc;
      const cst = costearProducto(l.producto, {
        trm: est.trm, colchonPct: est.colchonPct, importacionPct: est.importacionPct,
      });
      l.costo_unitario_cop = cst.total;
      l._costo = cst;   // el desglose, para poder mostrarlo
      if (l.modalidad === 'comodato') {
        const plazo = l.plazo_comodato || (l.producto?.marca === 'Geotab' ? PLAZO_UNICO_GEOTAB : 24);
        l.plazo_comodato = plazo;
        l.precio_unitario_cop = null;
        l.mensualidad_comodato_cop = comodato.get(`${l.producto_id}|${esc}|${plazo}`) ?? 0;
      } else {
        l.plazo_comodato = null;
        l.mensualidad_comodato_cop = null;
        l.precio_unitario_cop = venta.get(`${l.producto_id}|${esc}`) ?? null;
      }
    }
  }

  /* ── la mensualidad de servicio sale del combo y la escala ── */
  const refrescarServicio = () => {
    const opt = $('#n-combo').selectedOptions[0];
    if (!opt || !opt.value) return;
    const esc = escalaActual();
    const v = esc === '11+' ? opt.dataset.s11 : opt.dataset.s10;
    est.servicioUnit = v === '' || v == null ? 0 : Number(v);
    est.comboId = opt.value;
    est.comboVersion = Number(opt.dataset.version);
  };

  /* ── tabla de líneas ── */
  function pintarLineas() {
    const cont = $('#n-lineas');
    if (!est.lineas.length) {
      cont.innerHTML = '<div class="fs-empty-inline">Todavía no hay líneas. Elige un combo y la cantidad de vehículos, o agrega productos a mano.</div>';
    } else {
      cont.innerHTML = `
        <table class="fs-tabla fs-tabla-hitos">
          <thead><tr>
            <th>SKU</th><th style="width:80px">Cant.</th>
            <th style="width:120px">Modalidad</th><th style="width:90px">Plazo</th>
            <th style="width:130px">Precio venta</th><th style="width:130px">Mens. comodato</th>
            <th style="width:120px">Costo unit.</th><th style="width:40px"></th>
          </tr></thead>
          <tbody>
            ${est.lineas.map((l, i) => {
              const geotab = l.producto?.marca === 'Geotab';
              return `<tr data-i="${i}">
                <td>${escapeHtml(l.producto?.sku || '?')}<br>
                    <small class="fs-par-desc">${escapeHtml(l.producto?.nombre || '')}</small></td>
                <td><input type="number" min="1" class="l-cant" value="${l.cantidad}"></td>
                <td><select class="l-mod">
                      <option value="venta" ${l.modalidad === 'venta' ? 'selected' : ''}>Venta</option>
                      <option value="comodato" ${l.modalidad === 'comodato' ? 'selected' : ''}
                        ${l.producto?.aplica_comodato === false ? 'disabled' : ''}>Comodato</option>
                    </select></td>
                <td>${l.modalidad === 'comodato' ? `<select class="l-plazo">
                      ${(geotab ? [PLAZO_UNICO_GEOTAB] : PLAZOS_COMODATO).map((p) =>
                        `<option value="${p}" ${Number(l.plazo_comodato) === p ? 'selected' : ''}>${p}m</option>`).join('')}
                    </select>` : '—'}</td>
                <td>${l.modalidad === 'venta'
                      ? (l.precio_unitario_cop != null ? formatoCOP(l.precio_unitario_cop)
                        : '<span class="fs-faltante">sin precio</span>')
                      : '—'}</td>
                <td>${l.modalidad === 'comodato'
                      ? (l.mensualidad_comodato_cop != null ? formatoCOP(l.mensualidad_comodato_cop)
                        : '<span class="fs-faltante">sin precio</span>')
                      : '—'}</td>
                <td>${l.costo_unitario_cop
                      ? `${formatoCOP(l.costo_unitario_cop)}${esRutaImportacion(l.producto?.ruta_habitual)
                          ? `<br><small class="fs-par-desc">incluye +${est.importacionPct}% import.</small>` : ''}`
                      : '<span class="fs-faltante">sin costo</span>'}</td>
                <td><button class="fs-btn-link l-quitar" title="Quitar">✕</button></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>`;
    }

    cont.querySelectorAll('.l-cant').forEach((inp) => inp.addEventListener('change', async (e) => {
      est.lineas[Number(e.target.closest('tr').dataset.i)].cantidad = Math.max(1, Number(e.target.value) || 1);
      await refrescarTodo();
    }));
    cont.querySelectorAll('.l-mod').forEach((sel) => sel.addEventListener('change', async (e) => {
      const l = est.lineas[Number(e.target.closest('tr').dataset.i)];
      l.modalidad = e.target.value;
      // Cambiar de figura sí obliga a buscar el precio de la otra: el
      // valor guardado era el de la figura anterior.
      l._precioFijado = false;
      if (l.modalidad === 'comodato' && l.producto?.marca === 'Geotab') l.plazo_comodato = PLAZO_UNICO_GEOTAB;
      await refrescarTodo();
    }));
    cont.querySelectorAll('.l-plazo').forEach((sel) => sel.addEventListener('change', async (e) => {
      const l = est.lineas[Number(e.target.closest('tr').dataset.i)];
      l.plazo_comodato = Number(e.target.value);
      l._precioFijado = false;   // otro plazo, otra mensualidad
      await refrescarTodo();
    }));
    cont.querySelectorAll('.l-quitar').forEach((b) => b.addEventListener('click', async (e) => {
      est.lineas.splice(Number(e.target.closest('tr').dataset.i), 1);
      await refrescarTodo();
    }));
  }

  function pintarTotales() {
    const t = totalesDeLineas(est.lineas, $('#n-veh').value, est.servicioUnit);
    $('#n-totales').innerHTML = `
      <div class="fs-resumen">
        <div class="fs-resumen-caja"><span>${formatoCOP(t.venta)}</span>venta (una vez)</div>
        <div class="fs-resumen-caja"><span>${formatoCOP(t.mrrServicio)}</span>MRR servicio</div>
        <div class="fs-resumen-caja"><span>${formatoCOP(t.mrrComodato)}</span>MRR comodato</div>
        <div class="fs-resumen-caja"><span>${formatoCOP(t.mrrTotal)}</span>MRR total</div>
        <div class="fs-resumen-caja"><span>${formatoCOP(t.costo)}</span>costo estimado</div>
        <div class="fs-resumen-caja ${t.margenPct != null && t.margenPct < 0 ? 'error' : ''}">
          <span>${t.margenPct != null ? `${t.margenPct}%` : '—'}</span>margen sobre venta</div>
      </div>
      <div class="fs-nota-toolbar">
        La mensualidad de servicio es ${formatoCOP(est.servicioUnit)} por vehículo y siempre se cobra,
        en venta y en comodato. Todo antes de IVA.
      </div>`;

    const c = revisarConectividad(est.lineas);
    const cn = $('#n-conectividad');
    if (c.falta) {
      cn.innerHTML = `<span class="fs-faltante">Faltan ${c.falta} SIM: hay ${c.equiposConSim} equipo(s) que necesitan conectividad y solo ${c.sims} línea(s) de SIM.</span>`;
    } else if (c.sobran) {
      cn.innerHTML = `<span class="fs-faltante">Hay ${c.sobran} SIM de más frente a los ${c.equiposConSim} equipos que las necesitan. Revisa si es a propósito.</span>`;
    } else if (c.sims) {
      cn.textContent = `Conectividad cuadrada: ${c.sims} SIM para ${c.equiposConSim} equipos.`;
    } else {
      cn.textContent = '';
    }
  }

  async function refrescarTodo() {
    pintarEscala();
    refrescarServicio();
    await reprecificar();
    pintarLineas();
    pintarTotales();
  }

  /* ── explotar el combo ── */
  async function explotar(yaConfirmado = false) {
    const comboId = $('#n-combo').value;
    if (!comboId) return;
    if (!yaConfirmado && est.lineas.length
        && !confirmar('Se van a reemplazar las líneas actuales por el combo explotado. ¿Continuar?')) {
      // Se devuelve el selector al combo que de verdad está armado, para
      // que no quede mostrando uno que no corresponde a las líneas.
      $('#n-combo').value = est.comboId || '';
      return;
    }
    const items = await cargarItemsCombo(comboId);
    est.lineas = explotarCombo(items, $('#n-veh').value).map((x) => ({
      producto_id: x.producto_id,
      producto: x.producto,
      cantidad: x.cantidad,
      // Por defecto todo entra como venta; el usuario cambia por línea
      // lo que vaya en comodato. Geotab a 36 se pone solo al elegirlo.
      modalidad: 'venta',
      plazo_comodato: null,
      combo_id: comboId,
      combo_version: est.comboVersion,
    }));
    est.vehiculosAplicados = Math.max(1, Number($('#n-veh').value) || 1);
    await refrescarTodo();
  }

  /* ── buscador de cliente ── */
  let temporizador = null;
  $('#n-cliente-busca').addEventListener('input', (e) => {
    clearTimeout(temporizador);
    const txt = e.target.value;
    temporizador = setTimeout(async () => {
      const res = await buscarClientes(txt);
      const cont = $('#n-cliente-res');
      if (!res.length) { cont.innerHTML = ''; return; }
      cont.innerHTML = `<table class="fs-tabla" style="margin-top:6px"><tbody>
        ${res.map((c) => `<tr data-id="${c.id}" style="cursor:pointer">
          <td>${escapeHtml(nombreCliente(c))}</td>
          <td style="width:150px">${escapeHtml(c.nit_formateado || c.nit_normalizado || '')}</td>
        </tr>`).join('')}</tbody></table>`;
      cont.querySelectorAll('tr').forEach((tr) => tr.addEventListener('click', () => {
        est.cliente = res.find((c) => c.id === tr.dataset.id);
        $('#n-cliente-busca').value = nombreCliente(est.cliente);
        cont.innerHTML = '';
      }));
    }, 300);
  });

  $('#n-naturaleza').addEventListener('change', aplicarNaturaleza);
  $('#n-etapa').addEventListener('change', (e) => {
    const opt = e.target.selectedOptions[0];
    if (opt?.dataset.prob) $('#n-prob').value = opt.dataset.prob;
  });
  $('#n-combo').addEventListener('change', explotar);
  $('#n-veh').addEventListener('change', async () => {
    const nuevo = Math.max(1, Number($('#n-veh').value) || 1);
    $('#n-veh').value = nuevo;

    if (est.comboId && est.lineas.length && nuevo !== est.vehiculosAplicados) {
      const ok = confirmar(
        `Las líneas están armadas para ${est.vehiculosAplicados} vehículo(s). `
        + `¿Volver a explotar el combo para ${nuevo}?`);
      if (ok) {
        await explotar(true);
        return;
      }
      // Si dice que no, se devuelve el campo: dejarlo en 25 mientras las
      // líneas son de 8 hace que la pantalla muestre cifras que no
      // corresponden a nada.
      $('#n-veh').value = est.vehiculosAplicados;
      mostrarToast(`Se dejó en ${est.vehiculosAplicados} vehículo(s), como están las líneas.`, 'info');
    }
    await refrescarTodo();
  });
  $('#n-reprecio').addEventListener('click', async () => {
    if (!est.lineas.length) { mostrarToast('No hay líneas para reprecificar.', 'aviso'); return; }
    if (!confirmar('Se van a reemplazar los precios de las líneas por los de la lista vigente de hoy. '
                 + 'Si este negocio ya se vendió, el precio pactado se pierde. ¿Continuar?')) return;
    await reprecificar(true);
    pintarLineas();
    pintarTotales();
    mostrarToast('Precios actualizados a la lista de hoy. Todavía no se ha guardado nada.', 'info');
  });

  $('#n-cancelar').addEventListener('click', () => ov.remove());

  /* ── guardar ── */
  $('#n-guardar').addEventListener('click', async () => {
    const nat = $('#n-naturaleza').value;
    const veh = Math.max(1, Number($('#n-veh').value) || 1);
    const soporte = $('#n-soporte').value.trim();

    if (!existente && !est.cliente) {
      mostrarToast('Elige el cliente de la lista. Si no está, créalo primero.', 'aviso');
      return;
    }
    if (nat !== 'forecast' && !$('#n-etapa').value) {
      mostrarToast('Un negocio en pipeline o cerrado necesita etapa.', 'aviso');
      return;
    }
    if (nat === 'cerrado') {
      if (!$('#n-fecha').value) { mostrarToast('Un negocio cerrado necesita la fecha real de cierre.', 'aviso'); return; }
      if (!soporte && !existente) { mostrarToast('Un negocio cerrado necesita el documento soporte (OC o contrato).', 'aviso'); return; }
      if (!est.lineas.length) { mostrarToast('Un negocio cerrado necesita líneas: es lo que se va a reservar y comprar.', 'aviso'); return; }
    }
    const sinPrecio = est.lineas.filter((l) =>
      (l.modalidad === 'venta' && l.precio_unitario_cop == null)
      || (l.modalidad === 'comodato' && l.mensualidad_comodato_cop == null));
    if (sinPrecio.length && nat === 'cerrado') {
      mostrarToast(`${sinPrecio.length} línea(s) sin precio en la lista vigente. Cárgalo en el catálogo antes de cerrar.`, 'aviso');
      return;
    }

    /*
      Cerrar con líneas en costo 0 es el error más caro que permite esta
      pantalla, porque el costo se CONGELA en la línea: corregir el
      catálogo después no arregla este negocio, y el margen que va a ver
      Gerencia queda inflado para siempre. Se avisa nombrando los SKU y
      obligando a confirmar, no se bloquea: puede haber un caso legítimo
      (un Geotab a 36 meses de verdad cuesta 0).
    */
    if (nat === 'cerrado') {
      const sinCosto = est.lineas.filter((l) => !Number(l.costo_unitario_cop));
      if (sinCosto.length) {
        const skus = sinCosto.map((l) => l.producto?.sku || '?').join(', ');
        const razon = !est.trm
          ? 'No hay TRM cargada, así que ningún costo en dólares se pudo convertir.'
          : 'Esos SKU no tienen costo en el catálogo.';
        const ok = confirmar(
          `${sinCosto.length} línea(s) van con costo 0: ${skus}.\n\n${razon}\n\n`
          + 'El costo se congela al cerrar: si lo corriges después en el catálogo, '
          + 'ESTE negocio va a seguir con costo 0 y su margen va a quedar inflado.\n\n'
          + '¿Cerrar de todas formas?');
        if (!ok) return;
      }
    }

    const cab = {
      empresa: est.cliente ? nombreCliente(est.cliente) : negocio.empresa,
      nit: est.cliente ? (est.cliente.nit_formateado || est.cliente.nit_normalizado) : negocio.nit,
      cliente_id: est.cliente ? est.cliente.id : negocio?.cliente_id ?? null,
      naturaleza: nat,
      etapa_id: $('#n-etapa').value || null,
      probabilidad: nat === 'pipeline' ? (Number($('#n-prob').value) || null) : (nat === 'cerrado' ? 100 : null),
      cantidad_vehiculos: veh,
      escala_aplicada: escalaPorVehiculos(veh),
      mes_estimado_cierre: nat === 'cerrado' ? null : ($('#n-mes').value ? `${$('#n-mes').value}-01` : null),
      fecha_cierre_real: nat === 'cerrado' ? ($('#n-fecha').value || null) : null,
      combo_id: est.comboId || null,
      combo_version: est.comboVersion || null,
      mensualidad_servicio_unitaria_cop: est.servicioUnit || null,
      trm_usada: est.trm || null,
      colchon_trm_pct_usado: est.colchonPct ?? null,
      costos_importacion_pct_usado: est.importacionPct ?? null,
      observaciones: $('#n-obs').value.trim() || null,
      responsable_id: perfilActual()?.id ?? null,
    };

    try {
      let negocioId = negocio?.id;
      if (existente) {
        const diffs = calcularCambios(negocio, cab);
        const { error } = await sb.from('fs_negocio').update(cab).eq('id', negocioId);
        if (error) throw error;
        await registrarAuditoria('fs_negocio', negocioId, diffs);
      } else {
        const { data: consec, error: errC } = await sb.rpc('fs_siguiente_consecutivo', { p_nombre: 'negocio' });
        if (errC) throw errC;
        const codigo = `NEG-${String(consec).padStart(5, '0')}`;
        const { data, error } = await sb.from('fs_negocio')
          .insert({ ...cab, codigo, creado_por: perfilActual()?.id ?? null })
          .select().single();
        if (error) throw error;
        negocioId = data.id;
      }

      // Las líneas se reemplazan completas: son la explosión del combo,
      // no datos que el usuario mantenga fila por fila.
      const { error: errDel } = await sb.from('fs_negocio_linea').delete().eq('negocio_id', negocioId);
      if (errDel) throw errDel;

      if (est.lineas.length) {
        const filas = est.lineas.map((l) => ({
          negocio_id: negocioId,
          producto_id: l.producto_id,
          combo_id: l.combo_id || est.comboId || null,
          combo_version: l.combo_version || est.comboVersion || null,
          cantidad: l.cantidad,
          modalidad: l.modalidad,
          plazo_comodato: l.modalidad === 'comodato' ? l.plazo_comodato : null,
          precio_unitario_cop: l.modalidad === 'venta' ? l.precio_unitario_cop : null,
          mensualidad_comodato_cop: l.modalidad === 'comodato' ? (l.mensualidad_comodato_cop ?? 0) : null,
          costo_unitario_cop: l.costo_unitario_cop ?? 0,
          escala_aplicada: l.escala_aplicada || escalaPorVehiculos(veh),
        }));
        const { error: errIns } = await sb.from('fs_negocio_linea').insert(filas);
        if (errIns) throw errIns;
      }

      if (soporte) {
        await sb.from('fs_adjunto').insert({
          entidad: 'fs_negocio', entidad_id: negocioId,
          nombre_archivo: soporte, ruta_storage: soporte,
          subido_por: perfilActual()?.id ?? null,
        });
        await registrarAuditoria('fs_negocio', negocioId, { documento_soporte: [null, soporte] });
      }

      mostrarToast(existente ? 'Negocio actualizado.' : 'Negocio creado.', 'exito');
      ov.remove();

      // Cerrar el negocio es lo que dispara la reserva. Se hace después
      // de guardar y solo si todavía no tiene reservas, para que volver a
      // guardar un negocio ya cerrado no intente reservar dos veces.
      if (nat === 'cerrado') {
        const yaReservado = await tieneReservas(negocioId);
        if (!yaReservado) await reservarYMostrar(negocioId, cab.empresa);
      }

      alGuardar();
    } catch (err) {
      console.error(err);
      mostrarToast(`No se pudo guardar: ${err.message || err}`, 'error');
    }
  });

  aplicarNaturaleza();
  await refrescarTodo();
}

/* ═══════════════════ Reserva de stock ═══════════════════
   La reserva NO se calcula acá. Se llama a fs_reservar_negocio, que
   corre en la base con bloqueo de fila. Si se hiciera en el navegador,
   dos negocios cerrados al mismo tiempo leerían el mismo disponible y
   los dos lo tomarían: quedarían más unidades prometidas que físicas y
   nadie se enteraría hasta que faltaran equipos en bodega.
   ═══════════════════════════════════════════════════════ */

/*
  ¿Este negocio ya tiene reservas vivas? Reservado menos liberado.
  Sirve para no intentar reservar dos veces al volver a guardar.
*/
export async function tieneReservas(negocioId) {
  const { data, error } = await sb.from('fs_movimiento_inventario')
    .select('tipo,cantidad').eq('negocio_id', negocioId).in('tipo', ['reserva', 'liberacion']);
  if (error) {
    console.error(error);
    return false;
  }
  const neto = (data || []).reduce(
    (n, m) => n + (m.tipo === 'reserva' ? m.cantidad : -m.cantidad), 0);
  return neto > 0;
}

async function reservarYMostrar(negocioId, empresa) {
  const { data, error } = await sb.rpc('fs_reservar_negocio', { p_negocio: negocioId });

  if (error) {
    console.error(error);
    // Importante ser explícito: el negocio SÍ quedó guardado, la reserva
    // no. Si no se dice, el usuario asume que el stock quedó apartado.
    mostrarModalSimple('El negocio quedó guardado, pero NO se reservó stock', `
      <div class="fs-ayuda-modo" style="background:var(--red-light);border-left-color:var(--red)">
        <strong>${escapeHtml(error.message || String(error))}</strong>
      </div>
      <p>El negocio está cerrado y guardado, pero el inventario no se apartó.
      Corrige lo que dice el mensaje y vuelve a intentar la reserva desde el
      botón <strong>Reservar</strong> en el listado.</p>`);
    return;
  }

  const filas = data || [];
  const totReq = filas.reduce((n, f) => n + f.requerido, 0);
  const totRes = filas.reduce((n, f) => n + f.reservado, 0);
  const totFalta = filas.reduce((n, f) => n + f.faltante, 0);
  const conFalta = filas.filter((f) => f.faltante > 0);
  const ultima = conFalta.reduce(
    (m, f) => (f.fecha_estimada && (!m || f.fecha_estimada > m) ? f.fecha_estimada : m), null);

  mostrarModalSimple(`Reserva del negocio de ${escapeHtml(empresa || '')}`, `
    <div class="fs-resumen">
      <div class="fs-resumen-caja"><span>${totReq}</span>unidades del negocio</div>
      <div class="fs-resumen-caja"><span>${totRes}</span>salen de Fontibón</div>
      <div class="fs-resumen-caja ${totFalta ? 'aviso' : ''}"><span>${totFalta}</span>hay que comprar</div>
    </div>

    <table class="fs-tabla">
      <thead><tr><th>SKU</th><th style="width:80px">Pide</th><th style="width:90px">Reservado</th>
        <th style="width:90px">A comprar</th><th style="width:150px">Ruta</th>
        <th style="width:110px">Disponible</th></tr></thead>
      <tbody>
        ${filas.map((f) => `<tr>
          <td>${escapeHtml(f.sku)}<br><small class="fs-par-desc">${escapeHtml(f.producto || '')}</small></td>
          <td>${f.requerido}</td>
          <td>${f.reservado || '—'}</td>
          <td>${f.faltante ? `<span class="fs-faltante">${f.faltante}</span>` : '—'}</td>
          <td>${f.ruta ? (RUTAS[f.ruta] || f.ruta) : '<span class="fs-faltante">sin ruta</span>'}</td>
          <td>${f.faltante && f.fecha_estimada
                ? `${formatoFecha(f.fecha_estimada)}<br><small class="fs-par-desc">${f.dias_ruta} días</small>`
                : '—'}</td>
        </tr>`).join('')}
      </tbody>
    </table>

    <div class="fs-ayuda-modo">
      ${totFalta === 0
        ? 'Todo el negocio se cubre con lo que hay en Fontibón. No hay nada que comprar.'
        : `Se crearon ${conFalta.length} requerimiento(s) de compra por el faltante.
           ${ultima ? `Según los días de cada ruta, lo último estaría disponible alrededor del
           <strong>${formatoFecha(ultima)}</strong>.` : ''}
           Son estimaciones de planeación: la ruta real y sus fechas las define Comercio Exterior
           en la orden de compra.`}
    </div>`);
}

/*
  Reserva a mano desde el listado. Existe para dos casos: un negocio que
  se cerró antes de que existiera esta función, y uno cuya reserva falló
  y hay que reintentar después de corregir.
*/
async function reservarDesdeListado(negocio) {
  if (await tieneReservas(negocio.id)) {
    mostrarToast('Este negocio ya tiene stock reservado. Si quieres rehacerlo, libéralo primero.', 'aviso');
    return false;
  }
  if (!confirmar(`Se va a apartar inventario para el negocio ${negocio.codigo}. ¿Continuar?`)) return false;
  await reservarYMostrar(negocio.id, negocio.empresa);
  return true;
}

async function liberarDesdeListado(negocio) {
  if (!await tieneReservas(negocio.id)) {
    mostrarToast('Este negocio no tiene reservas vivas.', 'aviso');
    return false;
  }
  const motivo = window.prompt(
    `¿Por qué se libera la reserva del negocio ${negocio.codigo}?\n`
    + '(queda en el histórico del movimiento)');
  if (motivo === null) return false;

  const { data, error } = await sb.rpc('fs_liberar_negocio',
    { p_negocio: negocio.id, p_motivo: motivo || null });
  if (error) {
    console.error(error);
    mostrarToast(`No se pudo liberar: ${error.message || error}`, 'error');
    return false;
  }

  const filas = data || [];
  const avisos = [...new Set(filas.map((f) => f.aviso).filter(Boolean))];
  mostrarModalSimple(`Reserva liberada — ${escapeHtml(negocio.codigo)}`, `
    ${avisos.length ? `<div class="fs-ayuda-modo" style="background:var(--amber-light);border-left-color:var(--amber)">
      ${avisos.map((a) => `<strong>${escapeHtml(a)}</strong>`).join('<br>')}
    </div>` : ''}
    <table class="fs-tabla">
      <thead><tr><th>SKU</th><th style="width:120px">Liberado</th></tr></thead>
      <tbody>${filas.length
        ? filas.map((f) => `<tr><td>${escapeHtml(f.sku)}<br><small class="fs-par-desc">${escapeHtml(f.producto || '')}</small></td><td>${f.liberado}</td></tr>`).join('')
        : '<tr><td colspan="2">No había unidades reservadas.</td></tr>'}</tbody>
    </table>
    <div class="fs-ayuda-modo">
      Las unidades volvieron a estar disponibles y los requerimientos pendientes quedaron
      cancelados. No se borró ningún movimiento: la reserva y la liberación quedan las dos
      en el histórico.
    </div>`);
  return true;
}

/* Modal de solo lectura, para los resúmenes. */
function mostrarModalSimple(titulo, htmlCuerpo) {
  const ov = document.createElement('div');
  ov.className = 'fs-modal-overlay show';
  ov.innerHTML = `
    <div class="fs-modal fs-modal-ancho">
      <div class="fs-modal-title">${titulo}</div>
      ${htmlCuerpo}
      <div class="fs-modal-actions">
        <button class="fs-btn-primary" data-cerrar>Entendido</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-cerrar]').addEventListener('click', () => ov.remove());
}
