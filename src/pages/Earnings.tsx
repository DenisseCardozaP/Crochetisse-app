import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { supabase } from '../supabase'
import { friendlyError, money, todayMX } from '../format'
import { ErrorBox, Field, Modal, OkBox } from '../ui'

type Grain = 'quincena' | 'month' | 'year'

interface Period {
  period_start: string
  period_end: string
  gross: number
  fees: number
  net_sales: number
  cogs: number
  labor: number
  materials: number
  expense_event: number
  expense_other: number
  shrink: number
  utility: number
  her_share: number
  business_share: number
  withdrawal_due: number
  withdrawn: number
  internal_margin: number
}
interface Balance {
  total_due: number
  total_withdrawn: number
  balance: number
}
interface Withdrawal {
  id: string
  taken_on: string
  amount: number
  note: string | null
  voided: boolean
}
interface Fact {
  fact_date: string
  kind: string
  label: string
  gross: number
  fees: number
  cogs: number
  labor: number
  expenses: number
  shrink: number
  internal_margin: number
}

const KIND: Record<string, string> = {
  sale: 'Venta',
  order: 'Pedido',
  table_cost: 'Mesa',
  expense: 'Gasto',
  shrink: 'Merma',
  yarn_transfer: 'Estambre a producción',
}
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']

function numify<T extends object>(o: T): T {
  const r: any = {}
  for (const [k, v] of Object.entries(o)) r[k] = typeof v === 'string' && v !== '' && !isNaN(Number(v)) && k !== 'period_start' && k !== 'period_end' && k !== 'fact_date' ? Number(v) : v
  return r
}

function label(p: Period, grain: Grain): string {
  const [y, m, d] = p.period_start.split('-').map(Number)
  if (grain === 'year') return String(y)
  if (grain === 'month') return `${MONTHS[m - 1]} ${y}`
  return `${d === 1 ? '1 – 15' : '16 – ' + p.period_end.slice(8)} de ${MONTHS[m - 1]} ${y}`
}

function Detail(props: { period: Period; grain: Grain; onClose: () => void }) {
  const [rows, setRows] = useState<Fact[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    supabase.rpc('earnings_detail', { p_from: props.period.period_start, p_to: props.period.period_end }).then(({ data, error }) => {
      if (error) return setError(friendlyError(error.message))
      setRows(((data ?? []) as Fact[]).map(numify))
    })
  }, [props.period])
  return (
    <Modal title={`Detalle: ${label(props.period, props.grain)}`} onClose={props.onClose}>
      <ErrorBox message={error} />
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Qué</th>
              <th>Entra</th>
              <th>Comisión</th>
              <th>Costo</th>
              <th>Gasto/merma</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{r.fact_date}</td>
                <td>
                  {KIND[r.kind] ?? r.kind} · {r.label}
                  {r.kind === 'yarn_transfer' && <span className="muted small"> (ganancia interna {money(r.internal_margin)}, informativa)</span>}
                </td>
                <td>{r.gross ? money(r.gross) : ''}</td>
                <td>{r.fees ? money(r.fees) : ''}</td>
                <td>{r.cogs ? money(r.cogs) : ''}</td>
                <td>{r.expenses + r.shrink ? money(r.expenses + r.shrink) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  )
}

