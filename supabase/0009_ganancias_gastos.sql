-- =====================================================================
-- Etapa 6: gastos, retiros y ganancias (por quincena / mes / año)
-- Ejecutar UNA sola vez.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Gastos (inmutables; se anulan, no se editan)
-- ---------------------------------------------------------------------
create table public.expenses (
  id           uuid primary key default gen_random_uuid(),
  expense_date date not null default public.today_mx(),
  category     text not null check (length(btrim(category)) > 0),
  description  text,
  amount       numeric(14,2) not null check (amount > 0),
  event_id     uuid references public.events(id),
  client_uuid  uuid unique,
  created_at   timestamptz not null default now(),
  created_by   uuid default auth.uid()
);
create index expenses_date_idx on public.expenses (expense_date desc);

create table public.expense_voids (
  expense_id uuid primary key references public.expenses(id),
  reason     text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);

-- ---------------------------------------------------------------------
-- 2. Retiros (lo que tú te llevas; solo la dueña los ve y los registra)
-- ---------------------------------------------------------------------
create table public.withdrawals (
  id          uuid primary key default gen_random_uuid(),
  taken_on    date not null default public.today_mx(),
  amount      numeric(14,2) not null check (amount > 0),
  note        text,
  client_uuid uuid unique,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid()
);
create table public.withdrawal_voids (
  withdrawal_id uuid primary key references public.withdrawals(id),
  reason        text,
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid()
);

create trigger expenses_immutable before update or delete on public.expenses
  for each row execute function public.prevent_modification();
create trigger expense_voids_immutable before update or delete on public.expense_voids
  for each row execute function public.prevent_modification();
create trigger withdrawals_immutable before update or delete on public.withdrawals
  for each row execute function public.prevent_modification();
create trigger withdrawal_voids_immutable before update or delete on public.withdrawal_voids
  for each row execute function public.prevent_modification();
create trigger audit_expenses after insert or update or delete on public.expenses
  for each row execute function public.audit_row_change();
create trigger audit_expense_voids after insert or update or delete on public.expense_voids
  for each row execute function public.audit_row_change();
create trigger audit_withdrawals after insert or update or delete on public.withdrawals
  for each row execute function public.audit_row_change();
create trigger audit_withdrawal_voids after insert or update or delete on public.withdrawal_voids
  for each row execute function public.audit_row_change();

-- ---------------------------------------------------------------------
-- 3. Funciones de escritura
-- ---------------------------------------------------------------------
create or replace function public.add_expense(
  p_category text, p_amount numeric, p_description text default null,
  p_date date default public.today_mx(), p_event_id uuid default null, p_client_uuid uuid default null
) returns uuid
language plpgsql security invoker set search_path = public
as $$
declare v_id uuid;
begin
  if p_client_uuid is not null then
    select id into v_id from public.expenses where client_uuid = p_client_uuid;
    if found then return v_id; end if;
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'El monto del gasto debe ser mayor a 0.'; end if;
  if p_category is null or length(btrim(p_category)) = 0 then raise exception 'Elige o escribe la categoría del gasto.'; end if;
  insert into public.expenses (expense_date, category, description, amount, event_id, client_uuid)
  values (p_date, btrim(p_category), nullif(btrim(coalesce(p_description, '')), ''), round(p_amount, 2), p_event_id, p_client_uuid)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.void_expense(p_expense_id uuid, p_reason text default null)
returns void
language plpgsql security invoker set search_path = public
as $$
begin
  if not exists (select 1 from public.expenses where id = p_expense_id) then
    raise exception 'Gasto no encontrado.';
  end if;
  if exists (select 1 from public.expense_voids where expense_id = p_expense_id) then
    raise exception 'Ese gasto ya estaba anulado.';
  end if;
  insert into public.expense_voids (expense_id, reason) values (p_expense_id, p_reason);
end;
$$;

