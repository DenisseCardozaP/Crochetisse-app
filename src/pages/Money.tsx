import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { supabase } from '../supabase'
import { friendlyError, money, todayMX } from '../format'
import { ErrorBox, Field, Modal, OkBox } from '../ui'

interface Position {
  opening_date: string | null
  opening: number
  sales_in: number
  orders_in: number
  contributions_in: number
  other_in: number
  collections_in: number
  purchases_out: number
  expenses_out: number
  tables_out: number
  withdrawals_out: number
  other_out: number
  balance: number
  orders_receivable: number
  receivables_open: number
  projected: number
  inventory_value: number
}
interface Movement {
  id: string
  moved_on: string
  kind: string
  amount: number
  debtor: string | null
  note: string | null
  voided: boolean
}
interface Receivable {
  id: string
  debtor: string
  concept: string | null
  amount: number
  owed_on: string
  due_date: string | null
  collected: number
  balance: number
  voided: boolean
}

const KIND: Record<string, string> = {
  opening: 'Saldo inicial',
  contribution: 'Aportación mía',
  other_in: 'Otro ingreso',
  other_out: 'Otro egreso',
  receivable_payment: 'Cobro de deuda',
}
const num = (o: any, keys: string[]) => {
  const r = { ...o }
  for (const k of keys) r[k] = Number(o[k])
  return r
}

type Form = 'opening' | 'movement' | 'receivable' | { collect: Receivable } | null

