# ACTUALIZACIÓN 8 · Pedidos: precio del pedido completo + arreglos por pieza

Cambios:
- El precio se decide UNA vez para todo el pedido. La pantalla te muestra el costo estimado de todo, un precio sugerido con tu
  ganancia (botón "Usar") y tu utilidad con el precio que pongas. Sin precio por pieza.
- El empaque es una selección del pedido: su costo siempre cuenta y su precio va incluido en el total.
- Ramos y arreglos: al elegirlos aparecen las piezas de su receta; las cambias a lo que pidió el cliente (quitas, agregas,
  cambias cantidades). No necesitas crear un producto nuevo por cada ramo.
- Ya no se sale la ventanita al seleccionar texto y soltar el mouse fuera de ella.

Pasos:
1. Supabase > SQL Editor > New query > pega TODO `supabase/0008_pedido_precio_total.sql` > Run. "Success". UNA sola vez.
2. Sube la carpeta a GitHub (incluye `src`). Vercel republica solo.

---

# ACTUALIZACIÓN 7 · Cotizaciones y pedidos (Etapa 5)

Qué trae:
- Pestaña "Pedidos": cotizas (folio OP-2026-0001), confirmas y se vuelve pedido (folio PED-2026-0001).
- El precio de cada renglón lo decides tú. Al cotizar ves la referencia, el costo estimado (con tu mano de obra) y tu utilidad.
- Renglones: productos, bolsa (precio libre, puede ser $0) y renglones libres (envío, etc., con su costo si quieres).
- Ramo personalizado: marcas el renglón y eliges sus piezas (por ejemplo 1 conejito + 2 girasoles) en lugar de la receta base.
- Pagos: anticipo, resto y devoluciones, cada uno con su forma de pago y fecha. Un anticipo NO cuenta como venta.
- Entregar: lo que haya en producto terminado se toma de ahí y lo que falte se teje en ese momento (se descuentan sus
  materiales); la bolsa se descuenta al entregar. Se guarda la foto del costo real y de tu mano de obra.
- Un pedido queda "concretado" cuando está entregado Y pagado completo. Eso es lo que contará para tus ganancias.
- Cambios internos: la producción ahora acepta piezas personalizadas (lo usa la entrega); sin cambios para ti.
- También: ya no hay casilla de "entregué la bolsa" en la venta de bazar (si la agregas, se entregó).

Pasos:
1. Supabase > SQL Editor > New query > pega TODO `supabase/0007_pedidos.sql` > Run. "Success". UNA sola vez.
2. Sube la carpeta a GitHub (incluye `src`). Vercel republica solo.

Qué probar:
- Pedidos > Nueva cotización: cliente, 2 productos con TU precio, una bolsa en $0 y un envío como renglón libre.
- Confirmar: debe aparecer el folio PED. Registra un anticipo y revisa el saldo.
- Entregar: revisa que el inventario baje y que el costo real y la utilidad aparezcan. Registra el pago del saldo: pasa a "Concretado".
- Prueba un ramo personalizado y una cancelación.

---

# ACTUALIZACIÓN 6 · Venta sin internet en la iPad (Etapa 4b) + script de reinicio

Qué trae:
- La app ahora se instala en la iPad (pantalla de inicio) y abre SIN internet, igual que la prueba de la Etapa 0.
- Pestaña "Vender" (primera): muestra tus bazares abiertos y vende desde ellos. Cada venta se guarda PRIMERO en la iPad
  (nunca se pierde) y luego se envía sola cuando hay internet (al abrir, al volver la señal, cada 30 segundos o con
  "Enviar ahora"). Si el envío se repite, no se duplica.
- Las piezas que quedan se descuentan en la iPad aunque aún no se hayan enviado.
- Si el servidor rechaza una venta (por ejemplo, el bazar ya estaba cerrado) aparece en "Ventas con error" con el motivo,
  para reintentar o descartar. No se descuenta inventario hasta que se acepte.
- "Respaldo de ventas": exporta un archivo con todas las ventas de la iPad (se conservan 30 días aunque ya estén enviadas).
- No hay migración nueva en esta entrega: solo se sube la app.

Pasos:
1. Sube la carpeta a GitHub (incluye `src`, `public`, `package.json`, `vite.config.ts` e `index.html`). Vercel instala las
   dos piezas nuevas (dexie y vite-plugin-pwa) solo. Espera a que Vercel diga "Ready".
2. En la iPad, abre la dirección de la app en Safari CON internet, inicia sesión y entra a "Vender" una vez (así guarda
   tus bazares, productos, precios y formas de pago). Compartir > "Añadir a pantalla de inicio".
