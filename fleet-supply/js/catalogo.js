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
import {
  ROLES_EDITAN_CATALOGO,
  LINEAS,
  MARCAS,
  CONTROL_INVENTARIO,
  RUTAS,
  CATEGORIAS,
  MONEDAS_COSTO,
  NEGOCIOS_ACTIVOS,
} from './config.js';

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

// Compara el valor que trae la base contra el que entrega el formulario.
// Hace falta porque Supabase devuelve las columnas numeric como número
// (1440000) mientras el formulario las entrega como texto ("1440000"):
// con !== estricto eso se veía como un cambio y ensuciaba la auditoría.
function mismoValor(a, b) {
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
    if (!mismoValor(actual[campo], cambios[campo])) {
      diffs[campo] = [actual[campo], cambios[campo]];
    }
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

// ¿Este combo ya se usó en un negocio? Si sí, no se puede editar en
// sitio: hay que guardar una nueva versión para que el negocio conserve
// el combo con el que se vendió. Se activa poniendo NEGOCIOS_ACTIVOS en
// true cuando ya existan negocios cargados.
async function comboEnUso(comboId) {
  if (!NEGOCIOS_ACTIVOS) return false;
  const { count, error } = await sb
    .from('fs_negocio_linea')
    .select('id', { count: 'exact', head: true })
    .eq('combo_id', comboId);
  if (error) {
    console.error(error);
    return false;
  }
  return (count || 0) > 0;
}

// Texto legible de los ítems, para dejarlo en la bitácora.
async function resumirItems(items) {
  if (!items?.length) return '(sin ítems)';
  const ids = [...new Set(items.map((it) => it.producto_id))];
  const { data } = await sb.from('fs_productos').select('id,sku').in('id', ids);
  const porId = Object.fromEntries((data || []).map((p) => [p.id, p.sku]));
  return items.map((it) => `${porId[it.producto_id] || it.producto_id} x${it.cantidad}`).join(', ');
}

// Edita el combo en sitio, SIN crear versión nueva. Se usa mientras el
// combo no esté comprometido con un negocio: sirve para corregir un
// nombre, una nota o una cantidad sin llenar la tabla de versiones.
export async function editarCombo({ comboId, nombre, notas, items }) {
  if (!tieneRol(...ROLES_EDITAN_CATALOGO)) {
    mostrarToast('No tienes permiso para editar combos.', 'error');
    return null;
  }
  if (!nombre?.trim() || !items?.length) {
    mostrarToast('El combo necesita un nombre y al menos un producto.', 'aviso');
    return null;
  }
  if (await comboEnUso(comboId)) {
    mostrarToast('Este combo ya se usó en un negocio: guarda una nueva versión en vez de editarlo.', 'aviso');
    return null;
  }

  const anterior = await obtenerComboConItems(comboId);
  if (!anterior) {
    mostrarToast('No se encontró el combo.', 'error');
    return null;
  }

  const { error: errHeader } = await sb
    .from('fs_combos')
    .update({ nombre: nombre.trim(), notas: notas || null })
    .eq('id', comboId);
  if (errHeader) {
    console.error(errHeader);
    mostrarToast('No se pudo guardar. ¿Ya existe otro combo con ese nombre y versión?', 'error');
    return null;
  }

  // Se reemplazan las líneas del combo. El detalle anterior queda
  // registrado en fs_auditoria antes de sustituirlo.
  const resumenAntes = await resumirItems(
    anterior.items.map((it) => ({ producto_id: it.producto_id, cantidad: it.cantidad }))
  );
  const resumenDespues = await resumirItems(items);

  const { error: errDel } = await sb.from('fs_combo_items').delete().eq('combo_id', comboId);
  if (errDel) {
    console.error(errDel);
    mostrarToast('No se pudieron actualizar los productos del combo.', 'error');
    return null;
  }
  const { error: errIns } = await sb.from('fs_combo_items').insert(
    items.map((it) => ({ combo_id: comboId, producto_id: it.producto_id, cantidad: it.cantidad }))
  );
  if (errIns) {
    console.error(errIns);
    mostrarToast('El combo quedó sin productos: vuelve a agregarlos.', 'error');
    return null;
  }

  const diffs = {};
  if (anterior.nombre !== nombre.trim()) diffs.nombre = [anterior.nombre, nombre.trim()];
  if ((anterior.notas || '') !== (notas || '')) diffs.notas = [anterior.notas, notas];
  if (resumenAntes !== resumenDespues) diffs.items = [resumenAntes, resumenDespues];
  await registrarAuditoria('fs_combos', comboId, diffs);

  mostrarToast('Combo actualizado.', 'exito');
  return { id: comboId };
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
          <th>SKU</th><th>Nombre</th><th>Categoría</th><th>Línea</th><th>Marca</th>
          <th>Control</th><th>Precio ≤10</th><th>Precio 11+</th><th>Ruta planeación</th>
          <th>Mín.</th><th>SIM</th>
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
            <td>${p.categoria ? CATEGORIAS[p.categoria] : '—'}</td>
            <td>${LINEAS[p.linea] || escapeHtml(p.linea)}</td>
            <td>${p.marca ? MARCAS[p.marca] : '—'}</td>
            <td>${CONTROL_INVENTARIO[p.control_inventario] || '—'}</td>
            <td>${p.precio_venta_hasta_10 != null ? formatoCOP(p.precio_venta_hasta_10) : '—'}</td>
            <td>${p.precio_venta_11_mas != null ? formatoCOP(p.precio_venta_11_mas) : '—'}</td>
            <td>${p.ruta_habitual ? RUTAS[p.ruta_habitual] : '—'}</td>
            <td>${p.stock_minimo ?? '—'}</td>
            <td>${p.requiere_sim ? 'Sí' : '—'}</td>
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
        <label>Categoría
          <select id="f-categoria">
            <option value="">—</option>
            ${Object.entries(CATEGORIAS).map(([v, l]) => `<option value="${v}" ${existente && producto.categoria === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
        <label>Control de inventario
          <select id="f-control">
            ${Object.entries(CONTROL_INVENTARIO).map(([v, l]) => `<option value="${v}" ${existente && producto.control_inventario === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
        <label>Ruta para planeación (lead time)
          <select id="f-ruta">
            <option value="">—</option>
            ${Object.entries(RUTAS).map(([v, l]) => `<option value="${v}" ${existente && producto.ruta_habitual === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
        <label>Costo del proveedor<input id="f-costo" type="number" step="0.01" value="${existente ? producto.costo_usd ?? '' : ''}"></label>
        <label>Moneda del costo
          <select id="f-moneda">
            ${Object.entries(MONEDAS_COSTO).map(([v, l]) => `<option value="${v}" ${existente && (producto.costo_moneda || 'USD') === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
        <label>Precio venta ≤10 (COP)<input id="f-precio10" type="number" step="1" value="${existente ? producto.precio_venta_hasta_10 ?? '' : ''}"></label>
        <label>Precio venta 11+ (COP)<input id="f-precio11" type="number" step="1" value="${existente ? producto.precio_venta_11_mas ?? '' : ''}"></label>
        <label>Stock mínimo<input id="f-minimo" type="number" min="0" step="1" value="${existente ? producto.stock_minimo ?? '' : ''}"></label>
        <label class="fs-checkbox"><input id="f-comodato" type="checkbox" ${existente && producto.aplica_comodato ? 'checked' : ''}> Aplica comodato</label>
        <label class="fs-checkbox"><input id="f-sim" type="checkbox" ${existente && producto.requiere_sim ? 'checked' : ''}> Necesita SIM card</label>
        <div class="fs-full fs-ayuda-modo">La ruta no decide cómo se compra (eso lo define Comercio Exterior en cada orden): solo se usa para calcular días de cobertura y stock mínimo sugerido. Ante duda, elige la más lenta.</div>
        <label class="fs-full">Notas<textarea id="f-notas">${existente ? escapeHtml(producto.notas || '') : ''}</textarea></label>
      </div>
      <div class="fs-modal-actions">
        <button class="fs-btn-secundario" id="f-cancelar">Cancelar</button>
        <button class="fs-btn-primary" id="f-guardar">Guardar</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('#f-cancelar').addEventListener('click', () => overlay.remove());

  // Los campos de dinero se mandan como número, no como texto, para que
  // la base y la auditoría trabajen siempre con el mismo tipo de dato.
  const leerNumero = (selector) => {
    const v = overlay.querySelector(selector).value.trim();
    if (v === '') return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  };

  overlay.querySelector('#f-guardar').addEventListener('click', async () => {
    const datos = {
      sku: overlay.querySelector('#f-sku').value.trim(),
      nombre: overlay.querySelector('#f-nombre').value.trim(),
      linea: overlay.querySelector('#f-linea').value,
      marca: overlay.querySelector('#f-marca').value || null,
      categoria: overlay.querySelector('#f-categoria').value || null,
      control_inventario: overlay.querySelector('#f-control').value,
      ruta_habitual: overlay.querySelector('#f-ruta').value || null,
      costo_usd: leerNumero('#f-costo'),
      costo_moneda: overlay.querySelector('#f-moneda').value,
      precio_venta_hasta_10: leerNumero('#f-precio10'),
      precio_venta_11_mas: leerNumero('#f-precio11'),
      stock_minimo: leerNumero('#f-minimo'),
      aplica_comodato: overlay.querySelector('#f-comodato').checked,
      requiere_sim: overlay.querySelector('#f-sim').checked,
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
      <span class="fs-nota-toolbar">Los combos son plantillas reutilizables, no pedidos de cliente.</span>
    </div>
    <div id="fs-lista-combos"></div>
  `;

  const listaCont = container.querySelector('#fs-lista-combos');
  await pintarListaCombos(listaCont, combos, puedeEditar, container);

  const btnNuevo = container.querySelector('#fs-btn-nuevo-combo');
  if (btnNuevo) {
    btnNuevo.addEventListener('click', () =>
      abrirFormularioCombo({ modo: 'nuevo', alGuardar: () => renderCombos(container) })
    );
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
        ${
          puedeEditar
            ? `<div class="fs-card-combo-acciones">
                 <button class="fs-btn-link fs-combo-editar">Editar</button> ·
                 <button class="fs-btn-link fs-combo-duplicar">Duplicar</button> ·
                 <button class="fs-btn-link fs-combo-version">Nueva versión</button>
               </div>`
            : ''
        }
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
      .map(
        (it) =>
          `<li>${escapeHtml(it.fs_productos?.nombre || '—')} (${escapeHtml(it.fs_productos?.sku || '—')}) <strong>x ${it.cantidad}</strong></li>`
      )
      .join('')}</ul>`;
  }

  if (!puedeEditar) return;

  const abrirCon = async (btn, modo) => {
    const id = btn.closest('.fs-card-combo').dataset.id;
    const detalle = await obtenerComboConItems(id);
    if (!detalle) {
      mostrarToast('No se encontró el combo.', 'error');
      return;
    }
    abrirFormularioCombo({
      modo,
      combo: detalle,
      alGuardar: () => renderCombos(contenedorPadre),
    });
  };

  container.querySelectorAll('.fs-combo-editar').forEach((btn) => {
    btn.addEventListener('click', () => abrirCon(btn, 'editar'));
  });
  container.querySelectorAll('.fs-combo-duplicar').forEach((btn) => {
    btn.addEventListener('click', () => abrirCon(btn, 'duplicar'));
  });
  container.querySelectorAll('.fs-combo-version').forEach((btn) => {
    btn.addEventListener('click', () => abrirCon(btn, 'version'));
  });
}

/*
  Un solo formulario, cuatro modos:

  nuevo     — combo desde cero, versión 1.
  editar    — corrige el combo en sitio (nombre, notas, cantidades) sin
              crear versión. Disponible mientras el combo no esté usado
              por un negocio cerrado.
  duplicar  — crea un combo NUEVO a partir de este, con todo editable.
              Para los casos parecidos: se copia y se ajusta.
  version   — conserva el nombre, sube a version+1 y retira la anterior.
              Para cuando la plantilla cambia de verdad y quieres que
              quede el rastro de cómo era antes.
*/
async function abrirFormularioCombo({ modo, combo = null, alGuardar }) {
  const productos = await cargarProductos({ soloActivos: true });

  const titulos = {
    nuevo: 'Nuevo combo',
    editar: `Editar "${combo ? escapeHtml(combo.nombre) : ''}"`,
    duplicar: `Duplicar "${combo ? escapeHtml(combo.nombre) : ''}"`,
    version: `Nueva versión de "${combo ? escapeHtml(combo.nombre) : ''}"`,
  };
  const ayudas = {
    nuevo: 'Plantilla reutilizable. Se guarda como versión 1.',
    editar: 'Corrige la plantilla sin crear una versión nueva.',
    duplicar: 'Se crea un combo aparte. Puedes cambiarle todo, incluido el nombre.',
    version: 'El nombre no cambia. La versión actual se retira y esta queda vigente.',
  };
  const botones = {
    nuevo: 'Guardar combo',
    editar: 'Guardar cambios',
    duplicar: 'Crear copia',
    version: 'Guardar nueva versión',
  };

  const nombreInicial =
    modo === 'duplicar' ? `${combo.nombre} (copia)` : modo === 'nuevo' ? '' : combo.nombre;
  const notasIniciales = modo === 'nuevo' ? '' : combo.notas || '';
  const itemsIniciales =
    modo === 'nuevo'
      ? []
      : (combo.items || []).map((it) => ({ producto_id: it.producto_id, cantidad: it.cantidad }));

  const overlay = document.createElement('div');
  overlay.className = 'fs-modal-overlay show';
  overlay.innerHTML = `
    <div class="fs-modal fs-modal-ancho">
      <div class="fs-modal-title">${titulos[modo]}</div>
      <div class="fs-ayuda-modo">${ayudas[modo]}</div>
      <div class="fs-form-grid">
        <label class="fs-full">Nombre del combo
          <input id="c-nombre" value="${escapeHtml(nombreInicial)}" ${modo === 'version' ? 'disabled' : ''}>
        </label>
        <label class="fs-full">Notas<textarea id="c-notas">${escapeHtml(notasIniciales)}</textarea></label>
      </div>
      <div class="fs-combo-builder">
        <div class="fs-combo-builder-add">
          <select id="c-select-producto">
            <option value="">Selecciona un producto...</option>
            ${productos
              .map((p) => `<option value="${p.id}">${escapeHtml(p.nombre)} (${escapeHtml(p.sku)})</option>`)
              .join('')}
          </select>
          <input id="c-cantidad" type="number" min="1" value="1" style="width:70px">
          <button id="c-agregar-item" class="fs-btn-secundario">Agregar</button>
        </div>
        <ul id="c-lista-items" class="fs-lista-items-editable"></ul>
      </div>
      <div class="fs-modal-actions">
        <button class="fs-btn-secundario" id="c-cancelar">Cancelar</button>
        <button class="fs-btn-primary" id="c-guardar">${botones[modo]}</button>
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
        return `<li>
          <span class="fs-item-nombre">${escapeHtml(p?.nombre || '—')} (${escapeHtml(p?.sku || '—')})</span>
          <span class="fs-item-controles">
            x <input type="number" min="1" step="1" value="${it.cantidad}" data-idx="${idx}" class="fs-item-cant">
            <button data-idx="${idx}" class="fs-btn-link fs-quitar-item">Quitar</button>
          </span>
        </li>`;
      })
      .join('');

    // La cantidad se edita aquí mismo, sin volver a buscar el producto.
    // A propósito no se repinta la lista al escribir: si se repintara,
    // el campo perdería el foco en cada tecla.
    listaEl.querySelectorAll('.fs-item-cant').forEach((input) => {
      input.addEventListener('change', () => {
        const idx = Number(input.dataset.idx);
        const n = Number(input.value);
        if (!Number.isInteger(n) || n < 1) {
          input.value = itemsActuales[idx].cantidad;
          mostrarToast('La cantidad debe ser un número entero de 1 o más.', 'aviso');
          return;
        }
        itemsActuales[idx].cantidad = n;
      });
    });

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

    let resultado = null;
    if (modo === 'editar') {
      resultado = await editarCombo({ comboId: combo.id, nombre, notas, items: itemsActuales });
    } else if (modo === 'version') {
      resultado = await guardarCombo({
        nombre: combo.nombre,
        notas,
        items: itemsActuales,
        comboVigenteId: combo.id,
      });
    } else {
      // nuevo y duplicar terminan igual: un combo aparte, versión 1
      resultado = await guardarCombo({ nombre, notas, items: itemsActuales, comboVigenteId: null });
    }

    if (resultado) {
      overlay.remove();
      alGuardar();
    }
  });
}
