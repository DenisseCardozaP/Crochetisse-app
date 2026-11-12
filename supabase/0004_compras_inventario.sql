-- =====================================================================
-- ETAPA 3a · Compras, inventario (movimientos) y costo promedio ponderado
-- + corrección: los productos usan IVA 0% por el momento (la comisión de tarjeta sí lleva IVA)
-- Requiere 0001, 0002 y 0003. Córrelo UNA sola vez.
--
-- Ideas centrales:
--   * Toda entrada o salida de material es un MOVIMIENTO (nunca se edita). La existencia es la suma.
--   * Una compra captura varios materiales + el envío. El envío se reparte entre renglones en
--     proporción a su valor, y de ahí sale cuánto cuesta cada unidad "puesta en tu casa".
--   * Cada compra actualiza el costo del material con PROMEDIO PONDERADO:
--       (existencia actual × costo actual + compra) / (existencia + lo comprado)
--     Así un aumento de precio se mezcla con lo que ya tienes, sin brincos.
--   * Anular una compra revierte la existencia; el costo promedio queda hasta la siguiente compra
--     (o lo corriges a mano en Insumos).
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. IVA predeterminado de productos (hoy 0%; cámbialo cuando empieces a cobrar IVA)
-- ---------------------------------------------------------------------
alter table public.tax_rates add column is_default boolean not null default false;
create unique index tax_rates_one_default on public.tax_rates ((true)) where is_default;
update public.tax_rates set is_default = true where code = 'IVA0';

create or replace function public.product_price_suggestion(
  p_product_id uuid,
  p_on date default public.today_mx()
) returns jsonb
language plpgsql stable set search_path = public
as $$
declare
  p          public.products%rowtype;
  s          public.business_settings%rowtype;
  v_cost     jsonb;
  v_total    numeric;
  v_method   text;
  v_pct      numeric;
  v_iva      numeric;
  v_iva_fee  numeric;
  v_card     record;
  v_c_eff    numeric := 0;
  v_isr_eff  numeric := 0;
  v_den      numeric;
  v_ex       numeric;
  v_incl     numeric;
  v_gross    numeric;
  v_final    numeric;
  v_ex_final numeric;
begin
  select * into p from public.products where id = p_product_id;
  if not found then raise exception 'Producto no encontrado.'; end if;

  select * into s from public.business_settings
  where effective_from <= p_on order by effective_from desc limit 1;
  if not found then raise exception 'No hay configuración del negocio vigente.'; end if;

  v_cost  := public.product_cost(p_product_id, p_on);
  v_total := (v_cost ->> 'total')::numeric;

  v_method := coalesce(p.pricing_method_override, s.pricing_method);
  v_pct    := coalesce(p.profit_pct_override, s.default_profit_pct);
  if v_method = 'margin' and v_pct >= 1 then
    raise exception 'Con margen, la ganancia debe ser menor a 100%%.';
  end if;

  -- IVA del producto; si no tiene definido, el IVA predeterminado (hoy 0%)
  select rate into v_iva from public.tax_rates
  where id = coalesce(p.tax_rate_id, (select id from public.tax_rates where is_default limit 1));
  v_iva := coalesce(v_iva, 0);
  -- El IVA de la comisión de tarjeta siempre es 16%
  select rate into v_iva_fee from public.tax_rates where code = 'IVA16';
  v_iva_fee := coalesce(v_iva_fee, 0.16);

  select r.pct, r.fixed_fee, r.vat_on_fee, r.passes_to_price into v_card
  from public.payment_method_rates r
  join public.payment_methods m on m.id = r.payment_method_id
  where m.kind = 'card' and r.valid_from <= p_on
  order by r.valid_from desc, r.created_at desc
  limit 1;
  if found and v_card.passes_to_price then
    v_c_eff := v_card.pct * (1 + case when v_card.vat_on_fee then v_iva_fee else 0 end);
  end if;

  if s.isr_enabled then
    v_isr_eff := s.isr_pct / (1 + v_iva);
  end if;

  v_den := 1 - v_c_eff - v_isr_eff;
  if v_den <= 0 then
    raise exception 'La comisión y el ISR juntos no pueden llegar al 100%%.';
  end if;

  if v_method = 'margin' then
    v_ex := v_total / (1 - v_pct);
  else
    v_ex := v_total * (1 + v_pct);
  end if;
  v_incl  := v_ex * (1 + v_iva);
  v_gross := v_incl / v_den;

  v_final := case s.rounding_mode
    when 'nearest' then round(v_gross / s.rounding_step) * s.rounding_step
    when 'up'      then ceil(v_gross / s.rounding_step) * s.rounding_step
    else round(v_gross, 2)
  end;
  v_final := round(v_final, 2);
  v_ex_final := round(v_final / (1 + v_iva), 2);

  return jsonb_build_object(
    'product_id', p_product_id, 'on', p_on,
    'cost', v_cost, 'cost_total', v_total, 'complete', (v_cost ->> 'complete')::boolean,
    'method', v_method, 'profit_pct', v_pct,
    'iva_rate', v_iva,
    'price_ex_tax_base', round(v_ex, 4),
    'price_incl_tax_base', round(v_incl, 4),
    'card_commission_factor', v_c_eff,
    'isr_factor', v_isr_eff,
    'price_before_rounding', round(v_gross, 4),
    'rounding_mode', s.rounding_mode, 'rounding_step', s.rounding_step,
    'suggested_price', v_final,
    'suggested_ex_tax', v_ex_final,
    'suggested_iva', v_final - v_ex_final,
    'est_card_commission', round(v_final * v_c_eff, 2));
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Compras
-- ---------------------------------------------------------------------
create table public.purchases (
  id            uuid primary key default gen_random_uuid(),
  supplier_id   uuid references public.suppliers(id),
  purchase_date date not null default public.today_mx(),
  shipping      numeric(14,2) not null default 0 check (shipping >= 0),
  items_total   numeric(14,2) not null check (items_total >= 0),
  total_paid    numeric(14,2) not null check (total_paid >= 0),
  note          text,
  client_uuid   uuid unique,
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid(),
  check (total_paid = items_total + shipping)
);
create index purchases_date_idx on public.purchases (purchase_date desc);

