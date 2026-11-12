-- =====================================================================
-- ETAPA 3b · Producción, inventario de producto terminado y paso de estambre a producción
-- Requiere 0001 a 0004. Córrelo UNA sola vez.
--
-- Ideas centrales:
--   * "Producir" N piezas descuenta los materiales de la receta vigente (con merma) del inventario
--     y suma N piezas al inventario de producto terminado. Guarda una FOTO del costo real de esa tanda.
--   * Un ramo/arreglo toma sus piezas del producto terminado si hay; las que falten se tejen desde cero
--     (se descuentan sus materiales y se cuenta su mano de obra).
--   * Costo real = materiales a costo promedio del momento + mano de obra a la tarifa de la receta.
--     El costo estimado (receta de ese día) se guarda al lado para comparar.
--   * Pasar estambre de venta a producción: sale de la existencia de venta a su costo y entra a
--     producción al precio interno ($60 por madeja). No es una venta ni cuenta como ingreso.
-- =====================================================================
begin;

-- Nuevos tipos de movimiento de material y de origen de precio
alter table public.stock_movements drop constraint stock_movements_kind_check;
alter table public.stock_movements add constraint stock_movements_kind_check
  check (kind in ('opening', 'purchase', 'purchase_void', 'adjustment', 'production_use', 'transfer_out', 'transfer_in'));
alter table public.item_price_history drop constraint item_price_history_source_check;
alter table public.item_price_history add constraint item_price_history_source_check
  check (source in ('manual', 'purchase', 'transfer'));

-- ---------------------------------------------------------------------
-- 1. Producto terminado
-- ---------------------------------------------------------------------
create table public.product_stock_movements (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id),
  qty        numeric(14,4) not null check (qty <> 0),
  unit_cost  numeric(18,4),
  kind       text not null check (kind in ('production', 'assembly_use', 'adjustment')),
  moved_on   date not null default public.today_mx(),
  ref_id     uuid,
  note       text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create index product_stock_movements_idx on public.product_stock_movements (product_id, created_at desc);
create index product_stock_movements_ref_idx on public.product_stock_movements (ref_id);

create table public.production_runs (
  id                  uuid primary key default gen_random_uuid(),
  product_id          uuid not null references public.products(id),
  version_id          uuid not null references public.product_versions(id),
  qty                 numeric(14,4) not null check (qty > 0),
  run_date            date not null default public.today_mx(),
  labor_hours         numeric(12,4) not null,
  labor_cost          numeric(14,4) not null,
  materials_cost      numeric(14,4) not null,
  total_cost          numeric(14,4) not null,
  unit_cost           numeric(14,4) not null,
  estimated_unit_cost numeric(14,4) not null,
  note                text,
  client_uuid         uuid unique,
  created_at          timestamptz not null default now(),
  created_by          uuid default auth.uid()
);
create index production_runs_idx on public.production_runs (product_id, run_date desc);

create table public.yarn_transfers (
  id                    uuid primary key default gen_random_uuid(),
  from_item_id          uuid not null references public.items(id),
  to_item_id            uuid not null references public.items(id),
  qty_madejas           numeric(14,4) not null check (qty_madejas > 0),
  qty_base              numeric(14,4) not null check (qty_base > 0),
  price_per_madeja      numeric(14,4) not null check (price_per_madeja >= 0),
  from_cost_per_madeja  numeric(14,4),
  transfer_date         date not null default public.today_mx(),
  note                  text,
  client_uuid           uuid unique,
  created_at            timestamptz not null default now(),
  created_by            uuid default auth.uid()
);

create trigger product_stock_movements_immutable before update or delete on public.product_stock_movements
  for each row execute function public.prevent_modification();
create trigger production_runs_immutable before update or delete on public.production_runs
  for each row execute function public.prevent_modification();
create trigger yarn_transfers_immutable before update or delete on public.yarn_transfers
  for each row execute function public.prevent_modification();
create trigger audit_production_runs after insert or update or delete on public.production_runs
  for each row execute function public.audit_row_change();
create trigger audit_yarn_transfers after insert or update or delete on public.yarn_transfers
  for each row execute function public.audit_row_change();
create trigger audit_product_stock_movements after insert or update or delete on public.product_stock_movements
  for each row execute function public.audit_row_change();

create or replace function public.product_stock(p_product_id uuid)
returns numeric language sql stable set search_path = public
as $$ select coalesce(sum(qty), 0) from public.product_stock_movements where product_id = p_product_id $$;

