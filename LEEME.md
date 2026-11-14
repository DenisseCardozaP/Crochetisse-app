# ACTUALIZACIÓN 13 · Tú decides si cambia el precio al comprar + borrar insumos de prueba

- **Compras:** si una compra sale a un precio distinto al que tienes guardado, por cada material te pregunta: "Mantener mi precio actual" (error, oferta o caso aislado) o "Usar el precio de esta compra" (cambio fijo). La compra y la existencia siempre quedan con lo que realmente pagaste; lo que eliges es si tus costos y precios de venta se mueven. La opción que aparece por defecto es mantener tu precio. Si un material aún no tiene precio, la compra lo establece.
- **Borrar insumos de prueba:** `supabase/borrar_insumos.sql` (ver pasos adentro). Solo borra si el insumo no se ha usado en compras, recetas, ventas o traspasos; si se usó, no borra nada y te dice dónde.

Pasos:
1. Supabase > SQL Editor > New query > pega TODO `supabase/0013_compras_decidir_precio.sql` > Run. UNA sola vez.
2. Sube la carpeta a GitHub.
3. Para tus 2 estambres: abre `supabase/borrar_insumos.sql`, ejecuta primero la consulta del PASO 1 (viene comentada en el archivo), copia los nombres exactos y pégalos en la lista del PASO 2; ejecuta el archivo completo.

---

