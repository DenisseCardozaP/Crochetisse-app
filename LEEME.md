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
