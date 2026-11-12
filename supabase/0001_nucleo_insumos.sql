-- =====================================================================
-- ETAPA 1 · Núcleo y catálogo de insumos
-- Incluye: perfiles y roles, configuración con vigencia, IVA, métodos de pago
-- y comisiones, proveedores, categorías, insumos/empaques/estambres,
-- historial de precios de compra y bitácora de auditoría.
--
-- Cómo correrla: Supabase > SQL Editor > New query > pegar TODO > Run.
-- Es segura de correr una sola vez. Si falla a medias, no deja nada a medias
-- (todo va dentro de una transacción).
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 0. Utilidades
-- ---------------------------------------------------------------------
create or replace function public.today_mx()
returns date language sql stable
as $$ select (now() at time zone 'America/Mexico_City')::date $$;

create or replace function public.set_updated_at()
returns trigger language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.prevent_modification()
returns trigger language plpgsql
as $$
begin
  raise exception 'Los registros de % no se pueden modificar ni borrar; crea uno nuevo.', tg_table_name;
end;
$$;

-- ---------------------------------------------------------------------
-- 1. Perfiles y roles
-- ---------------------------------------------------------------------
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  role         text not null default 'collaborator' check (role in ('owner', 'collaborator')),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

create or replace function public.is_member()
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.is_active
  )
$$;

create or replace function public.is_owner()
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_active and p.role = 'owner'
  )
$$;

revoke all on function public.is_member() from public, anon;
revoke all on function public.is_owner()  from public, anon;
grant execute on function public.is_member() to authenticated;
grant execute on function public.is_owner()  to authenticated;

-- ---------------------------------------------------------------------
-- 2. Bitácora de auditoría (inmutable)
-- ---------------------------------------------------------------------
create table public.audit_log (
  id         bigint generated always as identity primary key,
  table_name text not null,
  row_id     uuid,
  action     text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  old_data   jsonb,
  new_data   jsonb,
  user_id    uuid,
  at         timestamptz not null default now()
);
create index audit_log_table_row_idx on public.audit_log (table_name, row_id);
create index audit_log_at_idx on public.audit_log (at desc);

create trigger audit_log_immutable
  before update or delete on public.audit_log
  for each row execute function public.prevent_modification();

create or replace function public.audit_row_change()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  v_row jsonb;
begin
  if tg_op = 'DELETE' then v_row := to_jsonb(old); else v_row := to_jsonb(new); end if;
  insert into public.audit_log (table_name, row_id, action, old_data, new_data, user_id)
  values (
    tg_table_name,
    (v_row ->> 'id')::uuid,
    tg_op,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end,
    auth.uid()
  );
  return null;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. IVA
-- ---------------------------------------------------------------------
create table public.tax_rates (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  name       text not null,
  rate       numeric(7,6) not null check (rate >= 0 and rate <= 1),
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 4. Configuración del negocio (una fila nueva por cada cambio)
-- ---------------------------------------------------------------------
create table public.business_settings (
  id                   uuid primary key default gen_random_uuid(),
  effective_from       date not null unique,
  labor_rate_per_hour  numeric(14,2) not null check (labor_rate_per_hour >= 0),
  pricing_method       text not null check (pricing_method in ('markup', 'margin')),
  default_profit_pct   numeric(7,6) not null check (default_profit_pct >= 0),
  rounding_mode        text not null default 'none' check (rounding_mode in ('none', 'nearest', 'up')),
  rounding_step        numeric(14,2) not null default 0.01 check (rounding_step > 0),
  business_share_pct   numeric(7,6) not null check (business_share_pct >= 0 and business_share_pct <= 1),
  reserve_pct          numeric(7,6) not null default 0 check (reserve_pct >= 0 and reserve_pct <= 1),
  isr_enabled          boolean not null default false,
  isr_pct              numeric(7,6) not null default 0 check (isr_pct >= 0 and isr_pct < 1),
  yarn_costing_mode    text not null default 'sale_price' check (yarn_costing_mode in ('purchase_cost', 'sale_price')),
  note                 text,
  created_at           timestamptz not null default now(),
  created_by           uuid default auth.uid(),
  -- con margen, el porcentaje debe ser menor a 100% (si no, el precio sería infinito)
  constraint margin_below_one check (pricing_method = 'markup' or default_profit_pct < 1)
);

create trigger business_settings_immutable
  before update or delete on public.business_settings
  for each row execute function public.prevent_modification();

-- ---------------------------------------------------------------------
-- 5. Métodos de pago y sus comisiones con vigencia
-- ---------------------------------------------------------------------
create table public.payment_methods (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  name       text not null,
  kind       text not null check (kind in ('cash', 'card', 'transfer', 'other')),
  sort_order int not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.payment_method_rates (
  id                uuid primary key default gen_random_uuid(),
  payment_method_id uuid not null references public.payment_methods(id),
  valid_from        date not null,
  pct               numeric(7,6) not null default 0 check (pct >= 0 and pct < 1),
  fixed_fee         numeric(14,2) not null default 0 check (fixed_fee >= 0),
  vat_on_fee        boolean not null default false,
  passes_to_price   boolean not null default false,
  note              text,
  created_at        timestamptz not null default now(),
  created_by        uuid default auth.uid(),
  unique (payment_method_id, valid_from)
);
create index payment_method_rates_lookup_idx
  on public.payment_method_rates (payment_method_id, valid_from desc);

create trigger payment_method_rates_immutable
  before update or delete on public.payment_method_rates
  for each row execute function public.prevent_modification();

-- ---------------------------------------------------------------------
-- 6. Proveedores y categorías
-- ---------------------------------------------------------------------
create table public.suppliers (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) > 0),
  contact    text,
  notes      text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index suppliers_name_unique on public.suppliers (lower(btrim(name)));
create trigger suppliers_updated_at before update on public.suppliers
  for each row execute function public.set_updated_at();

create table public.categories (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('item', 'product', 'expense')),
  name       text not null check (length(btrim(name)) > 0),
  parent_id  uuid references public.categories(id),
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  check (parent_id is null or parent_id <> id)
);
create unique index categories_kind_name_unique on public.categories (kind, lower(btrim(name)));