3. Abre la app desde el ícono nuevo. En "Vender" pulsa "Pedir almacenamiento seguro" si aparece.

PRUEBA ANTES DE UN BAZAR REAL (como la Etapa 0):
- Crea un bazar de prueba con productos (pestaña Bazares) y ábrelo en "Vender" con internet.
- Pon la iPad en modo avión, cierra la app por completo y ábrela otra vez: debe abrir y mostrar el bazar.
- Haz 3 ventas sin internet (una con bolsa, una con tarjeta, una con estambre). Deben mostrarse como "pendiente".
- Quita el modo avión: en segundos deben pasar a "enviada". En Bazares > tu bazar deben aparecer una sola vez cada una.
- Prueba "Respaldo de ventas".

Si abres la app sin internet por primera vez después de reinstalarla o de borrar datos de Safari, no tendrá tus bazares
guardados: siempre abre "Vender" con internet un rato antes de salir al bazar.

# REINICIO DE DATOS DE PRUEBA (cuando termines de probar)

`supabase/reset_datos_de_prueba.sql` borra ventas, bazares, producción, compras, inventario, productos y recetas de
prueba, y conserva tu configuración, comisiones, grupos de precio y tu estambre Alize Velluto (112 madejas, con su costo).
- Antes: saca un respaldo. Si ya capturaste insumos o productos REALES que quieras conservar, escribe sus nombres exactos en
  las dos listas que están al inicio del archivo (instrucciones dentro). Si no, córrelo tal cual.
- Se corre una vez en Supabase > SQL Editor. Si algo no cuadra, se cancela completo y no cambia nada.
- Después de correrlo, limpia también la iPad: en "Vender" haz "Respaldo de ventas" y borra los datos del sitio en Safari
  (Ajustes > Safari > Avanzado > Datos de sitios web) para quitar ventas de prueba pendientes.

---

# ACTUALIZACIÓN 5 · Bazares y ventas (Etapa 4a)

Qué trae:
- Pestaña "Bazares": creas el bazar (fecha, costo de mesa, fondo de caja) y armas SU lista de precios: producto, precio de
  ese bazar y cuántas piezas llevas. Puedes copiar la lista de otro bazar y ajustar. Cada bazar puede tener precios distintos.
- Botón "Vender": pantalla de venta con los productos como botones grandes (muestra cuántos quedan), precio editable al
  momento, estambre por madeja (el precio por cantidad se calcula solo contando todos los colores), una bolsa por venta
  cobrada aparte (con opción de "no la entregué": se cobra pero no descuenta inventario), efectivo con cambio, tarjeta con
  la comisión calculada.
- Cada venta guarda su foto: precio cobrado, costo y mano de obra de ese momento. Si cambias recetas después, no se mueve.
- Resumen del bazar: tickets, vendido, comisiones, costo de lo vendido (con tu mano de obra), mesa, utilidad y efectivo
  esperado en caja. Puedes anular ventas (regresan la existencia) y cerrar el bazar.

Pasos:
1. Supabase > SQL Editor > New query > pega TODO `supabase/0006_bazares_ventas.sql` > Run. "Success". UNA sola vez.
2. Sube la carpeta a GitHub (incluye `src`). Vercel republica solo.

Qué probar:
- Bazares > Nuevo bazar > agrega tus productos (y tus bolsas como productos tipo Empaque) con precio y piezas.
- Vender: haz un ticket con 2 productos + bolsa, cobra en efectivo. Luego otro con tarjeta y revisa la comisión.
- Vende 5 madejas mezcladas de estambre: deben salir a $65 cada una.
- Revisa el resumen y anula una venta: la existencia regresa.

IMPORTANTE: esta versión necesita internet para guardar cada venta. El modo SIN internet para la iPad (el mismo
mecanismo que probamos en la Etapa 0) es la siguiente entrega (4b), antes de que lo uses en un bazar real.
Para el bazar de este fin de semana sigue usando tu hoja de cálculo.

---

# ACTUALIZACIÓN 4 · Producción y estambre a producción (Etapa 3b)

Qué trae:
- Pestaña "Producción": registras N piezas producidas. Se descuentan los materiales de la receta (con merma) y se suman
  las piezas al inventario de producto terminado. Cada tanda guarda su costo REAL (materiales al costo promedio de ese
  día + mano de obra) junto al costo estimado, para que compares.
- Ramos y arreglos: toman sus piezas del producto terminado si hay; las que faltan se tejen desde cero (se descuentan
  sus materiales y se cuenta su mano de obra).
