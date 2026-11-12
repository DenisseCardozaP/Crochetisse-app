-- =====================================================================
-- ETAPA 4a · Bazares y ventas
-- Requiere 0001 a 0005. Córrelo UNA sola vez.
--
-- Ideas centrales:
--   * El precio de venta se decide por BAZAR: cada bazar tiene su lista (producto, precio, piezas que llevas).
--     El precio sugerido es solo el punto de partida. En un pedido el precio de cada renglón es libre.
--   * Cada venta guarda una FOTO: precio cobrado, costo y mano de obra de ese momento, IVA y comisión de tarjeta.
--     Si cambian recetas o precios después, las ventas pasadas no se mueven.
--   * La bolsa (empaque) es un renglón aparte. Siempre se cobra; solo descuenta sus materiales si la entregaste.
--   * Anular una venta devuelve la existencia con movimientos inversos (nada se borra ni se edita).
--   * El mismo ticket nunca se guarda dos veces (client_uuid), pensado para la iPad sin internet.
-- =====================================================================
begin;

-- Nuevos tipos de movimiento
alter table public.stock_movements drop constraint stock_movements_kind_check;
alter table public.stock_movements add constraint stock_movements_kind_check
  check (kind in ('opening', 'purchase', 'purchase_void', 'adjustment', 'production_use',
                  'transfer_out', 'transfer_in', 'sale', 'sale_void'));
alter table public.product_stock_movements drop constraint product_stock_movements_kind_check;
alter table public.product_stock_movements add constraint product_stock_movements_kind_check
  check (kind in ('production', 'assembly_use', 'adjustment', 'sale', 'sale_void'));

-- ---------------------------------------------------------------------
-- 1. Bazares y su lista de precios
-- ---------------------------------------------------------------------
create table public.events (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) > 0),
  event_date date not null default public.today_mx(),
  status     text not null default 'open' check (status in ('open', 'closed')),
  table_cost numeric(14,2) not null default 0 check (table_cost >= 0),
  float_cash numeric(14,2) not null default 0 check (float_cash >= 0),
  notes      text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
create index events_date_idx on public.events (event_date desc);
create trigger events_updated_at before update on public.events
  for each row execute function public.set_updated_at();

create table public.event_products (
  event_id    uuid not null references public.events(id),
  product_id  uuid not null references public.products(id),
  price       numeric(14,2) not null check (price >= 0),
  qty_brought int not null default 0 check (qty_brought >= 0),
  created_at  timestamptz not null default now(),
  primary key (event_id, product_id)
);

-- Copia la lista de otro bazar (precios y piezas), sin pisar lo que ya exista
create or replace function public.copy_event_products(p_from uuid, p_to uuid)
returns int
language plpgsql security invoker set search_path = public
as $$
declare n int;
begin
  insert into public.event_products (event_id, product_id, price, qty_brought)
  select p_to, product_id, price, qty_brought from public.event_products where event_id = p_from
  on conflict (event_id, product_id) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Ventas (inmutables)
-- ---------------------------------------------------------------------
create table public.sales (
  id                uuid primary key default gen_random_uuid(),
  event_id          uuid references public.events(id),
  sale_date         date not null default public.today_mx(),
  sold_at           timestamptz not null default now(),
  payment_method_id uuid not null references public.payment_methods(id),
  total             numeric(14,2) not null check (total >= 0),
  card_fee          numeric(14,2) not null default 0 check (card_fee >= 0),
  fee_basis         jsonb,
  note              text,
  client_uuid       uuid unique,
  created_at        timestamptz not null default now(),
  created_by        uuid default auth.uid()
);
create index sales_event_idx on public.sales (event_id);
create index sales_date_idx on public.sales (sale_date desc);

create table public.sale_lines (
  id          uuid primary key default gen_random_uuid(),
  sale_id     uuid not null references public.sales(id),
  line_type   text not null check (line_type in ('product', 'packaging', 'item')),
  product_id  uuid references public.products(id),
  item_id     uuid references public.items(id),
  description text not null,
  qty         numeric(14,4) not null check (qty > 0),
  unit_price  numeric(14,2) not null check (unit_price >= 0),
  line_total  numeric(14,2) not null check (line_total >= 0),
  tax_rate    numeric(7,6) not null default 0,
  tax_amount  numeric(14,2) not null default 0,
  unit_cost   numeric(14,4) not null default 0,
  unit_labor  numeric(14,4) not null default 0,
  delivered   boolean not null default true,
  check ((line_type = 'item') = (item_id is not null)),
  check ((line_type <> 'item') = (product_id is not null))
);
create index sale_lines_sale_idx on public.sale_lines (sale_id);
create index sale_lines_product_idx on public.sale_lines (product_id);

