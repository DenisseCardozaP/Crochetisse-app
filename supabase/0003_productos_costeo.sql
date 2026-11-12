-- =====================================================================
-- ETAPA 2 · Productos, recetas versionadas y costeo
-- Requiere 0001 y 0002 ya corridos. Córrelo UNA sola vez.
-- Todo va en una transacción: si algo falla, no queda nada a medias.
--
-- Ideas centrales:
--   * Un producto es un amigurumi, un ensamble (ramo, arreglo), un combo o un EMPAQUE
--     (chico, mediano, grande, llaveros, bouquets). Un empaque es un producto cuya receta
--     son insumos (bolsa, etiqueta...), así que se costea y se cobra igual que los demás.
--   * Cada cambio de receta crea una VERSIÓN nueva. Las versiones nunca se editan.
--   * Un componente es un insumo de producción o OTRO producto. Si es un producto, se usa
--     su costo de producción completo (nunca se vuelven a contar sus materiales).
--   * El costo se calcula con las vigencias: puedes preguntar cuánto costaba en cualquier fecha.
--   * El precio SUGERIDO se calcula; el precio PUBLICADO es una decisión que se guarda con fecha.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. Productos
-- ---------------------------------------------------------------------
create table public.products (
  id                      uuid primary key default gen_random_uuid(),
  code                    text unique,
  name                    text not null check (length(btrim(name)) > 0),
  kind                    text not null check (kind in ('amigurumi', 'assembly', 'bundle', 'packaging')),
  description             text,
  image_path              text,
  category_id             uuid references public.categories(id),
  tax_rate_id             uuid references public.tax_rates(id),
  pricing_method_override text check (pricing_method_override in ('markup', 'margin')),
  profit_pct_override     numeric(7,6) check (profit_pct_override >= 0),
  default_packaging_id    uuid references public.products(id),
  barcode                 text unique,
  is_active               boolean not null default true,
  created_at              timestamptz not null default now(),
  created_by              uuid default auth.uid(),
  updated_at              timestamptz not null default now(),
  check (default_packaging_id is distinct from id),
  check (kind <> 'packaging' or default_packaging_id is null),
  check (profit_pct_override is null or pricing_method_override is distinct from 'margin' or profit_pct_override < 1)
);
create unique index products_name_unique on public.products (lower(btrim(name)));
create index products_kind_idx on public.products (kind, is_active);
create index products_category_idx on public.products (category_id);

create trigger products_updated_at before update on public.products
  for each row execute function public.set_updated_at();

-- El empaque predeterminado debe ser un producto de tipo empaque
create or replace function public.products_check_packaging()
returns trigger language plpgsql
as $$
begin
  if new.default_packaging_id is not null
     and coalesce((select kind from public.products where id = new.default_packaging_id), '') <> 'packaging' then
    raise exception 'El empaque predeterminado debe ser un producto de tipo empaque.';
  end if;
  return new;
end;
$$;
create trigger products_check_packaging_trg before insert or update on public.products
  for each row execute function public.products_check_packaging();

-- ---------------------------------------------------------------------
-- 2. Versiones de receta (inmutables)
-- ---------------------------------------------------------------------
create table public.product_versions (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references public.products(id),
  version_no  int not null check (version_no >= 1),
  valid_from  date not null default public.today_mx(),
  labor_hours numeric(8,3) not null default 0 check (labor_hours >= 0),
  notes       text,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  unique (product_id, version_no)
);
create index product_versions_lookup_idx on public.product_versions (product_id, valid_from desc, version_no desc);

create trigger product_versions_immutable
  before update or delete on public.product_versions
  for each row execute function public.prevent_modification();

create table public.product_components (
  id                   uuid primary key default gen_random_uuid(),
  version_id           uuid not null references public.product_versions(id),
  item_id              uuid references public.items(id),
  component_product_id uuid references public.products(id),
  qty                  numeric(14,4) not null check (qty > 0),
  waste_pct            numeric(7,6) not null default 0 check (waste_pct >= 0 and waste_pct < 1),
  note                 text,
  check ((item_id is not null) <> (component_product_id is not null))
);
create unique index product_components_item_uq on public.product_components (version_id, item_id)
  where item_id is not null;