function NewWithdrawal(props: { suggested: number; onSaved: () => void; onClose: () => void }) {
  const [amount, setAmount] = useState(props.suggested > 0 ? props.suggested.toFixed(2) : '')
  const [date, setDate] = useState(todayMX())
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [uuid] = useState(() => crypto.randomUUID())
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!amount.trim() || Number(amount) <= 0) return setError('Escribe el monto.')
    setBusy(true)
    setError('')
    const { error } = await supabase.rpc('record_withdrawal', { p_amount: amount.trim(), p_date: date, p_note: note.trim() || null, p_client_uuid: uuid })
    setBusy(false)
    if (error) return setError(friendlyError(error.message))
    props.onSaved()
  }
  return (
    <Modal title="Registrar retiro" onClose={props.onClose}>
      <form onSubmit={submit}>
        <p className="muted small">Se sugiere lo que tienes pendiente por retirar; puedes cambiarlo.</p>
        <Field label="Monto (MXN)">
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Fecha">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        <Field label="Nota (opcional)">
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <ErrorBox message={error} />
        <div className="actions">
          <button type="button" onClick={props.onClose}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Guardando...' : 'Registrar retiro'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export default function Earnings() {
  const [grain, setGrain] = useState<Grain>('quincena')
  const [year, setYear] = useState(Number(todayMX().slice(0, 4)))
  const [periods, setPeriods] = useState<Period[]>([])
  const [balance, setBalance] = useState<Balance | null>(null)
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')
  const [detail, setDetail] = useState<Period | null>(null)
  const [withdrawing, setWithdrawing] = useState(false)

  const load = useCallback(async () => {
    setError('')
    const [p, b, w] = await Promise.all([
      supabase.rpc('earnings_periods', { p_grain: grain, p_from: `${year}-01-01`, p_to: `${year}-12-31` }),
      supabase.rpc('withdrawal_balance', { p_to: todayMX() }),
      supabase.rpc('list_withdrawals', { p_from: `${year}-01-01`, p_to: `${year}-12-31` }),
    ])
    const err = p.error ?? b.error ?? w.error
    if (err) {
      setLoading(false)
      return setError(friendlyError(err.message))
    }
    setPeriods(((p.data ?? []) as Period[]).map(numify).reverse())
    const bal = ((b.data ?? []) as Balance[])[0]
    setBalance(bal ? numify(bal) : null)
    setWithdrawals(((w.data ?? []) as Withdrawal[]).map(numify))
    setLoading(false)
  }, [grain, year])

  useEffect(() => {
    load()
  }, [load])

  async function voidWithdrawal(w: Withdrawal) {
    if (!confirm(`¿Anular el retiro de ${money(w.amount)} del ${w.taken_on}?`)) return
    const { error } = await supabase.rpc('void_withdrawal', { p_withdrawal_id: w.id, p_reason: 'Anulado desde la pantalla de ganancias' })
    if (error) return setError(friendlyError(error.message))
    setOk('Retiro anulado.')
    load()
  }

  const tot = periods.reduce(
    (a, p) => ({
      net: a.net + p.net_sales,
      utility: a.utility + p.utility,
      due: a.due + p.withdrawal_due,
      wd: a.wd + p.withdrawn,
      labor: a.labor + p.labor,
      share: a.share + p.her_share,
    }),
    { net: 0, utility: 0, due: 0, wd: 0, labor: 0, share: 0 },
  )

  return (
    <div>
      <div className="section-head">
        <h2>Ganancias</h2>
        <button className="primary" onClick={() => setWithdrawing(true)}>
          Registrar retiro
        </button>
      </div>
      <p className="muted small">
        Solo cuenta lo concretado: ventas cobradas y pedidos entregados y pagados por completo (los anticipos no cuentan todavía). Tu retiro = tu mano de obra + tu parte de la utilidad.
      </p>
      <ErrorBox message={error} />
      <OkBox message={ok} />
      {balance && (
        <div className="table-wrap">
          <table className="table">
            <tbody>
              <tr>
                <td>Te corresponde en total (hasta hoy)</td>
                <td>{money(balance.total_due)}</td>
              </tr>
              <tr>
                <td>Ya retirado</td>
                <td>{money(balance.total_withdrawn)}</td>
              </tr>
              <tr>
                <td>
                  <b>Pendiente por retirar</b>
                </td>
                <td>
                  <b>{money(balance.balance)}</b>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <div className="filters">
        <select value={grain} onChange={(e) => setGrain(e.target.value as Grain)}>
          <option value="quincena">Por quincena</option>
          <option value="month">Por mes</option>
          <option value="year">Por año</option>
        </select>
        <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {Array.from({ length: 6 }, (_, i) => Number(todayMX().slice(0, 4)) + 1 - i).map((y) => (
            <option key={y}>{y}</option>
          ))}
        </select>
      </div>
      {loading ? (
        <p className="muted">Cargando...</p>
      ) : (
        <div className="table-wrap">
          <table className="table clickable">
            <thead>
              <tr>
                <th>Periodo</th>
                <th>Ventas netas</th>
                <th>Costo (incluye tu mano de obra)</th>
                <th>Gastos</th>
                <th>Mermas</th>
                <th>Utilidad</th>
                <th>Tu mano de obra</th>
                <th>Tu parte de la utilidad</th>
                <th>A retirar</th>
                <th>Retirado</th>
              </tr>
            </thead>
            <tbody>
              {periods.map((p) => (
                <tr key={p.period_start} onClick={() => setDetail(p)}>
                  <td>{label(p, grain)}</td>
                  <td>{money(p.net_sales)}</td>
                  <td>{money(p.cogs)}</td>
                  <td>{money(p.expense_event + p.expense_other)}</td>
                  <td>{money(p.shrink)}</td>
                  <td style={p.utility < 0 ? { color: '#b3261e' } : undefined}>{money(p.utility)}</td>
                  <td>{money(p.labor)}</td>
                  <td>{money(p.her_share)}</td>
                  <td>
                    <b>{money(p.withdrawal_due)}</b>
                  </td>
                  <td>{money(p.withdrawn)}</td>
                </tr>
              ))}
              {periods.length === 0 && (
                <tr>
                  <td colSpan={10} className="muted">
                    Sin movimientos en {year}.
                  </td>
                </tr>
              )}
              {periods.length > 1 && (
                <tr>
                  <td>
                    <b>Total {year}</b>
                  </td>
                  <td>{money(tot.net)}</td>
                  <td />
                  <td />
                  <td />
                  <td>{money(tot.utility)}</td>
                  <td>{money(tot.labor)}</td>
                  <td>{money(tot.share)}</td>
                  <td>
                    <b>{money(tot.due)}</b>
                  </td>
                  <td>{money(tot.wd)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">
        Toca un periodo para ver de dónde sale cada número. Si hay pérdida en una quincena, la absorbe el negocio: tu mano de obra se retira igual.
      </p>
      <h3>Retiros de {year}</h3>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Monto</th>
              <th>Nota</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {withdrawals.map((w) => (
              <tr key={w.id} style={w.voided ? { opacity: 0.5, textDecoration: 'line-through' } : undefined}>
                <td>{w.taken_on}</td>
                <td>{money(w.amount)}</td>
                <td>{w.note ?? ''}</td>
                <td>{w.voided ? <span className="pill">anulado</span> : <button onClick={() => voidWithdrawal(w)}>Anular</button>}</td>
              </tr>
            ))}
            {withdrawals.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  Sin retiros registrados.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {detail && <Detail period={detail} grain={grain} onClose={() => setDetail(null)} />}
      {withdrawing && (
        <NewWithdrawal
          suggested={balance?.balance ?? 0}
          onSaved={() => {
            setWithdrawing(false)
            setOk('Retiro registrado.')
            load()
          }}
          onClose={() => setWithdrawing(false)}
        />
      )}
    </div>
  )
}
