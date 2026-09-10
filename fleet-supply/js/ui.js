/* ═══════════════════════════════════════════════════════
   ui.js
   Componentes y helpers de interfaz reutilizables: toasts,
   modales, cambio de pestañas, estado de carga, y tablas
   ordenables y filtrables.
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

export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* ═══════════════════════════════════════════════════════
   Tablas ordenables y filtrables

   Las dos reciben elementos ya pintados y no saben nada del
   dato: trabajan sobre el texto de las celdas. Eso las hace
   servir para cualquier tabla del módulo sin configuración,
   a cambio de una regla: la celda debe mostrar el valor, no
   esconderlo en un atributo.

   Cuando el texto no sirve para ordenar (una fecha dd/mm/aaaa
   se ordenaría como texto y pondría el 09/02 antes del 10/01),
   ponga el valor ordenable en data-orden en el <td> y esa
   función lo usa en vez del texto.
   ═══════════════════════════════════════════════════════ */

function sinAcentos(txt) {
  return String(txt ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim();
}

/**
 * Convierte el texto de una celda en algo comparable.
 * Reconoce dinero ($ 1.234.567), porcentajes (25,0%), fechas
 * dd/mm/aaaa y aaaa-mm-dd. Lo demás se compara como texto.
 */
function valorOrdenable(celda) {
  if (!celda) return '';
  const explicito = celda.dataset ? celda.dataset.orden : null;
  const txt = String(explicito ?? celda.textContent ?? '').trim();
  if (!txt || txt === '—' || txt === '-') return null;   // vacíos, siempre al final

  const fechaCorta = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(txt);
  if (fechaCorta) return Number(`${fechaCorta[3]}${fechaCorta[2]}${fechaCorta[1]}`);

  const fechaIso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(txt);
  if (fechaIso) return Number(`${fechaIso[1]}${fechaIso[2]}${fechaIso[3]}`);

  // Dinero y números en formato colombiano: punto de miles, coma decimal
  const limpio = txt
    .replace(/[^\d,.\-]/g, '')
    .replace(/\./g, '')
    .replace(',', '.');
  if (limpio !== '' && limpio !== '-' && !Number.isNaN(Number(limpio))) {
    return Number(limpio);
  }

  return sinAcentos(txt);
}

function comparar(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'es');
}

/**
 * Hace ordenable una tabla al hacer clic en sus encabezados.
 * Acepta el <table> o su <tbody>. Un <th> con data-no-orden se
 * queda quieto (útil para la columna de casillas o de acciones).
 */
export function hacerOrdenable(el) {
  if (!el) return;
  const tabla = el.tagName === 'TABLE' ? el : el.closest('table');
  if (!tabla || tabla.dataset.fsOrdenable === 'si') return;

  const cuerpo = tabla.tBodies[0];
  const encabezados = tabla.tHead
    ? [...tabla.tHead.rows[tabla.tHead.rows.length - 1].cells]
    : [];
  if (!cuerpo || encabezados.length === 0) return;

  tabla.dataset.fsOrdenable = 'si';

  encabezados.forEach((th, i) => {
    if (th.dataset.noOrden !== undefined) return;
    th.style.cursor = 'pointer';
    th.title = 'Ordenar por esta columna';

    th.addEventListener('click', () => {
      const desc = th.dataset.fsDir === 'asc';

      encabezados.forEach((otro) => {
        delete otro.dataset.fsDir;
        otro.textContent = otro.textContent.replace(/\s[▲▼]$/, '');
      });
      th.dataset.fsDir = desc ? 'desc' : 'asc';
      th.textContent = `${th.textContent.replace(/\s[▲▼]$/, '')} ${desc ? '▼' : '▲'}`;

      const filas = [...cuerpo.rows];
      filas.sort((f1, f2) => {
        const a = valorOrdenable(f1.cells[i]);
        const b = valorOrdenable(f2.cells[i]);
        // Los vacíos van al final SIEMPRE, en los dos sentidos: una fila
        // sin dato no es "la menor", es una fila sin dato.
        if (a === null && b === null) return 0;
        if (a === null) return 1;
        if (b === null) return -1;
        const r = comparar(a, b);
        return desc ? -r : r;
      });
      filas.forEach((f) => cuerpo.appendChild(f));
    });
  });
}

/**
 * Filtra las filas de una tabla mientras se escribe.
 * Busca todas las palabras del texto en cualquier parte de la
 * fila, sin importar acentos ni mayúsculas, así "nacar 24"
 * encuentra a Soluciones Nácar en comodato a 24 meses.
 *
 * @param {HTMLElement} input   campo de búsqueda
 * @param {HTMLElement} tabla   la <table> o su <tbody>
 * @param {HTMLElement} conteo  dónde escribir cuántas filas quedan (opcional)
 */
export function hacerFiltrable(input, tabla, conteo = null) {
  if (!input || !tabla) return;
  const cuerpo = tabla.tagName === 'TABLE' ? tabla.tBodies[0] : tabla;
  if (!cuerpo) return;

  // La tabla se vuelve a pintar y esta función se vuelve a llamar sobre
  // el mismo input: sin esto se acumularían escuchas duplicadas.
  if (input._fsFiltro) input.removeEventListener('input', input._fsFiltro);

  const aplicar = () => {
    const terminos = sinAcentos(input.value).split(/\s+/).filter(Boolean);
    let visibles = 0;

    [...cuerpo.rows].forEach((fila) => {
      const texto = sinAcentos(fila.textContent);
      const pasa = terminos.every((t) => texto.includes(t));
      fila.style.display = pasa ? '' : 'none';
      if (pasa) visibles += 1;
    });

    if (conteo) {
      const total = cuerpo.rows.length;
      conteo.textContent = terminos.length
        ? `${visibles} de ${total}`
        : `${total} ${total === 1 ? 'registro' : 'registros'}`;
    }
  };

  input._fsFiltro = aplicar;
  input.addEventListener('input', aplicar);
  aplicar();
}