-- ---------------------------------------------------------------------
-- 7. Insumos, empaques y estambres de reventa
--    Un estambre es UN solo registro que puede usarse para producir y/o venderse.
-- ---------------------------------------------------------------------
create table public.items (
  id                  uuid primary key default gen_random_uuid(),
  sku                 text unique,
  name                text not null check (length(btrim(name)) > 0),
  kind                text not null check (kind in ('material', 'packaging', 'resale')),
  category_id         uuid references public.categories(id),
  brand               text,
  color               text,
  color_code          text,
  purchase_unit       text not null check (length(btrim(purchase_unit)) > 0),
  base_unit           text not null check (length(btrim(base_unit)) > 0),
  units_per_purchase  numeric(14,4) not null check (units_per_purchase > 0),
  min_stock           numeric(14,4) not null default 0 check (min_stock >= 0),
  is_consumable       boolean not null default true,
  is_sellable         boolean not null default false,
  tax_rate_id         uuid references public.tax_rates(id),
  default_supplier_id uuid references public.suppliers(id),
  image_path          text,
  barcode             text unique,
  notes               text,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  created_by          uuid default auth.uid(),
  updated_at          timestamptz not null default now(),
  check (is_consumable or is_sellable)
);
-- Misma presentación del mismo producto = duplicado. Otra marca, color o presentación = otro insumo.
create unique index items_unique_presentation on public.items (
  lower(btrim(name)),
  lower(coalesce(btrim(brand), '')),
  lower(coalesce(btrim(color), '')),
  lower(coalesce(btrim(color_code), '')),
  lower(btrim(purchase_unit)),
  units_per_purchase
);
create index items_kind_active_idx on public.items (kind, is_active);
create index items_category_idx on public.items (category_id);
create index items_supplier_idx on public.items (default_supplier_id);

create trigger items_updated_at before update on public.items
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 8. Historial de precios de compra (inmutable)
-- ---------------------------------------------------------------------
create table public.item_price_history (
  id                uuid primary key default gen_random_uuid(),
  item_id           uuid not null references public.items(id),
  valid_from        date not null,
  purchase_price    numeric(14,4) not null check (purchase_price >= 0),
  -- copia de items.units_per_purchase al momento de registrar el precio (la llena un trigger)
  purchase_unit_qty numeric(14,4) not null check (purchase_unit_qty > 0),
  unit_cost_base    numeric(18,6) generated always as (round(purchase_price / purchase_unit_qty, 6)) stored,
  supplier_id       uuid references public.suppliers(id),
  source            text not null default 'manual' check (source in ('manual', 'purchase')),
  note              text,
  created_at        timestamptz not null default now(),
  created_by        uuid default auth.uid()
);
create index item_price_history_lookup_idx on public.item_price_history (item_id, valid_from desc, created_at desc);

create trigger item_price_history_immutable
  before update or delete on public.item_price_history
  for each row execute function public.prevent_modification();

create or replace function public.item_price_fill_snapshot()
returns trigger language plpgsql
as $$
declare
  v_units numeric;
begin
  select units_per_purchase into v_units from public.items where id = new.item_id;
  if v_units is null then
    raise exception 'Insumo no encontrado';
  end if;
  new.purchase_unit_qty := v_units;  -- siempre se toma del insumo, nunca del cliente
  return new;
end;
$$;

create trigger item_price_history_snapshot
  before insert on public.item_price_history
  for each row execute function public.item_price_fill_snapshot();