-- Costo de una pieza terminada: el de la última tanda; si nunca se ha producido, la receta de hoy
create or replace function public.product_unit_cost_now(p_product_id uuid, p_on date default public.today_mx())
returns numeric language plpgsql stable set search_path = public
as $$
declare v numeric;
begin
  select unit_cost into v from public.product_stock_movements
  where product_id = p_product_id and kind = 'production'
  order by created_at desc limit 1;
  if v is null then v := (public.product_cost(p_product_id, p_on) ->> 'total')::numeric; end if;
  return v;
end;
$$;

create view public.v_product_stock with (security_invoker = true) as
select p.id as product_id, coalesce(sum(m.qty), 0) as stock_qty
from public.products p
left join public.product_stock_movements m on m.product_id = p.id
group by p.id;

-- ---------------------------------------------------------------------
-- 2. Consumo recursivo de una receta
--    Devuelve {"materials": x, "labor": y, "hours": h}. Escribe los movimientos.
-- ---------------------------------------------------------------------
create or replace function public.consume_product_recipe(
  p_product_id uuid, p_qty numeric, p_run_id uuid, p_on date, p_depth int default 0
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

  for r in
    select c.component_product_id as pid, c.qty, c.waste_pct, p.name
    from public.product_components c join public.products p on p.id = c.component_product_id
    where c.version_id = v_ver.id and c.component_product_id is not null
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
      -- lo que falta se teje desde cero
      v_sub := public.consume_product_recipe(r.pid, v_rest, p_run_id, p_on, p_depth + 1);
      v_mat   := v_mat   + (v_sub ->> 'materials')::numeric;
      v_labor := v_labor + (v_sub ->> 'labor')::numeric;
      v_hours := v_hours + (v_sub ->> 'hours')::numeric;
    end if;
  end loop;

  return jsonb_build_object('materials', v_mat, 'labor', v_labor, 'hours', v_hours);
end;
$$;

-- Registrar una tanda de producción
create or replace function public.produce_product(
  p_product_id uuid,
  p_qty numeric,
  p_date date default public.today_mx(),
  p_note text default null,
  p_client_uuid uuid default null
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
begin
  if p_client_uuid is not null then
    select id into v_id from public.production_runs where client_uuid = p_client_uuid;
    if found then return v_id; end if;
  end if;
  if p_qty is null or p_qty <= 0 then raise exception 'La cantidad debe ser mayor a 0.'; end if;
  select kind into v_kind from public.products where id = p_product_id;
  if not found then raise exception 'Producto no encontrado.'; end if;
  if v_kind = 'packaging' then raise exception 'Los empaques no se producen: se descuentan al venderse.'; end if;

  v_id := gen_random_uuid();
  v_res := public.consume_product_recipe(p_product_id, p_qty, v_id, p_date);
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

-- Ajuste manual de producto terminado (conteo, regalo, defecto...)
create or replace function public.adjust_product_stock(p_product_id uuid, p_delta numeric, p_reason text)
returns uuid
language plpgsql security invoker set search_path = public
as $$
declare v_id uuid;
begin
  if p_delta is null or p_delta = 0 then raise exception 'El ajuste no puede ser 0.'; end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then raise exception 'Escribe el motivo del ajuste.'; end if;
  insert into public.product_stock_movements (product_id, qty, unit_cost, kind, note)
  values (p_product_id, p_delta, public.product_unit_cost_now(p_product_id), 'adjustment', p_reason)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Pasar estambre de venta a producción
-- ---------------------------------------------------------------------
create or replace function public.transfer_yarn_to_production(
  p_from_item uuid,        -- el estambre de venta (por madeja)
  p_to_item uuid,          -- el material de producción (en gramos)
  p_qty_madejas numeric,
  p_date date default public.today_mx(),
  p_price_per_madeja numeric default null,   -- si no lo das, usa el precio interno del grupo
  p_note text default null,
  p_client_uuid uuid default null
) returns uuid
language plpgsql security invoker set search_path = public
as $$
declare
  f        public.items%rowtype;
  t        public.items%rowtype;
  v_id     uuid;
  v_price  numeric;
  v_qbase  numeric;
  v_unit   numeric;
  v_fcost  numeric;
  v_stock  numeric;
  v_cur    numeric;
  v_avg    numeric;
begin
  if p_client_uuid is not null then
    select id into v_id from public.yarn_transfers where client_uuid = p_client_uuid;
    if found then return v_id; end if;
  end if;
  if p_qty_madejas is null or p_qty_madejas <= 0 then raise exception 'La cantidad debe ser mayor a 0.'; end if;
  select * into f from public.items where id = p_from_item;
  if not found or f.kind <> 'resale' then raise exception 'El origen debe ser un estambre de venta.'; end if;
  select * into t from public.items where id = p_to_item;
  if not found or not t.is_consumable or t.kind = 'resale' then
    raise exception 'El destino debe ser un material de producción.';
  end if;
  if f.content_qty is null or f.content_unit is distinct from t.base_unit then
    raise exception 'El estambre de venta y el material de producción deben usar la misma unidad (por ejemplo gramos).';
  end if;

  v_price := p_price_per_madeja;
  if v_price is null then
    if f.price_group_id is null then raise exception 'Este estambre no tiene grupo de precio; escribe el precio por madeja.'; end if;
    v_price := public.price_for_qty(f.price_group_id, 1, p_date, 'internal');
    if v_price is null then raise exception 'El grupo no tiene precio interno vigente; escribe el precio por madeja.'; end if;
  end if;
  if v_price < 0 then raise exception 'El precio no es válido.'; end if;

  v_qbase := round(p_qty_madejas * f.content_qty, 4);
  v_unit  := round(v_price / f.content_qty, 6);
  select unit_cost_base into v_fcost from public.v_item_cost_current where item_id = f.id;

  v_stock := public.item_stock(t.id);
  select unit_cost_base into v_cur from public.v_item_cost_current where item_id = t.id;
  if v_stock > 0 and v_cur is not null then
    v_avg := (v_stock * v_cur + v_qbase * v_unit) / (v_stock + v_qbase);
  else
    v_avg := v_unit;
  end if;

  insert into public.yarn_transfers (from_item_id, to_item_id, qty_madejas, qty_base, price_per_madeja,
                                     from_cost_per_madeja, transfer_date, note, client_uuid)
  values (f.id, t.id, p_qty_madejas, v_qbase, v_price, v_fcost, p_date, p_note, p_client_uuid)
  returning id into v_id;

  insert into public.stock_movements (item_id, qty_base, unit_cost, kind, moved_on, ref_id, note)
  values (f.id, -p_qty_madejas, v_fcost, 'transfer_out', p_date, v_id, coalesce(p_note, 'Pasado a producción')),
         (t.id, v_qbase, v_unit, 'transfer_in', p_date, v_id, coalesce(p_note, 'Pasado desde venta'));

  insert into public.item_price_history (item_id, valid_from, purchase_price, source, note)
  values (t.id, p_date, round(v_avg * t.units_per_purchase, 4), 'transfer',
          'Costo promedio ponderado tras pasar estambre a producción');
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Seguridad
-- ---------------------------------------------------------------------
alter table public.product_stock_movements enable row level security;
alter table public.production_runs         enable row level security;
alter table public.yarn_transfers          enable row level security;

create policy psm_select on public.product_stock_movements for select to authenticated using (public.is_member());
create policy psm_insert on public.product_stock_movements for insert to authenticated with check (public.is_member());
create policy production_runs_select on public.production_runs for select to authenticated using (public.is_member());
create policy production_runs_insert on public.production_runs for insert to authenticated with check (public.is_member());
create policy yarn_transfers_select on public.yarn_transfers for select to authenticated using (public.is_member());
create policy yarn_transfers_insert on public.yarn_transfers for insert to authenticated with check (public.is_member());

grant select, insert on public.product_stock_movements, public.production_runs, public.yarn_transfers to authenticated;
grant select on public.v_product_stock to authenticated;
revoke all on public.product_stock_movements, public.production_runs, public.yarn_transfers,
  public.v_product_stock from anon;

revoke all on function public.product_stock(uuid) from public, anon;
revoke all on function public.product_unit_cost_now(uuid, date) from public, anon;
revoke all on function public.consume_product_recipe(uuid, numeric, uuid, date, int) from public, anon;
revoke all on function public.produce_product(uuid, numeric, date, text, uuid) from public, anon;
revoke all on function public.adjust_product_stock(uuid, numeric, text) from public, anon;
revoke all on function public.transfer_yarn_to_production(uuid, uuid, numeric, date, numeric, text, uuid) from public, anon;
grant execute on function public.product_stock(uuid) to authenticated;
grant execute on function public.product_unit_cost_now(uuid, date) to authenticated;
grant execute on function public.produce_product(uuid, numeric, date, text, uuid) to authenticated;
grant execute on function public.adjust_product_stock(uuid, numeric, text) to authenticated;
grant execute on function public.transfer_yarn_to_production(uuid, uuid, numeric, date, numeric, text, uuid) to authenticated;
grant execute on function public.consume_product_recipe(uuid, numeric, uuid, date, int) to authenticated;
commit;
