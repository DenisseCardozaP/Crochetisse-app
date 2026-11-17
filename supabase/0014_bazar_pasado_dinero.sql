-- =====================================================================
-- 0014 (Etapa 9)
-- Dinero del negocio: saldo inicial, aportaciones, otros ingresos/egresos, cuentas por cobrar
-- y la posición de caja. Todo solo para la dueña. Ejecutar UNA sola vez.
-- =====================================================================
-- ---------------------------------------------------------------------
-- Cuentas por cobrar (lo que otras personas le deben al negocio, fuera de los pedidos)
-- ---------------------------------------------------------------------
create table public.receivables (
  id          uuid primary key default gen_random_uuid(),
  debtor      text not null check (length(btrim(debtor)) > 0),
  concept     text,
  amount      numeric(14,2) not null check (amount > 0),
  owed_on     date not null default public.today_mx(),
  due_date    date,
  note        text,
  client_uuid uuid unique,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid()
);
create table public.receivable_voids (
  receivable_id uuid primary key references public.receivables(id),
  reason        text,
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid()
);

-- Movimientos de dinero que no vienen de ventas, compras ni gastos.
-- amount con signo: positivo = entra al negocio, negativo = sale.
create table public.money_movements (
  id            uuid primary key default gen_random_uuid(),
  moved_on      date not null default public.today_mx(),
  kind          text not null check (kind in ('opening', 'contribution', 'other_in', 'other_out', 'receivable_payment')),
  amount        numeric(14,2) not null check (amount <> 0),
  receivable_id uuid references public.receivables(id),
  note          text,
  client_uuid   uuid unique,
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid(),
  check ((kind = 'receivable_payment') = (receivable_id is not null)),
  check (kind = 'opening' or (kind in ('contribution', 'other_in', 'receivable_payment') and amount > 0) or (kind = 'other_out' and amount < 0))
);
create table public.money_movement_voids (
  movement_id uuid primary key references public.money_movements(id),
  reason      text,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid()
);

