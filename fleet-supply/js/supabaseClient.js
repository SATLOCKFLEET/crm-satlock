/* ═══════════════════════════════════════════════════════
   supabaseClient.js
   Conexión compartida a Supabase — mismo proyecto y mismos
   usuarios que el CRM Satlock Fleet ya existente. Estas
   constantes se tomaron tal cual del index.html principal
   (constantes SUPA_URL / SUPA_KEY), no son nuevas.
   ═══════════════════════════════════════════════════════ */

const SUPA_URL = 'https://ewyagbwgzspnphawycye.supabase.co';
const SUPA_KEY = 'sb_publishable_LbYr_oD_eIqvgJTE9GiCJw_9FrLoukE';

// El SDK de Supabase se carga como script global en index.html
// (igual que en el CRM principal), así que window.supabase existe
// para cuando este módulo se ejecuta.
const { createClient } = window.supabase;

export const sb = createClient(SUPA_URL, SUPA_KEY, {
  auth: {
    // Mismo storageKey por defecto que usa supabase-js: al vivir
    // Fleet Supply en el mismo dominio (mismo origin) que el CRM,
    // la sesión ya iniciada en el CRM se reconoce aquí solo con
    // que el usuario haya iniciado sesión antes en /index.html.
    persistSession: true,
    autoRefreshToken: true,
  },
});