create table public.sale_voids (
  sale_id    uuid primary key references public.sales(id),
  reason     text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);

create trigger sales_immutable before update or delete on public.sales
  for each row execute function public.prevent_modification();
create trigger sale_lines_immutable before update or delete on public.sale_lines
  for each row execute function public.prevent_modification();
create trigger sale_voids_immutable before update or delete on public.sale_voids
  for each row execute function public.prevent_modification();
create trigger audit_events after insert or update or delete on public.events
  for each row execute function public.audit_row_change();
create trigger audit_sales after insert or update or delete on public.sales
  for each row execute function public.audit_row_change();
create trigger audit_sale_voids after insert or update or delete on public.sale_voids
  for each row execute function public.audit_row_change();

-- ---------------------------------------------------------------------
-- 3. Ayudas de cálculo
-- ---------------------------------------------------------------------
-- Comisión del método de pago: (pct × total + fijo) × (1 + IVA de la comisión si aplica)
create or replace function public.payment_fee(p_method uuid, p_total numeric, p_on date default public.today_mx())
returns jsonb
language plpgsql stable set search_path = public
as $$
declare r record; v_iva numeric := 0; v_fee numeric := 0;
begin
  select * into r from public.payment_method_rates
  where payment_method_id = p_method and valid_from <= p_on
  order by valid_from desc, created_at desc limit 1;
  if not found then return jsonb_build_object('fee', 0); end if;
  if r.vat_on_fee then
    select coalesce(rate, 0.16) into v_iva from public.tax_rates where code = 'IVA16';
  end if;
  v_fee := round((r.pct * p_total + r.fixed_fee) * (1 + v_iva), 2);
  return jsonb_build_object('fee', v_fee, 'pct', r.pct, 'fixed', r.fixed_fee, 'iva_on_fee', v_iva);
end;
$$;

-- Mano de obra por pieza de la última tanda (si no hay tanda, la de la receta)
create or replace function public.product_labor_unit_now(p_product_id uuid, p_on date default public.today_mx())
returns numeric
language plpgsql stable set search_path = public
as $$
declare v numeric;
begin
  select round(labor_cost / qty, 4) into v from public.production_runs
  where product_id = p_product_id order by created_at desc limit 1;
  if v is null then v := (public.product_cost(p_product_id, p_on) ->> 'labor')::numeric; end if;
  return coalesce(v, 0);
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Registrar una venta
--    p_lines:
--      {"type":"product","product_id":"..","qty":2,"unit_price":250}
--      {"type":"packaging","product_id":"..","qty":1,"unit_price":5,"delivered":true}
--      {"type":"item","item_id":"..","qty":3}      (estambre de venta: el precio sale de los escalones del grupo)
-- ---------------------------------------------------------------------
create or replace function public.register_sale(
  p_event_id uuid,
  p_payment_method_id uuid,
  p_lines jsonb,
  p_note text default null,
  p_client_uuid uuid default null,
  p_sale_date date default public.today_mx(),
  p_sold_at timestamptz default now()
) returns uuid
language plpgsql security invoker set search_path = public
as $$
declare
  v_id      uuid;
  v_status  text;
  l         jsonb;
  v_calc    jsonb := '[]'::jsonb;
  c         jsonb;
  v_type    text;
  v_qty     numeric;
  v_price   numeric;
  v_total   numeric := 0;
  v_lt      numeric;
  v_rate    numeric;
  v_def_tax numeric;
  pr        public.products%rowtype;
  it        public.items%rowtype;
  v_group_q jsonb := '{}'::jsonb;
  v_gq      numeric;
  v_cost    numeric;
  v_labor   numeric;
  v_deliv   boolean;
  v_fee     jsonb;
  r         record;
  v_ver     uuid;