create unique index product_components_product_uq on public.product_components (version_id, component_product_id)
  where component_product_id is not null;
create index product_components_item_idx on public.product_components (item_id);
create index product_components_product_idx on public.product_components (component_product_id);

create trigger product_components_immutable
  before update or delete on public.product_components
  for each row execute function public.prevent_modification();

-- ¿Se puede llegar de un producto a otro a través de sus recetas vigentes?
create or replace function public.product_reaches(p_from uuid, p_target uuid, p_on date default public.today_mx())
returns boolean
language sql stable
as $$
  with recursive walk(pid, depth) as (
    select p_from, 0
    union
    select c.component_product_id, w.depth + 1
    from walk w
    join lateral (
      select v.id from public.product_versions v
      where v.product_id = w.pid and v.valid_from <= p_on
      order by v.valid_from desc, v.version_no desc
      limit 1
    ) cv on true
    join public.product_components c on c.version_id = cv.id and c.component_product_id is not null
    where w.depth < 20
  )
  select exists (select 1 from walk where pid = p_target)
$$;

create or replace function public.product_components_check()
returns trigger language plpgsql
as $$
declare
  v_product uuid;
  v_kind    text;
begin
  select product_id into v_product from public.product_versions where id = new.version_id;
  if new.item_id is not null then
    if not coalesce((select is_consumable from public.items where id = new.item_id), false) then
      raise exception 'Ese insumo es solo para venta. En las recetas usa el material de producción.';
    end if;
  else
    if new.component_product_id = v_product then
      raise exception 'Un producto no puede llevarse a sí mismo como componente.';
    end if;
    select kind into v_kind from public.products where id = new.component_product_id;
    if v_kind = 'packaging' then
      raise exception 'El empaque no es un componente: se asigna como empaque predeterminado.';
    end if;
    if public.product_reaches(new.component_product_id, v_product) then
      raise exception 'Esta receta crearía un ciclo (un producto terminaría llevándose a sí mismo).';
    end if;
  end if;
  return new;
end;
$$;
create trigger product_components_check_trg before insert on public.product_components
  for each row execute function public.product_components_check();

-- ---------------------------------------------------------------------
-- 3. Precios publicados (inmutables, con fecha)
-- ---------------------------------------------------------------------
create table public.product_prices (
  id              uuid primary key default gen_random_uuid(),
  product_id      uuid not null references public.products(id),
  valid_from      date not null,
  price_incl_tax  numeric(14,2) not null check (price_incl_tax >= 0),
  suggested_price numeric(14,2),
  tax_rate_id     uuid references public.tax_rates(id),
  basis           jsonb not null,
  note            text,
  created_at      timestamptz not null default now(),
  created_by      uuid default auth.uid(),
  unique (product_id, valid_from)
);
create index product_prices_lookup_idx on public.product_prices (product_id, valid_from desc);

create trigger product_prices_immutable
  before update or delete on public.product_prices
  for each row execute function public.prevent_modification();

-- ---------------------------------------------------------------------
-- 4. Auditoría
-- ---------------------------------------------------------------------
create trigger audit_products after insert or update or delete on public.products
  for each row execute function public.audit_row_change();
create trigger audit_product_versions after insert or update or delete on public.product_versions
  for each row execute function public.audit_row_change();
create trigger audit_product_components after insert or update or delete on public.product_components
  for each row execute function public.audit_row_change();
create trigger audit_product_prices after insert or update or delete on public.product_prices
  for each row execute function public.audit_row_change();

-- ---------------------------------------------------------------------
-- 5. Costeo
--    Cada renglón se redondea a 4 decimales. El costo de producción NO incluye el empaque.
-- ---------------------------------------------------------------------
create or replace function public.product_cost(
  p_product_id uuid,
  p_on date default public.today_mx(),
  p_depth int default 0
) returns jsonb
language plpgsql stable set search_path = public
as $$
declare
  v_ver     record;
  v_rate    numeric := 0;
  v_labor   numeric := 0;
  v_mat     numeric := 0;
  v_comp    numeric := 0;
  v_lines   jsonb := '[]'::jsonb;
  v_missing jsonb := '[]'::jsonb;
  r         record;
  v_unit    numeric;
  v_sub     jsonb;
  v_tot     numeric;
  v_line    numeric;
