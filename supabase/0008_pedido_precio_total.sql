-- =====================================================================
-- Ajuste de pedidos: el precio se decide para el PEDIDO COMPLETO (no por pieza)
-- Requiere 0001 a 0007. Córrelo UNA sola vez.
--
--   * save_order ahora recibe el total del pedido. Para reportes, ese total se reparte entre los
--     renglones en proporción a su costo (el total del pedido es lo que manda).
--   * suggest_order_price te da un precio sugerido para el pedido a partir de su costo, con tu ganancia
--     configurada. Las ventas por transferencia/efectivo no llevan comisión de tarjeta; con
--     p_include_card = true se agrega (por si cobras con tarjeta).
-- =====================================================================
begin;

-- Precio sugerido a partir de un costo (misma fórmula que el precio sugerido de un producto)
create or replace function public.suggest_price_for_cost(
  p_cost numeric, p_on date default public.today_mx(), p_include_card boolean default false
) returns jsonb
language plpgsql stable set search_path = public
as $$
declare
  s          public.business_settings%rowtype;
  v_iva      numeric;
  v_iva_fee  numeric;
  v_card     record;
  v_c_eff    numeric := 0;
  v_isr_eff  numeric := 0;
  v_den      numeric;
  v_ex       numeric;
  v_gross    numeric;
  v_final    numeric;
begin
  select * into s from public.business_settings where effective_from <= p_on order by effective_from desc limit 1;
  if not found then raise exception 'No hay configuración del negocio vigente.'; end if;
  select coalesce(rate, 0) into v_iva from public.tax_rates where is_default limit 1;
  v_iva := coalesce(v_iva, 0);
  select coalesce(rate, 0.16) into v_iva_fee from public.tax_rates where code = 'IVA16';

  if p_include_card then
    select r.pct, r.vat_on_fee into v_card
    from public.payment_method_rates r join public.payment_methods m on m.id = r.payment_method_id
    where m.kind = 'card' and r.valid_from <= p_on order by r.valid_from desc, r.created_at desc limit 1;
    if found then v_c_eff := v_card.pct * (1 + case when v_card.vat_on_fee then v_iva_fee else 0 end); end if;
  end if;
  if s.isr_enabled then v_isr_eff := s.isr_pct / (1 + v_iva); end if;
  v_den := 1 - v_c_eff - v_isr_eff;
  if v_den <= 0 then raise exception 'La comisión y el ISR juntos no pueden llegar al 100%%.'; end if;

  if s.pricing_method = 'margin' then v_ex := p_cost / (1 - s.default_profit_pct);
  else v_ex := p_cost * (1 + s.default_profit_pct); end if;
  v_gross := v_ex * (1 + v_iva) / v_den;
  v_final := case s.rounding_mode
    when 'nearest' then round(v_gross / s.rounding_step) * s.rounding_step
    when 'up' then ceil(v_gross / s.rounding_step) * s.rounding_step
    else round(v_gross, 2) end;
  return jsonb_build_object('cost', p_cost, 'suggested_price', round(v_final, 2), 'method', s.pricing_method,
                            'profit_pct', s.default_profit_pct, 'iva_rate', v_iva);
end;
$$;

-- Sugerido para un conjunto de renglones (los mismos que se mandan a save_order)
create or replace function public.suggest_order_price(p_lines jsonb, p_include_card boolean default false)
returns jsonb
language plpgsql stable set search_path = public
as $$
declare v_cost numeric;
begin
  select coalesce(sum(x::numeric), 0) into v_cost from jsonb_array_elements_text(public.estimate_lines(p_lines)) x;
  return public.suggest_price_for_cost(v_cost, public.today_mx(), p_include_card);
end;
$$;

-- save_order con total del pedido (si no se da, se suman los precios de los renglones como antes)
drop function public.save_order(uuid, text, text, date, text, jsonb);

create or replace function public.save_order(
  p_order_id uuid, p_customer text, p_phone text, p_due date, p_notes text, p_lines jsonb, p_total numeric default null
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
  ln       public.order_lines%rowtype;
  v_ids    uuid[] := '{}';
  v_w      numeric[] := '{}';
  v_wsum   numeric := 0;
  v_wi     numeric;
  v_alloc  numeric;
  v_done   numeric := 0;
  i        int;
begin
  if not public.is_member() then raise exception 'No tienes permiso para hacer esto.'; end if;
  if p_customer is null or length(btrim(p_customer)) = 0 then raise exception 'Escribe el nombre del cliente.'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'El pedido necesita al menos un renglón.';
  end if;
  if p_total is not null and p_total < 0 then raise exception 'El precio del pedido no es válido.'; end if;

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
    v_price := coalesce((l ->> 'unit_price')::numeric, 0);
    if v_qty is null or v_qty <= 0 then raise exception 'Hay un renglón con cantidad no válida.'; end if;
    if v_price < 0 then raise exception 'Hay un renglón con precio no válido.'; end if;
    if p_total is null and l ->> 'unit_price' is null then raise exception 'Hay un renglón con precio no válido.'; end if;

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

  if p_total is not null then
    -- el total del pedido se reparte entre los renglones en proporción a su costo estimado
    for ln in select * from public.order_lines where order_id = v_id order by sort_no loop
      if ln.line_type = 'custom' then
        v_wi := ln.qty * ln.custom_unit_cost;
      else
        v_wi := public.estimate_line_cost(ln.product_id, ln.qty,
                  (select jsonb_agg(jsonb_build_object('component_product_id', c.component_product_id, 'qty', c.qty))
                   from public.order_line_components c where c.line_id = ln.id));
      end if;
      v_ids := v_ids || ln.id;
      v_w := v_w || coalesce(v_wi, 0);
      v_wsum := v_wsum + coalesce(v_wi, 0);
    end loop;
    if v_wsum = 0 then
      v_wsum := 0;
      i := 0;
      for ln in select * from public.order_lines where order_id = v_id order by sort_no loop
        i := i + 1; v_w[i] := ln.qty; v_wsum := v_wsum + ln.qty;
      end loop;
    end if;
    for i in 1 .. array_length(v_ids, 1) loop
      if i = array_length(v_ids, 1) then v_alloc := p_total - v_done;
      else v_alloc := round(p_total * v_w[i] / v_wsum, 2); end if;
      v_done := v_done + v_alloc;
      update public.order_lines set line_total = v_alloc, unit_price = round(v_alloc / qty, 2) where id = v_ids[i];
    end loop;
    v_total := p_total;
  end if;

  update public.orders set total = v_total where id = v_id;
  return v_id;
end;
$$;

revoke all on function public.suggest_price_for_cost(numeric, date, boolean) from public, anon;
revoke all on function public.suggest_order_price(jsonb, boolean) from public, anon;
revoke all on function public.save_order(uuid, text, text, date, text, jsonb, numeric) from public, anon;
grant execute on function public.suggest_price_for_cost(numeric, date, boolean) to authenticated;
grant execute on function public.suggest_order_price(jsonb, boolean) to authenticated;
grant execute on function public.save_order(uuid, text, text, date, text, jsonb, numeric) to authenticated;

commit;
