# ACTUALIZACIÓN 12 · Diseño divertido + respaldo, reseteo e importación (Etapa 8)

- **Diseño nuevo**: letra Poppins en negritas, rosa fuerte, verde olivo y café sobre crema con cuadros tipo tablero, botones tipo píldora y tarjetas de colores. La letra viene incluida en la app (funciona sin internet).
- **Respaldo** (Sistema > Respaldo, solo dueña): descarga TODO el negocio en un archivo. El Panel te avisa si pasan más de 7 días sin respaldar.
- **Importar CSV** (Insumos > Importar CSV): sube tu lista de insumos desde Excel/Sheets con precio y existencia inicial. Trae plantilla, revisión previa y omite duplicados.
- **Reseteo actualizado**: `supabase/reset_datos_de_prueba.sql` ahora también limpia gastos y retiros. En la pantalla Respaldo está el paso a paso para empezar de verdad.

Pasos:
1. Supabase > SQL Editor > New query > pega TODO `supabase/0012_respaldo.sql` > Run. UNA sola vez. (Solo lee datos.)
2. Sube la carpeta a GitHub (incluye `package.json`, `src`, `public`). Vercel instalará la letra al publicar.
3. NO ejecutes el reseteo todavía: primero descarga un respaldo y termina tus pruebas.

---