- "Pasar estambre a producción": sale de tu estambre de venta (a su costo de compra) y entra al material de producción en
  gramos al precio interno ($60 por madeja). No cuenta como venta. El costo del material de producción se mezcla con promedio.
- El precio guardado de un producto ahora se llama "precio de referencia": el precio real lo decides en cada bazar y en cada
  cotización de pedido (eso viene en la etapa de ventas).

Pasos:
1. Supabase > SQL Editor > New query > pega TODO `supabase/0005_produccion.sql` > Run. "Success". UNA sola vez.
2. Sube la carpeta a GitHub (incluye `src`). Vercel republica solo.

Qué probar:
- Insumos: crea "Estambre producción" (Material, unidad de compra madeja, unidad base g, 100 por compra).
- Producción > Pasar estambre a producción: 1 madeja de Negro -> tu material en gramos. Inventario: Negro baja 1, producción sube 100 g.
- Crea un amigurumi con receta (usando ese material) y registra producción de 2 piezas. Revisa el descuento en Inventario.
- Crea un ramo que lleve ese amigurumi y prodúcelo: usa las piezas terminadas y teje las que falten.

Nota: si produces sin tener existencia registrada de un material, la existencia queda negativa (se ve en Inventario): es
señal de que falta registrar una compra o un conteo.

---

# ACTUALIZACIÓN 3 · Compras e inventario (ya con tus correcciones)

Qué trae:
- Corrección de IVA: los productos usan IVA 0% por ahora; la comisión de tarjeta conserva su IVA (2.99% + $1 + IVA de la comisión).
  Cuando empieces a cobrar IVA, se cambia el IVA predeterminado (o el de cada producto).
- Pestaña "Compras": registras la compra completa (varios materiales + envío + total). El envío se reparte entre los
  renglones según su valor y de ahí sale el costo real de cada madeja/gramo ya puesto en tu casa.
- Costo con promedio ponderado: si el estambre subió, el nuevo costo mezcla lo que ya tenías con lo nuevo (sin brincos).
  Los costos de fechas pasadas no cambian.
- Pestaña "Inventario": existencia, costo y valor de cada material; ajustes por conteo, merma o regalo.
- Tu existencia inicial de estambre de venta: 112 madejas en 23 colores, a $42.40 por madeja ($212 / 5).

Pasos, en este orden:
1. Supabase > SQL Editor > New query > pega TODO `supabase/0004_compras_inventario.sql` > Run. "Success". UNA sola vez.
   (0001, 0002 y 0003 NO se vuelven a correr.)
2. Sube la carpeta a GitHub (incluye `src` completa). Vercel republica solo.

Qué probar:
- Inventario: 23 colores de Alize Velluto con su existencia; el Negro debe tener 9.
- Productos: el precio sugerido ahora sale sin IVA.
- Crea un material de producción (Insumos): tipo Material, unidad de compra "madeja", unidad base "g", unidades por compra 100.
  Luego Compras > Registrar compra: 5 madejas, total $212, envío lo que pagaste. Revisa el costo por gramo.
- Haz otra compra con otro precio y mira cómo el costo se mezcla (promedio).

Aún no existe: pasar estambre de venta a producción, usar materiales al producir, ventas. Siguen en la siguiente etapa.

---

# ACTUALIZACIÓN 2 · Productos y costeo

Qué trae: pestaña "Productos" para crear amigurumis, ramos/arreglos, combos y empaques; recetas con
versiones (cada cambio crea una versión nueva y el historial no se toca); costo de producción calculado
(materiales + mano de obra); un producto puede llevar otros productos (el ramo lleva conejitos) usando el
costo completo del conejito, sin volver a contar su estambre; precio sugerido (ganancia, IVA, comisión de
tarjeta y redondeo) y publicación del precio con fecha (solo la dueña).

Pasos, en este orden:

1. Supabase > SQL Editor > New query > pega TODO `supabase/0003_productos_costeo.sql` > Run. Debe decir "Success".
   Córrelo UNA sola vez. NO vuelvas a correr 0001 ni 0002 (ya están hechos).
2. Sube esta carpeta a tu repositorio de GitHub (Add file > Upload files, incluye `src` completa).
   Vercel vuelve a publicar solo.
3. Abre la app: pestaña nueva "Productos".