function FormModal(props: { form: NonNullable<Form>; onSaved: (msg: string) => void; onClose: () => void }) {
  const f = props.form
  const kindOf = typeof f === 'string' ? f : 'collect'
  const [amount, setAmount] = useState(typeof f === 'object' ? f.collect.balance.toFixed(2) : '')
  const [date, setDate] = useState(todayMX())
  const [mkind, setMkind] = useState('contribution')
  const [text, setText] = useState('')
  const [concept, setConcept] = useState('')
  const [due, setDue] = useState('')
  const [negative, setNegative] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [uuid] = useState(() => crypto.randomUUID())

  const titles: Record<string, string> = {
    opening: 'Saldo inicial del negocio',
    movement: 'Registrar movimiento de dinero',
    receivable: 'Nueva deuda a mi favor',
    collect: 'Registrar cobro',
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const n = Number(amount.replace(/[$,\s]/g, ''))
    if (!n || (kindOf !== 'opening' && n <= 0)) return setError('Escribe un monto válido.')
    if (kindOf === 'receivable' && !text.trim()) return setError('Escribe quién debe.')
    setBusy(true)
    setError('')
    let r
    if (kindOf === 'opening') {
      r = await supabase.rpc('set_opening_balance', { p_amount: negative ? -Math.abs(n) : Math.abs(n), p_date: date, p_note: text.trim() || null })
    } else if (kindOf === 'movement') {
      r = await supabase.rpc('add_money_movement', { p_kind: mkind, p_amount: n, p_date: date, p_note: text.trim() || null, p_client_uuid: uuid })
    } else if (kindOf === 'receivable') {
      r = await supabase.rpc('add_receivable', { p_debtor: text.trim(), p_amount: n, p_concept: concept.trim() || null, p_owed_on: date, p_due_date: due || null, p_client_uuid: uuid })
    } else {
      r = await supabase.rpc('collect_receivable', { p_receivable_id: (f as { collect: Receivable }).collect.id, p_amount: n, p_date: date, p_note: text.trim() || null, p_client_uuid: uuid })
    }
    setBusy(false)
    if (r.error) return setError(friendlyError(r.error.message))
    props.onSaved('Guardado.')
  }

  return (
    <Modal title={titles[kindOf]} onClose={props.onClose}>
      <form onSubmit={submit}>
        {kindOf === 'opening' && (
          <>
            <p className="muted small">
              Es lo que tiene el negocio HOY entre efectivo y banco. Si estás en números rojos (debes más de lo que tienes), marca la casilla: queda en negativo. A partir de esta fecha el sistema suma y resta todo lo que pase.
            </p>
            <label className="inline" style={{ marginBottom: 10 }}>
              <input type="checkbox" checked={negative} onChange={(e) => setNegative(e.target.checked)} /> Estoy en negativo (en rojos)
            </label>
          </>
        )}
        {kindOf === 'movement' && (
          <Field label="¿Qué fue?">
            <select value={mkind} onChange={(e) => setMkind(e.target.value)}>
              <option value="contribution">Aportación mía (puse dinero al negocio)</option>
              <option value="other_in">Otro ingreso</option>
              <option value="other_out">Otro egreso (sale dinero)</option>
            </select>
          </Field>
        )}
        {kindOf === 'receivable' && (
          <Field label="¿Quién me debe?">
            <input value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
        )}
        <Field label="Monto (MXN)">
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Fecha">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        {kindOf === 'receivable' && (
          <div className="grid2">
            <Field label="Concepto (opcional)">
              <input value={concept} onChange={(e) => setConcept(e.target.value)} />
            </Field>
            <Field label="Fecha en que prometió pagar (opcional)">
              <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </Field>
          </div>
        )}
        {kindOf !== 'receivable' && (
          <Field label="Nota (opcional)">
            <input value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
        )}
        <ErrorBox message={error} />
        <div className="actions">
          <button type="button" onClick={props.onClose}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Guardando...' : 'Guardar'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export default function Money() {
  const [pos, setPos] = useState<Position | null>(null)
  const [moves, setMoves] = useState<Movement[]>([])
  const [recs, setRecs] = useState<Receivable[]>([])
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')
  const [form, setForm] = useState<Form>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const [p, m, r] = await Promise.all([supabase.rpc('money_position', { p_to: todayMX() }), supabase.rpc('list_money_movements'), supabase.rpc('list_receivables')])
    const err = p.error ?? m.error ?? r.error
    if (err) {
      setLoading(false)
      return setError(friendlyError(err.message))
    }
    const p0: any = (p.data ?? [])[0]
    setPos(
      p0
        ? num(p0, ['opening', 'sales_in', 'orders_in', 'contributions_in', 'other_in', 'collections_in', 'purchases_out', 'expenses_out', 'tables_out', 'withdrawals_out', 'other_out', 'balance', 'orders_receivable', 'receivables_open', 'projected', 'inventory_value'])
        : null,
    )
    setMoves((m.data ?? []).map((x: any) => num(x, ['amount'])))
    setRecs((r.data ?? []).map((x: any) => num(x, ['amount', 'collected', 'balance'])))
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function voidMove(m: Movement) {
    if (!confirm(`¿Anular "${KIND[m.kind]}" de ${money(Math.abs(m.amount))}?`)) return
    const { error } = await supabase.rpc('void_money_movement', { p_id: m.id, p_reason: 'Anulado desde la pantalla de dinero' })
    if (error) return setError(friendlyError(error.message))
    setOk('Movimiento anulado.')
    load()
  }
  async function voidRec(r: Receivable) {
    if (!confirm(`¿Anular la deuda de ${r.debtor} por ${money(r.amount)}?`)) return
    const { error } = await supabase.rpc('void_receivable', { p_id: r.id, p_reason: 'Anulada desde la pantalla de dinero' })
    if (error) return setError(friendlyError(error.message))
    setOk('Deuda anulada.')
    load()
  }

  const hasOpening = !!pos?.opening_date
  const line = (label: string, v: number, sign: '+' | '−') => (
    <tr key={label}>
      <td>{label}</td>
      <td style={{ textAlign: 'right' }}>
        {sign} {money(v)}
      </td>
    </tr>
  )

  return (
    <div>
      <div className="section-head">
        <h2>Dinero del negocio</h2>
        {hasOpening && (
          <button className="primary" onClick={() => setForm('movement')}>
            + Movimiento
          </button>
        )}
      </div>
      <ErrorBox message={error} />
      <OkBox message={ok} />
      {loading ? (
        <p className="muted">Cargando...</p>
      ) : !hasOpening ? (
        <div className="panel-card">
          <h3>Empieza con el saldo inicial</h3>
          <p>
            Para saber cuánto dinero tiene el negocio, dime con cuánto empiezas hoy entre efectivo y banco (puede ser negativo si estás en rojos). Desde esa fecha el sistema suma las ventas, cobros de pedidos y aportaciones, y resta compras, gastos, mesas y retiros.
          </p>
          <button className="primary" onClick={() => setForm('opening')}>
            Capturar saldo inicial
          </button>
        </div>
      ) : (
        pos && (
          <>
            <div className="stat-grid">
              <div className="stat">
                <div className="k">Dinero en el negocio hoy</div>
                <div className="n">{money(pos.balance)}</div>
                <div className="s">Desde el {pos.opening_date}</div>
              </div>
              <div className="stat">
                <div className="k">Por cobrar</div>
                <div className="n">{money(pos.orders_receivable + pos.receivables_open)}</div>
                <div className="s">Pedidos {money(pos.orders_receivable)} · deudas {money(pos.receivables_open)}</div>
              </div>
              <div className="stat">
                <div className="k">Dinero + por cobrar</div>
                <div className="n">{money(pos.projected)}</div>
                <div className="s">Si todo se cobra</div>
              </div>
            </div>
            <p className="muted small">En inventario tienes además {money(pos.inventory_value)} entre materiales y productos terminados (a costo). No cuenta como dinero hasta que se venda.</p>

            <h3>De dónde sale ese número</h3>
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {line(`Saldo inicial (${pos.opening_date})`, pos.opening, pos.opening < 0 ? '−' : '+')}
                  {line('Ventas de bazar y directas (netas de comisión)', pos.sales_in, '+')}
                  {line('Cobros de pedidos (anticipos y pagos)', pos.orders_in, '+')}
                  {line('Aportaciones mías', pos.contributions_in, '+')}
                  {line('Cobros de deudas', pos.collections_in, '+')}
                  {line('Otros ingresos', pos.other_in, '+')}
                  {line('Compras de insumos', pos.purchases_out, '−')}
                  {line('Gastos', pos.expenses_out, '−')}
                  {line('Mesas de bazar', pos.tables_out, '−')}
                  {line('Retiros (mi nómina)', pos.withdrawals_out, '−')}
                  {line('Otros egresos', pos.other_out, '−')}
                  <tr>
                    <td>
                      <b>Dinero en el negocio</b>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <b>{money(pos.balance)}</b>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="hint">Las ventas con tarjeta se cuentan el día de la venta. Lo anterior a la fecha del saldo inicial no se toma en cuenta: ya está dentro del saldo con el que empezaste.</p>
          </>
        )
      )}

      {!loading && (
        <>
          <div className="section-head">
            <h2 style={{ fontSize: 22 }}>Me deben</h2>
            <button onClick={() => setForm('receivable')}>+ Nueva deuda</button>
          </div>
          <p className="muted small">Para dinero que te deben fuera de los pedidos (los saldos de pedidos ya se ven solos en Pedidos).</p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Quién</th>
                  <th>Concepto</th>
                  <th>Desde</th>
                  <th>Debe</th>
                  <th>Cobrado</th>
                  <th>Falta</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {recs.map((r) => (
                  <tr key={r.id} style={r.voided ? { opacity: 0.5, textDecoration: 'line-through' } : undefined}>
                    <td>{r.debtor}</td>
                    <td>{r.concept ?? ''}{r.due_date ? <span className="muted small"> · prometió {r.due_date}</span> : null}</td>
                    <td>{r.owed_on}</td>
                    <td>{money(r.amount)}</td>
                    <td>{money(r.collected)}</td>
                    <td>
                      <b>{money(r.balance)}</b>
                    </td>
                    <td>
                      {r.voided ? (
                        <span className="pill">anulada</span>
                      ) : (
                        <div className="row-actions">
                          {r.balance > 0 && hasOpening && <button onClick={() => setForm({ collect: r })}>Registrar cobro</button>}
                          <button onClick={() => voidRec(r)}>Anular</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {recs.length === 0 && (
                  <tr>
                    <td colSpan={7} className="muted">
                      Nadie te debe (por ahora).
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="section-head">
            <h2 style={{ fontSize: 22 }}>Movimientos de dinero</h2>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Tipo</th>
                  <th>Detalle</th>
                  <th>Monto</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {moves.map((m) => (
                  <tr key={m.id} style={m.voided ? { opacity: 0.5, textDecoration: 'line-through' } : undefined}>
                    <td>{m.moved_on}</td>
                    <td>{KIND[m.kind] ?? m.kind}</td>
                    <td>{[m.debtor, m.note].filter(Boolean).join(' · ')}</td>
                    <td>{m.amount < 0 ? '−' : ''}{money(Math.abs(m.amount))}</td>
                    <td>{m.voided ? <span className="pill">anulado</span> : <button onClick={() => voidMove(m)}>Anular</button>}</td>
                  </tr>
                ))}
                {moves.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted">
                      Sin movimientos todavía.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
      {form && (
        <FormModal
          form={form}
          onSaved={(m) => {
            setForm(null)
            setOk(m)
            load()
          }}
          onClose={() => setForm(null)}
        />
      )}
    </div>
  )
}
