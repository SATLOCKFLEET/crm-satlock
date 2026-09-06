/* ═══════════════════════════════════════════════════════
   catalogo.js
   SKU, precios y combos — Fase 1.

   - fs_productos: alta/edición/baja lógica de productos.
   - fs_combos + fs_combo_items: armar combos libremente y
     guardarlos como plantilla versionada.
   - Cada cambio de un campo de producto queda en fs_auditoria
     (nunca se sobreescribe silenciosamente).
   ═══════════════════════════════════════════════════════ */

import { sb } from './supabaseClient.js';
import { perfilActual, tieneRol } from './auth.js';
import { mostrarToast, confirmar, escapeHtml, estadoCargando, estadoVacio } from './ui.js';
import { formatoCOP, formatoUSD } from './formato.js';
import { ROLES_EDITAN_CATALOGO, LINEAS, MARCAS, CONTROL_INVENTARIO, RUTAS } from './config.js';

/* ───────────────────────── Datos: productos ───────────────────────── */

export async function cargarProductos({ soloActivos = true, texto = '' } = {}) {
  let query = sb.from('fs_productos').select('*').order('nombre', { ascending: true });
  if (soloActivos) query = query.eq('activo', true);
  if (texto && texto.trim().length >= 2) {
    query = query.or(`nombre.ilike.%${texto}%,sku.ilike.%${texto}%`);
  }
  const { data, error } = await query;
  if (error) {
    console.error(error);
    mostrarToast('No se pudo cargar el catálogo.', 'error');
    return [];
  }
  return data;
}

async function registrarAuditoria(tabla, registroId, cambios) {
  const usuarioId = perfilActual()?.id;
  const filas = Object.entries(cambios).map(([campo, [anterior, nuevo]]) => ({
    tabla,
    registro_id: registroId,
    campo,
    valor_anterior: anterior == null ? null : String(anterior),
    valor_nuevo: nuevo == null ? null : String(nuevo),
    usuario_id: usuarioId,
  }));
  if (!filas.length) return;
  const { error } = await sb.from('fs_auditoria').insert(filas);
  if (error) console.error('Error registrando auditoría:', error);
}

export async function crearProducto(datos) {
  if (!tieneRol(...ROLES_EDITAN_CATALOGO)) {
    mostrarToast('No tienes permiso para crear productos.', 'error');
    return null;
  }
  const payload = { ...datos, creado_por: perfilActual()?.id };
  const { data, error } = await sb.from('fs_productos').insert(payload).select().single();
  if (error) {
    console.error(error);
    mostrarToast('No se pudo crear el producto (¿SKU repetido?).', 'error');
    return null;
  }
  mostrarToast('Producto creado.', 'exito');
  return data;
}

export async function actualizarProducto(id, cambios) {
  if (!tieneRol(...ROLES_EDITAN_CATALOGO)) {
    mostrarToast('No tienes permiso para editar productos.', 'error');
    return null;
  }
  const { data: actual, error: errActual } = await sb
    .from('fs_productos')
    .select('*')
    .eq('id', id)
    .single();
  if (errActual || !actual) {
    mostrarToast('No se encontró el producto.', 'error');
    return null;
  }

  const diffs = {};
  for (const campo of Object.keys(cambios)) {
    if (actual[campo] !== cambios[campo]) diffs[campo] = [actual[campo], cambios[campo]];
  }

  const { data, error } = await sb.from('fs_productos').update(cambios).eq('id', id).select().single();
  if (error) {
    console.error(error);
    mostrarToast('No se pudo actualizar el producto.', 'error');
    return null;
  }
  await registrarAuditoria('fs_productos', id, diffs);
  mostrarToast('Producto actualizado.', 'exito');
  return data;
}

export async function desactivarProducto(id) {
  if (!tieneRol(...ROLES_EDITAN_CATALOGO)) {
    mostrarToast('No tienes permiso para desactivar productos.', 'error');
    return null;
  }
  if (!confirmar('¿Desactivar este producto? Sigue existiendo en el historial, solo deja de verse en el catálogo activo.')) {
    return null;
  }
  return actualizarProducto(id, { activo: false });
}

/* ───────────────────────── Datos: combos ───────────────────────── */

