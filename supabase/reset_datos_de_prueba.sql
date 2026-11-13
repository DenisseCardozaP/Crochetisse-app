-- =====================================================================
-- REINICIO DE DATOS DE PRUEBA
-- Córrelo UNA vez, justo antes de empezar a usar el sistema "en serio".
--
-- ANTES: saca un respaldo (Supabase > Database > Backups, o pídeme el pg_dump). Esto BORRA datos.
--
-- BORRA:  ventas, bazares, cotizaciones y pedidos (los folios vuelven a empezar en 0001), producción, compras, movimientos de inventario, productos y recetas,
--         precios de referencia, historial de costos, bitácora de cambios y los insumos que no
--         estén en la lista de conservar.
-- CONSERVA: tu usuario y perfil, configuración (tarifa, ganancia, redondeo), IVA, métodos de pago y
--         comisiones, proveedores, categorías, grupos de precio y sus escalones, y tu estambre
--         Alize Velluto (23 colores) con su costo actual. Su existencia vuelve al conteo inicial (112 madejas).
--
-- SI YA CAPTURASTE COSAS REALES (insumos o productos que quieres quedarte), escribe sus nombres EXACTOS
-- en las dos listas de abajo ANTES de correrlo. Los productos que conserves deben usar solo insumos
-- que también conserves. De los insumos que conserves se mantiene su costo actual y su existencia.
-- =====================================================================
begin;

create temp table keep_items_cfg (name text);
create temp table keep_products_cfg (name text);

-- >>> EDITA AQUÍ (un nombre por renglón, tal como aparece en la app). Si no hay nada, déjalo vacío. <<<
-- insert into keep_items_cfg values ('Relleno de fibra'), ('Ojos de seguridad 8 mm');
-- insert into keep_products_cfg values ('Conejito');
-- >>> FIN DE LA PARTE EDITABLE <<<

-- 1. Qué se conserva
create temp table keep_items as
select i.id from public.items i
where i.brand = 'Alize Velluto' or lower(btrim(i.name)) in (select lower(btrim(name)) from keep_items_cfg);

create temp table keep_products as
select p.id from public.products p
where lower(btrim(p.name)) in (select lower(btrim(name)) from keep_products_cfg);

do $$
declare v text;
begin
  select string_agg(distinct i.name, ', ') into v
  from public.product_components c
  join public.product_versions pv on pv.id = c.version_id
  join public.items i on i.id = c.item_id
  where pv.product_id in (select id from keep_products) and c.item_id not in (select id from keep_items);
  if v is not null then
    raise exception 'Un producto que conservas usa insumos que no conservas: %. Agrégalos a la lista de insumos.', v;
  end if;
  select string_agg(distinct p.name, ', ') into v
  from public.product_components c
  join public.product_versions pv on pv.id = c.version_id
  join public.products p on p.id = c.component_product_id
  where pv.product_id in (select id from keep_products) and c.component_product_id not in (select id from keep_products);
  if v is not null then
    raise exception 'Un producto que conservas lleva otros productos que no conservas: %. Agrégalos a la lista de productos.', v;
  end if;
end $$;

-- 2. Copias temporales de lo que se queda
create temp table t_cost as
select c.item_id, c.purchase_price, c.supplier_id from public.v_item_cost_current c where c.item_id in (select id from keep_items);

create temp table t_stock as
select m.item_id, sum(m.qty_base) as qty
from public.stock_movements m
where m.item_id in (select id from keep_items)
  and m.item_id not in (select id from public.items where brand = 'Alize Velluto')
group by m.item_id having sum(m.qty_base) > 0;

create temp table t_products as select * from public.products where id in (select id from keep_products);
create temp table t_versions as select * from public.product_versions where product_id in (select id from keep_products);
create temp table t_components as select * from public.product_components where version_id in (select id from t_versions);
create temp table t_prices as select * from public.product_prices where product_id in (select id from keep_products);

