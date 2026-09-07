/* ═══════════════════════════════════════════════════════
   configuracion.js
   Maestros del módulo: proveedores, rutas con sus hitos, y
   parámetros configurables (TRM, colchón, porcentajes).

   Esto existe para que Comercio Exterior pueda corregir los días
   de cada ruta sin depender de que alguien edite código y lo suba
   al repositorio. Todos los hitos nacen con confirmado = false:
   son estimaciones hasta que alguien los valide aquí.
   ═══════════════════════════════════════════════════════ */

import { sb } from './supabaseClient.js';
import { tieneRol } from './auth.js';
import {
  mostrarToast, confirmar, escapeHtml, estadoCargando, estadoVacio,
  hacerOrdenable, hacerFiltrable,
} from './ui.js';
import { formatoTRM } from './formato.js';
import { calcularCambios, registrarAuditoria } from './auditoria.js';
import {
  ROLES_EDITAN_CONFIG, ROLES_EDITAN_PARAMETROS, MONEDAS_COSTO,
  PARAMETROS_INTERNOS, PARAMETROS_BOOLEANOS,
  FACTOR_SEGURIDAD_STOCK, DIAS_CONSUMO_PROMEDIO,
} from './config.js';
import { obtenerTRM, etiquetaOrigenTRM, limpiarCacheTRM } from './trm.js';

const MODOS = { local: 'Local', importacion: 'Importación' };
const MEDIOS = { maritimo: 'Marítimo', aereo: 'Aéreo', terrestre: 'Terrestre', na: 'No aplica' };

/* ═══════════════ Pantalla principal con sub-pestañas ═══════════════ */

export async function renderConfiguracion(container) {
  container.innerHTML = `
    <div class="fs-subtabs">
      <button class="fs-subtab active" data-sec="rutas">Rutas y hitos</button>
      <button class="fs-subtab" data-sec="proveedores">Proveedores</button>
      <button class="fs-subtab" data-sec="etapas">Etapas del pipeline</button>
      <button class="fs-subtab" data-sec="minimos">Mínimos de stock</button>
      <button class="fs-subtab" data-sec="parametros">Parámetros</button>
    </div>
    <div id="fs-cfg-cuerpo"></div>
  `;
  const cuerpo = container.querySelector('#fs-cfg-cuerpo');
  const pintar = (sec) => {
    if (sec === 'rutas') renderRutas(cuerpo);
    else if (sec === 'proveedores') renderProveedores(cuerpo);
    else if (sec === 'etapas') renderEtapas(cuerpo);
    else if (sec === 'minimos') renderMinimos(cuerpo);
    else renderParametros(cuerpo);
  };

  container.querySelectorAll('.fs-subtab').forEach((btn) => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.fs-subtab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      pintar(btn.dataset.sec);
    });
  });

  pintar('rutas');
}

/* ═══════════════════════ RUTAS Y HITOS ═══════════════════════ */

async function cargarRutas() {
  const { data, error } = await sb
    .from('fs_ruta')
    .select('*, fs_proveedor(nombre), fs_hito_plantilla(*)')
    .order('codigo');
  if (error) {
    console.error(error);
    mostrarToast('No se pudieron cargar las rutas.', 'error');
    return [];
  }
  return (data || []).map((r) => ({
    ...r,
    fs_hito_plantilla: (r.fs_hito_plantilla || []).sort((a, b) => a.orden - b.orden),
  }));
}

async function renderRutas(container) {
  estadoCargando(container, 'Cargando rutas...');
  const puedeEditar = tieneRol(...ROLES_EDITAN_CONFIG);
  const rutas = await cargarRutas();

  if (!rutas.length) {
    estadoVacio(container, 'No hay rutas cargadas. ¿Corriste los scripts de semilla?');
    return;
  }

  const sinConfirmar = rutas.reduce(
    (n, r) => n + r.fs_hito_plantilla.filter((h) => !h.confirmado).length, 0);

  container.innerHTML = `
    ${sinConfirmar > 0 ? `<div class="fs-ayuda-modo">Hay <strong>${sinConfirmar} hitos sin confirmar</strong>.
      Los días son estimaciones hasta que alguien los valide: marca la casilla de cada hito cuando el dato sea real.
      De estos días dependen el cronograma y la alerta de cobertura.</div>` : ''}
    <div id="fs-rutas-lista"></div>`;

  const lista = container.querySelector('#fs-rutas-lista');
  lista.innerHTML = rutas.map((r) => tarjetaRuta(r, puedeEditar)).join('');

  rutas.forEach((r) => cablearRuta(lista, r, puedeEditar, () => renderRutas(container)));
}