-- No se puede cambiar la presentación de un insumo que ya tiene precios:
-- se crea un insumo nuevo, para no alterar costos históricos.
create or replace function public.items_guard_presentation()
returns trigger language plpgsql
as $$
begin
  if (new.units_per_purchase is distinct from old.units_per_purchase
      or new.base_unit is distinct from old.base_unit
      or new.purchase_unit is distinct from old.purchase_unit)
     and exists (select 1 from public.item_price_history h where h.item_id = old.id) then
    raise exception 'No se puede cambiar la presentación de un insumo con historial de precios; crea un insumo nuevo.';
  end if;
  return new;
end;
$$;

create trigger items_guard_presentation_trg
  before update on public.items
  for each row execute function public.items_guard_presentation();

-- ---------------------------------------------------------------------
-- 9. Auditoría en las tablas que cambian reglas del negocio
-- ---------------------------------------------------------------------
create trigger audit_items after insert or update or delete on public.items
  for each row execute function public.audit_row_change();
create trigger audit_suppliers after insert or update or delete on public.suppliers
  for each row execute function public.audit_row_change();
create trigger audit_tax_rates after insert or update or delete on public.tax_rates
  for each row execute function public.audit_row_change();
create trigger audit_business_settings after insert or update or delete on public.business_settings
  for each row execute function public.audit_row_change();
create trigger audit_payment_method_rates after insert or update or delete on public.payment_method_rates
  for each row execute function public.audit_row_change();
create trigger audit_item_price_history after insert or update or delete on public.item_price_history
  for each row execute function public.audit_row_change();

-- ---------------------------------------------------------------------
-- 10. Vistas (security_invoker: respetan los permisos de quien consulta)
-- ---------------------------------------------------------------------
create view public.v_current_settings with (security_invoker = true) as
select s.*
from public.business_settings s
where s.effective_from <= public.today_mx()
order by s.effective_from desc
limit 1;

create view public.v_payment_method_current_rate with (security_invoker = true) as
select distinct on (r.payment_method_id)
  r.payment_method_id, r.valid_from, r.pct, r.fixed_fee, r.vat_on_fee, r.passes_to_price, r.note
from public.payment_method_rates r
where r.valid_from <= public.today_mx()
order by r.payment_method_id, r.valid_from desc, r.created_at desc;

create view public.v_item_cost_current with (security_invoker = true) as
select distinct on (h.item_id)
  h.item_id, h.id as price_id, h.valid_from, h.purchase_price,
  h.purchase_unit_qty, h.unit_cost_base, h.supplier_id
from public.item_price_history h
where h.valid_from <= public.today_mx()
order by h.item_id, h.valid_from desc, h.created_at desc;

create view public.v_item_list with (security_invoker = true) as
select
  i.id, i.sku, i.name, i.kind, i.category_id, c.name as category_name,
  i.brand, i.color, i.color_code,
  i.purchase_unit, i.base_unit, i.units_per_purchase, i.min_stock,
  i.is_consumable, i.is_sellable, i.tax_rate_id,
  i.default_supplier_id, s.name as supplier_name,
  i.image_path, i.barcode, i.notes, i.is_active, i.created_at, i.updated_at,
  cc.purchase_price as current_purchase_price,
  cc.unit_cost_base as current_unit_cost,
  cc.valid_from as price_valid_from
from public.items i
left join public.categories c on c.id = i.category_id
left join public.suppliers s on s.id = i.default_supplier_id
left join public.v_item_cost_current cc on cc.item_id = i.id;

-- ---------------------------------------------------------------------
-- 11. Seguridad: RLS
--     Lectura: cualquier miembro activo. Cambios de reglas del negocio: solo dueña.
-- ---------------------------------------------------------------------
alter table public.profiles             enable row level security;
alter table public.audit_log            enable row level security;
alter table public.tax_rates            enable row level security;
alter table public.business_settings    enable row level security;
alter table public.payment_methods      enable row level security;
alter table public.payment_method_rates enable row level security;
alter table public.suppliers            enable row level security;
alter table public.categories           enable row level security;
alter table public.items                enable row level security;
alter table public.item_price_history   enable row level security;

create policy profiles_select on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_owner());

create policy audit_log_select on public.audit_log
  for select to authenticated using (public.is_owner());

-- Solo dueña escribe: IVA, configuración, métodos de pago y comisiones
create policy tax_rates_select on public.tax_rates for select to authenticated using (public.is_member());
create policy tax_rates_insert on public.tax_rates for insert to authenticated with check (public.is_owner());
create policy tax_rates_update on public.tax_rates for update to authenticated using (public.is_owner()) with check (public.is_owner());

create policy business_settings_select on public.business_settings for select to authenticated using (public.is_member());
create policy business_settings_insert on public.business_settings for insert to authenticated with check (public.is_owner());