-- 3. Vaciar (TRUNCATE no dispara los candados de "no se puede borrar"; se hace todo junto por las relaciones)
truncate table
  public.expense_voids, public.expenses, public.withdrawal_voids, public.withdrawals,
  public.order_payments, public.order_line_components, public.order_lines, public.orders, public.folio_counters,
  public.sale_voids, public.sale_lines, public.sales,
  public.event_products, public.events,
  public.product_stock_movements, public.production_runs, public.yarn_transfers,
  public.purchase_voids, public.purchase_lines, public.purchases,
  public.stock_movements, public.item_price_history,
  public.product_prices, public.product_components, public.product_versions, public.products,
  public.audit_log;

delete from public.items where id not in (select id from keep_items);

-- 4. Regresar productos y recetas conservados
insert into public.products (id, code, name, kind, description, image_path, category_id, tax_rate_id,
  pricing_method_override, profit_pct_override, default_packaging_id, barcode, is_active, created_at, created_by, updated_at)
select id, code, name, kind, description, image_path, category_id, tax_rate_id,
  pricing_method_override, profit_pct_override, null, barcode, is_active, created_at, created_by, updated_at
from t_products order by (kind = 'packaging') desc;
update public.products p set default_packaging_id = t.default_packaging_id
from t_products t where t.id = p.id and t.default_packaging_id in (select id from keep_products);
insert into public.product_versions select * from t_versions;
insert into public.product_components select * from t_components;
insert into public.product_prices select * from t_prices;

-- 5. Costo actual de los insumos conservados
insert into public.item_price_history (item_id, valid_from, purchase_price, supplier_id, source, note)
select item_id, public.today_mx(), purchase_price, supplier_id, 'manual', 'Costo conservado al reiniciar los datos de prueba'
from t_cost;

-- 6. Existencia: Alize Velluto vuelve al conteo inicial; el resto de lo conservado mantiene su existencia
insert into public.stock_movements (item_id, qty_base, unit_cost, kind, note)
select i.id, o.qty, (select c.unit_cost_base from public.v_item_cost_current c where c.item_id = i.id), 'opening',
       'Existencia inicial (conteo de tu archivo)'
from (values
    ('Light yellow', 2),
    ('Orange', 2),
    ('Black', 9),
    ('Mimosa', 5),
    ('Pistachio green', 5),
    ('Lilac', 5),
    ('Asparagus', 4),
    ('Lavender', 5),
    ('Honey', 3),
    ('Coal grey', 4),
    ('Camel', 5),
    ('Dusty pink', 5),
    ('Light cream', 5),
    ('Baby blue', 5),
    ('Medium brown', 3),
    ('Red', 5),
    ('Baby pink', 5),
    ('Blue', 5),
    ('Brown', 5),
    ('Marigold', 5),
    ('Cotton candy', 5),
    ('White', 10),
    ('Grey', 5)
) as o(color, qty)
join public.items i on i.brand = 'Alize Velluto' and i.color = o.color;

insert into public.stock_movements (item_id, qty_base, unit_cost, kind, note)
select s.item_id, s.qty, (select c.unit_cost_base from public.v_item_cost_current c where c.item_id = s.item_id), 'opening',
       'Existencia conservada al reiniciar los datos de prueba'
from t_stock s;

-- La bitácora arranca limpia (los pasos de arriba también la llenaron)
truncate table public.audit_log;

-- 7. Comprobaciones: si algo no cuadra, se cancela todo
do $$
declare n int; v numeric;
begin
  select count(*) into n from public.sales;           if n <> 0 then raise exception 'Quedaron ventas.'; end if;
  select count(*) into n from public.events;          if n <> 0 then raise exception 'Quedaron bazares.'; end if;
  select count(*) into n from public.orders;          if n <> 0 then raise exception 'Quedaron pedidos.'; end if;
  select count(*) into n from public.purchases;       if n <> 0 then raise exception 'Quedaron compras.'; end if;
  select count(*) into n from public.production_runs; if n <> 0 then raise exception 'Quedó producción.'; end if;
  select sum(s.stock_qty) into v from public.v_item_stock s join public.items i on i.id = s.item_id where i.brand = 'Alize Velluto';
  if v is distinct from 112 then raise exception 'La existencia de Alize Velluto es %, debía ser 112.', v; end if;
  select count(*) into n from public.items i
    where i.brand = 'Alize Velluto' and not exists (select 1 from public.item_price_history h where h.item_id = i.id);
  if n <> 0 then raise exception 'Hay % colores de Alize sin costo.', n; end if;
end $$;

commit;
