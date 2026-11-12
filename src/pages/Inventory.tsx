import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { supabase } from '../supabase'
import { friendlyError, money } from '../format'
import { ErrorBox, Field, Modal, OkBox } from '../ui'
import Decimal from 'decimal.js'

interface Row {
  id: string
  name: string
  brand: string | null
  color: string | null
  kind: 'material' | 'packaging' | 'resale'
  base_unit: string
  min_stock: number
  stock: number
  cost: number | null
}

const KIND: Record<string, string> = { material: 'Material', packaging: 'Empaque', resale: 'Para venta' }

function Adjust(props: { row: Row; onSaved: () => void; onClose: () => void }) {
  const [mode, setMode] = useState<'count' | 'delta'>('count')
  const [value, setValue] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    let delta: Decimal
    try {
      if (value.trim() === '') throw new Error('x')
      delta = mode === 'count' ? new Decimal(value).minus(props.row.stock) : new Decimal(value)
    } catch {
      return setError('Escribe un número.')
    }
    if (delta.isZero()) return setError('No hay diferencia: no hace falta ajustar.')
    if (!reason.trim()) return setError('Escribe el motivo (conteo físico, merma, regalo...).')
    setBusy(true)
    setError('')
    const { error } = await supabase.rpc('adjust_stock', {
      p_item_id: props.row.id,
      p_delta: delta.toString(),
      p_reason: reason.trim(),
    })
    setBusy(false)
    if (error) return setError(friendlyError(error.message))
    props.onSaved()
  }

  return (
    <Modal title={`Ajustar existencia: ${props.row.name}${props.row.color ? ' · ' + props.row.color : ''}`} onClose={props.onClose}>
      <p>
        Existencia actual: <b>{props.row.stock} {props.row.base_unit}</b>
      </p>
      <form onSubmit={submit}>
        <Field label="¿Cómo quieres capturarlo?">
          <select value={mode} onChange={(e) => setMode(e.target.value as 'count' | 'delta')}>
            <option value="count">Cuánto hay realmente (conteo)</option>
            <option value="delta">Cuánto sumar o restar</option>
          </select>
        </Field>
        <Field
          label={mode === 'count' ? `Cantidad real (${props.row.base_unit})` : `Diferencia (${props.row.base_unit}, negativa = salida)`}
        >
          <input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <Field label="Motivo">
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <ErrorBox message={error} />
        <div className="actions">
          <button type="button" onClick={props.onClose}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Guardando...' : 'Guardar ajuste'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export default function Inventory() {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState('')
  const [onlyLow, setOnlyLow] = useState(false)
  const [adjusting, setAdjusting] = useState<Row | null>(null)

  const load = useCallback(async () => {
    setError('')
    const [i, s, c] = await Promise.all([
      supabase.from('items').select('id, name, brand, color, kind, base_unit, min_stock').eq('is_active', true).order('name'),
      supabase.from('v_item_stock').select('item_id, stock_qty'),
      supabase.from('v_item_cost_current').select('item_id, unit_cost_base'),
    ])
    if (i.error) return setError(friendlyError(i.error.message))
    const stock = new Map((s.data ?? []).map((x: { item_id: string; stock_qty: number }) => [x.item_id, Number(x.stock_qty)]))
    const cost = new Map((c.data ?? []).map((x: { item_id: string; unit_cost_base: number }) => [x.item_id, Number(x.unit_cost_base)]))
    setRows(
      (i.data ?? []).map((x: any) => ({
        ...x,
        stock: stock.get(x.id) ?? 0,
        cost: cost.get(x.id) ?? null,
      })),
    )
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const shown = rows.filter((r) => {
    if (kind && r.kind !== kind) return false
    if (onlyLow && !(r.min_stock > 0 && r.stock <= r.min_stock)) return false
    const text = [r.name, r.brand, r.color].filter(Boolean).join(' ').toLowerCase()
    return !search || text.includes(search.toLowerCase())
  })
  const totalValue = shown.reduce((a, r) => (r.cost === null ? a : a.plus(new Decimal(r.stock).times(r.cost))), new Decimal(0))

  return (
    <div>
      <div className="section-head">
        <h2>Inventario</h2>
      </div>
      <div className="filters">
        <input placeholder="Buscar..." value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Todo</option>
          {Object.entries(KIND).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <label className="inline">
          <input type="checkbox" checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} /> Solo con poca existencia
        </label>
      </div>
      <ErrorBox message={error} />
      <OkBox message={ok} />
      {loading ? (
        <p className="muted">Cargando...</p>
      ) : (
        <>
          <p className="muted small">Valor de lo que se muestra, a costo promedio: {money(totalValue.toFixed(2))}</p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Material</th>
                  <th>Tipo</th>
                  <th>Existencia</th>
                  <th>Costo por unidad</th>
                  <th>Valor</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {[r.name, r.brand, r.color].filter(Boolean).join(' · ')}
                      {r.min_stock > 0 && r.stock <= r.min_stock && <span className="pill">poca</span>}
                    </td>
                    <td>{KIND[r.kind]}</td>
                    <td>
                      {r.stock} {r.base_unit}
                    </td>
                    <td>{r.cost === null ? 'sin precio' : money(r.cost, 4)}</td>
                    <td>{r.cost === null ? '—' : money(new Decimal(r.stock).times(r.cost).toFixed(2))}</td>
                    <td>
                      <button onClick={() => setAdjusting(r)}>Ajustar</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {adjusting && (
        <Adjust
          row={adjusting}
          onSaved={() => {
            setAdjusting(null)
            setOk('Ajuste guardado.')
            load()
          }}
          onClose={() => setAdjusting(null)}
        />
      )}
    </div>
  )
}
