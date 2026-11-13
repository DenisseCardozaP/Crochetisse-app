import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { supabase } from '../supabase'
import { friendlyError, money, todayMX } from '../format'
import { ErrorBox, Field, Modal, OkBox } from '../ui'

interface Expense {
  id: string
  expense_date: string
  category: string
  description: string | null
  amount: number
  event_id: string | null
  voided: boolean
}
interface EventRow {
  id: string
  name: string
  event_date: string
}

const CATEGORIES = ['Gasolina', 'Transporte', 'Publicidad', 'Exhibición', 'Comida', 'Otro']

function NewExpense(props: { events: EventRow[]; onSaved: () => void; onClose: () => void }) {
  const [date, setDate] = useState(todayMX())
  const [category, setCategory] = useState('Gasolina')
  const [other, setOther] = useState('')
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [eventId, setEventId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // Un identificador por captura: si se manda dos veces (doble clic, mala señal) no se duplica el gasto
  const [uuid] = useState(() => crypto.randomUUID())

  async function submit(e: FormEvent) {
    e.preventDefault()
    const cat = category === 'Otro' ? other.trim() : category
    if (!cat) return setError('Escribe la categoría.')
    if (!amount.trim() || Number(amount) <= 0) return setError('Escribe el monto.')
    setBusy(true)
    setError('')
    const { error } = await supabase.rpc('add_expense', {
      p_category: cat,
      p_amount: amount.trim(),
      p_description: description.trim() || null,
      p_date: date,
      p_event_id: eventId || null,
      p_client_uuid: uuid,
    })
    setBusy(false)
    if (error) return setError(friendlyError(error.message))
    props.onSaved()
  }

  return (
    <Modal title="Nuevo gasto" onClose={props.onClose}>
      <form onSubmit={submit}>
        <Field label="Fecha">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        <Field label="Categoría">
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        {category === 'Otro' && (
          <Field label="¿Cuál?">
            <input value={other} onChange={(e) => setOther(e.target.value)} />
          </Field>
        )}
        <Field label="Monto (MXN)">
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Descripción (opcional)">
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="¿De qué bazar? (opcional)" hint="Solo para saber cuánto te costó cada bazar; para las ganancias cuenta igual.">
          <select value={eventId} onChange={(e) => setEventId(e.target.value)}>
            <option value="">Ninguno</option>
            {props.events.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {ev.name} · {ev.event_date}
              </option>
            ))}
          </select>
        </Field>
        <ErrorBox message={error} />
        <div className="actions">
          <button type="button" onClick={props.onClose}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Guardando...' : 'Guardar gasto'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export default function Expenses() {
  const [rows, setRows] = useState<Expense[]>([])
  const [events, setEvents] = useState<EventRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setError('')
    const [x, v, e] = await Promise.all([
      supabase.from('expenses').select('id, expense_date, category, description, amount, event_id').order('expense_date', { ascending: false }).limit(300),
      supabase.from('expense_voids').select('expense_id'),
      supabase.from('events').select('id, name, event_date').order('event_date', { ascending: false }),
    ])
    if (x.error) return setError(friendlyError(x.error.message))
    const voided = new Set((v.data ?? []).map((r: { expense_id: string }) => r.expense_id))
    setRows((x.data ?? []).map((r: any) => ({ ...r, amount: Number(r.amount), voided: voided.has(r.id) })))
    setEvents((e.data ?? []) as EventRow[])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function voidExpense(r: Expense) {
    if (!confirm(`¿Anular el gasto de ${money(r.amount)} (${r.category})? Queda registrado como anulado y deja de contar.`)) return
    const { error } = await supabase.rpc('void_expense', { p_expense_id: r.id, p_reason: 'Anulado desde la pantalla de gastos' })
    if (error) return setError(friendlyError(error.message))
    setOk('Gasto anulado.')
    load()
  }

  const evName = new Map(events.map((e) => [e.id, e.name]))
  const total = rows.filter((r) => !r.voided).reduce((a, r) => a + r.amount, 0)

  return (
    <div>
      <div className="section-head">
        <h2>Gastos</h2>
        <button className="primary" onClick={() => setCreating(true)}>
          + Nuevo gasto
        </button>
      </div>
      <p className="muted small">
        Aquí van los gastos que no son material: gasolina, publicidad, exhibidores... (la mesa del bazar se captura en Bazares y también cuenta). Los materiales se registran en Compras.
      </p>
      <ErrorBox message={error} />
      <OkBox message={ok} />
      {loading ? (
        <p className="muted">Cargando...</p>
      ) : (
        <>
          <p className="muted small">Total de lo que se muestra (sin anulados): {money(total)}</p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Categoría</th>
                  <th>Descripción</th>
                  <th>Bazar</th>
                  <th>Monto</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} style={r.voided ? { opacity: 0.5, textDecoration: 'line-through' } : undefined}>
                    <td>{r.expense_date}</td>
                    <td>{r.category}</td>
                    <td>{r.description ?? ''}</td>
                    <td>{r.event_id ? evName.get(r.event_id) ?? '' : ''}</td>
                    <td>{money(r.amount)}</td>
                    <td>{r.voided ? <span className="pill">anulado</span> : <button onClick={() => voidExpense(r)}>Anular</button>}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted">
                      Todavía no hay gastos.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
      {creating && (
        <NewExpense
          events={events}
          onSaved={() => {
            setCreating(false)
            setOk('Gasto guardado.')
            load()
          }}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  )
}