function totalDias(hitos) {
  return hitos.reduce((s, h) => s + (Number(h.dias_estandar) || 0), 0);
}

// Días si el embarque se salta los hitos omitibles (una carga pequeña
// que entra sin nacionalizar, por ejemplo).
function diasSinOmitibles(hitos) {
  return hitos.reduce((s, h) => s + (h.omitible ? 0 : Number(h.dias_estandar) || 0), 0);
}

function textoEscenarioCorto(hitos) {
  const corto = diasSinOmitibles(hitos);
  if (corto === totalDias(hitos)) return '';
  return `${corto} días si se omiten los hitos marcados`;
}

function tarjetaRuta(r, puedeEditar) {
  const hitos = r.fs_hito_plantilla;
  const confirmados = hitos.filter((h) => h.confirmado).length;
  return `
  <div class="fs-card-ruta" data-ruta="${r.id}">
    <div class="fs-card-ruta-head">
      <div>
        <strong>${escapeHtml(r.codigo)} · ${escapeHtml(r.nombre)}</strong>
        <div class="fs-card-ruta-sub">
          ${escapeHtml(r.fs_proveedor?.nombre || 'sin proveedor')} ·
          ${MODOS[r.modo] || r.modo} · ${MEDIOS[r.medio_transporte] || r.medio_transporte}
          ${r.activa ? '' : ' · <span class="fs-inactiva">inactiva</span>'}
        </div>
        ${r.observaciones ? `<div class="fs-ruta-obs">${escapeHtml(r.observaciones)}</div>` : ''}
      </div>
      <div class="fs-card-ruta-total">
        <span class="fs-total-dias" data-ruta="${r.id}">${totalDias(hitos)}</span> días
        <div class="fs-card-ruta-sub fs-total-corto" data-ruta="${r.id}">${textoEscenarioCorto(hitos)}</div>
        <div class="fs-card-ruta-sub">${confirmados} de ${hitos.length} confirmados</div>
      </div>
    </div>

    <table class="fs-tabla fs-tabla-hitos">
      <thead><tr>
        <th style="width:32px">#</th><th>Hito</th>
        <th style="width:90px">Días</th>
        <th>Responsable</th><th style="width:78px">Puede<br>omitirse</th><th style="width:80px">Confirmado</th>
        ${puedeEditar ? '<th style="width:60px"></th>' : ''}
      </tr></thead>
      <tbody>
        ${hitos.map((h) => filaHito(h, puedeEditar)).join('')}
      </tbody>
    </table>

    ${puedeEditar ? `
      <div class="fs-card-ruta-acciones">
        <button class="fs-btn-secundario fs-hito-agregar">+ Agregar hito</button>
        <button class="fs-btn-primary fs-ruta-guardar">Guardar cambios</button>
      </div>` : ''}
  </div>`;
}

function filaHito(h, puedeEditar) {
  const ro = puedeEditar ? '' : 'disabled';
  return `
  <tr data-hito="${h.id}">
    <td>${h.orden}</td>
    <td><input type="text" class="h-nombre" value="${escapeHtml(h.nombre)}" ${ro}></td>
    <td><input type="number" min="0" step="1" class="h-dias" value="${h.dias_estandar}" ${ro}></td>
    <td><input type="text" class="h-area" value="${escapeHtml(h.area_responsable || '')}" ${ro}></td>
    <td style="text-align:center"><input type="checkbox" class="h-omit" ${h.omitible ? 'checked' : ''} ${ro}></td>
    <td style="text-align:center"><input type="checkbox" class="h-conf" ${h.confirmado ? 'checked' : ''} ${ro}></td>
    ${puedeEditar ? '<td><button class="fs-btn-link h-quitar">Quitar</button></td>' : ''}
  </tr>`;
}