do $$
declare t text;
begin
  foreach t in array array['receivables', 'receivable_voids', 'money_movements', 'money_movement_voids'] loop
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.prevent_modification()', t || '_immutable', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.audit_row_change()', 'audit_' || t, t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- Saldo inicial: lo que tiene el negocio el día que empiezas a usar el sistema (puede ser negativo)
create or replace function public.set_opening_balance(p_amount numeric, p_date date default public.today_mx(), p_note text default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  if not public.is_owner() then raise exception 'Solo la dueña puede manejar el dinero del negocio.'; end if;
  if p_amount is null or p_amount = 0 then raise exception 'Escribe el saldo inicial (puede ser negativo).'; end if;
  if exists (select 1 from public.money_movements m where m.kind = 'opening'
             and not exists (select 1 from public.money_movement_voids v where v.movement_id = m.id)) then
    raise exception 'Ya hay un saldo inicial. Anúlalo primero si quieres capturar otro.';
  end if;
  insert into public.money_movements (moved_on, kind, amount, note) values (p_date, 'opening', round(p_amount, 2), p_note)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.opening_date() returns date
language sql stable security definer set search_path = public
as $$
  select m.moved_on from public.money_movements m
  where m.kind = 'opening' and not exists (select 1 from public.money_movement_voids v where v.movement_id = m.id)
  limit 1
$$;

-- Aportación tuya, otro ingreso u otro egreso. p_amount siempre positivo; el tipo decide si entra o sale.
create or replace function public.add_money_movement(
  p_kind text, p_amount numeric, p_date date default public.today_mx(), p_note text default null, p_client_uuid uuid default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid; v_d0 date;
begin
  if not public.is_owner() then raise exception 'Solo la dueña puede manejar el dinero del negocio.'; end if;
  if p_client_uuid is not null then
    select id into v_id from public.money_movements where client_uuid = p_client_uuid;
    if found then return v_id; end if;
  end if;
  if p_kind not in ('contribution', 'other_in', 'other_out') then raise exception 'Tipo de movimiento no válido.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'El monto debe ser mayor a 0.'; end if;
  v_d0 := public.opening_date();
  if v_d0 is not null and p_date < v_d0 then
    raise exception 'La fecha es anterior al saldo inicial (%): no contaría.', v_d0;
  end if;
  insert into public.money_movements (moved_on, kind, amount, note, client_uuid)
  values (p_date, p_kind, case when p_kind = 'other_out' then -round(p_amount, 2) else round(p_amount, 2) end, p_note, p_client_uuid)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.void_money_movement(p_id uuid, p_reason text default null)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_owner() then raise exception 'Solo la dueña puede manejar el dinero del negocio.'; end if;
  if not exists (select 1 from public.money_movements where id = p_id) then raise exception 'Movimiento no encontrado.'; end if;
  if exists (select 1 from public.money_movement_voids where movement_id = p_id) then raise exception 'Ese movimiento ya estaba anulado.'; end if;
  insert into public.money_movement_voids (movement_id, reason) values (p_id, p_reason);
end;
$$;

create or replace function public.add_receivable(
  p_debtor text, p_amount numeric, p_concept text default null, p_owed_on date default public.today_mx(),
  p_due_date date default null, p_note text default null, p_client_uuid uuid default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid;
begin
  if not public.is_owner() then raise exception 'Solo la dueña puede manejar el dinero del negocio.'; end if;
  if p_client_uuid is not null then
    select id into v_id from public.receivables where client_uuid = p_client_uuid;
    if found then return v_id; end if;
  end if;
  if p_debtor is null or length(btrim(p_debtor)) = 0 then raise exception 'Escribe quién debe.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'El monto debe ser mayor a 0.'; end if;
  insert into public.receivables (debtor, concept, amount, owed_on, due_date, note, client_uuid)
  values (btrim(p_debtor), nullif(btrim(coalesce(p_concept, '')), ''), round(p_amount, 2), p_owed_on, p_due_date, p_note, p_client_uuid)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.collect_receivable(
  p_receivable_id uuid, p_amount numeric, p_date date default public.today_mx(), p_note text default null, p_client_uuid uuid default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid; v_owed numeric; v_paid numeric; v_d0 date;
begin
  if not public.is_owner() then raise exception 'Solo la dueña puede manejar el dinero del negocio.'; end if;
  if p_client_uuid is not null then
    select id into v_id from public.money_movements where client_uuid = p_client_uuid;
    if found then return v_id; end if;
  end if;
  select amount into v_owed from public.receivables r
  where r.id = p_receivable_id and not exists (select 1 from public.receivable_voids v where v.receivable_id = r.id);
  if v_owed is null then raise exception 'Esa deuda no existe o está anulada.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'El monto debe ser mayor a 0.'; end if;
  select coalesce(sum(m.amount), 0) into v_paid from public.money_movements m
  where m.receivable_id = p_receivable_id and not exists (select 1 from public.money_movement_voids v where v.movement_id = m.id);
  if p_amount > v_owed - v_paid then
    raise exception 'El cobro (%) es mayor a lo que falta por cobrar (%).', p_amount, v_owed - v_paid;
  end if;
  v_d0 := public.opening_date();
  if v_d0 is not null and p_date < v_d0 then
    raise exception 'La fecha es anterior al saldo inicial (%): no contaría.', v_d0;
  end if;
  insert into public.money_movements (moved_on, kind, amount, receivable_id, note, client_uuid)
  values (p_date, 'receivable_payment', round(p_amount, 2), p_receivable_id, p_note, p_client_uuid)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.void_receivable(p_id uuid, p_reason text default null)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_owner() then raise exception 'Solo la dueña puede manejar el dinero del negocio.'; end if;
  if not exists (select 1 from public.receivables where id = p_id) then raise exception 'Deuda no encontrada.'; end if;
  if exists (select 1 from public.receivable_voids where receivable_id = p_id) then raise exception 'Esa deuda ya estaba anulada.'; end if;
  if exists (select 1 from public.money_movements m where m.receivable_id = p_id
             and not exists (select 1 from public.money_movement_voids v where v.movement_id = m.id)) then
    raise exception 'Esa deuda ya tiene cobros: anula primero esos cobros.';
  end if;
  insert into public.receivable_voids (receivable_id, reason) values (p_id, p_reason);
end;
$$;

create or replace function public.list_money_movements()
returns table (id uuid, moved_on date, kind text, amount numeric, receivable_id uuid, debtor text, note text, voided boolean)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
begin
  if not public.is_owner() then raise exception 'Solo la dueña puede manejar el dinero del negocio.'; end if;
  return query
  select m.id, m.moved_on, m.kind, m.amount, m.receivable_id, r.debtor, m.note,
         exists (select 1 from public.money_movement_voids v where v.movement_id = m.id)
  from public.money_movements m left join public.receivables r on r.id = m.receivable_id
  order by m.moved_on desc, m.created_at desc;
end;
$$;

create or replace function public.list_receivables()
returns table (id uuid, debtor text, concept text, amount numeric, owed_on date, due_date date, note text, collected numeric, balance numeric, voided boolean)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
begin
  if not public.is_owner() then raise exception 'Solo la dueña puede manejar el dinero del negocio.'; end if;
  return query
  select r.id, r.debtor, r.concept, r.amount, r.owed_on, r.due_date, r.note,
         c.collected, r.amount - c.collected,
         exists (select 1 from public.receivable_voids v where v.receivable_id = r.id)
  from public.receivables r
  cross join lateral (
    select coalesce(sum(m.amount), 0) as collected from public.money_movements m
    where m.receivable_id = r.id and not exists (select 1 from public.money_movement_voids v where v.movement_id = m.id)
  ) c
  order by r.owed_on desc, r.created_at desc;
end;
$$;

-- ---------------------------------------------------------------------
-- Posición de dinero: cuánto debería haber hoy, de dónde viene y a dónde se fue.
-- Empieza en el saldo inicial y suma/resta todo lo que pasó desde esa fecha.
-- (Las ventas con tarjeta entran netas de la comisión, el día de la venta.)
-- ---------------------------------------------------------------------
create or replace function public.money_position(p_to date default public.today_mx())
returns table (
  opening_date date, opening numeric,
  sales_in numeric, orders_in numeric, contributions_in numeric, other_in numeric, collections_in numeric,
  purchases_out numeric, expenses_out numeric, tables_out numeric, withdrawals_out numeric, other_out numeric,
  balance numeric,
  orders_receivable numeric, receivables_open numeric, projected numeric, inventory_value numeric
)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  d0 date; v_open numeric := 0;
  v_s numeric; v_o numeric; v_c numeric; v_oi numeric; v_col numeric;
  v_p numeric; v_e numeric; v_t numeric; v_w numeric; v_oo numeric;
  v_or numeric; v_ro numeric; v_inv numeric;
begin
  if not public.is_owner() then raise exception 'Solo la dueña puede manejar el dinero del negocio.'; end if;
  d0 := public.opening_date();
  if d0 is not null then
    select m.amount into v_open from public.money_movements m
    where m.kind = 'opening' and not exists (select 1 from public.money_movement_voids v where v.movement_id = m.id);
  end if;
  d0 := coalesce(d0, date '1900-01-01');

  select coalesce(sum(s.total - s.card_fee), 0) into v_s from public.sales s
   where s.sale_date between d0 and p_to and not exists (select 1 from public.sale_voids v where v.sale_id = s.id);
  select coalesce(sum(case when p.kind = 'payment' then p.amount - p.fee else -p.amount end), 0) into v_o
   from public.order_payments p where p.paid_on between d0 and p_to;
  select
    coalesce(sum(m.amount) filter (where m.kind = 'contribution'), 0),
    coalesce(sum(m.amount) filter (where m.kind = 'other_in'), 0),
    coalesce(sum(m.amount) filter (where m.kind = 'receivable_payment'), 0),
    coalesce(-sum(m.amount) filter (where m.kind = 'other_out'), 0)
   into v_c, v_oi, v_col, v_oo
   from public.money_movements m
   where m.kind <> 'opening' and m.moved_on between d0 and p_to
     and not exists (select 1 from public.money_movement_voids v where v.movement_id = m.id);
  select coalesce(sum(p.total_paid), 0) into v_p from public.purchases p
   where p.purchase_date between d0 and p_to and not exists (select 1 from public.purchase_voids v where v.purchase_id = p.id);
  select coalesce(sum(x.amount), 0) into v_e from public.expenses x
   where x.expense_date between d0 and p_to and not exists (select 1 from public.expense_voids v where v.expense_id = x.id);
  select coalesce(sum(e.table_cost), 0) into v_t from public.events e where e.event_date between d0 and p_to;
  select coalesce(sum(w.amount), 0) into v_w from public.withdrawals w
   where w.taken_on between d0 and p_to and not exists (select 1 from public.withdrawal_voids v where v.withdrawal_id = w.id);

  select coalesce(sum(o.balance), 0) into v_or from public.v_order_summary o where o.status in ('confirmed', 'delivered') and o.balance > 0;
  select coalesce(sum(r.amount - c.collected), 0) into v_ro
   from public.receivables r
   cross join lateral (select coalesce(sum(m.amount), 0) as collected from public.money_movements m
     where m.receivable_id = r.id and not exists (select 1 from public.money_movement_voids v where v.movement_id = m.id)) c
   where not exists (select 1 from public.receivable_voids v where v.receivable_id = r.id);
  select coalesce(sum(s.stock_qty * c.unit_cost_base), 0) + coalesce((
           select sum(ps.stock_qty * coalesce(public.product_unit_cost_now(ps.product_id), 0))
           from public.v_product_stock ps where ps.stock_qty > 0), 0)
   into v_inv
   from public.v_item_stock s join public.v_item_cost_current c on c.item_id = s.item_id where s.stock_qty > 0;

  return query select
    case when d0 = date '1900-01-01' then null else d0 end, v_open,
    round(v_s, 2), round(v_o, 2), v_c, v_oi, v_col,
    round(v_p, 2), round(v_e, 2), round(v_t, 2), round(v_w, 2), v_oo,
    round(v_open + v_s + v_o + v_c + v_oi + v_col - v_p - v_e - v_t - v_w - v_oo, 2),
    round(v_or, 2), round(v_ro, 2),
    round(v_open + v_s + v_o + v_c + v_oi + v_col - v_p - v_e - v_t - v_w - v_oo + v_or + v_ro, 2),
    round(v_inv, 2);
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'set_opening_balance(numeric, date, text)', 'opening_date()', 'add_money_movement(text, numeric, date, text, uuid)',
    'void_money_movement(uuid, text)', 'add_receivable(text, numeric, text, date, date, text, uuid)',
    'collect_receivable(uuid, numeric, date, text, uuid)', 'void_receivable(uuid, text)',
    'list_money_movements()', 'list_receivables()', 'money_position(date)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
