-- =====================================================================
-- ETAPA 1b · Grupos de precio, escalones por cantidad y estambre de venta
-- Requiere haber corrido antes 0001_nucleo_insumos.sql (una sola vez cada una).
-- Todo va en una transacción: si algo falla, no queda nada a medias.
--
-- Idea central:
--   * El estambre de VENTA se cuenta por madeja (unidad de venta = unidad de compra = 1 madeja).
--     Cada madeja "contiene" 100 g (dato informativo; se usará al pasarla a producción).
--   * Los precios de venta viven en un GRUPO DE PRECIO (por ejemplo "Alize Velluto"),
--     con escalones por cantidad. Todos los colores del grupo comparten esos precios y las
--     piezas se cuentan entre colores del mismo grupo.
--   * Hay un precio INTERNO por grupo (lo que te "cobras" al pasar madejas a producción).
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. Grupos de precio y escalones
-- ---------------------------------------------------------------------
create table public.price_groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) > 0),
  description text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid()
);
create unique index price_groups_name_unique on public.price_groups (lower(btrim(name)));

create table public.price_group_tiers (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.price_groups(id),
  audience    text not null check (audience in ('customer', 'internal')),
  valid_from  date not null,
  min_qty     int not null check (min_qty >= 1),
  -- precio por pieza, con IVA incluido
  unit_price  numeric(14,2) not null check (unit_price >= 0),
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  check (audience = 'customer' or min_qty = 1),
  unique (group_id, audience, valid_from, min_qty)
);
create index price_group_tiers_lookup_idx
  on public.price_group_tiers (group_id, audience, valid_from desc, min_qty);

create trigger price_group_tiers_immutable
  before update or delete on public.price_group_tiers
  for each row execute function public.prevent_modification();

create trigger audit_price_groups after insert or update or delete on public.price_groups
  for each row execute function public.audit_row_change();
create trigger audit_price_group_tiers after insert or update or delete on public.price_group_tiers
  for each row execute function public.audit_row_change();

-- ---------------------------------------------------------------------
-- 2. Insumos: contenido por unidad y grupo de precio
-- ---------------------------------------------------------------------
alter table public.items
  add column content_qty     numeric(14,4),
  add column content_unit    text,
  add column price_group_id  uuid references public.price_groups(id);

alter table public.items
  add constraint items_content_qty_pos check (content_qty is null or content_qty > 0),
  add constraint items_content_pair check ((content_qty is null) = (content_unit is null)),
  add constraint items_group_only_resale check (price_group_id is null or kind = 'resale');

create index items_price_group_idx on public.items (price_group_id);

-- ---------------------------------------------------------------------
-- 3. Vista de insumos con los datos nuevos (se recrea)
-- ---------------------------------------------------------------------
drop view public.v_item_list;
create view public.v_item_list with (security_invoker = true) as
select
  i.id, i.sku, i.name, i.kind, i.category_id, c.name as category_name,
  i.brand, i.color, i.color_code,
  i.purchase_unit, i.base_unit, i.units_per_purchase, i.min_stock,
  i.content_qty, i.content_unit,
  i.price_group_id, g.name as price_group_name,
  i.is_consumable, i.is_sellable, i.tax_rate_id,
  i.default_supplier_id, s.name as supplier_name,
  i.image_path, i.barcode, i.notes, i.is_active, i.created_at, i.updated_at,
  cc.purchase_price as current_purchase_price,
  cc.unit_cost_base as current_unit_cost,
  cc.valid_from as price_valid_from
from public.items i
left join public.categories c on c.id = i.category_id
left join public.suppliers s on s.id = i.default_supplier_id
left join public.price_groups g on g.id = i.price_group_id
left join public.v_item_cost_current cc on cc.item_id = i.id;

