-- =====================================================================
-- Etapa 8: respaldo completo descargable (solo la dueña). Solo lee datos.
-- Ejecutar UNA sola vez.
-- Devuelve todas las tablas del sistema (incluye retiros y bitácora) en un solo archivo JSON.
-- Si en el futuro se crean tablas nuevas, entran solas al respaldo.
-- =====================================================================
create or replace function public.export_backup()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare r record; v_data jsonb := '{}'; v_count jsonb := '{}'; d jsonb;
begin
  if not public.is_owner() then raise exception 'Solo la dueña puede descargar el respaldo.'; end if;
  for r in
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name
  loop
    execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from public.%I t', r.table_name) into d;
    v_data := v_data || jsonb_build_object(r.table_name, d);
    v_count := v_count || jsonb_build_object(r.table_name, jsonb_array_length(d));
  end loop;
  return jsonb_build_object('app', 'amigurumis', 'exported_at', now(), 'today', public.today_mx(),
                            'counts', v_count, 'tables', v_data);
end;
$$;

revoke all on function public.export_backup() from public, anon;
grant execute on function public.export_backup() to authenticated;
