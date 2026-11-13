-- =====================================================================
-- ETAPA 5 · Cotizaciones y pedidos
-- Requiere 0001 a 0006. Córrelo UNA sola vez.
--
-- Ideas centrales:
--   * Una cotización (folio OP-2026-0001) se confirma y se vuelve pedido (folio PED-2026-0001).
--   * El precio de cada renglón es libre: tú lo decides al cotizar. Aquí ves el costo estimado y tu utilidad.
--   * Los pagos (anticipo, resto, devolución) son registros aparte e inmutables. Un anticipo NO cuenta como venta.
--   * Al ENTREGAR: lo que haya en producto terminado se toma de ahí y lo que falte se teje en ese momento
--     (se descuentan sus materiales). Se guarda la foto del costo real y de tu mano de obra.
--   * Un pedido está "concretado" cuando está entregado Y pagado completo; ahí cuenta para tus ganancias.
--   * Ramos personalizados: un renglón puede llevar su propia lista de piezas en lugar de la receta base.
--   * Las bolsas de pedido se eligen una por una (precio libre, puede ser $0); se descuentan al entregar.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. Producción con piezas personalizadas (reemplaza las funciones de la etapa 3b)
-- ---------------------------------------------------------------------
drop function public.produce_product(uuid, numeric, date, text, uuid);
drop function public.consume_product_recipe(uuid, numeric, uuid, date, int);

create or replace function public.consume_product_recipe(
  p_product_id uuid, p_qty numeric, p_run_id uuid, p_on date, p_depth int default 0, p_override jsonb default null
) returns jsonb
language plpgsql security invoker set search_path = public
as $$
declare
  v_ver    record;
  v_rate   numeric;
  v_mat    numeric := 0;
  v_hours  numeric;
  v_labor  numeric;
  v_name   text;
  r        record;
  v_need   numeric;
  v_cost   numeric;
  v_avail  numeric;
  v_take   numeric;
  v_rest   numeric;
  v_sub    jsonb;
  v_ucost  numeric;
begin
  if p_depth > 10 then raise exception 'La receta es demasiado profunda o tiene un ciclo.'; end if;
  select name into v_name from public.products where id = p_product_id;
  select * into v_ver from public.product_versions
  where product_id = p_product_id and valid_from <= p_on
  order by valid_from desc, version_no desc limit 1;
  if not found then
    raise exception 'El producto "%" no tiene receta vigente en esa fecha.', v_name;
  end if;

  select labor_rate_per_hour into v_rate from public.business_settings
  where effective_from <= p_on order by effective_from desc limit 1;
  v_hours := round(v_ver.labor_hours * p_qty, 4);
  v_labor := round(v_hours * coalesce(v_rate, 0), 4);

  for r in
    select c.item_id, c.qty, c.waste_pct, i.name
    from public.product_components c join public.items i on i.id = c.item_id
    where c.version_id = v_ver.id and c.item_id is not null
  loop
    v_need := round(p_qty * r.qty * (1 + r.waste_pct), 4);
    select h.unit_cost_base into v_cost from public.item_price_history h
    where h.item_id = r.item_id and h.valid_from <= p_on
    order by h.valid_from desc, h.created_at desc limit 1;
    if v_cost is null then
      raise exception 'Falta el precio de compra de "%". Regístralo en Insumos o en una compra.', r.name;
    end if;
    insert into public.stock_movements (item_id, qty_base, unit_cost, kind, moved_on, ref_id, note)
    values (r.item_id, -v_need, v_cost, 'production_use', p_on, p_run_id, 'Producción de ' || v_name);
    v_mat := v_mat + round(v_need * v_cost, 4);
  end loop;

  -- piezas: las de la receta, o las personalizadas si se dieron
  for r in
    select c.component_product_id as pid, c.qty, c.waste_pct, p.name
    from public.product_components c join public.products p on p.id = c.component_product_id
    where c.version_id = v_ver.id and c.component_product_id is not null and p_override is null
    union all
    select (o.value ->> 'component_product_id')::uuid, (o.value ->> 'qty')::numeric, 0::numeric, p.name
    from jsonb_array_elements(coalesce(p_override, '[]'::jsonb)) o
    join public.products p on p.id = (o.value ->> 'component_product_id')::uuid
  loop
    v_need  := round(p_qty * r.qty * (1 + r.waste_pct), 4);
    v_avail := greatest(public.product_stock(r.pid), 0);
    v_take  := least(v_avail, v_need);
    if v_take > 0 then
      v_ucost := public.product_unit_cost_now(r.pid, p_on);
      insert into public.product_stock_movements (product_id, qty, unit_cost, kind, moved_on, ref_id, note)
      values (r.pid, -v_take, v_ucost, 'assembly_use', p_on, p_run_id, 'Usado en ' || v_name);
      v_mat := v_mat + round(v_take * v_ucost, 4);
    end if;
    v_rest := v_need - v_take;
    if v_rest > 0 then
      v_sub := public.consume_product_recipe(r.pid, v_rest, p_run_id, p_on, p_depth + 1, null);
      v_mat   := v_mat   + (v_sub ->> 'materials')::numeric;
      v_labor := v_labor + (v_sub ->> 'labor')::numeric;
      v_hours := v_hours + (v_sub ->> 'hours')::numeric;
    end if;
  end loop;

  return jsonb_build_object('materials', v_mat, 'labor', v_labor, 'hours', v_hours);