begin
  if p_client_uuid is not null then
    select id into v_id from public.sales where client_uuid = p_client_uuid;
    if found then return v_id; end if;
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'La venta necesita al menos un renglón.';
  end if;
  if not exists (select 1 from public.payment_methods where id = p_payment_method_id and is_active) then
    raise exception 'Método de pago no válido.';
  end if;
  if p_event_id is not null then
    select status into v_status from public.events where id = p_event_id;
    if not found then raise exception 'Bazar no encontrado.'; end if;
    if v_status <> 'open' then raise exception 'Este bazar está cerrado: no se pueden registrar ventas.'; end if;
  end if;
  select coalesce(rate, 0) into v_def_tax from public.tax_rates where is_default limit 1;
  v_def_tax := coalesce(v_def_tax, 0);

  -- cantidades de estambre de venta por grupo (los escalones cuentan entre colores)
  for l in select value from jsonb_array_elements(p_lines) where value ->> 'type' = 'item' loop
    select * into it from public.items where id = (l ->> 'item_id')::uuid;
    if found and it.price_group_id is not null then
      v_group_q := jsonb_set(v_group_q, array[it.price_group_id::text],
        to_jsonb(coalesce((v_group_q ->> it.price_group_id::text)::numeric, 0) + coalesce((l ->> 'qty')::numeric, 0)));
    end if;
  end loop;

  -- pasada 1: calcular cada renglón
  for l in select value from jsonb_array_elements(p_lines) loop
    v_type := l ->> 'type';
    v_qty := (l ->> 'qty')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'Hay un renglón con cantidad no válida.'; end if;
    v_deliv := coalesce((l ->> 'delivered')::boolean, true);

    if v_type in ('product', 'packaging') then
      select * into pr from public.products where id = (l ->> 'product_id')::uuid;
      if not found then raise exception 'Producto no encontrado.'; end if;
      if v_type = 'packaging' and pr.kind <> 'packaging' then raise exception '"%" no es un empaque.', pr.name; end if;
      if v_type = 'product' and pr.kind = 'packaging' then raise exception '"%" es un empaque: agrégalo como bolsa.', pr.name; end if;
      v_price := (l ->> 'unit_price')::numeric;
      if v_price is null or v_price < 0 then raise exception 'Hay un renglón con precio no válido.'; end if;
      select coalesce(rate, 0) into v_rate from public.tax_rates
        where id = coalesce(pr.tax_rate_id, (select id from public.tax_rates where is_default limit 1));
      v_rate := coalesce(v_rate, v_def_tax);
      if v_type = 'product' then
        v_cost := public.product_unit_cost_now(pr.id, p_sale_date);
        v_labor := public.product_labor_unit_now(pr.id, p_sale_date);
      else
        v_cost := case when v_deliv then coalesce((public.product_cost(pr.id, p_sale_date) ->> 'total')::numeric, 0) else 0 end;
        v_labor := 0;
      end if;
      c := jsonb_build_object('type', v_type, 'product_id', pr.id, 'item_id', null, 'desc', pr.name,
            'qty', v_qty, 'price', v_price, 'rate', v_rate, 'cost', coalesce(v_cost, 0), 'labor', coalesce(v_labor, 0), 'delivered', v_deliv);
    elsif v_type = 'item' then
      select * into it from public.items where id = (l ->> 'item_id')::uuid;
      if not found then raise exception 'Material no encontrado.'; end if;
      if not it.is_sellable then raise exception '"%" no es un artículo de venta.', it.name; end if;
      if it.price_group_id is not null then
        v_gq := (v_group_q ->> it.price_group_id::text)::numeric;
        v_price := public.price_for_qty(it.price_group_id, floor(v_gq)::int, p_sale_date, 'customer');
        if v_price is null then raise exception 'El grupo de "%" no tiene precio vigente.', it.name; end if;
      else
        v_price := (l ->> 'unit_price')::numeric;
        if v_price is null or v_price < 0 then raise exception 'Hay un renglón con precio no válido.'; end if;
      end if;
      select coalesce(rate, 0) into v_rate from public.tax_rates
        where id = coalesce(it.tax_rate_id, (select id from public.tax_rates where is_default limit 1));
      v_rate := coalesce(v_rate, v_def_tax);
      select unit_cost_base into v_cost from public.v_item_cost_current where item_id = it.id;
      c := jsonb_build_object('type', 'item', 'product_id', null, 'item_id', it.id,
            'desc', concat_ws(' · ', it.name, it.brand, it.color),
            'qty', v_qty, 'price', v_price, 'rate', v_rate, 'cost', coalesce(v_cost, 0), 'labor', 0, 'delivered', true);
    else
      raise exception 'Tipo de renglón no válido.';
    end if;
    v_total := v_total + round(v_qty * v_price, 2);
    v_calc := v_calc || c;
  end loop;

  v_fee := public.payment_fee(p_payment_method_id, v_total, p_sale_date);
  v_id := gen_random_uuid();
  insert into public.sales (id, event_id, sale_date, sold_at, payment_method_id, total, card_fee, fee_basis, note, client_uuid)
  values (v_id, p_event_id, p_sale_date, p_sold_at, p_payment_method_id, v_total, (v_fee ->> 'fee')::numeric, v_fee, p_note, p_client_uuid);

  -- pasada 2: renglones y movimientos de inventario
  for c in select value from jsonb_array_elements(v_calc) loop
    v_qty := (c ->> 'qty')::numeric;
    v_price := (c ->> 'price')::numeric;
    v_lt := round(v_qty * v_price, 2);
    v_rate := (c ->> 'rate')::numeric;
    insert into public.sale_lines (sale_id, line_type, product_id, item_id, description, qty, unit_price, line_total,
                                   tax_rate, tax_amount, unit_cost, unit_labor, delivered)
    values (v_id, c ->> 'type', nullif(c ->> 'product_id', '')::uuid, nullif(c ->> 'item_id', '')::uuid, c ->> 'desc',
            v_qty, v_price, v_lt, v_rate, round(v_lt - v_lt / (1 + v_rate), 2),
            (c ->> 'cost')::numeric, (c ->> 'labor')::numeric, (c ->> 'delivered')::boolean);

    if c ->> 'type' = 'product' then
      insert into public.product_stock_movements (product_id, qty, unit_cost, kind, moved_on, ref_id, note)
      values ((c ->> 'product_id')::uuid, -v_qty, (c ->> 'cost')::numeric, 'sale', p_sale_date, v_id, p_note);
    elsif c ->> 'type' = 'item' then
      insert into public.stock_movements (item_id, qty_base, unit_cost, kind, moved_on, ref_id, note)
      values ((c ->> 'item_id')::uuid, -v_qty, (c ->> 'cost')::numeric, 'sale', p_sale_date, v_id, p_note);
    elsif (c ->> 'delivered')::boolean then
      -- bolsa entregada: descuenta sus materiales
      select id into v_ver from public.product_versions
        where product_id = (c ->> 'product_id')::uuid and valid_from <= p_sale_date
        order by valid_from desc, version_no desc limit 1;
      for r in select cm.item_id, cm.qty, cm.waste_pct from public.product_components cm
               where cm.version_id = v_ver and cm.item_id is not null loop
        insert into public.stock_movements (item_id, qty_base, unit_cost, kind, moved_on, ref_id, note)
        values (r.item_id, -round(v_qty * r.qty * (1 + r.waste_pct), 4),
                (select unit_cost_base from public.v_item_cost_current where item_id = r.item_id),
                'sale', p_sale_date, v_id, 'Empaque entregado');
      end loop;
    end if;
  end loop;
  return v_id;