create policy payment_methods_select on public.payment_methods for select to authenticated using (public.is_member());
create policy payment_methods_insert on public.payment_methods for insert to authenticated with check (public.is_owner());
create policy payment_methods_update on public.payment_methods for update to authenticated using (public.is_owner()) with check (public.is_owner());

create policy payment_method_rates_select on public.payment_method_rates for select to authenticated using (public.is_member());
create policy payment_method_rates_insert on public.payment_method_rates for insert to authenticated with check (public.is_owner());

-- Catálogos: cualquier miembro activo
create policy suppliers_select on public.suppliers for select to authenticated using (public.is_member());
create policy suppliers_insert on public.suppliers for insert to authenticated with check (public.is_member());
create policy suppliers_update on public.suppliers for update to authenticated using (public.is_member()) with check (public.is_member());

create policy categories_select on public.categories for select to authenticated using (public.is_member());
create policy categories_insert on public.categories for insert to authenticated with check (public.is_member());
create policy categories_update on public.categories for update to authenticated using (public.is_member()) with check (public.is_member());

create policy items_select on public.items for select to authenticated using (public.is_member());
create policy items_insert on public.items for insert to authenticated with check (public.is_member());
create policy items_update on public.items for update to authenticated using (public.is_member()) with check (public.is_member());

create policy item_price_history_select on public.item_price_history for select to authenticated using (public.is_member());
create policy item_price_history_insert on public.item_price_history for insert to authenticated with check (public.is_member());

-- ---------------------------------------------------------------------
-- 12. Permisos explícitos (los proyectos nuevos de Supabase ya no los dan solos).
--     Nadie puede borrar: lo que ya no se usa se desactiva (is_active).
-- ---------------------------------------------------------------------
grant usage on schema public to authenticated;

grant select on public.profiles, public.audit_log to authenticated;
grant select, insert, update on public.tax_rates, public.payment_methods,
  public.suppliers, public.categories, public.items to authenticated;
grant select, insert on public.business_settings, public.payment_method_rates,
  public.item_price_history to authenticated;
grant select on public.v_current_settings, public.v_payment_method_current_rate,
  public.v_item_cost_current, public.v_item_list to authenticated;

revoke all on public.profiles, public.audit_log, public.tax_rates, public.business_settings,
  public.payment_methods, public.payment_method_rates, public.suppliers, public.categories,
  public.items, public.item_price_history,
  public.v_current_settings, public.v_payment_method_current_rate,
  public.v_item_cost_current, public.v_item_list from anon;

-- ---------------------------------------------------------------------
-- 13. Datos iniciales (los puedes cambiar desde la app)
--     * Comisión de tarjeta: 2.99% + $1, más IVA sobre la comisión (confirmado en Clip).
--     * Tarifa por hora $60 y margen de ganancia 30% sobre el precio (confirmado).
-- ---------------------------------------------------------------------
insert into public.tax_rates (code, name, rate) values
  ('IVA16',  'IVA 16%', 0.16),
  ('IVA0',   'IVA 0%',  0),
  ('EXENTO', 'Exento',  0)
on conflict (code) do nothing;

insert into public.payment_methods (code, name, kind, sort_order) values
  ('cash',     'Efectivo',      'cash',     1),
  ('card',     'Tarjeta',       'card',     2),
  ('transfer', 'Transferencia', 'transfer', 3)
on conflict (code) do nothing;

insert into public.payment_method_rates (payment_method_id, valid_from, pct, fixed_fee, vat_on_fee, passes_to_price, note)
select pm.id, date '2000-01-01',
  case pm.code when 'card' then 0.0299 else 0 end,
  case pm.code when 'card' then 1 else 0 end,
  pm.code = 'card',
  pm.code = 'card',
  case pm.code when 'card' then '2.99% + $1, más IVA sobre la comisión (confirmado por la dueña en Clip).' end
from public.payment_methods pm
on conflict (payment_method_id, valid_from) do nothing;

insert into public.business_settings (
  effective_from, labor_rate_per_hour, pricing_method, default_profit_pct,
  rounding_mode, rounding_step, business_share_pct, reserve_pct,
  isr_enabled, isr_pct, yarn_costing_mode, note
) values (
  date '2000-01-01', 60, 'margin', 0.30,
  'none', 0.01, 0.5, 0,
  false, 0, 'sale_price',
  'Valores iniciales: $60/h y 30% de margen sobre el precio (confirmado por la dueña).'
)
on conflict (effective_from) do nothing;

-- El usuario más antiguo de este proyecto (el primero que se creó) queda como dueña.
-- Cualquier otro usuario NO tiene acceso hasta que la dueña le cree un perfil.
insert into public.profiles (id, display_name, role)
select u.id, u.email, 'owner'
from auth.users u
order by u.created_at asc
limit 1
on conflict (id) do nothing;

commit;
