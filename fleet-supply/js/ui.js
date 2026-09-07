/* ═══════════════════════════════════════════════════════
   ui.js
   Componentes y helpers de interfaz reutilizables: toasts,
   modales, cambio de pestañas, estado de carga.
   ═══════════════════════════════════════════════════════ */

export function mostrarToast(mensaje, tipo = 'info') {
  let cont = document.getElementById('fs-toast-cont');
  if (!cont) {
    cont = document.createElement('div');
    cont.id = 'fs-toast-cont';
    cont.style.cssText =
      'position:fixed;top:16px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:8px;';
    document.body.appendChild(cont);
  }
  const colores = {
    info: '#19428C',
    exito: '#1D9E75',
    error: '#E24B4A',
    aviso: '#BA7517',
  };
  const toast = document.createElement('div');
  toast.textContent = mensaje;
  toast.style.cssText = `background:${colores[tipo] || colores.info};color:#fff;padding:10px 16px;
    border-radius:8px;font-size:13px;font-family:inherit;box-shadow:0 2px 8px rgba(0,0,0,.15);
    max-width:360px;`;
  cont.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

export function abrirModal(idModal) {
  const el = document.getElementById(idModal);
  if (el) el.classList.add('show');
}

export function cerrarModal(idModal) {
  const el = document.getElementById(idModal);
  if (el) el.classList.remove('show');
}

export function confirmar(mensaje) {
  // Confirm nativo por simplicidad en esta fase; se puede
  // reemplazar por un modal propio más adelante sin cambiar
  // la firma de la función.
  return window.confirm(mensaje);
}

export function cambiarTab(idPanel, botonEl, selectorPaneles = '.fs-panel', selectorTabs = '.fs-tab') {
  document.querySelectorAll(selectorPaneles).forEach((p) => p.classList.remove('active'));
  document.querySelectorAll(selectorTabs).forEach((t) => t.classList.remove('active'));
  const panel = document.getElementById(idPanel);
  if (panel) panel.classList.add('active');
  if (botonEl) botonEl.classList.add('active');
}

export function estadoCargando(contenedorEl, mensaje = 'Cargando...') {
  contenedorEl.innerHTML = `<div class="fs-loading">${mensaje}</div>`;
}

export function estadoVacio(contenedorEl, mensaje = 'No hay datos para mostrar.') {
  contenedorEl.innerHTML = `<div class="fs-empty">${mensaje}</div>`;
}

export function iniciales(nombre) {
  if (!nombre) return '?';
  return nombre
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || '')
    .join('');
}

/* ═══════════════ TABLAS ORDENABLES Y FILTRABLES ═══════════════
   Se usa marcando los <th> que se pueden ordenar:
     <th data-orden="texto">Nombre</th>
     <th data-orden="numero">Costo</th>
     <th data-orden="fecha">Llegada</th>
   y llamando hacerOrdenable(tablaEl) después de pintar la tabla.

   Ordena las filas que ya están en el DOM, sin volver a consultar la
   base: son listados de pocos cientos de filas y así el orden no
   depende de la conexión.
*/

// Texto visible de una celda, listo para comparar.
function textoCelda(fila, indice) {
  const td = fila.children[indice];
  if (!td) return '';
  return (td.dataset.orden ?? td.textContent ?? '').trim();
}

function aComparable(txt, tipo) {
  if (tipo === 'numero') {
    // Quita $, puntos de mil, espacios y el signo de moneda.
    const n = Number(String(txt).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
  }
  if (tipo === 'fecha') {
    const t = Date.parse(txt);
    return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
  }
  return String(txt).toLowerCase();
}

export function hacerOrdenable(tablaEl) {
  if (!tablaEl) return;
  const cuerpo = tablaEl.tBodies[0];
  if (!cuerpo) return;

  tablaEl.querySelectorAll('th[data-orden]').forEach((th, _i) => {
    const indice = [...th.parentElement.children].indexOf(th);
    th.addEventListener('click', () => {
      const tipo = th.dataset.orden || 'texto';
      const desc = th.classList.contains('asc');
      tablaEl.querySelectorAll('th[data-orden]').forEach((o) => o.classList.remove('asc', 'desc'));
      th.classList.add(desc ? 'desc' : 'asc');

      const filas = [...cuerpo.rows];
      filas.sort((a, b) => {
        const va = aComparable(textoCelda(a, indice), tipo);
        const vb = aComparable(textoCelda(b, indice), tipo);
        if (va < vb) return desc ? 1 : -1;
        if (va > vb) return desc ? -1 : 1;
        return 0;
      });
      filas.forEach((f) => cuerpo.appendChild(f));
    });
  });
}

/*
  Filtro de texto sobre una tabla ya pintada. Busca en todas las
  celdas de cada fila, sin acentos y sin distinguir mayúsculas, de
  modo que "camara" encuentre "CÁMARA".
  Si se le pasa un elemento en contadorEl, escribe ahí cuántas filas
  quedaron visibles.
*/
function sinAcentos(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export function hacerFiltrable(inputEl, tablaEl, contadorEl = null) {
  if (!inputEl || !tablaEl) return;
  const cuerpo = tablaEl.tBodies[0];
  if (!cuerpo) return;

  const aplicar = () => {
    const q = sinAcentos(inputEl.value.trim());
    let visibles = 0;
    for (const fila of cuerpo.rows) {
      const coincide = !q || sinAcentos(fila.textContent).includes(q);
      fila.hidden = !coincide;
      if (coincide) visibles++;
    }
    if (contadorEl) {
      contadorEl.textContent = q
        ? `${visibles} de ${cuerpo.rows.length} filas`
        : `${cuerpo.rows.length} filas`;
    }
  };

  inputEl.addEventListener('input', aplicar);
  aplicar();
  return aplicar;
}

/*
  Bloque para las secciones que todavía no existen. Evita que una
  pestaña vacía se vea como un error del módulo.
*/
export function enObra(contenedorEl, titulo, explicacion, fase) {
  contenedorEl.innerHTML = `
    <div class="fs-en-obra">
      <h3>${escapeHtml(titulo)}</h3>
      <p>${escapeHtml(explicacion)}</p>
      ${fase ? `<span class="fs-en-obra-fase">${escapeHtml(fase)}</span>` : ''}
    </div>`;
}

export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
