-- =====================================================================
-- Borrar insumos que no quieres (por ejemplo, estambres de tus pruebas).
-- Seguro: si un insumo ya se usó en una compra, venta, receta o traspaso, NO lo borra y te dice dónde se usa
-- (en ese caso usa "Desactivar" en la pantalla Insumos). Todo o nada.
--
-- PASO 1 (solo mirar): ejecuta esta consulta para ver tus insumos que NO son del estambre Alize
-- y cuántas veces se usan. Luego copia los nombres EXACTOS que quieras borrar.
--
--   select i.name, i.brand, i.color, i.kind,
--          (select count(*) from public.purchase_lines p where p.item_id = i.id) as compras,
--          (select count(*) from public.product_components c where c.item_id = i.id) as recetas
--   from public.items i
--   where coalesce(i.brand, '') <> 'Alize Velluto'
--   order by i.created_at;
--
-- PASO 2: escribe los nombres entre comillas simples, separados por coma, en la línea marcada,
-- y ejecuta TODO este archivo.
-- =====================================================================
begin;

create temp table _borrar on commit drop as
select id, name from public.items
where name = any (array[
  'ESCRIBE AQUÍ EL NOMBRE 1',
  'ESCRIBE AQUÍ EL NOMBRE 2'
]);

do $$
declare
  r record; n int; v_msg text := ''; v_found int;
begin
  select count(*) into v_found from _borrar;
  if v_found = 0 then raise exception 'No encontré ningún insumo con esos nombres. Revisa que estén idénticos a como aparecen en Insumos.'; end if;

  -- no borrar nada que ya se haya usado (todas las tablas que apuntan a items, salvo su historial de precios y movimientos)
  for r in
    select c.conrelid::regclass::text as tbl, a.attname as col
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
    where c.confrelid = 'public.items'::regclass and c.contype = 'f'
      and c.conrelid::regclass::text not in ('public.item_price_history', 'public.stock_movements', 'item_price_history', 'stock_movements')
  loop
    execute format('select count(*) from %s where %I in (select id from _borrar)', r.tbl, r.col) into n;
    if n > 0 then v_msg := v_msg || format('%s (%s filas); ', r.tbl, n); end if;
  end loop;
  if exists (select 1 from public.stock_movements m where m.item_id in (select id from _borrar) and m.kind not in ('opening', 'adjustment')) then
    v_msg := v_msg || 'movimientos de inventario (compras, producción o ventas); ';
  end if;
  if v_msg <> '' then
    raise exception 'No se borró nada: esos insumos ya se usaron en: %  Usa "Desactivar" en Insumos para esconderlos.', v_msg;
  end if;
end $$;

-- su historial de precios y movimientos de existencia inicial (son inmutables, por eso se apagan sus candados un momento)
alter table public.item_price_history disable trigger user;
alter table public.stock_movements disable trigger user;
delete from public.item_price_history where item_id in (select id from _borrar);
delete from public.stock_movements where item_id in (select id from _borrar);
alter table public.item_price_history enable trigger user;
alter table public.stock_movements enable trigger user;

delete from public.items where id in (select id from _borrar);

select 'Borrados: ' || string_agg(name, ', ') as resultado from _borrar;
commit;