end;
$$;

create or replace function public.produce_product(
  p_product_id uuid,
  p_qty numeric,
  p_date date default public.today_mx(),
  p_note text default null,
  p_client_uuid uuid default null,
  p_override jsonb default null
) returns uuid
language plpgsql security invoker set search_path = public
as $$
declare
  v_id    uuid;
  v_kind  text;
  v_ver   uuid;
  v_res   jsonb;
  v_total numeric;
  v_est   numeric;
  o       jsonb;
  ck      text;
begin
  if p_client_uuid is not null then
    select id into v_id from public.production_runs where client_uuid = p_client_uuid;
    if found then return v_id; end if;
  end if;
  if p_qty is null or p_qty <= 0 then raise exception 'La cantidad debe ser mayor a 0.'; end if;
  select kind into v_kind from public.products where id = p_product_id;
  if not found then raise exception 'Producto no encontrado.'; end if;
  if v_kind = 'packaging' then raise exception 'Los empaques no se producen: se descuentan al venderse.'; end if;

  if p_override is not null then
    if jsonb_typeof(p_override) <> 'array' then raise exception 'Las piezas personalizadas deben ser una lista.'; end if;
    for o in select value from jsonb_array_elements(p_override) loop
      select kind into ck from public.products where id = (o ->> 'component_product_id')::uuid;
      if not found then raise exception 'Una pieza del ramo no existe.'; end if;
      if ck = 'packaging' then raise exception 'Un empaque no puede ser pieza de un ramo.'; end if;
      if (o ->> 'component_product_id')::uuid = p_product_id then raise exception 'Un producto no puede llevarse a sí mismo.'; end if;
      if coalesce((o ->> 'qty')::numeric, 0) <= 0 then raise exception 'Las cantidades de las piezas deben ser mayores a 0.'; end if;
      if public.product_reaches((o ->> 'component_product_id')::uuid, p_product_id, p_date) then
        raise exception 'Esta combinación crearía un ciclo.';
      end if;
    end loop;
  end if;

  v_id := gen_random_uuid();
  v_res := public.consume_product_recipe(p_product_id, p_qty, v_id, p_date, 0, p_override);
  v_total := round((v_res ->> 'materials')::numeric + (v_res ->> 'labor')::numeric, 4);
  v_est := (public.product_cost(p_product_id, p_date) ->> 'total')::numeric;

  select id into v_ver from public.product_versions
  where product_id = p_product_id and valid_from <= p_date
  order by valid_from desc, version_no desc limit 1;

  insert into public.production_runs (id, product_id, version_id, qty, run_date, labor_hours, labor_cost,
      materials_cost, total_cost, unit_cost, estimated_unit_cost, note, client_uuid)
  values (v_id, p_product_id, v_ver, p_qty, p_date, (v_res ->> 'hours')::numeric, (v_res ->> 'labor')::numeric,
      (v_res ->> 'materials')::numeric, v_total, round(v_total / p_qty, 4), coalesce(v_est, 0), p_note, p_client_uuid);

  insert into public.product_stock_movements (product_id, qty, unit_cost, kind, moved_on, ref_id, note)
  values (p_product_id, p_qty, round(v_total / p_qty, 4), 'production', p_date, v_id, p_note);
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Folios
-- ---------------------------------------------------------------------
create table public.folio_counters (
  year int not null,
  kind text not null,
  last int not null default 0,
  primary key (year, kind)
);
alter table public.folio_counters enable row level security;
revoke all on public.folio_counters from public, anon, authenticated;