begin
  if p_depth > 10 then
    raise exception 'La receta es demasiado profunda o tiene un ciclo.';
  end if;

  select * into v_ver
  from public.product_versions
  where product_id = p_product_id and valid_from <= p_on
  order by valid_from desc, version_no desc
  limit 1;

  if not found then
    return jsonb_build_object(
      'product_id', p_product_id, 'on', p_on, 'has_recipe', false, 'complete', false,
      'total', 0, 'labor', 0, 'materials', 0, 'components', 0,
      'lines', '[]'::jsonb, 'missing', jsonb_build_array('Sin receta en esa fecha'));
  end if;

  select labor_rate_per_hour into v_rate
  from public.business_settings
  where effective_from <= p_on
  order by effective_from desc
  limit 1;
  v_rate := coalesce(v_rate, 0);
  v_labor := round(v_ver.labor_hours * v_rate, 4);

  -- Insumos
  for r in
    select c.qty, c.waste_pct, c.item_id, i.name, i.base_unit
    from public.product_components c
    join public.items i on i.id = c.item_id
    where c.version_id = v_ver.id and c.item_id is not null
    order by i.name
  loop
    select h.unit_cost_base into v_unit
    from public.item_price_history h
    where h.item_id = r.item_id and h.valid_from <= p_on
    order by h.valid_from desc, h.created_at desc
    limit 1;
    if v_unit is null then
      v_missing := v_missing || to_jsonb(r.name || ' (sin precio de compra)');
      v_lines := v_lines || jsonb_build_object(
        'type', 'item', 'id', r.item_id, 'name', r.name, 'unit', r.base_unit,
        'qty', r.qty, 'waste_pct', r.waste_pct, 'unit_cost', null, 'cost', null);
    else
      v_line := round(r.qty * (1 + r.waste_pct) * v_unit, 4);
      v_mat := v_mat + v_line;
      v_lines := v_lines || jsonb_build_object(
        'type', 'item', 'id', r.item_id, 'name', r.name, 'unit', r.base_unit,
        'qty', r.qty, 'waste_pct', r.waste_pct, 'unit_cost', v_unit, 'cost', v_line);
    end if;
  end loop;

  -- Productos componentes: se usa SU costo de producción completo
  for r in
    select c.qty, c.waste_pct, c.component_product_id, p.name
    from public.product_components c
    join public.products p on p.id = c.component_product_id
    where c.version_id = v_ver.id and c.component_product_id is not null
    order by p.name
  loop
    v_sub := public.product_cost(r.component_product_id, p_on, p_depth + 1);
    if coalesce((v_sub ->> 'complete')::boolean, false) is not true then
      v_missing := v_missing || to_jsonb(r.name || ' (costo incompleto)');
    end if;
    v_tot := (v_sub ->> 'total')::numeric;
    v_line := round(r.qty * (1 + r.waste_pct) * v_tot, 4);
    v_comp := v_comp + v_line;
    v_lines := v_lines || jsonb_build_object(
      'type', 'product', 'id', r.component_product_id, 'name', r.name, 'unit', 'pz',
      'qty', r.qty, 'waste_pct', r.waste_pct, 'unit_cost', v_tot, 'cost', v_line);
  end loop;

  return jsonb_build_object(
    'product_id', p_product_id, 'on', p_on, 'has_recipe', true,
    'version_no', v_ver.version_no, 'version_id', v_ver.id,
    'labor_hours', v_ver.labor_hours, 'labor_rate', v_rate,
    'labor', v_labor, 'materials', v_mat, 'components', v_comp,
    'total', round(v_labor + v_mat + v_comp, 4),
    'complete', jsonb_array_length(v_missing) = 0,
    'lines', v_lines, 'missing', v_missing);