function cablearRuta(lista, ruta, puedeEditar, refrescar) {
  const card = lista.querySelector(`.fs-card-ruta[data-ruta="${ruta.id}"]`);
  if (!card) return;

  // El total se recalcula mientras escribes: es el dato que importa.
  const recalcular = () => {
    let total = 0;
    let corto = 0;
    card.querySelectorAll('tbody tr').forEach((fila) => {
      const dias = Number(fila.querySelector('.h-dias').value) || 0;
      total += dias;
      if (!fila.querySelector('.h-omit')?.checked) corto += dias;
    });
    card.querySelector(`.fs-total-dias[data-ruta="${ruta.id}"]`).textContent = total;
    const el = card.querySelector(`.fs-total-corto[data-ruta="${ruta.id}"]`);
    if (el) el.textContent = corto === total ? '' : `${corto} días si se omiten los hitos marcados`;
  };
  card.querySelectorAll('.h-dias').forEach((i) => i.addEventListener('input', recalcular));
  card.querySelectorAll('.h-omit').forEach((i) => i.addEventListener('change', recalcular));

  if (!puedeEditar) return;

  card.querySelector('.fs-ruta-guardar').addEventListener('click', async () => {
    await guardarHitosDeRuta(card, ruta);
    refrescar();
  });

  card.querySelector('.fs-hito-agregar').addEventListener('click', async () => {
    const siguiente = ruta.fs_hito_plantilla.length
      ? Math.max(...ruta.fs_hito_plantilla.map((h) => h.orden)) + 1 : 1;
    const { error } = await sb.from('fs_hito_plantilla').insert({
      ruta_id: ruta.id, orden: siguiente, nombre: 'Hito nuevo',
      dias_estandar: 0, confirmado: false,
    });
    if (error) {
      console.error(error);
      mostrarToast('No se pudo agregar el hito.', 'error');
      return;
    }
    mostrarToast('Hito agregado. Ponle nombre y días.', 'exito');
    refrescar();
  });

  card.querySelectorAll('.h-quitar').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const fila = btn.closest('tr');
      const hitoId = fila.dataset.hito;
      const h = ruta.fs_hito_plantilla.find((x) => x.id === hitoId);
      if (!confirmar(`¿Quitar el hito "${h?.nombre || ''}" de la ruta ${ruta.codigo}?`)) return;
      // Queda registrado antes de quitarlo.
      await registrarAuditoria('fs_hito_plantilla', hitoId, {
        eliminado: [`${h?.orden}. ${h?.nombre} (${h?.dias_estandar} días)`, null],
      });
      const { error } = await sb.from('fs_hito_plantilla').delete().eq('id', hitoId);
      if (error) {
        console.error(error);
        mostrarToast('No se pudo quitar el hito.', 'error');
        return;
      }
      mostrarToast('Hito quitado.', 'exito');
      refrescar();
    });
  });
}

async function guardarHitosDeRuta(card, ruta) {
  let cambiados = 0;
  for (const fila of card.querySelectorAll('tbody tr')) {
    const hitoId = fila.dataset.hito;
    const actual = ruta.fs_hito_plantilla.find((h) => h.id === hitoId);
    if (!actual) continue;

    const nuevos = {
      nombre: fila.querySelector('.h-nombre').value.trim(),
      dias_estandar: Number(fila.querySelector('.h-dias').value) || 0,
      area_responsable: fila.querySelector('.h-area').value.trim() || null,
      omitible: fila.querySelector('.h-omit').checked,
      confirmado: fila.querySelector('.h-conf').checked,
    };

    if (!nuevos.nombre) {
      mostrarToast('Un hito no puede quedar sin nombre.', 'aviso');
      return;
    }

    const diffs = calcularCambios(actual, nuevos);
    if (!Object.keys(diffs).length) continue;

    const { error } = await sb.from('fs_hito_plantilla').update(nuevos).eq('id', hitoId);
    if (error) {
      console.error(error);
      mostrarToast(`No se pudo guardar el hito "${nuevos.nombre}".`, 'error');
      return;
    }
    await registrarAuditoria('fs_hito_plantilla', hitoId, diffs);
    cambiados++;
  }
  mostrarToast(cambiados ? `Ruta ${ruta.codigo}: ${cambiados} hito(s) actualizados.` : 'No había cambios.',
    cambiados ? 'exito' : 'info');
}

