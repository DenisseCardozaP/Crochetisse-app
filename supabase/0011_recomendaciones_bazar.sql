-- =====================================================================
-- Etapa 7: recomendaciones de qué llevar a un bazar, según tus ventas pasadas.
-- Solo lee datos (no cambia nada). Ejecutar UNA sola vez.
-- Reglas (por producto, usando los bazares donde hubo ventas; ventas anuladas no cuentan):
--   estrella   = vendiste 80% o más de lo que llevaste  -> llevar 25% más de lo que sueles llevar
--   constante  = entre 50% y 80%                         -> llevar 15% más de lo que sueles vender
--   lento      = menos de 50%                            -> llevar solo lo que sueles vender
--   sin_ventas = ya lo llevaste y no vendiste            -> mejor no llevarlo
--   nuevo      = nunca lo has llevado                    -> probar con 2
-- =====================================================================
create or replace function public.bazaar_recommendations()
returns table (
  product_id uuid, name text, tag text, events_count int,
  qty_brought numeric, qty_sold numeric, sell_through numeric, avg_sold numeric,
  avg_price numeric, unit_cost numeric, profit_per_unit numeric, profit_total numeric,
  stock_now numeric, suggested_qty int, to_produce int, last_event date
)
language sql stable security invoker set search_path = public
as $$
  with held as (
    select distinct s.event_id from public.sales s
    where s.event_id is not null
      and not exists (select 1 from public.sale_voids v where v.sale_id = s.id)
  ),
  sold as (
    select sa.event_id, sl.product_id, sum(sl.qty) as qty, sum(sl.line_total) as revenue, sum(sl.qty * sl.unit_cost) as cost
    from public.sales sa join public.sale_lines sl on sl.sale_id = sa.id
    where sa.event_id is not null and sl.line_type = 'product'
      and not exists (select 1 from public.sale_voids v where v.sale_id = sa.id)
    group by sa.event_id, sl.product_id
  ),
  pe as (
    select coalesce(ep.event_id, s.event_id) as event_id, coalesce(ep.product_id, s.product_id) as product_id,
           coalesce(ep.qty_brought, 0) as brought, coalesce(s.qty, 0) as sold,
           coalesce(s.revenue, 0) as revenue, coalesce(s.cost, 0) as cost
    from public.event_products ep
    full join sold s on s.event_id = ep.event_id and s.product_id = ep.product_id
    where coalesce(ep.event_id, s.event_id) in (select event_id from held)
  ),
  agg as (
    select pe.product_id,
           count(*) filter (where brought > 0 or sold > 0)::int as events_count,
           sum(brought) as brought, sum(sold) as sold, sum(revenue) as revenue, sum(cost) as cost,
           sum(sold) filter (where brought > 0) as sold_on_list,
           avg(brought) filter (where brought > 0) as avg_brought,
           max(e.event_date) as last_event
    from pe join public.events e on e.id = pe.event_id
    group by pe.product_id
  ),
  base as (
    select p.id, p.name, coalesce(a.events_count, 0) as ev, coalesce(a.brought, 0) as brought,
           coalesce(a.sold, 0) as sold, coalesce(a.revenue, 0) as revenue, coalesce(a.cost, 0) as cost,
           case when coalesce(a.brought, 0) > 0 then a.sold_on_list / a.brought end as st,
           a.avg_brought, a.last_event,
           coalesce((select stock_qty from public.v_product_stock v where v.product_id = p.id), 0) as stock,
           public.product_unit_cost_now(p.id) as ucost
    from public.products p left join agg a on a.product_id = p.id
    where p.is_active and p.kind <> 'packaging'
  ),
  tagged as (
    select b.*, case when b.ev = 0 then 'nuevo'
                     when b.sold = 0 then 'sin_ventas'
                     when b.st is null then 'constante'
                     when b.st >= 0.8 then 'estrella'
                     when b.st >= 0.5 then 'constante'
                     else 'lento' end as tg,
           case when b.ev = 0 then 0 else b.sold / b.ev end as avg_s
    from base b
  )
  select t.id, t.name, t.tg, t.ev, t.brought, t.sold, round(t.st, 4), round(t.avg_s, 2),
         case when t.sold > 0 then round(t.revenue / t.sold, 2) end,
         t.ucost,
         case when t.sold > 0 then round(t.revenue / t.sold - coalesce(t.ucost, 0), 2) end,
         round(t.revenue - t.cost, 2), t.stock,
         sug.q, greatest(sug.q - t.stock, 0)::int, t.last_event
  from tagged t
  cross join lateral (
    select (case t.tg
              when 'nuevo' then 2
              when 'sin_ventas' then 0
              when 'estrella' then ceil(coalesce(t.avg_brought, t.avg_s) * 1.25)
              when 'constante' then ceil(t.avg_s * 1.15)
              else ceil(t.avg_s) end)::int as q
  ) sug
  order by case t.tg when 'estrella' then 1 when 'constante' then 2 when 'nuevo' then 3 when 'lento' then 4 else 5 end,
           t.revenue - t.cost desc, t.name;
$$;

revoke all on function public.bazaar_recommendations() from public, anon;
grant execute on function public.bazaar_recommendations() to authenticated;