create table public.purchase_lines (
  id                 uuid primary key default gen_random_uuid(),
  purchase_id        uuid not null references public.purchases(id),
  item_id            uuid not null references public.items(id),
  qty_purchase       numeric(14,4) not null check (qty_purchase > 0),
  purchase_unit_qty  numeric(14,4) not null check (purchase_unit_qty > 0),
  qty_base           numeric(14,4) not null check (qty_base > 0),
  line_price         numeric(14,2) not null check (line_price >= 0),
  shipping_alloc     numeric(14,4) not null default 0 check (shipping_alloc >= 0),
  landed_total       numeric(14,4) not null check (landed_total >= 0),
  unit_cost_base     numeric(18,6) not null check (unit_cost_base >= 0)
);
create index purchase_lines_purchase_idx on public.purchase_lines (purchase_id);
create index purchase_lines_item_idx on public.purchase_lines (item_id);

create table public.purchase_voids (
  purchase_id uuid primary key references public.purchases(id),
  reason      text,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid()
);

-- ---------------------------------------------------------------------
-- 3. Movimientos de inventario (la existencia es la suma de movimientos)
-- ---------------------------------------------------------------------
create table public.stock_movements (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references public.items(id),
  qty_base    numeric(14,4) not null check (qty_base <> 0),
  unit_cost   numeric(18,6),
  kind        text not null check (kind in ('opening', 'purchase', 'purchase_void', 'adjustment')),
  moved_on    date not null default public.today_mx(),
  ref_id      uuid,
  note        text,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid()
);
create index stock_movements_item_idx on public.stock_movements (item_id, moved_on desc);
create index stock_movements_ref_idx on public.stock_movements (ref_id);

create trigger purchases_immutable before update or delete on public.purchases
  for each row execute function public.prevent_modification();
create trigger purchase_lines_immutable before update or delete on public.purchase_lines
  for each row execute function public.prevent_modification();
create trigger purchase_voids_immutable before update or delete on public.purchase_voids
  for each row execute function public.prevent_modification();
create trigger stock_movements_immutable before update or delete on public.stock_movements
  for each row execute function public.prevent_modification();

create trigger audit_purchases after insert or update or delete on public.purchases
  for each row execute function public.audit_row_change();
create trigger audit_purchase_voids after insert or update or delete on public.purchase_voids
  for each row execute function public.audit_row_change();
create trigger audit_stock_movements after insert or update or delete on public.stock_movements
  for each row execute function public.audit_row_change();

create view public.v_item_stock with (security_invoker = true) as
select i.id as item_id, coalesce(sum(m.qty_base), 0) as stock_qty, max(m.moved_on) as last_move
from public.items i
left join public.stock_movements m on m.item_id = i.id
group by i.id;

-- Existencia de un material (para usar dentro de las funciones)
create or replace function public.item_stock(p_item_id uuid)
returns numeric language sql stable set search_path = public
as $$ select coalesce(sum(qty_base), 0) from public.stock_movements where item_id = p_item_id $$;