-- Precios vigentes por grupo: el juego completo de escalones con la fecha de inicio más reciente
create view public.v_group_prices_current with (security_invoker = true) as
with latest as (
  select group_id, audience, max(valid_from) as vf
  from public.price_group_tiers
  where valid_from <= public.today_mx()
  group by group_id, audience
)
select t.group_id, t.audience, t.valid_from, t.min_qty, t.unit_price
from public.price_group_tiers t
join latest l on l.group_id = t.group_id and l.audience = t.audience and l.vf = t.valid_from
order by t.group_id, t.audience, t.min_qty;

-- ---------------------------------------------------------------------
-- 4. Funciones
-- ---------------------------------------------------------------------

-- Precio por pieza para una cantidad (las piezas se cuentan en el grupo). Devuelve null si no hay precio.
create or replace function public.price_for_qty(
  p_group_id uuid, p_qty int,
  p_on date default public.today_mx(),
  p_audience text default 'customer'
) returns numeric
language sql stable
as $$
  with latest as (
    select max(valid_from) as vf
    from public.price_group_tiers
    where group_id = p_group_id and audience = p_audience and valid_from <= p_on
  )
  select t.unit_price
  from public.price_group_tiers t, latest l
  where t.group_id = p_group_id and t.audience = p_audience
    and t.valid_from = l.vf and t.min_qty <= p_qty
  order by t.min_qty desc
  limit 1
$$;

-- Guarda un juego COMPLETO de escalones con una fecha de inicio (solo la dueña).
-- p_tiers: [{"min_qty":1,"unit_price":70},{"min_qty":5,"unit_price":65}, ...]
create or replace function public.set_group_prices(
  p_group_id uuid, p_audience text, p_valid_from date, p_tiers jsonb
) returns int
language plpgsql security definer set search_path = public
as $$
declare
  t          jsonb;
  q          int;
  pr         numeric;
  prev_qty   int := 0;
  prev_price numeric := null;
  has_one    boolean := false;
  n          int := 0;
begin
  if not public.is_owner() then
    raise exception 'Solo la dueña puede cambiar los precios de venta.';
  end if;
  if p_audience not in ('customer', 'internal') then
    raise exception 'Tipo de precio no válido.';
  end if;
  if not exists (select 1 from public.price_groups where id = p_group_id) then
    raise exception 'El grupo de precio no existe.';
  end if;
  if p_tiers is null or jsonb_typeof(p_tiers) <> 'array' or jsonb_array_length(p_tiers) = 0 then
    raise exception 'Escribe al menos un precio.';
  end if;
  if p_audience = 'internal' and jsonb_array_length(p_tiers) <> 1 then
    raise exception 'El precio interno es un solo precio.';
  end if;

  for t in select value from jsonb_array_elements(p_tiers) order by (value ->> 'min_qty')::int
  loop
    q  := (t ->> 'min_qty')::int;
    pr := (t ->> 'unit_price')::numeric;
    if q is null or pr is null or q < 1 or pr < 0 then
      raise exception 'Cantidad o precio no válidos.';
    end if;
    if q <= prev_qty then
      raise exception 'Dos escalones tienen la misma cantidad mínima.';
    end if;
    if prev_price is not null and pr > prev_price then
      raise exception 'El precio no puede subir al comprar más piezas.';
    end if;
    if q = 1 then has_one := true; end if;

    insert into public.price_group_tiers (group_id, audience, valid_from, min_qty, unit_price)
    values (p_group_id, p_audience, p_valid_from, q, pr);

    prev_qty := q;
    prev_price := pr;
    n := n + 1;
  end loop;

  if not has_one then
    raise exception 'Debe haber un precio para 1 pieza.';
  end if;
  if p_audience = 'internal' and n <> 1 then
    raise exception 'El precio interno es un solo precio.';
  end if;
  return n;
end;
$$;

-- Registra el costo de compra (por unidad) en todos los insumos activos del grupo.
create or replace function public.set_group_purchase_price(
  p_group_id uuid, p_price numeric, p_valid_from date, p_note text default null
) returns int
language plpgsql security invoker set search_path = public
as $$
declare
  n int;