/* ═══════════════════════ PROVEEDORES ═══════════════════════ */

async function renderProveedores(container) {
  estadoCargando(container, 'Cargando proveedores...');
  const puedeEditar = tieneRol(...ROLES_EDITAN_CONFIG);
  const { data, error } = await sb.from('fs_proveedor').select('*').order('nombre');
  if (error) {
    console.error(error);
    estadoVacio(container, 'No se pudieron cargar los proveedores.');
    return;
  }
  const provs = data || [];

  container.innerHTML = `
    <div class="fs-toolbar">
      ${puedeEditar ? '<button id="p-nuevo" class="fs-btn-primary">+ Nuevo proveedor</button>' : ''}
      <span class="fs-nota-toolbar">El proveedor es quien factura; la marca es de quién es el equipo. No son lo mismo.</span>
    </div>
    <table class="fs-tabla">
      <thead><tr>
        <th>Proveedor</th><th>País</th><th>Moneda</th>
        <th>Condiciones de pago</th><th>Estado</th>${puedeEditar ? '<th></th>' : ''}
      </tr></thead>
      <tbody>
        ${provs.map((p) => `
          <tr data-id="${p.id}">
            <td><strong>${escapeHtml(p.nombre)}</strong></td>
            <td>${escapeHtml(p.pais || '—')}</td>
            <td>${escapeHtml(p.moneda)}</td>
            <td>${escapeHtml(p.condiciones_pago || '—')}</td>
            <td>${p.activo ? 'Activo' : 'Inactivo'}</td>
            ${puedeEditar ? '<td><button class="fs-btn-link p-editar">Editar</button></td>' : ''}
          </tr>`).join('')}
      </tbody>
    </table>`;

  if (!puedeEditar) return;

  container.querySelector('#p-nuevo').addEventListener('click', () =>
    formProveedor(null, () => renderProveedores(container)));

  container.querySelectorAll('.p-editar').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.closest('tr').dataset.id;
      formProveedor(provs.find((p) => p.id === id), () => renderProveedores(container));
    });
  });
}