end;
$$;

-- Precio sugerido (con IVA incluido) y su desglose
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

  -- IVA del producto; si no tiene definido, se usa IVA 16%
  select rate into v_iva from public.tax_rates
  where id = coalesce(p.tax_rate_id, (select id from public.tax_rates where code = 'IVA16'));
  v_iva := coalesce(v_iva, 0.16);
  select rate into v_iva_fee from public.tax_rates where code = 'IVA16';
  v_iva_fee := coalesce(v_iva_fee, 0.16);

  -- Comisión de tarjeta trasladada al precio
  select r.pct, r.fixed_fee, r.vat_on_fee, r.passes_to_price into v_card
  from public.payment_method_rates r
  join public.payment_methods m on m.id = r.payment_method_id
  where m.kind = 'card' and r.valid_from <= p_on
  order by r.valid_from desc, r.created_at desc
  limit 1;
  if found and v_card.passes_to_price then
    v_c_eff := v_card.pct * (1 + case when v_card.vat_on_fee then v_iva_fee else 0 end);
  end if;

  -- ISR trasladado al precio (opcional): se calcula sobre el precio sin IVA
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

-- Guarda una versión NUEVA de receta (la anterior se conserva).
-- p_components: [{"item_id":"...","qty":60,"waste_pct":0.05} , {"component_product_id":"...","qty":3}]
create or replace function public.save_product_version(
  p_product_id uuid,
  p_labor_hours numeric,
  p_notes text,
  p_components jsonb,
  p_valid_from date default public.today_mx()
) returns uuid
language plpgsql security invoker set search_path = public
as $$
declare
  v_no  int;
  v_id  uuid;
  c     jsonb;
begin
  if not exists (select 1 from public.products where id = p_product_id) then
    raise exception 'Producto no encontrado.';
  end if;
  if p_components is null or jsonb_typeof(p_components) <> 'array' then
    raise exception 'Los componentes deben ser una lista.';
  end if;

  select coalesce(max(version_no), 0) + 1 into v_no from public.product_versions where product_id = p_product_id;

  insert into public.product_versions (product_id, version_no, valid_from, labor_hours, notes)
  values (p_product_id, v_no, p_valid_from, coalesce(p_labor_hours, 0), p_notes)
  returning id into v_id;

  for c in select value from jsonb_array_elements(p_components)
  loop
    insert into public.product_components (version_id, item_id, component_product_id, qty, waste_pct)
    values (
      v_id,
      nullif(c ->> 'item_id', '')::uuid,
      nullif(c ->> 'component_product_id', '')::uuid,
      (c ->> 'qty')::numeric,
      coalesce((c ->> 'waste_pct')::numeric, 0)
    );
  end loop;
  return v_id;
end;
$$;

