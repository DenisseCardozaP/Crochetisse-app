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
