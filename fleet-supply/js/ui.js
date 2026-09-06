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

export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