-- ---------------------------------------------------------------------
-- 4. Registrar una compra completa
--    p_lines: [{"item_id":"...","qty":5,"line_price":212}]   (qty en la unidad de compra: madejas, bolsas...)
--    line_price = lo que pagaste por ese renglón (sin el envío). El envío se reparte aparte.
-- ---------------------------------------------------------------------
create or replace function public.register_purchase(
  p_supplier_id uuid,
  p_purchase_date date,
  p_shipping numeric,
  p_note text,
  p_lines jsonb,
  p_client_uuid uuid default null
) returns uuid
language plpgsql security invoker set search_path = public
as $$
declare
  v_id        uuid;
  v_ship      numeric := round(coalesce(p_shipping, 0), 2);
  v_items     numeric := 0;
  v_alloc_sum numeric := 0;
  v_n         int;
  v_i         int := 0;
  l           jsonb;
  it          public.items%rowtype;
  v_qty       numeric;
  v_price     numeric;
  v_alloc     numeric;
  v_landed    numeric;
  v_qbase     numeric;
  v_unit      numeric;
  v_stock     numeric;
  v_cur       numeric;
  v_avg       numeric;
begin
  if p_client_uuid is not null then
    select id into v_id from public.purchases where client_uuid = p_client_uuid;
    if found then return v_id; end if;
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'La compra necesita al menos un renglón.';
  end if;
  if v_ship < 0 then raise exception 'El envío no es válido.'; end if;
  v_n := jsonb_array_length(p_lines);

  for l in select value from jsonb_array_elements(p_lines) loop
    v_price := (l ->> 'line_price')::numeric;
    if v_price is null or v_price < 0 then raise exception 'Hay un renglón con precio no válido.'; end if;
    v_items := v_items + round(v_price, 2);
  end loop;

  insert into public.purchases (supplier_id, purchase_date, shipping, items_total, total_paid, note, client_uuid)
  values (p_supplier_id, coalesce(p_purchase_date, public.today_mx()), v_ship, v_items, v_items + v_ship, p_note, p_client_uuid)
  returning id into v_id;

  for l in select value from jsonb_array_elements(p_lines) loop
    v_i := v_i + 1;
    select * into it from public.items where id = (l ->> 'item_id')::uuid;
    if not found then raise exception 'Material no encontrado.'; end if;
    v_qty   := (l ->> 'qty')::numeric;
    v_price := round((l ->> 'line_price')::numeric, 2);
    if v_qty is null or v_qty <= 0 then raise exception 'Hay un renglón con cantidad no válida.'; end if;

    -- reparto del envío proporcional al valor; el último renglón absorbe el redondeo
    if v_i = v_n then
      v_alloc := greatest(v_ship - v_alloc_sum, 0);
    elsif v_items > 0 then
      v_alloc := round(v_ship * v_price / v_items, 4);
    else
      v_alloc := round(v_ship / v_n, 4);
    end if;
    v_alloc_sum := v_alloc_sum + v_alloc;

    v_landed := v_price + v_alloc;
    v_qbase  := round(v_qty * it.units_per_purchase, 4);
    v_unit   := round(v_landed / v_qbase, 6);

    insert into public.purchase_lines (purchase_id, item_id, qty_purchase, purchase_unit_qty, qty_base,
                                       line_price, shipping_alloc, landed_total, unit_cost_base)
    values (v_id, it.id, v_qty, it.units_per_purchase, v_qbase, v_price, v_alloc, v_landed, v_unit);

    -- costo promedio ponderado con la existencia actual
    v_stock := public.item_stock(it.id);
    select unit_cost_base into v_cur from public.v_item_cost_current where item_id = it.id;
    if v_stock > 0 and v_cur is not null then
      v_avg := (v_stock * v_cur + v_landed) / (v_stock + v_qbase);
    else
      v_avg := v_unit;
    end if;

    insert into public.stock_movements (item_id, qty_base, unit_cost, kind, moved_on, ref_id, note)
    values (it.id, v_qbase, v_unit, 'purchase', coalesce(p_purchase_date, public.today_mx()), v_id, p_note);

    insert into public.item_price_history (item_id, valid_from, purchase_price, supplier_id, source, note)
    values (it.id, coalesce(p_purchase_date, public.today_mx()),
            round(v_avg * it.units_per_purchase, 4), p_supplier_id, 'purchase',
            'Costo promedio ponderado tras compra');
  end loop;

  return v_id;
end;
$$;