-- Publica el precio de un producto (solo la dueña). Si no das precio, usa el sugerido.
create or replace function public.publish_product_price(
  p_product_id uuid,
  p_valid_from date default public.today_mx(),
  p_price numeric default null,
  p_note text default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_sug   jsonb;
  v_price numeric;
  v_id    uuid;
  v_tax   uuid;
begin
  if not public.is_owner() then
    raise exception 'Solo la dueña puede publicar precios.';
  end if;
  if not exists (select 1 from public.products where id = p_product_id) then
    raise exception 'Producto no encontrado.';
  end if;

  v_sug := public.product_price_suggestion(p_product_id, public.today_mx());
  if p_price is null then
    if (v_sug ->> 'complete')::boolean is not true then
      raise exception 'Faltan costos para sugerir un precio: %', v_sug -> 'cost' -> 'missing';
    end if;
    v_price := (v_sug ->> 'suggested_price')::numeric;
  else
    if p_price < 0 then raise exception 'El precio no es válido.'; end if;
    v_price := round(p_price, 2);
  end if;

  select tax_rate_id into v_tax from public.products where id = p_product_id;

  insert into public.product_prices (product_id, valid_from, price_incl_tax, suggested_price, tax_rate_id, basis, note)
  values (p_product_id, p_valid_from, v_price, (v_sug ->> 'suggested_price')::numeric, v_tax, v_sug, p_note)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Vistas
-- ---------------------------------------------------------------------
create view public.v_product_price_current with (security_invoker = true) as
select distinct on (pp.product_id)
  pp.product_id, pp.id as price_id, pp.valid_from, pp.price_incl_tax, pp.suggested_price
from public.product_prices pp
where pp.valid_from <= public.today_mx()
order by pp.product_id, pp.valid_from desc, pp.created_at desc;

create view public.v_product_overview with (security_invoker = true) as
select
  p.id, p.code, p.name, p.kind, p.description, p.category_id, c.name as category_name,
  p.tax_rate_id, p.pricing_method_override, p.profit_pct_override,
  p.default_packaging_id, pk.name as default_packaging_name,
  p.barcode, p.is_active, p.created_at, p.updated_at,
  cv.version_no as current_version_no, cv.labor_hours as current_labor_hours,
  cost.j ->> 'total' as cost_total_text,
  (cost.j ->> 'complete')::boolean as cost_complete,
  (cost.j ->> 'has_recipe')::boolean as has_recipe,
  case when (cost.j ->> 'has_recipe')::boolean
       then (public.product_price_suggestion(p.id) ->> 'suggested_price')::numeric end as suggested_price,
  pr.price_incl_tax as current_price,
  pr.valid_from as price_valid_from
from public.products p
left join public.categories c on c.id = p.category_id
left join public.products pk on pk.id = p.default_packaging_id
left join lateral (
  select v.version_no, v.labor_hours from public.product_versions v
  where v.product_id = p.id and v.valid_from <= public.today_mx()
  order by v.valid_from desc, v.version_no desc limit 1
) cv on true
left join lateral (select public.product_cost(p.id) as j) cost on true
left join public.v_product_price_current pr on pr.product_id = p.id;

-- ---------------------------------------------------------------------
-- 7. Seguridad
-- ---------------------------------------------------------------------
alter table public.products           enable row level security;
alter table public.product_versions   enable row level security;
alter table public.product_components enable row level security;
alter table public.product_prices     enable row level security;

create policy products_select on public.products for select to authenticated using (public.is_member());
create policy products_insert on public.products for insert to authenticated with check (public.is_member());
create policy products_update on public.products for update to authenticated
  using (public.is_member()) with check (public.is_member());

create policy product_versions_select on public.product_versions for select to authenticated using (public.is_member());
create policy product_versions_insert on public.product_versions for insert to authenticated with check (public.is_member());

create policy product_components_select on public.product_components for select to authenticated using (public.is_member());
create policy product_components_insert on public.product_components for insert to authenticated with check (public.is_member());

-- Los precios publicados solo se leen; se escriben con publish_product_price()
create policy product_prices_select on public.product_prices for select to authenticated using (public.is_member());

grant select, insert, update on public.products to authenticated;
grant select, insert on public.product_versions, public.product_components to authenticated;
grant select on public.product_prices, public.v_product_price_current, public.v_product_overview to authenticated;

revoke all on public.products, public.product_versions, public.product_components, public.product_prices,
  public.v_product_price_current, public.v_product_overview from anon;

revoke all on function public.product_reaches(uuid, uuid, date) from public, anon;
revoke all on function public.product_cost(uuid, date, int) from public, anon;
revoke all on function public.product_price_suggestion(uuid, date) from public, anon;
revoke all on function public.save_product_version(uuid, numeric, text, jsonb, date) from public, anon;
revoke all on function public.publish_product_price(uuid, date, numeric, text) from public, anon;
grant execute on function public.product_reaches(uuid, uuid, date) to authenticated;
grant execute on function public.product_cost(uuid, date, int) to authenticated;
grant execute on function public.product_price_suggestion(uuid, date) to authenticated;
grant execute on function public.save_product_version(uuid, numeric, text, jsonb, date) to authenticated;
grant execute on function public.publish_product_price(uuid, date, numeric, text) to authenticated;

commit;
