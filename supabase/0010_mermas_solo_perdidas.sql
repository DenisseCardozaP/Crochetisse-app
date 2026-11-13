-- =====================================================================
-- 0010: las mermas solo cuentan PÉRDIDAS. Un ajuste que suma existencia
-- (conteo, corrección) ya no se cuenta como ganancia. Ejecutar UNA sola vez.
-- =====================================================================
create or replace view public.v_earning_facts as
-- ventas de bazar / directas (no anuladas)
select s.sale_date as fact_date, 'sale'::text as kind,
       coalesce(e.name, 'Venta directa') as label, s.id as ref_id,
       s.total as gross, s.card_fee as fees,
       coalesce(l.cogs, 0) as cogs, coalesce(l.labor, 0) as labor,
       0::numeric as expense_event, 0::numeric as expense_other, 0::numeric as shrink, 0::numeric as internal_margin
from public.sales s
left join public.events e on e.id = s.event_id
left join lateral (
  select sum(qty * unit_cost) as cogs, sum(qty * unit_labor) as labor from public.sale_lines where sale_id = s.id
) l on true
where not exists (select 1 from public.sale_voids v where v.sale_id = s.id)
union all
-- pedidos concretados (entregados y pagados completos)
select o.concretized_on, 'order', coalesce(o.order_folio, o.quote_folio) || ' · ' || o.customer_name, o.id,
       o.total, o.fees, coalesce(o.cost_real, 0), coalesce(o.labor_real, 0), 0, 0, 0, 0
from public.v_order_summary o
where o.concretized
union all
-- costo de mesa de cada bazar
select e.event_date, 'table_cost', 'Mesa: ' || e.name, e.id, 0, 0, 0, 0, e.table_cost, 0, 0, 0
from public.events e where e.table_cost > 0
union all
-- gastos (no anulados)
select x.expense_date, 'expense', x.category || coalesce(': ' || x.description, ''), x.id,
       0, 0, 0, 0,
       case when x.event_id is not null then x.amount else 0 end,
       case when x.event_id is null then x.amount else 0 end, 0, 0
from public.expenses x
where not exists (select 1 from public.expense_voids v where v.expense_id = x.id)
union all
-- mermas: ajustes de inventario de insumos
select m.moved_on, 'shrink', 'Ajuste de insumo: ' || coalesce(m.note, ''), m.id,
       0, 0, 0, 0, 0, 0, greatest(-(m.qty_base * coalesce(m.unit_cost, 0)), 0), 0
from public.stock_movements m where m.kind = 'adjustment'
union all
-- mermas: ajustes de producto terminado
select m.moved_on, 'shrink', 'Ajuste de producto: ' || coalesce(m.note, ''), m.id,
       0, 0, 0, 0, 0, 0, greatest(-(m.qty * coalesce(m.unit_cost, 0)), 0), 0
from public.product_stock_movements m where m.kind = 'adjustment'
union all
-- estambre pasado a producción: ganancia interna (informativa)
select t.transfer_date, 'yarn_transfer', 'Estambre a producción', t.id,
       0, 0, 0, 0, 0, 0, 0,
       t.qty_madejas * (t.price_per_madeja - coalesce(t.from_cost_per_madeja, t.price_per_madeja))
from public.yarn_transfers t;