create or replace function public.next_folio(p_kind text)
returns text
language plpgsql security definer set search_path = public
as $$
declare v_year int := extract(year from public.today_mx())::int; v_n int;
begin
  if not public.is_member() then raise exception 'No tienes permiso para hacer esto.'; end if;
  insert into public.folio_counters (year, kind, last) values (v_year, p_kind, 1)
  on conflict (year, kind) do update set last = public.folio_counters.last + 1
  returning last into v_n;
  return p_kind || '-' || v_year || '-' || lpad(v_n::text, 4, '0');
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Tablas de pedidos
-- ---------------------------------------------------------------------
create table public.orders (
  id             uuid primary key default gen_random_uuid(),
  quote_folio    text not null unique,
  order_folio    text unique,
  status         text not null default 'quote' check (status in ('quote', 'confirmed', 'delivered', 'cancelled')),
  customer_name  text not null check (length(btrim(customer_name)) > 0),
  customer_phone text,
  notes          text,
  due_date       date,
  total          numeric(14,2) not null default 0 check (total >= 0),
  confirmed_on   date,
  delivered_on   date,
  cancelled_on   date,
  cancel_reason  text,
  created_at     timestamptz not null default now(),
  created_by     uuid default auth.uid(),
  updated_at     timestamptz not null default now()
);
create index orders_status_idx on public.orders (status, due_date);
create trigger orders_updated_at before update on public.orders
  for each row execute function public.set_updated_at();

create table public.order_lines (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references public.orders(id),
  sort_no          int not null default 0,
  line_type        text not null check (line_type in ('product', 'packaging', 'custom')),
  product_id       uuid references public.products(id),
  description      text not null,
  qty              numeric(14,4) not null check (qty > 0),
  unit_price       numeric(14,2) not null check (unit_price >= 0),
  line_total       numeric(14,2) not null check (line_total >= 0),
  custom_unit_cost numeric(14,4) not null default 0 check (custom_unit_cost >= 0),
  tax_rate         numeric(7,6) not null default 0,
  tax_amount       numeric(14,2) not null default 0,
  unit_cost        numeric(14,4) not null default 0,
  unit_labor       numeric(14,4) not null default 0,
  check ((line_type = 'custom') = (product_id is null))
);
create index order_lines_order_idx on public.order_lines (order_id, sort_no);

create table public.order_line_components (
  id                   uuid primary key default gen_random_uuid(),
  line_id              uuid not null references public.order_lines(id),
  component_product_id uuid not null references public.products(id),
  qty                  numeric(14,4) not null check (qty > 0),
  unique (line_id, component_product_id)
);

create table public.order_payments (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references public.orders(id),
  kind              text not null default 'payment' check (kind in ('payment', 'refund')),
  amount            numeric(14,2) not null check (amount > 0),
  payment_method_id uuid not null references public.payment_methods(id),
  paid_on           date not null default public.today_mx(),
  fee               numeric(14,2) not null default 0,
  note              text,
  client_uuid       uuid unique,
  created_at        timestamptz not null default now(),
  created_by        uuid default auth.uid()
);
create index order_payments_order_idx on public.order_payments (order_id);

create trigger order_payments_immutable before update or delete on public.order_payments
  for each row execute function public.prevent_modification();