-- Anular una compra: revierte la existencia (el costo promedio se queda como está)
create or replace function public.void_purchase(p_purchase_id uuid, p_reason text default null)
returns void
language plpgsql security invoker set search_path = public
as $$
declare r record;
begin
  if not exists (select 1 from public.purchases where id = p_purchase_id) then
    raise exception 'Compra no encontrada.';
  end if;
  if exists (select 1 from public.purchase_voids where purchase_id = p_purchase_id) then
    raise exception 'Esta compra ya estaba anulada.';
  end if;
  insert into public.purchase_voids (purchase_id, reason) values (p_purchase_id, p_reason);
  for r in select item_id, qty_base, unit_cost_base from public.purchase_lines where purchase_id = p_purchase_id loop
    insert into public.stock_movements (item_id, qty_base, unit_cost, kind, ref_id, note)
    values (r.item_id, -r.qty_base, r.unit_cost_base, 'purchase_void', p_purchase_id, p_reason);
  end loop;
end;
$$;

-- Ajuste manual de existencia (conteo físico, merma, regalo...). Cantidad con signo: negativo = salida.
create or replace function public.adjust_stock(p_item_id uuid, p_delta numeric, p_reason text)
returns uuid
language plpgsql security invoker set search_path = public
as $$
declare v_id uuid; v_cost numeric;
begin
  if p_delta is null or p_delta = 0 then raise exception 'El ajuste no puede ser 0.'; end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then raise exception 'Escribe el motivo del ajuste.'; end if;
  select unit_cost_base into v_cost from public.v_item_cost_current where item_id = p_item_id;
  insert into public.stock_movements (item_id, qty_base, unit_cost, kind, note)
  values (p_item_id, p_delta, v_cost, 'adjustment', p_reason)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Seguridad
-- ---------------------------------------------------------------------
alter table public.purchases        enable row level security;
alter table public.purchase_lines   enable row level security;
alter table public.purchase_voids   enable row level security;
alter table public.stock_movements  enable row level security;

create policy purchases_select on public.purchases for select to authenticated using (public.is_member());
create policy purchases_insert on public.purchases for insert to authenticated with check (public.is_member());
create policy purchase_lines_select on public.purchase_lines for select to authenticated using (public.is_member());
create policy purchase_lines_insert on public.purchase_lines for insert to authenticated with check (public.is_member());
create policy purchase_voids_select on public.purchase_voids for select to authenticated using (public.is_member());
create policy purchase_voids_insert on public.purchase_voids for insert to authenticated with check (public.is_member());
create policy stock_movements_select on public.stock_movements for select to authenticated using (public.is_member());
create policy stock_movements_insert on public.stock_movements for insert to authenticated with check (public.is_member());

grant select, insert on public.purchases, public.purchase_lines, public.purchase_voids, public.stock_movements to authenticated;
grant select on public.v_item_stock to authenticated;
revoke all on public.purchases, public.purchase_lines, public.purchase_voids, public.stock_movements,
  public.v_item_stock from anon;

revoke all on function public.item_stock(uuid) from public, anon;
revoke all on function public.register_purchase(uuid, date, numeric, text, jsonb, uuid) from public, anon;
revoke all on function public.void_purchase(uuid, text) from public, anon;
revoke all on function public.adjust_stock(uuid, numeric, text) from public, anon;
revoke all on function public.product_price_suggestion(uuid, date) from public, anon;
grant execute on function public.item_stock(uuid) to authenticated;
grant execute on function public.register_purchase(uuid, date, numeric, text, jsonb, uuid) to authenticated;
grant execute on function public.void_purchase(uuid, text) to authenticated;
grant execute on function public.adjust_stock(uuid, numeric, text) to authenticated;
grant execute on function public.product_price_suggestion(uuid, date) to authenticated;

-- ---------------------------------------------------------------------
-- 6. Existencia inicial de tu estambre de venta (el conteo de tu archivo: 112 madejas)
--    Costo por madeja: $212 / 5 = $42.40 (aproximado, lo confirmaste). Si ya habías registrado
--    un costo de grupo, se respeta; si no, se registra este.
-- ---------------------------------------------------------------------
insert into public.item_price_history (item_id, valid_from, purchase_price, source, note)
select i.id, public.today_mx(), 42.40, 'manual', 'Costo aproximado: paquete de 5 madejas = $212'
from public.items i
where i.brand = 'Alize Velluto'
  and not exists (select 1 from public.item_price_history h where h.item_id = i.id);

insert into public.stock_movements (item_id, qty_base, unit_cost, kind, note)
select i.id, o.qty, (select c.unit_cost_base from public.v_item_cost_current c where c.item_id = i.id),
       'opening', 'Existencia inicial (conteo de tu archivo)'
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

commit;