export async function listarCombos({ soloVigentes = true } = {}) {
  let query = sb.from('fs_combos').select('*').order('nombre', { ascending: true });
  if (soloVigentes) query = query.eq('vigente', true);
  const { data, error } = await query;
  if (error) {
    console.error(error);
    mostrarToast('No se pudieron cargar los combos.', 'error');
    return [];
  }
  return data;
}

export async function obtenerComboConItems(comboId) {
  const { data: combo, error: errCombo } = await sb.from('fs_combos').select('*').eq('id', comboId).single();
  if (errCombo || !combo) return null;
  const { data: items, error: errItems } = await sb
    .from('fs_combo_items')
    .select('id,cantidad,producto_id,fs_productos(id,sku,nombre,precio_venta_hasta_10,precio_venta_11_mas)')
    .eq('combo_id', comboId);
  if (errItems) {
    console.error(errItems);
    return { ...combo, items: [] };
  }
  return { ...combo, items };
}

// Guarda un combo nuevo, o una nueva versión de uno existente.
// items: [{ producto_id, cantidad }]
export async function guardarCombo({ nombre, items, notas, comboVigenteId = null }) {
  if (!tieneRol(...ROLES_EDITAN_CATALOGO)) {
    mostrarToast('No tienes permiso para guardar combos.', 'error');
    return null;
  }
  if (!nombre?.trim() || !items?.length) {
    mostrarToast('El combo necesita un nombre y al menos un producto.', 'aviso');
    return null;
  }

  let siguienteVersion = 1;
  if (comboVigenteId) {
    const { data: viejo, error: errViejo } = await sb
      .from('fs_combos')
      .select('id,version')
      .eq('id', comboVigenteId)
      .single();
    if (errViejo || !viejo) {
      mostrarToast('No se encontró la versión vigente del combo.', 'error');
      return null;
    }
    siguienteVersion = viejo.version + 1;
    const { error: errMarcar } = await sb.from('fs_combos').update({ vigente: false }).eq('id', comboVigenteId);
    if (errMarcar) {
      console.error(errMarcar);
      mostrarToast('No se pudo cerrar la versión anterior del combo.', 'error');
      return null;
    }
  }

  const { data: comboNuevo, error: errCombo } = await sb
    .from('fs_combos')
    .insert({
      nombre: nombre.trim(),
      version: siguienteVersion,
      vigente: true,
      notas: notas || null,
      creado_por: perfilActual()?.id,
    })
    .select()
    .single();

  if (errCombo || !comboNuevo) {
    console.error(errCombo);
    mostrarToast('No se pudo crear la nueva versión del combo.', 'error');
    return null;
  }

  const filasItems = items.map((it) => ({
    combo_id: comboNuevo.id,
    producto_id: it.producto_id,
    cantidad: it.cantidad,
  }));
  const { error: errItems } = await sb.from('fs_combo_items').insert(filasItems);
  if (errItems) {
    console.error(errItems);
    mostrarToast('El combo se creó pero falló al guardar sus productos.', 'error');
    return comboNuevo;
  }

  mostrarToast(`Combo guardado (versión ${siguienteVersion}).`, 'exito');
  return comboNuevo;
}

/* ───────────────────────── UI: pestaña Catálogo ───────────────────────── */

export async function renderCatalogo(container) {
  estadoCargando(container, 'Cargando catálogo...');
  const puedeEditar = tieneRol(...ROLES_EDITAN_CATALOGO);
  const productos = await cargarProductos({ soloActivos: true });

  container.innerHTML = `
    <div class="fs-toolbar">
      <input type="text" id="fs-buscar-producto" placeholder="Buscar por nombre o SKU..." class="fs-input" style="max-width:320px">
      ${puedeEditar ? '<button id="fs-btn-nuevo-producto" class="fs-btn-primary">+ Nuevo producto</button>' : ''}
    </div>
    <div id="fs-tabla-productos"></div>
  `;

  const tablaCont = container.querySelector('#fs-tabla-productos');
  pintarTablaProductos(tablaCont, productos, puedeEditar);

  container.querySelector('#fs-buscar-producto').addEventListener('input', async (e) => {
    const filtrados = await cargarProductos({ soloActivos: true, texto: e.target.value });
    pintarTablaProductos(tablaCont, filtrados, puedeEditar);
  });

  const btnNuevo = container.querySelector('#fs-btn-nuevo-producto');
  if (btnNuevo) {
    btnNuevo.addEventListener('click', () => abrirFormularioProducto(null, () => renderCatalogo(container)));
  }
}

