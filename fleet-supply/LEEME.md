# Fleet Supply — Fase 1

Módulo de comercial y abastecimiento del área Fleet, dentro del CRM Satlock.
Esta Fase 1 entrega el cimiento: roles, catálogo de productos y combos.
No incluye pipeline, inventario, compras ni cronograma (fases siguientes).

---

## Qué trae

```
/fleet-supply/
  index.html            Pantalla del módulo (pestañas Catálogo y Combos)
  LEEME.md              Este archivo
  /css/estilos.css      Estilos (misma paleta del CRM)
  /js/supabaseClient.js Conexión a Supabase (misma URL y llave del CRM)
  /js/auth.js           Sesión compartida con el CRM + control de roles
  /js/ui.js             Toasts, modales, pestañas, estados de carga
  /js/formato.js        COP, USD, fechas dd/mm/aaaa, TRM (America/Bogota)
  /js/config.js         Roles, líneas, marcas, rutas de abastecimiento
  /js/catalogo.js       Productos y combos (lo funcional de esta fase)
  /js/importador.js     Vacío — fase posterior
  /js/negocios.js       Vacío — fase posterior
  /js/inventario.js     Vacío — fase posterior
  /js/compras.js        Vacío — fase posterior
  /js/cronograma.js     Vacío — fase posterior
  /js/finanzas.js       Vacío — fase posterior
```

El `index.html` del CRM principal **no se toca**. Este módulo vive aparte y
solo comparte la base de datos y los usuarios.

---

## Instalación

**1. Sube la carpeta al repo**

Sube `fleet-supply/` completa a la raíz del repositorio, al mismo nivel que el
`index.html` del CRM. Queda accesible en `tudominio.com/fleet-supply/`.

**2. Base de datos**

Las 5 tablas (`fs_usuarios_rol`, `fs_productos`, `fs_combos`, `fs_combo_items`,
`fs_auditoria`) ya fueron creadas con RLS activo, y ya se sembraron los roles.
Solo queda pendiente terminar de asignar a Diana y Carolina — el SQL está en el
chat.

**3. Entra al módulo**

Inicia sesión normalmente en el CRM y luego ve a `/fleet-supply/`. Reconoce tu
sesión sola, sin pedir clave otra vez.

---

## Roles

| Persona | Rol Fleet Supply | Qué puede hacer en esta fase |
|---|---|---|
| Yezid Bautista | `jefe_comercial` | Crear y editar productos y combos |
| Johan Gómez | `almacenista` | Consultar |
| Carolina Salamanca | `comercio_exterior` | Consultar |
| Jackeline Varela | `financiera` | Consultar |
| Juan Galán, David Herrera | `gerencia` | Consultar |
| Diana Andrade, Vivian Díaz | `solo_lectura` | Consultar |

Quien no tenga fila en `fs_usuarios_rol` no entra: ve una pantalla de
"Sin acceso". Para dar acceso a alguien más, se le inserta su fila ahí.

---

## Cómo probar

1. **Catálogo** — crea un producto (SKU + nombre + marca + control de
   inventario + precios). Debe aparecer en la tabla.
2. **Auditoría** — edita el precio de ese producto y revisa `fs_auditoria`:
   debe quedar el campo, el valor anterior, el nuevo, tu usuario y la fecha.
3. **Baja lógica** — desactívalo. Desaparece de la lista pero sigue en la
   tabla con `activo = false`. Nada se borra nunca.
4. **Combos** — arma un combo con 2 o 3 productos y cantidades, guárdalo.
5. **Versionado** — ábrelo y guarda una "nueva versión". En `fs_combos` deben
   quedar dos filas: la v1 con `vigente = false` y la v2 con `vigente = true`,
   cada una con sus propios ítems. Así un negocio ya cerrado conserva la
   versión con la que se vendió.
6. **Permisos** — entra con un usuario que no sea Yezid: debe ver el catálogo
   y los combos, pero sin botones de crear ni editar.

---

## Notas de diseño

- **Catálogo propio.** El listado de 497 ítems del CRM (arreglo fijo en el
  JavaScript del `index.html`) no tiene precio, costo ni marca, así que Fleet
  Supply construye su catálogo aparte en `fs_productos`. Las columnas
  `*_legado` guardan el dato viejo como referencia. Más adelante se decide si
  se vinculan las dos listas.
- **Roles desacoplados.** El rol de Fleet Supply vive en `fs_usuarios_rol`, no
  en `usuarios.rol`, porque ese campo ya se usa para permisos de otras partes
  del CRM (por ejemplo `facturacion` lo comparten varias personas) y no
  queremos que el módulo herede accesos de quien no debe tenerlos.
- **Precios por escala.** El umbral está centralizado en `config.js`
  (`UMBRAL_ESCALA_VOLUMEN = 10`): hasta 10 unidades aplica una escala, de 11 en
  adelante la otra. La aplicación automática según la cantidad del negocio se
  implementa cuando exista el negocio, en una fase posterior.
- **TRM manual.** Se ingresa a mano, como se acordó. `formato.js` ya la
  formatea.