function formProveedor(prov, alGuardar) {
  const ex = !!prov;
  const ov = document.createElement('div');
  ov.className = 'fs-modal-overlay show';
  ov.innerHTML = `
    <div class="fs-modal">
      <div class="fs-modal-title">${ex ? 'Editar proveedor' : 'Nuevo proveedor'}</div>
      <div class="fs-form-grid">
        <label class="fs-full">Nombre<input id="p-nombre" value="${ex ? escapeHtml(prov.nombre) : ''}"></label>
        <label>País<input id="p-pais" value="${ex ? escapeHtml(prov.pais || '') : ''}"></label>
        <label>Moneda
          <select id="p-moneda">
            ${Object.keys(MONEDAS_COSTO).concat(['EUR']).map((m) =>
              `<option value="${m}" ${ex && prov.moneda === m ? 'selected' : ''}>${m}</option>`).join('')}
          </select>
        </label>
        <label class="fs-full">Condiciones de pago
          <input id="p-pago" value="${ex ? escapeHtml(prov.condiciones_pago || '') : ''}"
                 placeholder="Ej: 50% anticipo, 50% contra entrega">
        </label>
        <label class="fs-full">Observaciones<textarea id="p-obs">${ex ? escapeHtml(prov.observaciones || '') : ''}</textarea></label>
        <label class="fs-checkbox"><input type="checkbox" id="p-activo" ${!ex || prov.activo ? 'checked' : ''}> Activo</label>
      </div>
      <div class="fs-modal-actions">
        <button class="fs-btn-secundario" id="p-cancelar">Cancelar</button>
        <button class="fs-btn-primary" id="p-guardar">Guardar</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  ov.querySelector('#p-cancelar').addEventListener('click', () => ov.remove());
  ov.querySelector('#p-guardar').addEventListener('click', async () => {
    const datos = {
      nombre: ov.querySelector('#p-nombre').value.trim(),
      pais: ov.querySelector('#p-pais').value.trim() || null,
      moneda: ov.querySelector('#p-moneda').value,
      condiciones_pago: ov.querySelector('#p-pago').value.trim() || null,
      observaciones: ov.querySelector('#p-obs').value.trim() || null,
      activo: ov.querySelector('#p-activo').checked,
    };
    if (!datos.nombre) {
      mostrarToast('El proveedor necesita un nombre.', 'aviso');
      return;
    }

    if (ex) {
      const diffs = calcularCambios(prov, datos);
      const { error } = await sb.from('fs_proveedor').update(datos).eq('id', prov.id);
      if (error) {
        console.error(error);
        mostrarToast('No se pudo guardar (¿nombre repetido?).', 'error');
        return;
      }
      await registrarAuditoria('fs_proveedor', prov.id, diffs);
    } else {
      const { error } = await sb.from('fs_proveedor').insert(datos);
      if (error) {
        console.error(error);
        mostrarToast('No se pudo crear (¿nombre repetido?).', 'error');
        return;
      }
    }
    mostrarToast('Proveedor guardado.', 'exito');
    ov.remove();
    alGuardar();
  });
}

/* ═══════════════════ ETAPAS DEL PIPELINE ═══════════════════
   Las cinco etapas venían sembradas por SQL y no había manera de
   tocarlas sin entrar a la base. Aquí se pueden renombrar, reordenar
   y ajustar la probabilidad con la que cada etapa pondera el
   pronóstico. Una etapa no se borra: se desactiva, para no dejar
   huérfanos los negocios que ya pasaron por ella.
   ═══════════════════════════════════════════════════════════ */

async function renderEtapas(container) {
  estadoCargando(container, 'Cargando etapas...');
  const puedeEditar = tieneRol(...ROLES_EDITAN_CONFIG);
  const { data, error } = await sb.from('fs_etapa_pipeline').select('*').order('orden');
  if (error) {
    console.error(error);
    estadoVacio(container, 'No se pudieron cargar las etapas del pipeline.');
    return;
  }
  const etapas = data || [];

  container.innerHTML = `
    <div class="fs-ayuda-modo">
      El pronóstico pondera cada negocio por la probabilidad de su etapa: un negocio
      de $100 millones en <em>Cotizado</em> al 30% suma $30 millones al pronóstico.
      Ajusta los porcentajes a como se comporta el embudo de Fleet en la realidad.
      Una etapa que ya no se use se <strong>desactiva</strong>, no se borra: los
      negocios que pasaron por ella conservan su historia.
    </div>
    <table class="fs-tabla">
      <thead><tr>
        <th style="width:80px">Orden</th>
        <th>Nombre</th>
        <th style="width:150px">Probabilidad</th>
        <th style="width:90px">Activa</th>
      </tr></thead>
      <tbody>
        ${etapas.map((e) => `
          <tr data-id="${e.id}">
            <td><input type="number" class="et-orden" min="1" value="${e.orden}" ${puedeEditar ? '' : 'disabled'}></td>
            <td><input type="text" class="et-nombre" value="${escapeHtml(e.nombre)}" ${puedeEditar ? '' : 'disabled'}></td>
            <td><input type="number" class="et-prob" min="0" max="100" value="${e.probabilidad_default}" ${puedeEditar ? '' : 'disabled'}></td>
            <td style="text-align:center">
              <input type="checkbox" class="et-activa" ${e.activa ? 'checked' : ''} ${puedeEditar ? '' : 'disabled'}>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>
    ${puedeEditar ? `
      <div class="fs-modal-actions">
        <button id="et-agregar" class="fs-btn-secundario">Agregar etapa</button>
        <button id="et-guardar" class="fs-btn-primary">Guardar etapas</button>
      </div>` : ''}`;

  if (!puedeEditar) return;

  container.querySelector('#et-agregar').addEventListener('click', async () => {
    const nombre = window.prompt('Nombre de la etapa nueva:');
    if (!nombre || !nombre.trim()) return;
    const siguiente = etapas.reduce((m, e) => Math.max(m, e.orden), 0) + 1;
    const { error: err } = await sb.from('fs_etapa_pipeline')
      .insert({ nombre: nombre.trim(), orden: siguiente, probabilidad_default: 50, activa: true });
    if (err) {
      console.error(err);
      mostrarToast('No se pudo crear la etapa.', 'error');
      return;
    }
    mostrarToast('Etapa creada.', 'exito');
    renderEtapas(container);
  });

  container.querySelector('#et-guardar').addEventListener('click', async () => {
    let cambiadas = 0;
    for (const fila of container.querySelectorAll('tbody tr')) {
      const previa = etapas.find((e) => e.id === fila.dataset.id);
      const datos = {
        orden: Number(fila.querySelector('.et-orden').value),
        nombre: fila.querySelector('.et-nombre').value.trim(),
        probabilidad_default: Number(fila.querySelector('.et-prob').value),
        activa: fila.querySelector('.et-activa').checked,
      };
      if (!datos.nombre) {
        mostrarToast('Ninguna etapa puede quedar sin nombre.', 'aviso');
        return;
      }
      if (!Number.isInteger(datos.orden) || datos.orden < 1) {
        mostrarToast(`El orden de "${datos.nombre}" debe ser un entero mayor que cero.`, 'aviso');
        return;
      }
      if (datos.probabilidad_default < 0 || datos.probabilidad_default > 100) {
        mostrarToast(`La probabilidad de "${datos.nombre}" tiene que estar entre 0 y 100.`, 'aviso');
        return;
      }
      const diffs = calcularCambios(previa, datos);
      if (!Object.keys(diffs).length) continue;

      const { error: err } = await sb.from('fs_etapa_pipeline').update(datos).eq('id', previa.id);
      if (err) {
        console.error(err);
        mostrarToast(`No se pudo guardar "${datos.nombre}".`, 'error');
        return;
      }
      await registrarAuditoria('fs_etapa_pipeline', previa.id, diffs);
      cambiadas++;
    }
    mostrarToast(cambiadas ? `${cambiadas} etapa(s) actualizadas.` : 'No había cambios.',
      cambiadas ? 'exito' : 'info');
    renderEtapas(container);
  });
}

/* ═══════════════════ MÍNIMOS DE STOCK ═══════════════════
   El mínimo manual vive en el producto (fs_productos.stock_minimo) y
   es el que dispara la alerta de reposición. Al lado se muestra el
   sugerido que calcula el sistema por bodega, para poder comparar.

   Aviso honesto: el sugerido sale del consumo de los últimos
   DIAS_CONSUMO_PROMEDIO días por el lead time de la ruta y el factor
   de seguridad. Todavía no hay historia de consumo en el módulo, así
   que hoy viene vacío. Hasta que la haya, el mínimo lo pone una
   persona; no se inventa un número que parezca calculado.
   ═══════════════════════════════════════════════════════ */

async function renderMinimos(container) {
  estadoCargando(container, 'Cargando mínimos...');
  const puedeEditar = tieneRol(...ROLES_EDITAN_CONFIG);

  const { data, error } = await sb.from('fs_productos')
    .select('id,sku,nombre,marca,control_inventario,ruta_habitual,stock_minimo,fs_stock(cantidad_fisica,cantidad_reservada,disponible,stock_minimo_sugerido)')
    .eq('activo', true)
    .order('sku');
  if (error) {
    console.error(error);
    estadoVacio(container, 'No se pudieron cargar los productos.');
    return;
  }
  const productos = data || [];
  if (!productos.length) {
    estadoVacio(container, 'Todavía no hay productos en el catálogo. Cárgalos en Catálogo → Cargar desde Excel.');
    return;
  }

  const suma = (p, campo) => (p.fs_stock || []).reduce((n, s) => n + (s[campo] ?? 0), 0);
  const haySugerido = productos.some((p) => (p.fs_stock || []).some((s) => s.stock_minimo_sugerido != null));

  container.innerHTML = `
    <div class="fs-ayuda-modo">
      El <strong>mínimo</strong> es el que dispara la alerta de reposición: cuando el
      disponible baja de ahí, el SKU entra a la lista de compras. Lo pones tú, por SKU.
      ${haySugerido
        ? 'Al lado está el sugerido que calcula el sistema, para comparar.'
        : `El <strong>sugerido</strong> aparecerá cuando el módulo tenga historia de
           consumo: se calcula con el consumo de los últimos ${DIAS_CONSUMO_PROMEDIO} días,
           los días de la ruta y un factor de seguridad de ${FACTOR_SEGURIDAD_STOCK}.
           Mientras no haya movimientos registrados, esa columna sale vacía y el mínimo
           lo defines a mano.`}
    </div>

    <div class="fs-toolbar">
      <input type="text" id="min-buscar" class="fs-input" style="max-width:320px"
             placeholder="Buscar por SKU, nombre o marca...">
      <span class="fs-conteo-filas" id="min-conteo"></span>
    </div>

    <table class="fs-tabla" id="min-tabla">
      <thead><tr>
        <th data-orden="texto" style="width:130px">SKU</th>
        <th data-orden="texto">Nombre</th>
        <th data-orden="texto" style="width:110px">Marca</th>
        <th data-orden="numero" style="width:90px">Físico</th>
        <th data-orden="numero" style="width:100px">Disponible</th>
        <th data-orden="numero" style="width:110px">Sugerido</th>
        <th style="width:110px">Mínimo</th>
      </tr></thead>
      <tbody>
        ${productos.map((p) => {
          const fisico = suma(p, 'cantidad_fisica');
          const disp = suma(p, 'disponible');
          const sug = (p.fs_stock || []).reduce(
            (n, s) => (s.stock_minimo_sugerido == null ? n : n + s.stock_minimo_sugerido), null);
          const bajo = p.stock_minimo != null && disp < p.stock_minimo;
          return `<tr data-id="${p.id}">
            <td>${escapeHtml(p.sku)}</td>
            <td>${escapeHtml(p.nombre)}</td>
            <td>${escapeHtml(p.marca || '—')}</td>
            <td data-orden="${fisico}">${fisico}</td>
            <td data-orden="${disp}">${bajo ? `<span class="fs-inactiva">${disp}</span>` : disp}</td>
            <td data-orden="${sug ?? -1}">${sug ?? '—'}</td>
            <td><input type="number" class="min-valor" min="0" style="width:90px"
                       value="${p.stock_minimo ?? ''}" ${puedeEditar ? '' : 'disabled'}></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    ${puedeEditar ? '<div class="fs-modal-actions"><button id="min-guardar" class="fs-btn-primary">Guardar mínimos</button></div>' : ''}`;

  const tabla = container.querySelector('#min-tabla');
  hacerOrdenable(tabla);
  hacerFiltrable(container.querySelector('#min-buscar'), tabla, container.querySelector('#min-conteo'));

  if (!puedeEditar) return;

  container.querySelector('#min-guardar').addEventListener('click', async () => {
    let cambiados = 0;
    for (const fila of container.querySelectorAll('#min-tabla tbody tr')) {
      const previo = productos.find((p) => p.id === fila.dataset.id);
      const crudo = fila.querySelector('.min-valor').value.trim();
      const valor = crudo === '' ? null : Number(crudo);
      if (valor != null && (!Number.isInteger(valor) || valor < 0)) {
        mostrarToast(`El mínimo de ${previo.sku} debe ser un entero de cero o más.`, 'aviso');
        return;
      }
      const diffs = calcularCambios({ stock_minimo: previo.stock_minimo }, { stock_minimo: valor });
      if (!Object.keys(diffs).length) continue;

      const { error: err } = await sb.from('fs_productos')
        .update({ stock_minimo: valor }).eq('id', previo.id);
      if (err) {
        console.error(err);
        mostrarToast(`No se pudo guardar el mínimo de ${previo.sku}.`, 'error');
        return;
      }
      await registrarAuditoria('fs_productos', previo.id, diffs);
      cambiados++;
    }
    mostrarToast(cambiados ? `${cambiados} mínimo(s) actualizados.` : 'No había cambios.',
      cambiados ? 'exito' : 'info');
    if (cambiados) renderMinimos(container);
  });
}

/* ═══════════════════════ PARÁMETROS ═══════════════════════ */

async function renderParametros(container) {
  estadoCargando(container, 'Cargando parámetros...');
  const puedeEditar = tieneRol(...ROLES_EDITAN_PARAMETROS);
  const { data, error } = await sb.from('fs_parametro').select('*').order('clave');
  if (error) {
    console.error(error);
    estadoVacio(container, 'No se pudieron cargar los parámetros.');
    return;
  }
  // Fuera los parámetros internos: el mapeo de columnas del importador
  // se guarda aquí pero es JSON, y esta pantalla valida números.
  const params = (data || []).filter((p) => !PARAMETROS_INTERNOS.includes(p.clave));

  // La TRM que el módulo está usando de verdad en este momento, con su
  // procedencia. No se lee del parámetro: el parámetro es solo el
  // valor fijado a mano, y lo normal es que esté en cero.
  const t = await obtenerTRM(undefined, { forzar: true });
  const claseCaja = t.origen === 'oficial'
    ? 'fs-trm-panel'
    : 'fs-trm-panel alerta';

  container.innerHTML = `
    <div class="${claseCaja}">
      <div class="fs-trm-valor">
        ${t.valor > 0 ? formatoTRM(t.valor) : '—'}
        <span class="fs-trm-origen">${escapeHtml(etiquetaOrigenTRM(t))}</span>
      </div>
      <div class="fs-trm-texto">
        ${t.origen === 'oficial'
          ? `TRM oficial traída de datos.gov.co (Superfinanciera), vigente del
             <strong>${escapeHtml(t.desde || '')}</strong> al <strong>${escapeHtml(t.hasta || '')}</strong>.
             Es la misma con la que se liquida en aduana.`
          : `<strong>${escapeHtml(t.aviso || '')}</strong>`}
        <div class="fs-par-desc" style="margin-top:6px">
          Se consulta sola al costear un negocio o una orden. Lo que se costea queda
          <strong>congelado</strong> en ese negocio o en esa orden: si la TRM cambia mañana,
          lo ya cerrado no se mueve.
        </div>
      </div>
      <button id="trm-consultar" class="fs-btn-secundario">Consultar ahora</button>
    </div>
    <table class="fs-tabla">
      <thead><tr><th style="width:230px">Parámetro</th><th style="width:150px">Valor</th><th>Qué significa</th></tr></thead>
      <tbody>
        ${params.map((p) => `
          <tr data-clave="${escapeHtml(p.clave)}">
            <td><code>${escapeHtml(p.clave)}</code></td>
            <td><input class="par-valor" value="${escapeHtml(p.valor)}" ${puedeEditar ? '' : 'disabled'}></td>
            <td class="fs-par-desc">${escapeHtml(p.descripcion || '')}</td>
          </tr>`).join('')}
      </tbody>
    </table>
    ${puedeEditar ? '<div class="fs-modal-actions"><button id="par-guardar" class="fs-btn-primary">Guardar parámetros</button></div>' : ''}`;

  // El botón de consultar va antes del corte por rol: cualquiera puede
  // refrescar la TRM, no es un cambio de configuración.
  container.querySelector('#trm-consultar').addEventListener('click', async () => {
    limpiarCacheTRM();
    mostrarToast('Consultando la TRM oficial...', 'info');
    renderParametros(container);
  });

  if (!puedeEditar) return;

  container.querySelector('#par-guardar').addEventListener('click', async () => {
    let cambiados = 0;
    for (const fila of container.querySelectorAll('tbody tr')) {
      const clave = fila.dataset.clave;
      const actual = params.find((p) => p.clave === clave);
      const valor = fila.querySelector('.par-valor').value.trim();

      if (valor === '') {
        mostrarToast(`El parámetro ${clave} no puede quedar vacío.`, 'aviso');
        return;
      }
      if (PARAMETROS_BOOLEANOS.includes(clave)) {
        if (!['true', 'false'].includes(valor.toLowerCase())) {
          mostrarToast(`El parámetro ${clave} solo acepta true o false.`, 'aviso');
          return;
        }
      } else if (Number.isNaN(Number(valor))) {
        mostrarToast(`El parámetro ${clave} debe ser un número.`, 'aviso');
        return;
      }
      const diffs = calcularCambios({ valor: actual.valor }, { valor });
      if (!Object.keys(diffs).length) continue;

      const { error } = await sb.from('fs_parametro').update({ valor }).eq('clave', clave);
      if (error) {
        console.error(error);
        mostrarToast(`No se pudo guardar ${clave}.`, 'error');
        return;
      }
      await registrarAuditoria('fs_parametro', { clave }, diffs);
      cambiados++;
    }
    mostrarToast(cambiados ? `${cambiados} parámetro(s) actualizados.` : 'No había cambios.',
      cambiados ? 'exito' : 'info');
    renderParametros(container);
  });
}
