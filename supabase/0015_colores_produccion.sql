-- =====================================================================
-- 0015 · Colores usados al producir + variante
-- Una receta por producto; al producir puedes repartir un material
-- (estambre) entre varios colores. El inventario baja de cada color
-- y el costo real sale de lo que usaste. El estimado sigue siendo el de la receta.
-- =====================================================================

alter table public.production_runs add column if not exists variant text;

drop function public.produce_product(uuid, numeric, date, text, uuid, jsonb);
drop function public.consume_product_recipe(uuid, numeric, uuid, date, int, jsonb);

create or replace function public.consume_product_recipe(
  p_product_id uuid, p_qty numeric, p_run_id uuid, p_on date, p_depth int default 0, p_override jsonb default null, p_swap jsonb default null
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
  v_parts  jsonb;
  pt       jsonb;
  v_pname  text;
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
    v_parts := null;
    if p_depth = 0 and p_swap is not null then
      select s.value -> 'parts' into v_parts
      from jsonb_array_elements(p_swap) s
      where (s.value ->> 'item_id')::uuid = r.item_id limit 1;
    end if;
    if v_parts is null then
      v_parts := jsonb_build_array(jsonb_build_object('item_id', r.item_id, 'qty', r.qty * (1 + r.waste_pct)));
    end if;
    for pt in select value from jsonb_array_elements(v_parts) loop
      v_need := round(p_qty * (pt ->> 'qty')::numeric, 4);
      select name into v_pname from public.items where id = (pt ->> 'item_id')::uuid;
      select h.unit_cost_base into v_cost from public.item_price_history h
      where h.item_id = (pt ->> 'item_id')::uuid and h.valid_from <= p_on
      order by h.valid_from desc, h.created_at desc limit 1;
      if v_cost is null then
        raise exception 'Falta el precio de compra de "%". Regístralo en Insumos o en una compra.', v_pname;
      end if;
      insert into public.stock_movements (item_id, qty_base, unit_cost, kind, moved_on, ref_id, note)
      values ((pt ->> 'item_id')::uuid, -v_need, v_cost, 'production_use', p_on, p_run_id, 'Producción de ' || v_name);
      v_mat := v_mat + round(v_need * v_cost, 4);
    end loop;
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
  p_override jsonb default null,
  p_swap jsonb default null,
  p_variant text default null
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
  sw      jsonb;
  sp      jsonb;
  v_k     text;
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

  if p_swap is not null then
    if jsonb_typeof(p_swap) <> 'array' then raise exception 'Los colores usados deben ser una lista.'; end if;
    for sw in select value from jsonb_array_elements(p_swap) loop
      if not exists (
        select 1 from public.product_components c
        where c.item_id = (sw ->> 'item_id')::uuid
          and c.version_id = (select id from public.product_versions
                              where product_id = p_product_id and valid_from <= p_date
                              order by valid_from desc, version_no desc limit 1)
      ) then raise exception 'Ese material no está en la receta de este producto.'; end if;
      if jsonb_typeof(sw -> 'parts') <> 'array' or jsonb_array_length(sw -> 'parts') = 0 then
        raise exception 'Indica qué colores usaste.';
      end if;
      for sp in select value from jsonb_array_elements(sw -> 'parts') loop
        select kind into v_k from public.items where id = (sp ->> 'item_id')::uuid and is_active;
        if not found then raise exception 'Uno de los colores no existe o está desactivado.'; end if;
        if v_k <> 'material' then raise exception 'Solo puedes usar materiales (no estambre de venta ni empaques).'; end if;
        if coalesce((sp ->> 'qty')::numeric, 0) <= 0 then raise exception 'Las cantidades de cada color deben ser mayores a 0.'; end if;
      end loop;
    end loop;
  end if;

  v_id := gen_random_uuid();
  v_res := public.consume_product_recipe(p_product_id, p_qty, v_id, p_date, 0, p_override, p_swap);
  v_total := round((v_res ->> 'materials')::numeric + (v_res ->> 'labor')::numeric, 4);
  v_est := (public.product_cost(p_product_id, p_date) ->> 'total')::numeric;

  select id into v_ver from public.product_versions
  where product_id = p_product_id and valid_from <= p_date
  order by valid_from desc, version_no desc limit 1;

  insert into public.production_runs (id, product_id, version_id, qty, run_date, labor_hours, labor_cost,
      materials_cost, total_cost, unit_cost, estimated_unit_cost, note, client_uuid, variant)
  values (v_id, p_product_id, v_ver, p_qty, p_date, (v_res ->> 'hours')::numeric, (v_res ->> 'labor')::numeric,
      (v_res ->> 'materials')::numeric, v_total, round(v_total / p_qty, 4), coalesce(v_est, 0), p_note, p_client_uuid, nullif(btrim(p_variant), ''));

  insert into public.product_stock_movements (product_id, qty, unit_cost, kind, moved_on, ref_id, note)
  values (p_product_id, p_qty, round(v_total / p_qty, 4), 'production', p_date, v_id, p_note);
  return v_id;
end;
$$;

revoke all on function public.produce_product(uuid, numeric, date, text, uuid, jsonb, jsonb, text) from public, anon;
revoke all on function public.consume_product_recipe(uuid, numeric, uuid, date, int, jsonb, jsonb) from public, anon;
grant execute on function public.produce_product(uuid, numeric, date, text, uuid, jsonb, jsonb, text) to authenticated;
grant execute on function public.consume_product_recipe(uuid, numeric, uuid, date, int, jsonb, jsonb) to authenticated;
