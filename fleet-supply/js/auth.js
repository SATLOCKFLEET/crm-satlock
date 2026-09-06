/* ═══════════════════════════════════════════════════════
   auth.js
   Sesión y control de roles de Fleet Supply.

   No hay pantalla de login propia: Fleet Supply vive bajo el
   mismo dominio que el CRM (/fleet-supply/), así que si el
   usuario ya inició sesión en el CRM principal, el token de
   Supabase ya está en localStorage y esta sesión se reconoce
   sola. Si no hay sesión, se manda de vuelta al CRM a iniciar
   sesión ahí.
   ═══════════════════════════════════════════════════════ */

import { sb } from './supabaseClient.js';

let _sesion = null;
let _perfil = null; // fila de usuarios
let _rolFS = null; // fila de fs_usuarios_rol

export async function iniciar() {
  const { data, error } = await sb.auth.getSession();
  if (error || !data?.session) {
    redirigirALogin();
    return null;
  }
  _sesion = data.session;

  const { data: perfil, error: errPerfil } = await sb
    .from('usuarios')
    .select('id,nombre,cargo,rol,linea,regional,activo')
    .eq('id', _sesion.user.id)
    .maybeSingle();

  if (errPerfil || !perfil || perfil.activo === false) {
    mostrarSinAcceso('No encontramos tu usuario activo en el CRM.');
    return null;
  }
  _perfil = perfil;

  const { data: rolFsRow, error: errRol } = await sb
    .from('fs_usuarios_rol')
    .select('rol_fs')
    .eq('usuario_id', _perfil.id)
    .maybeSingle();

  if (errRol || !rolFsRow) {
    mostrarSinAcceso('Tu usuario no tiene un rol asignado en Fleet Supply todavía. Pídele al Jefe Comercial que te agregue.');
    return null;
  }
  _rolFS = rolFsRow.rol_fs;

  return { sesion: _sesion, perfil: _perfil, rolFS: _rolFS };
}

export function perfilActual() {
  return _perfil;
}

export function rolFSActual() {
  return _rolFS;
}

export function tieneRol(...roles) {
  return _rolFS != null && roles.includes(_rolFS);
}

export async function cerrarSesion() {
  await sb.auth.signOut();
  redirigirALogin();
}

function redirigirALogin() {
  // Ajusta la ruta si el CRM principal no vive un nivel arriba.
  window.location.href = '../index.html';
}

function mostrarSinAcceso(mensaje) {
  document.body.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;font-family:'Segoe UI',system-ui,sans-serif;">
      <div style="max-width:420px;text-align:center;">
        <div style="font-size:18px;font-weight:600;color:#0d1b3e;margin-bottom:10px;">Sin acceso a Fleet Supply</div>
        <div style="font-size:13px;color:#3d5080;margin-bottom:20px;">${mensaje}</div>
        <a href="../index.html" style="font-size:13px;color:#19428C;">Volver al CRM</a>
      </div>
    </div>`;
}