end;
$$;

-- Anular una venta: devuelve la existencia con movimientos inversos
create or replace function public.void_sale(p_sale_id uuid, p_reason text default null)
returns void
language plpgsql security invoker set search_path = public
as $$
begin
  if not exists (select 1 from public.sales where id = p_sale_id) then raise exception 'Venta no encontrada.'; end if;
  if exists (select 1 from public.sale_voids where sale_id = p_sale_id) then raise exception 'Esta venta ya estaba anulada.'; end if;
  insert into public.sale_voids (sale_id, reason) values (p_sale_id, p_reason);
  insert into public.stock_movements (item_id, qty_base, unit_cost, kind, moved_on, ref_id, note)
  select item_id, -qty_base, unit_cost, 'sale_void', public.today_mx(), p_sale_id, p_reason
  from public.stock_movements where ref_id = p_sale_id and kind = 'sale';
  insert into public.product_stock_movements (product_id, qty, unit_cost, kind, moved_on, ref_id, note)
  select product_id, -qty, unit_cost, 'sale_void', public.today_mx(), p_sale_id, p_reason
  from public.product_stock_movements where ref_id = p_sale_id and kind = 'sale';
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Vistas
-- ---------------------------------------------------------------------
create view public.v_event_product_status with (security_invoker = true) as
select ep.event_id, ep.product_id, p.name, p.kind, ep.price, ep.qty_brought,
       coalesce(s.sold, 0) as qty_sold,
       ep.qty_brought - coalesce(s.sold, 0) as qty_remaining,
       coalesce(s.revenue, 0) as revenue
from public.event_products ep
join public.products p on p.id = ep.product_id
left join lateral (
  select sum(sl.qty) as sold, sum(sl.line_total) as revenue
  from public.sale_lines sl join public.sales sa on sa.id = sl.sale_id
  where sa.event_id = ep.event_id and sl.product_id = ep.product_id
    and not exists (select 1 from public.sale_voids v where v.sale_id = sa.id)
) s on true;