create or replace function public.record_withdrawal(
  p_amount numeric, p_date date default public.today_mx(), p_note text default null, p_client_uuid uuid default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  if not public.is_owner() then raise exception 'Solo la dueña puede registrar retiros.'; end if;
  if p_client_uuid is not null then
    select id into v_id from public.withdrawals where client_uuid = p_client_uuid;
    if found then return v_id; end if;
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'El retiro debe ser mayor a 0.'; end if;
  insert into public.withdrawals (taken_on, amount, note, client_uuid)
  values (p_date, round(p_amount, 2), p_note, p_client_uuid)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.void_withdrawal(p_withdrawal_id uuid, p_reason text default null)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_owner() then raise exception 'Solo la dueña puede anular retiros.'; end if;
  if not exists (select 1 from public.withdrawals where id = p_withdrawal_id) then
    raise exception 'Retiro no encontrado.';
  end if;
  if exists (select 1 from public.withdrawal_voids where withdrawal_id = p_withdrawal_id) then
    raise exception 'Ese retiro ya estaba anulado.';
  end if;
  insert into public.withdrawal_voids (withdrawal_id, reason) values (p_withdrawal_id, p_reason);
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Hechos de ganancias: una fila por cada cosa que mueve el dinero del negocio
--    (sin acceso directo: solo se lee con las funciones de abajo, que exigen ser dueña)
-- ---------------------------------------------------------------------
create view public.v_earning_facts as
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
       0, 0, 0, 0, 0, 0, -(m.qty_base * coalesce(m.unit_cost, 0)), 0
from public.stock_movements m where m.kind = 'adjustment'
union all
-- mermas: ajustes de producto terminado
select m.moved_on, 'shrink', 'Ajuste de producto: ' || coalesce(m.note, ''), m.id,
       0, 0, 0, 0, 0, 0, -(m.qty * coalesce(m.unit_cost, 0)), 0
from public.product_stock_movements m where m.kind = 'adjustment'
union all
-- estambre pasado a producción: ganancia interna (informativa)
select t.transfer_date, 'yarn_transfer', 'Estambre a producción', t.id,
       0, 0, 0, 0, 0, 0, 0,
       t.qty_madejas * (t.price_per_madeja - coalesce(t.from_cost_per_madeja, t.price_per_madeja))
from public.yarn_transfers t;

revoke all on public.v_earning_facts from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. Ganancias por periodo
--    Se calcula por quincena (1-15 y 16-fin) y luego se suma al mes o al año.
--    utilidad = ventas netas − costo (con tu mano de obra) − gastos − mermas
--    a retirar = mano de obra + (1 − parte del negocio) × utilidad positiva
-- ---------------------------------------------------------------------
create or replace function public.earnings_periods(
  p_grain text, p_from date, p_to date
) returns table (
  period_start date, period_end date,
  gross numeric, fees numeric, net_sales numeric, cogs numeric, labor numeric, materials numeric,
  expense_event numeric, expense_other numeric, shrink numeric,
  utility numeric, her_share numeric, business_share numeric, withdrawal_due numeric,
  withdrawn numeric, internal_margin numeric
)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare v_pct numeric;
begin
  if not public.is_owner() then raise exception 'Solo la dueña puede ver las ganancias.'; end if;
  if p_grain not in ('quincena', 'month', 'year') then raise exception 'Periodo inválido: %', p_grain; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Rango de fechas inválido.'; end if;

  select business_share_pct into v_pct from public.business_settings
  where effective_from <= p_to order by effective_from desc limit 1;
  if v_pct is null then
    select business_share_pct into v_pct from public.business_settings order by effective_from limit 1;
  end if;

  return query
  with f as (
    select case when extract(day from fact_date) <= 15 then date_trunc('month', fact_date)::date
                else (date_trunc('month', fact_date) + interval '15 days')::date end as q,
           gross, fees, cogs, labor, expense_event, expense_other, shrink, internal_margin, 0::numeric as wd
    from public.v_earning_facts where fact_date between p_from and p_to
    union all
    select case when extract(day from w.taken_on) <= 15 then date_trunc('month', w.taken_on)::date
                else (date_trunc('month', w.taken_on) + interval '15 days')::date end,
           0, 0, 0, 0, 0, 0, 0, 0, w.amount
    from public.withdrawals w
    where w.taken_on between p_from and p_to
      and not exists (select 1 from public.withdrawal_voids v where v.withdrawal_id = w.id)
  ),
  qn as (
    select q, sum(gross) g, sum(fees) fe, sum(cogs) c, sum(labor) l, sum(expense_event) ee, sum(expense_other) eo,
           sum(shrink) sh, sum(internal_margin) im, sum(wd) wd
    from f group by q
  ),
  qc as (
    select q, g, fe, c, l, ee, eo, sh, im, wd,
           (g - fe - c - ee - eo - sh) as u,
           round(greatest(g - fe - c - ee - eo - sh, 0) * (1 - v_pct), 2) as hs
    from qn
  ),
  grp as (
    select case p_grain when 'quincena' then q
                        when 'month' then date_trunc('month', q)::date
                        else date_trunc('year', q)::date end as ps,
           g, fe, c, l, ee, eo, sh, im, wd, u, hs,
           greatest(g - fe - c - ee - eo - sh, 0) as pool
    from qc
  )
  select ps,
    case p_grain when 'quincena' then (case when extract(day from ps) = 1 then ps + 14
                                            else (date_trunc('month', ps) + interval '1 month - 1 day')::date end)
                 when 'month' then (ps + interval '1 month - 1 day')::date
                 else (ps + interval '1 year - 1 day')::date end,
    round(sum(g), 2), round(sum(fe), 2), round(sum(g) - sum(fe), 2),
    round(sum(c), 2), round(sum(l), 2), round(sum(c) - sum(l), 2),
    round(sum(ee), 2), round(sum(eo), 2), round(sum(sh), 2),
    round(sum(u), 2), round(sum(hs), 2), round(sum(pool) - sum(hs), 2),
    round(sum(l) + sum(hs), 2), round(sum(wd), 2), round(sum(im), 2)
  from grp group by ps order by ps;
end;
$$;

-- Detalle: cada hecho que entra a un rango (para ver de dónde sale cada número)
create or replace function public.earnings_detail(p_from date, p_to date)
returns table (
  fact_date date, kind text, label text, gross numeric, fees numeric, cogs numeric, labor numeric,
  expenses numeric, shrink numeric, internal_margin numeric
)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
begin
  if not public.is_owner() then raise exception 'Solo la dueña puede ver las ganancias.'; end if;
  return query
  select f.fact_date, f.kind, f.label, f.gross, f.fees, f.cogs, f.labor,
         f.expense_event + f.expense_other, f.shrink, f.internal_margin
  from public.v_earning_facts f
  where f.fact_date between p_from and p_to
  order by f.fact_date, f.kind;
end;
$$;

-- Saldo: lo que te toca de todas las quincenas cerradas o en curso, menos lo ya retirado
create or replace function public.withdrawal_balance(p_to date default public.today_mx())
returns table (total_due numeric, total_withdrawn numeric, balance numeric)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
begin
  if not public.is_owner() then raise exception 'Solo la dueña puede ver las ganancias.'; end if;
  return query
  select coalesce(sum(e.withdrawal_due), 0), coalesce(sum(e.withdrawn), 0),
         coalesce(sum(e.withdrawal_due), 0) - coalesce(sum(e.withdrawn), 0)
  from public.earnings_periods('quincena', date '2000-01-01', p_to) e;
end;
$$;

create or replace function public.list_withdrawals(p_from date default date '2000-01-01', p_to date default date '2100-01-01')
returns table (id uuid, taken_on date, amount numeric, note text, voided boolean)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
begin
  if not public.is_owner() then raise exception 'Solo la dueña puede ver los retiros.'; end if;
  return query
  select w.id, w.taken_on, w.amount, w.note,
         exists (select 1 from public.withdrawal_voids v where v.withdrawal_id = w.id)
  from public.withdrawals w where w.taken_on between p_from and p_to
  order by w.taken_on desc, w.created_at desc;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Seguridad
-- ---------------------------------------------------------------------
alter table public.expenses         enable row level security;
alter table public.expense_voids    enable row level security;
alter table public.withdrawals      enable row level security;
alter table public.withdrawal_voids enable row level security;

create policy expenses_select on public.expenses for select to authenticated using (public.is_member());
create policy expenses_insert on public.expenses for insert to authenticated with check (public.is_member());
create policy expense_voids_select on public.expense_voids for select to authenticated using (public.is_member());
create policy expense_voids_insert on public.expense_voids for insert to authenticated with check (public.is_member());
-- retiros: sin políticas para usuarios (solo se tocan con funciones de la dueña)

grant select, insert on public.expenses, public.expense_voids to authenticated;
revoke all on public.expenses, public.expense_voids, public.withdrawals, public.withdrawal_voids from anon;
revoke all on public.withdrawals, public.withdrawal_voids from authenticated;

revoke all on function public.add_expense(text, numeric, text, date, uuid, uuid) from public, anon;
revoke all on function public.void_expense(uuid, text) from public, anon;
revoke all on function public.record_withdrawal(numeric, date, text, uuid) from public, anon;
revoke all on function public.void_withdrawal(uuid, text) from public, anon;
revoke all on function public.earnings_periods(text, date, date) from public, anon;
revoke all on function public.earnings_detail(date, date) from public, anon;
revoke all on function public.withdrawal_balance(date) from public, anon;
revoke all on function public.list_withdrawals(date, date) from public, anon;
grant execute on function public.add_expense(text, numeric, text, date, uuid, uuid) to authenticated;
grant execute on function public.void_expense(uuid, text) to authenticated;
grant execute on function public.record_withdrawal(numeric, date, text, uuid) to authenticated;
grant execute on function public.void_withdrawal(uuid, text) to authenticated;
grant execute on function public.earnings_periods(text, date, date) to authenticated;
grant execute on function public.earnings_detail(date, date) to authenticated;
grant execute on function public.withdrawal_balance(date) to authenticated;
grant execute on function public.list_withdrawals(date, date) to authenticated;
