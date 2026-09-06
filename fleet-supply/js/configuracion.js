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
import { mostrarToast, confirmar, escapeHtml, estadoCargando, estadoVacio } from './ui.js';
import { formatoTRM } from './formato.js';
import { calcularCambios, registrarAuditoria } from './auditoria.js';
import { ROLES_EDITAN_CONFIG, ROLES_EDITAN_PARAMETROS, MONEDAS_COSTO } from './config.js';

const MODOS = { local: 'Local', importacion: 'Importación' };
const MEDIOS = { maritimo: 'Marítimo', aereo: 'Aéreo', terrestre: 'Terrestre', na: 'No aplica' };

/* ═══════════════ Pantalla principal con sub-pestañas ═══════════════ */

export async function renderConfiguracion(container) {
  container.innerHTML = `
    <div class="fs-subtabs">
      <button class="fs-subtab active" data-sec="rutas">Rutas y hitos</button>
      <button class="fs-subtab" data-sec="proveedores">Proveedores</button>
      <button class="fs-subtab" data-sec="parametros">Parámetros</button>
    </div>
    <div id="fs-cfg-cuerpo"></div>
  `;
  const cuerpo = container.querySelector('#fs-cfg-cuerpo');
  const pintar = (sec) => {
    if (sec === 'rutas') renderRutas(cuerpo);
    else if (sec === 'proveedores') renderProveedores(cuerpo);
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
      </div>
      <div class="fs-card-ruta-total">
        <span class="fs-total-dias" data-ruta="${r.id}">${totalDias(hitos)}</span> días
        <div class="fs-card-ruta-sub">${confirmados} de ${hitos.length} confirmados</div>
      </div>
    </div>

    <table class="fs-tabla fs-tabla-hitos">
      <thead><tr>
        <th style="width:32px">#</th><th>Hito</th>
        <th style="width:90px">Días</th><th style="width:90px">Aéreo</th>
        <th>Responsable</th><th style="width:80px">Confirmado</th>
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
    <td><input type="number" min="0" step="1" class="h-aereo" value="${h.dias_aereo ?? ''}" placeholder="—" ${ro}></td>
    <td><input type="text" class="h-area" value="${escapeHtml(h.area_responsable || '')}" ${ro}></td>
    <td style="text-align:center"><input type="checkbox" class="h-conf" ${h.confirmado ? 'checked' : ''} ${ro}></td>
    ${puedeEditar ? '<td><button class="fs-btn-link h-quitar">Quitar</button></td>' : ''}
  </tr>`;
}

function cablearRuta(lista, ruta, puedeEditar, refrescar) {
  const card = lista.querySelector(`.fs-card-ruta[data-ruta="${ruta.id}"]`);
  if (!card) return;

  // El total se recalcula mientras escribes: es el dato que importa.
  const recalcular = () => {
    const suma = [...card.querySelectorAll('.h-dias')]
      .reduce((s, i) => s + (Number(i.value) || 0), 0);
    card.querySelector(`.fs-total-dias[data-ruta="${ruta.id}"]`).textContent = suma;
  };
  card.querySelectorAll('.h-dias').forEach((i) => i.addEventListener('input', recalcular));

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

    const aereoTxt = fila.querySelector('.h-aereo').value.trim();
    const nuevos = {
      nombre: fila.querySelector('.h-nombre').value.trim(),
      dias_estandar: Number(fila.querySelector('.h-dias').value) || 0,
      dias_aereo: aereoTxt === '' ? null : Number(aereoTxt),
      area_responsable: fila.querySelector('.h-area').value.trim() || null,
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
  const params = data || [];
  const trm = params.find((p) => p.clave === 'trm_del_dia');

  container.innerHTML = `
    <div class="fs-ayuda-modo">
      La TRM se ingresa a mano, como acordamos. Cámbiala aquí y queda aplicada
      para todas las cotizaciones, con su registro de quién la cambió y cuándo.
      ${trm && Number(trm.valor) > 0
        ? `TRM actual: <strong>${formatoTRM(trm.valor)}</strong>`
        : '<strong>Todavía no hay TRM cargada.</strong>'}
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
      if (Number.isNaN(Number(valor))) {
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