Para probar (necesitas precio de compra registrado en los materiales que uses):
- Crea un producto tipo Amigurumi > ábrelo > "Crear receta": horas de trabajo + materiales (cantidad en gramos o piezas).
- Revisa "Cómo se calculó el costo" y el precio sugerido.
- Como dueña: "Publicar precio" (sugerido o uno tuyo). Publica otro con fecha futura: hoy sigue rigiendo el actual.
- Crea un empaque (ej. "Bolsa chica con etiqueta") con su receta de bolsa + etiqueta.
- Crea un ramo que lleve el amigurumi (+ Otro producto) y revisa que el costo no cuente el estambre dos veces.
- Cambia la receta: debe aparecer como versión 2 y la 1 se conserva.

Nota: el estambre de VENTA no se puede usar en recetas; para producción necesitas materiales de producción
(en gramos). Si te marca "sin precio de compra", registra el precio del material en Insumos.

---

# ACTUALIZACIÓN 1b (si ya publicaste la Etapa 1)

Qué trae: estambre de venta por madeja, grupos de precio con escalones por cantidad
(1-4 = $70, 5-9 = $65, 10 o más = $60), precio interno ($60), tus 23 colores de Alize Velluto ya cargados,
y la fecha "Desde el inicio" en lugar de 2000-01-01.

Pasos, en este orden:

1. Supabase > SQL Editor > New query > pega TODO el contenido de `supabase/0002_precios_grupo_reventa.sql` > Run.
   Debe decir "Success". Córrelo UNA sola vez (si lo repites da error de "already exists"; no pasa nada).
   NO vuelvas a correr `0001`.
2. Actualiza la app: en tu repositorio de GitHub (`amigurumis-sistema`) sube los archivos de esta carpeta
   (Add file > Upload files) para que reemplacen a los anteriores. Incluye la carpeta `src` completa.
   Vercel vuelve a publicar solo en uno o dos minutos.
3. Abre la app. Debe haber una pestaña nueva: "Precios de venta".

Qué probar:
- Insumos: deben aparecer 23 estambres "Alize Velluto" de tipo "Para venta".
- Precios de venta > Alize Velluto: la tabla de precios, el precio interno y "Costo de compra: Sin registrar".
- "Costo de compra del grupo": registra lo que te cuesta cada madeja (el paquete de 5 entre 5) y revisa que se aplique a los 23.
- Cambia los precios a clientes con una fecha de mañana: hoy debe seguir rigiendo el actual.

Las existencias (112 madejas) todavía NO están en el sistema: se cargan cuando exista el módulo de inventario.

---

# Sistema de gestión de amigurumis · Etapa 1 (pantallas)

Esta versión incluye: inicio de sesión, insumos (con historial de precios y costo por gramo),
proveedores, categorías y configuración (tarifa, ganancia, reparto, comisiones).
Funciona en la computadora y también en el iPad (sin modo sin conexión todavía: ese es solo del punto de venta).

IMPORTANTE: antes de usarla, la migración `supabase/0001_nucleo_insumos.sql` debe estar corrida en Supabase
(ya la corriste). Si no, corre ese archivo en SQL Editor.

## Publicarla (recomendado: proyecto NUEVO, sin tocar la prueba anterior)

1. GitHub > New repository > nombre `amigurumis-sistema` > Private > Create repository (sin README).
2. "uploading an existing file" y arrastra el CONTENIDO de esta carpeta
   (index.html, package.json, tsconfig.json, vite.config.ts, LEEME.md y las carpetas src y supabase).
   No subas `node_modules`. Commit changes.
3. Vercel > Add New > Project > elige `amigurumis-sistema` > Deploy.
   (No agregues la integración de Supabase; solo Deploy.)
4. Abre la dirección que te da y entra con tu correo y contraseña de Supabase.

## Probarla en tu computadora (opcional)

    npm install
    npm run dev

## Qué probar primero

1. Entrar con tu correo y contraseña.
2. Proveedores y categorías: crea un proveedor y la categoría "Estambre" (tipo Insumos).
3. Insumos > Nuevo insumo:
   - Nombre: Estambre, tipo Material, unidad de compra: madeja, cantidad que trae: 100, unidad de consumo: g
   - Precio: 70. El costo por unidad debe decir $0.7000.
   - Marca "se vende" también si lo vendes. Guarda.
4. Abre el insumo y registra un precio nuevo (por ejemplo 80). El historial debe mostrar los dos y el costo actual debe pasar a $0.8000.
5. Configuración: debe mostrar $60 por hora, 30% sobre el precio (margen), reparto 50/50 y la comisión de tarjeta 2.99% + $1 con IVA.

Si algo falla, copia el mensaje exacto y mándamelo.