create trigger audit_orders after insert or update or delete on public.orders
  for each row execute function public.audit_row_change();
create trigger audit_order_lines after insert or update or delete on public.order_lines
  for each row execute function public.audit_row_change();
create trigger audit_order_payments after insert or update or delete on public.order_payments
  for each row execute function public.audit_row_change();

-- Un pedido entregado o cancelado no se toca
create or replace function public.order_lines_guard()
returns trigger language plpgsql
as $$
declare v_status text; v_order uuid;
begin
  if tg_table_name = 'order_lines' then
    v_order := coalesce(new.order_id, old.order_id);
  else
    select order_id into v_order from public.order_lines where id = coalesce(new.line_id, old.line_id);
  end if;
  select status into v_status from public.orders where id = v_order;
  if v_status in ('delivered', 'cancelled') then
    raise exception 'Un pedido entregado o cancelado ya no se puede modificar.';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger order_lines_guard_trg before insert or update or delete on public.order_lines
  for each row execute function public.order_lines_guard();
create trigger order_line_components_guard_trg before insert or update or delete on public.order_line_components
  for each row execute function public.order_lines_guard();

-- ---------------------------------------------------------------------
-- 4. Costo estimado de un renglón (con piezas personalizadas si las hay)
-- ---------------------------------------------------------------------
create or replace function public.estimate_line_cost(p_product_id uuid, p_qty numeric, p_components jsonb, p_on date default public.today_mx())
returns numeric
language plpgsql stable set search_path = public
as $$
declare
  v_cost jsonb;
  v_own  numeric;
  v_comp numeric := 0;
  c      jsonb;
begin
  v_cost := public.product_cost(p_product_id, p_on);
  if p_components is null or jsonb_typeof(p_components) <> 'array' or jsonb_array_length(p_components) = 0 then
    return round((v_cost ->> 'total')::numeric * p_qty, 4);
  end if;
  v_own := (v_cost ->> 'total')::numeric - (v_cost ->> 'components')::numeric;
  for c in select value from jsonb_array_elements(p_components) loop
    v_comp := v_comp + coalesce((c ->> 'qty')::numeric, 0)
              * coalesce((public.product_cost((c ->> 'component_product_id')::uuid, p_on) ->> 'total')::numeric, 0);
  end loop;
  return round((v_own + v_comp) * p_qty, 4);
end;
$$;

-- Vista previa para la pantalla: costo estimado de cada renglón (lista alineada con p_lines)
create or replace function public.estimate_lines(p_lines jsonb)
returns jsonb
language plpgsql stable set search_path = public
as $$
declare l jsonb; res jsonb := '[]'::jsonb; v numeric;
begin
  for l in select value from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    if l ->> 'type' = 'custom' then
      v := coalesce((l ->> 'unit_cost')::numeric, 0) * coalesce((l ->> 'qty')::numeric, 0);
    elsif l ->> 'product_id' is null then
      v := 0;
    else
      v := public.estimate_line_cost((l ->> 'product_id')::uuid, coalesce((l ->> 'qty')::numeric, 0), l -> 'components');
    end if;
    res := res || to_jsonb(coalesce(v, 0));
  end loop;
  return res;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Guardar cotización / pedido (crea o reemplaza los renglones)