function pintarTablaProductos(container, productos, puedeEditar) {
  if (!productos.length) {
    estadoVacio(container, 'No hay productos en el catálogo todavía.');
    return;
  }
  container.innerHTML = `
    <table class="fs-tabla">
      <thead>
        <tr>
          <th>SKU</th><th>Nombre</th><th>Línea</th><th>Marca</th>
          <th>Control</th><th>Precio ≤10</th><th>Precio 11+</th><th>Ruta habitual</th>
          ${puedeEditar ? '<th></th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${productos
          .map(
            (p) => `
          <tr data-id="${p.id}">
            <td>${escapeHtml(p.sku)}</td>
            <td>${escapeHtml(p.nombre)}</td>
            <td>${LINEAS[p.linea] || escapeHtml(p.linea)}</td>
            <td>${p.marca ? MARCAS[p.marca] : '—'}</td>
            <td>${CONTROL_INVENTARIO[p.control_inventario] || '—'}</td>
            <td>${p.precio_venta_hasta_10 != null ? formatoCOP(p.precio_venta_hasta_10) : '—'}</td>
            <td>${p.precio_venta_11_mas != null ? formatoCOP(p.precio_venta_11_mas) : '—'}</td>
            <td>${p.ruta_habitual ? RUTAS[p.ruta_habitual] : '—'}</td>
            ${puedeEditar ? `<td><button class="fs-btn-link fs-editar-producto">Editar</button> · <button class="fs-btn-link fs-desactivar-producto">Desactivar</button></td>` : ''}
          </tr>`
          )
          .join('')}
      </tbody>
    </table>`;

  if (puedeEditar) {
    container.querySelectorAll('.fs-editar-producto').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = e.target.closest('tr').dataset.id;
        const producto = productos.find((p) => p.id === id);
        abrirFormularioProducto(producto, () => pintarTablaProductos(container, productos, puedeEditar));
      });
    });
    container.querySelectorAll('.fs-desactivar-producto').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const id = e.target.closest('tr').dataset.id;
        const ok = await desactivarProducto(id);
        if (ok) e.target.closest('tr').remove();
      });
    });
  }
}