create view public.v_event_summary with (security_invoker = true) as
select e.id as event_id, e.name, e.event_date, e.status, e.table_cost, e.float_cash,
  coalesce(t.tickets, 0) as tickets,
  coalesce(t.gross, 0) as gross,
  coalesce(t.fees, 0) as card_fees,
  coalesce(t.gross, 0) - coalesce(t.fees, 0) as net_after_fees,
  coalesce(c.cogs, 0) as cost_of_goods,
  coalesce(c.labor, 0) as labor_in_cost,
  coalesce(t.gross, 0) - coalesce(t.fees, 0) - coalesce(c.cogs, 0) as profit_before_table,
  coalesce(t.gross, 0) - coalesce(t.fees, 0) - coalesce(c.cogs, 0) - e.table_cost as profit,
  coalesce(t.cash, 0) as cash_sales,
  coalesce(t.card, 0) as card_sales,
  coalesce(t.other, 0) as other_sales,
  e.float_cash + coalesce(t.cash, 0) as expected_cash
from public.events e
left join lateral (
  select count(*) as tickets, sum(s.total) as gross, sum(s.card_fee) as fees,
         sum(s.total) filter (where m.kind = 'cash') as cash,
         sum(s.total) filter (where m.kind = 'card') as card,
         sum(s.total) filter (where m.kind not in ('cash', 'card')) as other
  from public.sales s join public.payment_methods m on m.id = s.payment_method_id
  where s.event_id = e.id and not exists (select 1 from public.sale_voids v where v.sale_id = s.id)
) t on true
left join lateral (
  select sum(sl.qty * sl.unit_cost) as cogs, sum(sl.qty * sl.unit_labor) as labor
  from public.sale_lines sl join public.sales s on s.id = sl.sale_id
  where s.event_id = e.id and not exists (select 1 from public.sale_voids v where v.sale_id = s.id)
) c on true;

-- ---------------------------------------------------------------------
-- 6. Seguridad
-- ---------------------------------------------------------------------
alter table public.events         enable row level security;
alter table public.event_products enable row level security;
alter table public.sales          enable row level security;
alter table public.sale_lines     enable row level security;
alter table public.sale_voids     enable row level security;

create policy events_select on public.events for select to authenticated using (public.is_member());
create policy events_insert on public.events for insert to authenticated with check (public.is_member());
create policy events_update on public.events for update to authenticated using (public.is_member()) with check (public.is_member());
create policy event_products_select on public.event_products for select to authenticated using (public.is_member());
create policy event_products_insert on public.event_products for insert to authenticated with check (public.is_member());
create policy event_products_update on public.event_products for update to authenticated using (public.is_member()) with check (public.is_member());
create policy event_products_delete on public.event_products for delete to authenticated using (public.is_member());
create policy sales_select on public.sales for select to authenticated using (public.is_member());
create policy sales_insert on public.sales for insert to authenticated with check (public.is_member());
create policy sale_lines_select on public.sale_lines for select to authenticated using (public.is_member());
create policy sale_lines_insert on public.sale_lines for insert to authenticated with check (public.is_member());
create policy sale_voids_select on public.sale_voids for select to authenticated using (public.is_member());
create policy sale_voids_insert on public.sale_voids for insert to authenticated with check (public.is_member());

grant select, insert, update on public.events to authenticated;
grant select, insert, update, delete on public.event_products to authenticated;
grant select, insert on public.sales, public.sale_lines, public.sale_voids to authenticated;
grant select on public.v_event_product_status, public.v_event_summary to authenticated;
revoke all on public.events, public.event_products, public.sales, public.sale_lines, public.sale_voids,
  public.v_event_product_status, public.v_event_summary from anon;

revoke all on function public.copy_event_products(uuid, uuid) from public, anon;
revoke all on function public.payment_fee(uuid, numeric, date) from public, anon;
revoke all on function public.product_labor_unit_now(uuid, date) from public, anon;
revoke all on function public.register_sale(uuid, uuid, jsonb, text, uuid, date, timestamptz) from public, anon;
revoke all on function public.void_sale(uuid, text) from public, anon;
grant execute on function public.copy_event_products(uuid, uuid) to authenticated;
grant execute on function public.payment_fee(uuid, numeric, date) to authenticated;
grant execute on function public.product_labor_unit_now(uuid, date) to authenticated;
grant execute on function public.register_sale(uuid, uuid, jsonb, text, uuid, date, timestamptz) to authenticated;
grant execute on function public.void_sale(uuid, text) to authenticated;

commit;