--    p_lines: [{"type":"product","product_id":"..","qty":2,"unit_price":350,
--               "components":[{"component_product_id":"..","qty":1}]},     -- opcional: ramo personalizado
--              {"type":"packaging","product_id":"..","qty":1,"unit_price":0},
--              {"type":"custom","description":"Envío","qty":1,"unit_price":80,"unit_cost":60}]
-- ---------------------------------------------------------------------
create or replace function public.save_order(
  p_order_id uuid, p_customer text, p_phone text, p_due date, p_notes text, p_lines jsonb
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id     uuid;
  v_status text;
  l        jsonb;
  comp     jsonb;
  pr       public.products%rowtype;
  v_type   text;
  v_qty    numeric;
  v_price  numeric;
  v_total  numeric := 0;
  v_line   uuid;
  v_n      int := 0;
  v_desc   text;
begin
  if not public.is_member() then raise exception 'No tienes permiso para hacer esto.'; end if;
  if p_customer is null or length(btrim(p_customer)) = 0 then raise exception 'Escribe el nombre del cliente.'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'El pedido necesita al menos un renglón.';
  end if;

  if p_order_id is null then
    insert into public.orders (quote_folio, customer_name, customer_phone, due_date, notes)
    values (public.next_folio('OP'), btrim(p_customer), nullif(btrim(coalesce(p_phone, '')), ''), p_due, p_notes)
    returning id into v_id;
  else
    select status into v_status from public.orders where id = p_order_id for update;
    if not found then raise exception 'Pedido no encontrado.'; end if;
    if v_status not in ('quote', 'confirmed') then
      raise exception 'Un pedido entregado o cancelado ya no se puede modificar.';
    end if;
    v_id := p_order_id;
    delete from public.order_line_components where line_id in (select id from public.order_lines where order_id = v_id);
    delete from public.order_lines where order_id = v_id;
    update public.orders set customer_name = btrim(p_customer), customer_phone = nullif(btrim(coalesce(p_phone, '')), ''),
      due_date = p_due, notes = p_notes where id = v_id;
  end if;

  for l in select value from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    v_type := l ->> 'type';
    v_qty := (l ->> 'qty')::numeric;
    v_price := (l ->> 'unit_price')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'Hay un renglón con cantidad no válida.'; end if;
    if v_price is null or v_price < 0 then raise exception 'Hay un renglón con precio no válido.'; end if;

    if v_type = 'custom' then
      v_desc := btrim(coalesce(l ->> 'description', ''));
      if v_desc = '' then raise exception 'Un renglón libre necesita descripción.'; end if;
      insert into public.order_lines (order_id, sort_no, line_type, description, qty, unit_price, line_total, custom_unit_cost)
      values (v_id, v_n, 'custom', v_desc, v_qty, v_price, round(v_qty * v_price, 2), coalesce((l ->> 'unit_cost')::numeric, 0))
      returning id into v_line;
    elsif v_type in ('product', 'packaging') then
      select * into pr from public.products where id = (l ->> 'product_id')::uuid;
      if not found then raise exception 'Producto no encontrado.'; end if;
      if v_type = 'packaging' and pr.kind <> 'packaging' then raise exception '"%" no es un empaque.', pr.name; end if;
      if v_type = 'product' and pr.kind = 'packaging' then raise exception '"%" es un empaque: agrégalo como bolsa.', pr.name; end if;
      insert into public.order_lines (order_id, sort_no, line_type, product_id, description, qty, unit_price, line_total)
      values (v_id, v_n, v_type, pr.id, pr.name, v_qty, v_price, round(v_qty * v_price, 2))
      returning id into v_line;
      if v_type = 'product' and l -> 'components' is not null and jsonb_typeof(l -> 'components') = 'array' then
        for comp in select value from jsonb_array_elements(l -> 'components') loop
          if not exists (select 1 from public.products where id = (comp ->> 'component_product_id')::uuid and kind <> 'packaging') then
            raise exception 'Una pieza del ramo no es válida.';
          end if;
          if (comp ->> 'component_product_id')::uuid = pr.id then raise exception 'Un producto no puede llevarse a sí mismo.'; end if;
          insert into public.order_line_components (line_id, component_product_id, qty)
          values (v_line, (comp ->> 'component_product_id')::uuid, (comp ->> 'qty')::numeric);
        end loop;
      end if;
    else
      raise exception 'Tipo de renglón no válido.';
    end if;
    v_total := v_total + round(v_qty * v_price, 2);
  end loop;

  update public.orders set total = v_total where id = v_id;
  return v_id;
end;
$$;

create or replace function public.confirm_order(p_order_id uuid)
returns text
language plpgsql security definer set search_path = public
as $$
declare v_status text; v_folio text;
begin
  if not public.is_member() then raise exception 'No tienes permiso para hacer esto.'; end if;
  select status into v_status from public.orders where id = p_order_id for update;
  if not found then raise exception 'Pedido no encontrado.'; end if;
  if v_status <> 'quote' then raise exception 'Solo una cotización se puede confirmar.'; end if;
  if not exists (select 1 from public.order_lines where order_id = p_order_id) then
    raise exception 'El pedido no tiene renglones.';
  end if;
  v_folio := public.next_folio('PED');
  update public.orders set status = 'confirmed', order_folio = v_folio, confirmed_on = public.today_mx() where id = p_order_id;
  return v_folio;
end;
$$;

create or replace function public.cancel_order(p_order_id uuid, p_reason text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare v_status text;
begin
  if not public.is_member() then raise exception 'No tienes permiso para hacer esto.'; end if;
  select status into v_status from public.orders where id = p_order_id for update;
  if not found then raise exception 'Pedido no encontrado.'; end if;
  if v_status not in ('quote', 'confirmed') then raise exception 'Solo se cancela una cotización o un pedido sin entregar.'; end if;
  update public.orders set status = 'cancelled', cancelled_on = public.today_mx(), cancel_reason = p_reason where id = p_order_id;
end;
$$;

-- Pagos: anticipo, resto o devolución
create or replace function public.record_order_payment(
  p_order_id uuid, p_amount numeric, p_method uuid, p_date date default public.today_mx(),
  p_note text default null, p_kind text default 'payment', p_client_uuid uuid default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  o       public.orders%rowtype;
  v_id    uuid;
  v_paid  numeric;
  v_fee   numeric := 0;
begin
  if not public.is_member() then raise exception 'No tienes permiso para hacer esto.'; end if;
  if p_client_uuid is not null then
    select id into v_id from public.order_payments where client_uuid = p_client_uuid;
    if found then return v_id; end if;
  end if;
  if p_kind not in ('payment', 'refund') then raise exception 'Tipo de pago no válido.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'El monto debe ser mayor a 0.'; end if;
  select * into o from public.orders where id = p_order_id for update;
  if not found then raise exception 'Pedido no encontrado.'; end if;
  if o.status not in ('confirmed', 'delivered') then raise exception 'Confirma la cotización antes de registrar pagos.'; end if;
  if not exists (select 1 from public.payment_methods where id = p_method and is_active) then raise exception 'Método de pago no válido.'; end if;
  select coalesce(sum(case kind when 'payment' then amount else -amount end), 0) into v_paid from public.order_payments where order_id = p_order_id;
  if p_kind = 'payment' then
    if v_paid + p_amount > o.total then raise exception 'El pago excede el saldo del pedido (saldo: %).', o.total - v_paid; end if;
    v_fee := (public.payment_fee(p_method, p_amount, p_date) ->> 'fee')::numeric;
  else
    if p_amount > v_paid then raise exception 'La devolución es mayor a lo pagado (pagado: %).', v_paid; end if;
  end if;
  insert into public.order_payments (order_id, kind, amount, payment_method_id, paid_on, fee, note, client_uuid)
  values (p_order_id, p_kind, round(p_amount, 2), p_method, p_date, v_fee, p_note, p_client_uuid)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Entregar: toma de producto terminado, teje lo que falte y guarda la foto del costo
-- ---------------------------------------------------------------------
create or replace function public.deliver_order(p_order_id uuid, p_date date default public.today_mx())
returns void
language plpgsql security definer set search_path = public
as $$
declare
  o         public.orders%rowtype;
  l         public.order_lines%rowtype;
  pr        public.products%rowtype;
  v_over    jsonb;
  v_run     uuid;
  v_before_cost  numeric;
  v_before_labor numeric;
  v_avail   numeric;
  v_short   numeric;
  v_take    numeric;
  v_run_cost  numeric;
  v_run_labor numeric;
  v_cost    numeric;
  v_labor   numeric;
  v_rate    numeric;
  v_def_tax numeric;
  v_ver     uuid;
  r         record;
  v_note    text;
begin
  if not public.is_member() then raise exception 'No tienes permiso para hacer esto.'; end if;
  select * into o from public.orders where id = p_order_id for update;
  if not found then raise exception 'Pedido no encontrado.'; end if;
  if o.status <> 'confirmed' then raise exception 'Solo se entrega un pedido confirmado.'; end if;
  v_note := 'Pedido ' || o.order_folio;
  select coalesce(rate, 0) into v_def_tax from public.tax_rates where is_default limit 1;
  v_def_tax := coalesce(v_def_tax, 0);

  for l in select * from public.order_lines where order_id = p_order_id order by sort_no loop
    if l.line_type = 'custom' then
      v_cost := l.custom_unit_cost; v_labor := 0; v_rate := v_def_tax;
    else
      select * into pr from public.products where id = l.product_id;
      select coalesce(rate, 0) into v_rate from public.tax_rates
        where id = coalesce(pr.tax_rate_id, (select id from public.tax_rates where is_default limit 1));
      v_rate := coalesce(v_rate, v_def_tax);

      if l.line_type = 'packaging' then
        v_cost := coalesce((public.product_cost(pr.id, p_date) ->> 'total')::numeric, 0);
        v_labor := 0;
        select id into v_ver from public.product_versions
          where product_id = pr.id and valid_from <= p_date order by valid_from desc, version_no desc limit 1;
        for r in select cm.item_id, cm.qty, cm.waste_pct from public.product_components cm
                 where cm.version_id = v_ver and cm.item_id is not null loop
          insert into public.stock_movements (item_id, qty_base, unit_cost, kind, moved_on, ref_id, note)
          values (r.item_id, -round(l.qty * r.qty * (1 + r.waste_pct), 4),
                  (select unit_cost_base from public.v_item_cost_current where item_id = r.item_id),
                  'sale', p_date, o.id, 'Empaque de ' || v_note);
        end loop;
      else
        select coalesce(jsonb_agg(jsonb_build_object('component_product_id', c.component_product_id, 'qty', c.qty)), null)
          into v_over from public.order_line_components c where c.line_id = l.id;
        if v_over is not null then
          -- ramo personalizado: siempre se arma con sus piezas (de existencia o tejidas)
          v_run := public.produce_product(pr.id, l.qty, p_date, v_note || ' (personalizado)', null, v_over);
          select unit_cost, round(labor_cost / qty, 4) into v_run_cost, v_run_labor from public.production_runs where id = v_run;
          v_cost := v_run_cost; v_labor := v_run_labor;
        else
          v_before_cost := public.product_unit_cost_now(pr.id, p_date);
          v_before_labor := public.product_labor_unit_now(pr.id, p_date);
          v_avail := greatest(public.product_stock(pr.id), 0);
          v_take := least(v_avail, l.qty);
          v_short := l.qty - v_take;
          v_cost := v_before_cost; v_labor := v_before_labor;
          if v_short > 0 then
            v_run := public.produce_product(pr.id, v_short, p_date, v_note);
            select unit_cost, round(labor_cost / qty, 4) into v_run_cost, v_run_labor from public.production_runs where id = v_run;
            v_cost  := round((v_take * v_before_cost + v_short * v_run_cost) / l.qty, 4);
            v_labor := round((v_take * v_before_labor + v_short * v_run_labor) / l.qty, 4);
          end if;
        end if;
        insert into public.product_stock_movements (product_id, qty, unit_cost, kind, moved_on, ref_id, note)
        values (pr.id, -l.qty, v_cost, 'sale', p_date, o.id, v_note);
      end if;
    end if;
    update public.order_lines set unit_cost = coalesce(v_cost, 0), unit_labor = coalesce(v_labor, 0),
      tax_rate = v_rate, tax_amount = round(l.line_total - l.line_total / (1 + v_rate), 2)
    where id = l.id;
  end loop;

  update public.orders set status = 'delivered', delivered_on = p_date where id = p_order_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 7. Vista de pedidos
-- ---------------------------------------------------------------------
create view public.v_order_summary with (security_invoker = true) as
select o.id, o.quote_folio, o.order_folio, o.status, o.customer_name, o.customer_phone, o.notes, o.due_date,
  o.total, o.confirmed_on, o.delivered_on, o.cancelled_on, o.created_at,
  coalesce(p.paid, 0) as paid,
  o.total - coalesce(p.paid, 0) as balance,
  coalesce(p.fees, 0) as fees,
  (o.status = 'delivered' and o.total - coalesce(p.paid, 0) <= 0) as concretized,
  case when o.status = 'delivered' and o.total - coalesce(p.paid, 0) <= 0
       then greatest(o.delivered_on, coalesce(p.last_paid, o.delivered_on)) end as concretized_on,
  case when o.status = 'delivered' then c.cogs end as cost_real,
  case when o.status = 'delivered' then c.labor end as labor_real,
  e.est as cost_estimated
from public.orders o
left join lateral (
  select sum(case kind when 'payment' then amount else -amount end) as paid,
         sum(fee) as fees, max(paid_on) as last_paid
  from public.order_payments where order_id = o.id
) p on true
left join lateral (
  select sum(qty * unit_cost) as cogs, sum(qty * unit_labor) as labor from public.order_lines where order_id = o.id
) c on true
left join lateral (
  select sum(case when ol.line_type = 'custom' then ol.qty * ol.custom_unit_cost
                  else public.estimate_line_cost(ol.product_id, ol.qty,
                         (select jsonb_agg(jsonb_build_object('component_product_id', oc.component_product_id, 'qty', oc.qty))
                          from public.order_line_components oc where oc.line_id = ol.id)) end) as est
  from public.order_lines ol where ol.order_id = o.id
) e on true;

-- ---------------------------------------------------------------------
-- 8. Seguridad (los pedidos se escriben solo con las funciones de arriba)
-- ---------------------------------------------------------------------
alter table public.orders                enable row level security;
alter table public.order_lines           enable row level security;
alter table public.order_line_components enable row level security;
alter table public.order_payments        enable row level security;

create policy orders_select on public.orders for select to authenticated using (public.is_member());
create policy order_lines_select on public.order_lines for select to authenticated using (public.is_member());
create policy order_line_components_select on public.order_line_components for select to authenticated using (public.is_member());
create policy order_payments_select on public.order_payments for select to authenticated using (public.is_member());

grant select on public.orders, public.order_lines, public.order_line_components, public.order_payments,
  public.v_order_summary to authenticated;
revoke all on public.orders, public.order_lines, public.order_line_components, public.order_payments,
  public.v_order_summary from anon;

revoke all on function public.produce_product(uuid, numeric, date, text, uuid, jsonb) from public, anon;
revoke all on function public.consume_product_recipe(uuid, numeric, uuid, date, int, jsonb) from public, anon;
revoke all on function public.next_folio(text) from public, anon;
revoke all on function public.estimate_line_cost(uuid, numeric, jsonb, date) from public, anon;
revoke all on function public.estimate_lines(jsonb) from public, anon;
revoke all on function public.save_order(uuid, text, text, date, text, jsonb) from public, anon;
revoke all on function public.confirm_order(uuid) from public, anon;
revoke all on function public.cancel_order(uuid, text) from public, anon;
revoke all on function public.record_order_payment(uuid, numeric, uuid, date, text, text, uuid) from public, anon;
revoke all on function public.deliver_order(uuid, date) from public, anon;
grant execute on function public.produce_product(uuid, numeric, date, text, uuid, jsonb) to authenticated;
grant execute on function public.consume_product_recipe(uuid, numeric, uuid, date, int, jsonb) to authenticated;
grant execute on function public.estimate_line_cost(uuid, numeric, jsonb, date) to authenticated;
grant execute on function public.estimate_lines(jsonb) to authenticated;
grant execute on function public.save_order(uuid, text, text, date, text, jsonb) to authenticated;
grant execute on function public.confirm_order(uuid) to authenticated;
grant execute on function public.cancel_order(uuid, text) to authenticated;
grant execute on function public.record_order_payment(uuid, numeric, uuid, date, text, text, uuid) to authenticated;
grant execute on function public.deliver_order(uuid, date) to authenticated;

commit;
