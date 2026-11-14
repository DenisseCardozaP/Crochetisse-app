-- =====================================================================
-- 0013: al registrar una compra eliges, por renglón, si cambia el precio de referencia.
--   price_mode: 'keep' (se queda el precio anterior) | 'new' (usa el costo de esta compra)
--               | 'average' (promedio con lo que había; predeterminado si no se manda nada)
-- La compra siempre queda registrada con lo que realmente pagaste. Ejecutar UNA sola vez.
-- =====================================================================
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
  v_mode      text;
  v_new       numeric;
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

    -- Qué pasa con el precio de referencia del material (el que usan los costos):
    --   'keep'    = se queda el precio anterior (error, oferta o caso aislado; la compra real sí queda registrada)
    --   'new'     = pasa a ser el costo de esta compra (cambio de precio fijo)
    --   'average' = costo promedio con lo que ya había (comportamiento anterior; es el predeterminado)
    -- Si el material todavía no tiene precio, esta compra lo establece siempre.
    v_mode := coalesce(l ->> 'price_mode', 'average');
    if v_mode not in ('keep', 'new', 'average') then
      raise exception 'Modo de precio no válido: %.', v_mode;
    end if;
    if v_cur is null then
      v_new := v_unit;
    elsif v_mode = 'keep' then
      v_new := null;
    elsif v_mode = 'new' then
      v_new := v_unit;
    else
      v_new := v_avg;
    end if;

    if v_new is not null then
      insert into public.item_price_history (item_id, valid_from, purchase_price, supplier_id, source, note)
      values (it.id, coalesce(p_purchase_date, public.today_mx()),
              round(v_new * it.units_per_purchase, 4), p_supplier_id, 'purchase',
              case when v_cur is null then 'Primer precio (compra)'
                   when v_mode = 'new' then 'Precio actualizado con esta compra'
                   else 'Costo promedio ponderado tras compra' end);
    end if;
  end loop;

  return v_id;
end;
$$;

revoke all on function public.register_purchase(uuid, date, numeric, text, jsonb, uuid) from public, anon;
grant execute on function public.register_purchase(uuid, date, numeric, text, jsonb, uuid) to authenticated;