function abrirFormularioProducto(producto, alGuardar) {
  const existente = !!producto;
  const overlay = document.createElement('div');
  overlay.className = 'fs-modal-overlay show';
  overlay.innerHTML = `
    <div class="fs-modal">
      <div class="fs-modal-title">${existente ? 'Editar producto' : 'Nuevo producto'}</div>
      <div class="fs-form-grid">
        <label>SKU<input id="f-sku" value="${existente ? escapeHtml(producto.sku) : ''}" ${existente ? 'disabled' : ''}></label>
        <label>Nombre<input id="f-nombre" value="${existente ? escapeHtml(producto.nombre) : ''}"></label>
        <label>Línea
          <select id="f-linea">
            ${Object.entries(LINEAS).map(([v, l]) => `<option value="${v}" ${existente && producto.linea === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
        <label>Marca
          <select id="f-marca">
            <option value="">—</option>
            ${Object.entries(MARCAS).map(([v, l]) => `<option value="${v}" ${existente && producto.marca === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
        <label>Control de inventario
          <select id="f-control">
            ${Object.entries(CONTROL_INVENTARIO).map(([v, l]) => `<option value="${v}" ${existente && producto.control_inventario === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
        <label>Ruta habitual
          <select id="f-ruta">
            <option value="">—</option>
            ${Object.entries(RUTAS).map(([v, l]) => `<option value="${v}" ${existente && producto.ruta_habitual === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
        <label>Costo (USD)<input id="f-costo" type="number" step="0.01" value="${existente ? producto.costo_usd ?? '' : ''}"></label>
        <label>Precio venta ≤10 (COP)<input id="f-precio10" type="number" step="1" value="${existente ? producto.precio_venta_hasta_10 ?? '' : ''}"></label>
        <label>Precio venta 11+ (COP)<input id="f-precio11" type="number" step="1" value="${existente ? producto.precio_venta_11_mas ?? '' : ''}"></label>
        <label class="fs-checkbox"><input id="f-comodato" type="checkbox" ${existente && producto.aplica_comodato ? 'checked' : ''}> Aplica comodato</label>
        <label class="fs-full">Notas<textarea id="f-notas">${existente ? escapeHtml(producto.notas || '') : ''}</textarea></label>
      </div>
      <div class="fs-modal-actions">
        <button class="fs-btn-secundario" id="f-cancelar">Cancelar</button>
        <button class="fs-btn-primary" id="f-guardar">Guardar</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('#f-cancelar').addEventListener('click', () => overlay.remove());

  overlay.querySelector('#f-guardar').addEventListener('click', async () => {
    const datos = {
      sku: overlay.querySelector('#f-sku').value.trim(),
      nombre: overlay.querySelector('#f-nombre').value.trim(),
      linea: overlay.querySelector('#f-linea').value,
      marca: overlay.querySelector('#f-marca').value || null,
      control_inventario: overlay.querySelector('#f-control').value,
      ruta_habitual: overlay.querySelector('#f-ruta').value || null,
      costo_usd: overlay.querySelector('#f-costo').value || null,
      precio_venta_hasta_10: overlay.querySelector('#f-precio10').value || null,
      precio_venta_11_mas: overlay.querySelector('#f-precio11').value || null,
      aplica_comodato: overlay.querySelector('#f-comodato').checked,
      notas: overlay.querySelector('#f-notas').value.trim() || null,
    };
    if (!datos.sku || !datos.nombre) {
      mostrarToast('SKU y nombre son obligatorios.', 'aviso');
      return;
    }
    const resultado = existente ? await actualizarProducto(producto.id, datos) : await crearProducto(datos);
    if (resultado) {
      overlay.remove();
      alGuardar();
    }
  });
}

/* ───────────────────────── UI: pestaña Combos ───────────────────────── */

export async function renderCombos(container) {
  estadoCargando(container, 'Cargando combos...');
  const puedeEditar = tieneRol(...ROLES_EDITAN_CATALOGO);
  const combos = await listarCombos({ soloVigentes: true });

  container.innerHTML = `
    <div class="fs-toolbar">
      ${puedeEditar ? '<button id="fs-btn-nuevo-combo" class="fs-btn-primary">+ Nuevo combo</button>' : ''}
    </div>
    <div id="fs-lista-combos"></div>
  `;

  const listaCont = container.querySelector('#fs-lista-combos');
  await pintarListaCombos(listaCont, combos, puedeEditar, container);

  const btnNuevo = container.querySelector('#fs-btn-nuevo-combo');
  if (btnNuevo) {
    btnNuevo.addEventListener('click', () => abrirFormularioCombo(null, () => renderCombos(container)));
  }
}

async function pintarListaCombos(container, combos, puedeEditar, contenedorPadre) {
  if (!combos.length) {
    estadoVacio(container, 'No hay combos guardados todavía.');
    return;
  }
  container.innerHTML = combos
    .map(
      (c) => `
    <div class="fs-card-combo" data-id="${c.id}">
      <div class="fs-card-combo-header">
        <div><strong>${escapeHtml(c.nombre)}</strong> <span class="fs-badge">v${c.version}</span></div>
        ${puedeEditar ? '<button class="fs-btn-link fs-editar-combo">Nueva versión</button>' : ''}
      </div>
      <div class="fs-card-combo-items" id="items-${c.id}">Cargando ítems...</div>
    </div>`
    )
    .join('');

  for (const c of combos) {
    const detalle = await obtenerComboConItems(c.id);
    const itemsCont = container.querySelector(`#items-${c.id}`);
    if (!detalle || !detalle.items.length) {
      itemsCont.innerHTML = '<div class="fs-empty-inline">Sin productos</div>';
      continue;
    }
    itemsCont.innerHTML = `<ul class="fs-lista-items">${detalle.items
      .map((it) => `<li>${it.cantidad} × ${escapeHtml(it.fs_productos?.nombre || '—')} (${escapeHtml(it.fs_productos?.sku || '—')})</li>`)
      .join('')}</ul>`;
  }

  if (puedeEditar) {
    container.querySelectorAll('.fs-editar-combo').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const id = e.target.closest('.fs-card-combo').dataset.id;
        const detalle = await obtenerComboConItems(id);
        abrirFormularioCombo(detalle, () => renderCombos(contenedorPadre));
      });
    });
  }
}

async function abrirFormularioCombo(comboExistente, alGuardar) {
  const productos = await cargarProductos({ soloActivos: true });
  const itemsIniciales = comboExistente?.items?.map((it) => ({
    producto_id: it.producto_id,
    cantidad: it.cantidad,
  })) || [];

  const overlay = document.createElement('div');
  overlay.className = 'fs-modal-overlay show';
  overlay.innerHTML = `
    <div class="fs-modal fs-modal-ancho">
      <div class="fs-modal-title">${comboExistente ? `Nueva versión de "${escapeHtml(comboExistente.nombre)}"` : 'Nuevo combo'}</div>
      <div class="fs-form-grid">
        <label class="fs-full">Nombre del combo<input id="c-nombre" value="${comboExistente ? escapeHtml(comboExistente.nombre) : ''}" ${comboExistente ? 'disabled' : ''}></label>
        <label class="fs-full">Notas<textarea id="c-notas">${comboExistente ? escapeHtml(comboExistente.notas || '') : ''}</textarea></label>
      </div>
      <div class="fs-combo-builder">
        <div class="fs-combo-builder-add">
          <select id="c-select-producto">
            <option value="">Selecciona un producto...</option>
            ${productos.map((p) => `<option value="${p.id}">${escapeHtml(p.nombre)} (${escapeHtml(p.sku)})</option>`).join('')}
          </select>
          <input id="c-cantidad" type="number" min="1" value="1" style="width:70px">
          <button id="c-agregar-item" class="fs-btn-secundario">Agregar</button>
        </div>
        <ul id="c-lista-items" class="fs-lista-items-editable"></ul>
      </div>
      <div class="fs-modal-actions">
        <button class="fs-btn-secundario" id="c-cancelar">Cancelar</button>
        <button class="fs-btn-primary" id="c-guardar">Guardar combo</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const itemsActuales = [...itemsIniciales];
  const listaEl = overlay.querySelector('#c-lista-items');

  function pintarItems() {
    if (!itemsActuales.length) {
      listaEl.innerHTML = '<li class="fs-empty-inline">Aún no agregas productos</li>';
      return;
    }
    listaEl.innerHTML = itemsActuales
      .map((it, idx) => {
        const p = productos.find((pr) => pr.id === it.producto_id);
        return `<li>${it.cantidad} × ${escapeHtml(p?.nombre || '—')} <button data-idx="${idx}" class="fs-btn-link fs-quitar-item">Quitar</button></li>`;
      })
      .join('');
    listaEl.querySelectorAll('.fs-quitar-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        itemsActuales.splice(Number(btn.dataset.idx), 1);
        pintarItems();
      });
    });
  }
  pintarItems();

  overlay.querySelector('#c-agregar-item').addEventListener('click', () => {
    const productoId = overlay.querySelector('#c-select-producto').value;
    const cantidad = Number(overlay.querySelector('#c-cantidad').value);
    if (!productoId || !cantidad || cantidad < 1) {
      mostrarToast('Selecciona un producto y una cantidad válida.', 'aviso');
      return;
    }
    const existente = itemsActuales.find((it) => it.producto_id === productoId);
    if (existente) existente.cantidad += cantidad;
    else itemsActuales.push({ producto_id: productoId, cantidad });
    pintarItems();
  });

  overlay.querySelector('#c-cancelar').addEventListener('click', () => overlay.remove());

  overlay.querySelector('#c-guardar').addEventListener('click', async () => {
    const nombre = overlay.querySelector('#c-nombre').value.trim();
    const notas = overlay.querySelector('#c-notas').value.trim();
    const resultado = await guardarCombo({
      nombre,
      notas,
      items: itemsActuales,
      comboVigenteId: comboExistente?.id || null,
    });
    if (resultado) {
      overlay.remove();
      alGuardar();
    }
  });
}