begin
  if p_price is null or p_price < 0 then
    raise exception 'El precio no es válido.';
  end if;
  insert into public.item_price_history (item_id, valid_from, purchase_price, source, note)
  select i.id, p_valid_from, p_price, 'manual', p_note
  from public.items i
  where i.price_group_id = p_group_id and i.is_active;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.price_for_qty(uuid, int, date, text) from public, anon;
revoke all on function public.set_group_prices(uuid, text, date, jsonb) from public, anon;
revoke all on function public.set_group_purchase_price(uuid, numeric, date, text) from public, anon;
grant execute on function public.price_for_qty(uuid, int, date, text) to authenticated;
grant execute on function public.set_group_prices(uuid, text, date, jsonb) to authenticated;
grant execute on function public.set_group_purchase_price(uuid, numeric, date, text) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Seguridad
-- ---------------------------------------------------------------------
alter table public.price_groups      enable row level security;
alter table public.price_group_tiers enable row level security;

create policy price_groups_select on public.price_groups for select to authenticated using (public.is_member());
create policy price_groups_insert on public.price_groups for insert to authenticated with check (public.is_owner());
create policy price_groups_update on public.price_groups for update to authenticated
  using (public.is_owner()) with check (public.is_owner());

-- Los escalones solo se leen; se escriben únicamente con set_group_prices()
create policy price_group_tiers_select on public.price_group_tiers for select to authenticated using (public.is_member());

grant select, insert, update on public.price_groups to authenticated;
grant select on public.price_group_tiers to authenticated;
grant select on public.v_item_list, public.v_group_prices_current to authenticated;
revoke all on public.price_groups, public.price_group_tiers,
  public.v_item_list, public.v_group_prices_current from anon;

-- ---------------------------------------------------------------------
-- 6. Datos iniciales: estambre Alize Velluto (tu inventario para venta)
--    Precios a clientes: 1-4 = $70, 5-9 = $65, 10 o más = $60. Precio interno: $60.
--    Los precios incluyen IVA. El costo de compra de cada madeja lo registras en la app
--    (Precios de venta > grupo > "Costo de compra del grupo").
--    Las existencias (112 madejas) se cargarán cuando exista el módulo de inventario.
-- ---------------------------------------------------------------------
insert into public.price_groups (name, description)
values ('Alize Velluto', 'Estambre Alize Velluto, madeja de 100 g');

insert into public.price_group_tiers (group_id, audience, valid_from, min_qty, unit_price)
select g.id, v.audience, date '2000-01-01', v.min_qty, v.price
from public.price_groups g
cross join (values
  ('customer', 1, 70.00),
  ('customer', 5, 65.00),
  ('customer', 10, 60.00),
  ('internal', 1, 60.00)
) as v(audience, min_qty, price)
where g.name = 'Alize Velluto';

insert into public.items (
  name, kind, brand, color, color_code,
  purchase_unit, base_unit, units_per_purchase, content_qty, content_unit,
  is_consumable, is_sellable, tax_rate_id, price_group_id, min_stock
)
select
  'Estambre Alize Velluto', 'resale', 'Alize Velluto', v.color, v.code,
  'madeja', 'madeja', 1, 100, 'g',
  false, true,
  (select id from public.tax_rates where code = 'IVA16'),
  (select id from public.price_groups where name = 'Alize Velluto'),
  0
from (values
  ('Light yellow', '13'),
  ('Orange', '6'),
  ('Black', '60'),
  ('Mimosa', '216'),
  ('Pistachio green', '11'),
  ('Lilac', '146'),
  ('Asparagus', '103'),
  ('Lavender', '43'),
  ('Honey', '310'),
  ('Coal grey', '87'),
  ('Camel', '429'),
  ('Dusty pink', '98'),
  ('Light cream', '62'),
  ('Baby blue', '218'),
  ('Medium brown', '466'),
  ('Red', '56'),
  ('Baby pink', '31'),
  ('Blue', '141'),
  ('Brown', '493'),
  ('Marigold', '550'),
  ('Cotton candy', '121'),
  ('White', '55'),
  ('Grey', '416')
) as v(color, code);

commit;
