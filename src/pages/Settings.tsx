import { useCallback, useEffect, useState } from 'react'
import Decimal from 'decimal.js'
import type { FormEvent } from 'react'
import { supabase } from '../supabase'
import {
  fractionToPct,
  friendlyError,
  isNonNegativeNumber,
  isPositiveNumber,
  money,
  pct,
  pctToFraction,
  todayMX,
  displayDate,
} from '../format'
import { ErrorBox, Field, OkBox } from '../ui'

interface SettingsRow {
  id: string
  effective_from: string
  labor_rate_per_hour: number
  pricing_method: 'markup' | 'margin'
  default_profit_pct: number
  rounding_mode: 'none' | 'nearest' | 'up'
  rounding_step: number
  business_share_pct: number
  reserve_pct: number
  isr_enabled: boolean
  isr_pct: number
  yarn_costing_mode: 'purchase_cost' | 'sale_price'
  default_iva_rate: number
  note: string | null
}

interface MethodRate {
  payment_method_id: string
  name: string
  kind: string
  pct: number
  fixed_fee: number
  vat_on_fee: boolean
  passes_to_price: boolean
  valid_from: string
}

interface Method {
  id: string
  name: string
}

const METHOD_LABEL = { markup: 'Sobre el costo (markup)', margin: 'Sobre el precio (margen)' }
const ROUND_LABEL = { none: 'Sin redondeo', nearest: 'Al múltiplo más cercano', up: 'Hacia arriba' }
const YARN_LABEL = {
  sale_price: 'A su precio interno de venta',
  purchase_cost: 'A su costo de compra',
}

function SettingsForm(props: { current: SettingsRow | null; onSaved: () => void }) {
  const c = props.current
  const [from, setFrom] = useState(todayMX())
  const [labor, setLabor] = useState(c ? String(c.labor_rate_per_hour) : '')
  const [method, setMethod] = useState<'markup' | 'margin'>(c?.pricing_method ?? 'margin')
  const [profit, setProfit] = useState(c ? fractionToPct(c.default_profit_pct) : '')
  const [roundMode, setRoundMode] = useState<'none' | 'nearest' | 'up'>(c?.rounding_mode ?? 'none')
  const [roundStep, setRoundStep] = useState(c ? String(c.rounding_step) : '0.01')
  const [share, setShare] = useState(c ? fractionToPct(c.business_share_pct) : '50')
  const [reserve, setReserve] = useState(c ? fractionToPct(c.reserve_pct) : '0')
  const [isr, setIsr] = useState(c?.isr_enabled ?? false)
  const [isrPct, setIsrPct] = useState(c ? fractionToPct(c.isr_pct) : '0')
  const [yarn, setYarn] = useState<'purchase_cost' | 'sale_price'>(c?.yarn_costing_mode ?? 'sale_price')
  const [iva, setIva] = useState(c ? String(c.default_iva_rate ?? 0.16) : '0.16')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')
  const [busy, setBusy] = useState(false)

  const ownerShare = isNonNegativeNumber(share) ? new Decimal(100).minus(share).toString() : '—'

  async function submit(e: FormEvent) {
    e.preventDefault()
    setOk('')
    if (!isNonNegativeNumber(labor)) return setError('La tarifa por hora no es válida.')
    if (!isNonNegativeNumber(profit)) return setError('El porcentaje de ganancia no es válido.')
    if (method === 'margin' && Number(profit) >= 100) return setError('Con margen, el porcentaje debe ser menor a 100.')
    if (!isPositiveNumber(roundStep)) return setError('El múltiplo de redondeo debe ser mayor a 0.')
    if (!isNonNegativeNumber(share) || Number(share) > 100) return setError('El reparto del negocio debe estar entre 0 y 100.')
    if (!isNonNegativeNumber(reserve) || Number(reserve) > 100) return setError('La reserva debe estar entre 0 y 100.')
    if (isr && (!isNonNegativeNumber(isrPct) || Number(isrPct) >= 100)) return setError('El ISR no es válido.')

    setBusy(true)
    setError('')
    const { error } = await supabase.from('business_settings').insert({
      effective_from: from,
      labor_rate_per_hour: labor,
      pricing_method: method,
      default_profit_pct: pctToFraction(profit),
      rounding_mode: roundMode,
      rounding_step: roundStep,
      business_share_pct: pctToFraction(share),
      reserve_pct: pctToFraction(reserve),
      isr_enabled: isr,
      isr_pct: isr ? pctToFraction(isrPct) : '0',
      yarn_costing_mode: yarn,
      default_iva_rate: iva,
      note: note.trim() || null,
    })
    setBusy(false)
    if (error) return setError(friendlyError(error.message))
    setOk('Configuración guardada. Rige desde la fecha indicada y las anteriores se conservan.')
    setNote('')
    props.onSaved()
  }

  return (
    <form onSubmit={submit}>
      <p className="muted small">
        Cada cambio crea una configuración nueva con su fecha de inicio. Las anteriores no se modifican, así que tus
        ventas y costos pasados no cambian.
      </p>
      <div className="grid3">
        <Field label="Rige desde">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Tarifa por hora (MXN)">
          <input inputMode="decimal" value={labor} onChange={(e) => setLabor(e.target.value)} />
        </Field>
        <Field label="Ganancia (%)">
          <input inputMode="decimal" value={profit} onChange={(e) => setProfit(e.target.value)} />
        </Field>
      </div>
      <div className="grid3">
        <Field label="La ganancia se calcula">
          <select value={method} onChange={(e) => setMethod(e.target.value as 'markup' | 'margin')}>
            <option value="margin">{METHOD_LABEL.margin}</option>
            <option value="markup">{METHOD_LABEL.markup}</option>
          </select>
        </Field>
        <Field label="Redondeo de precios">
          <select value={roundMode} onChange={(e) => setRoundMode(e.target.value as 'none' | 'nearest' | 'up')}>
            {(Object.keys(ROUND_LABEL) as (keyof typeof ROUND_LABEL)[]).map((k) => (
              <option key={k} value={k}>
                {ROUND_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Múltiplo de redondeo (MXN)" hint="Ejemplo: 5 para redondear a $5">
          <input inputMode="decimal" value={roundStep} onChange={(e) => setRoundStep(e.target.value)} />
        </Field>
      </div>
      <div className="grid3">
        <Field label="Utilidad para el negocio (%)" hint={`Para ti: ${ownerShare}%`}>
          <input inputMode="decimal" value={share} onChange={(e) => setShare(e.target.value)} />
        </Field>
        <Field label="Reserva de reinversión (%)" hint="Se aparta antes de repartir">
          <input inputMode="decimal" value={reserve} onChange={(e) => setReserve(e.target.value)} />
        </Field>
        <Field label="IVA en los precios de productos" hint="Se usa al calcular el precio sugerido (cada producto puede tener el suyo).">
          <select value={iva} onChange={(e) => setIva(e.target.value)}>
            <option value="0.16">Con IVA 16%</option>
            <option value="0">Sin IVA (0%)</option>
          </select>
        </Field>
        <Field label="Estambre que pasa a producción">
          <select value={yarn} onChange={(e) => setYarn(e.target.value as 'purchase_cost' | 'sale_price')}>
            <option value="sale_price">{YARN_LABEL.sale_price}</option>
            <option value="purchase_cost">{YARN_LABEL.purchase_cost}</option>
          </select>
        </Field>
      </div>
      <div className="grid3">
        <label className="inline top-pad">
          <input type="checkbox" checked={isr} onChange={(e) => setIsr(e.target.checked)} />
          Descontar ISR
        </label>
        {isr && (
          <Field label="ISR (%)">
            <input inputMode="decimal" value={isrPct} onChange={(e) => setIsrPct(e.target.value)} />
          </Field>
        )}
      </div>
      <Field label="Nota (opcional)">
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Por qué cambió" />
      </Field>
      <ErrorBox message={error} />
      <OkBox message={ok} />
      <div className="actions left">
        <button className="primary" disabled={busy}>
          {busy ? 'Guardando...' : 'Guardar configuración nueva'}
        </button>
      </div>
    </form>
  )
}

function RateForm(props: { methods: Method[]; onSaved: () => void }) {
  const [methodId, setMethodId] = useState(props.methods[0]?.id ?? '')
  const [from, setFrom] = useState(todayMX())
  const [rate, setRate] = useState('0')
  const [fee, setFee] = useState('0')
  const [vat, setVat] = useState(false)
  const [passes, setPasses] = useState(false)
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!methodId && props.methods[0]) setMethodId(props.methods[0].id)
  }, [props.methods, methodId])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setOk('')
    if (!methodId) return setError('Elige un método de pago.')
    if (!isNonNegativeNumber(rate) || Number(rate) >= 100) return setError('El porcentaje no es válido.')
    if (!isNonNegativeNumber(fee)) return setError('La cuota fija no es válida.')
    setBusy(true)
    setError('')
    const { error } = await supabase.from('payment_method_rates').insert({
      payment_method_id: methodId,
      valid_from: from,
      pct: pctToFraction(rate),
      fixed_fee: fee,
      vat_on_fee: vat,
      passes_to_price: passes,
    })
    setBusy(false)
    if (error) return setError(friendlyError(error.message))
    setOk('Comisión guardada.')
    props.onSaved()
  }

  return (
    <form onSubmit={submit}>
      <h3>Registrar un cambio de comisión</h3>
      <div className="grid3">
        <Field label="Método de pago">
          <select value={methodId} onChange={(e) => setMethodId(e.target.value)}>
            {props.methods.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Rige desde">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <span />
        <Field label="Comisión (%)">
          <input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
        </Field>
        <Field label="Cuota fija por venta (MXN)">
          <input inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} />
        </Field>
        <span />
      </div>
      <div className="checks">
        <label className="inline">
          <input type="checkbox" checked={vat} onChange={(e) => setVat(e.target.checked)} />
          Se suma IVA sobre la comisión
        </label>
        <label className="inline">
          <input type="checkbox" checked={passes} onChange={(e) => setPasses(e.target.checked)} />
          Se traslada al precio
        </label>
      </div>
      <ErrorBox message={error} />
      <OkBox message={ok} />
      <div className="actions left">
        <button className="primary" disabled={busy}>
          {busy ? 'Guardando...' : 'Guardar comisión'}
        </button>
      </div>
    </form>
  )
}

export default function Settings({ isOwner }: { isOwner: boolean }) {
  const [current, setCurrent] = useState<SettingsRow | null>(null)
  const [history, setHistory] = useState<SettingsRow[]>([])
  const [rates, setRates] = useState<MethodRate[]>([])
  const [methods, setMethods] = useState<Method[]>([])
  const [error, setError] = useState('')
  const [formKey, setFormKey] = useState(0)

  const load = useCallback(async () => {
    const [cur, hist, rt, mt] = await Promise.all([
      supabase.from('v_current_settings').select('*').maybeSingle(),
      supabase.from('business_settings').select('*').order('effective_from', { ascending: false }),
      supabase
        .from('v_payment_method_current_rate')
        .select('payment_method_id, pct, fixed_fee, vat_on_fee, passes_to_price, valid_from'),
      supabase.from('payment_methods').select('id, name, kind').eq('is_active', true).order('sort_order'),
    ])
    const err = cur.error ?? hist.error ?? rt.error ?? mt.error
    if (err) return setError(friendlyError(err.message))
    setError('')
    setCurrent((cur.data as SettingsRow | null) ?? null)
    setHistory((hist.data as SettingsRow[]) ?? [])
    const ms = (mt.data as (Method & { kind: string })[]) ?? []
    setMethods(ms)
    const rows = ((rt.data as Omit<MethodRate, 'name' | 'kind'>[]) ?? []).map((r) => {
      const m = ms.find((x) => x.id === r.payment_method_id)
      return { ...r, name: m?.name ?? '—', kind: m?.kind ?? '' }
    })
    setRates(rows)
    setFormKey((k) => k + 1)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div>
      <ErrorBox message={error} />
      <h2>Configuración vigente</h2>
      {current ? (
        <ul className="kv">
          <li>
            <span>Tarifa por hora</span>
            <strong>{money(current.labor_rate_per_hour)}</strong>
          </li>
          <li>
            <span>Ganancia</span>
            <strong>
              {pct(current.default_profit_pct)} {current.pricing_method === 'margin' ? 'sobre el precio (margen)' : 'sobre el costo (markup)'}
            </strong>
          </li>
          <li>
            <span>Reparto de utilidad</span>
            <strong>
              Negocio {pct(current.business_share_pct)} · Tú {pct(new Decimal(1).minus(String(current.business_share_pct)).toString())}
            </strong>
          </li>
          <li>
            <span>Reserva de reinversión</span>
            <strong>{pct(current.reserve_pct)}</strong>
          </li>
          <li>
            <span>ISR</span>
            <strong>{current.isr_enabled ? pct(current.isr_pct) : 'No se descuenta'}</strong>
          </li>
          <li>
            <span>Redondeo</span>
            <strong>
              {ROUND_LABEL[current.rounding_mode]}
              {current.rounding_mode !== 'none' ? ` (${money(current.rounding_step)})` : ''}
            </strong>
          </li>
          <li>
            <span>Estambre que pasa a producción</span>
            <strong>{YARN_LABEL[current.yarn_costing_mode]}</strong>
          </li>
          <li>
            <span>IVA en precios de productos</span>
            <strong>{pct(current.default_iva_rate ?? 0.16)}</strong>
          </li>
          <li>
            <span>Rige desde</span>
            <strong>{displayDate(current.effective_from)}</strong>
          </li>
        </ul>
      ) : (
        <p className="muted">No hay configuración vigente.</p>
      )}

      <h2>Comisiones por método de pago</h2>
      <table className="table">
        <thead>
          <tr>
            <th>Método</th>
            <th>Comisión</th>
            <th>Cuota fija</th>
            <th>IVA sobre comisión</th>
            <th>Se traslada al precio</th>
            <th>Desde</th>
          </tr>
        </thead>
        <tbody>
          {rates.map((r) => (
            <tr key={r.payment_method_id}>
              <td>{r.name}</td>
              <td>{pct(r.pct)}</td>
              <td>{money(r.fixed_fee)}</td>
              <td>{r.vat_on_fee ? 'Sí' : 'No'}</td>
              <td>{r.passes_to_price ? 'Sí' : 'No'}</td>
              <td>{displayDate(r.valid_from)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {isOwner ? (
        <>
          <h2>Cambiar configuración</h2>
          <SettingsForm key={formKey} current={current} onSaved={load} />
          <RateForm key={'r' + formKey} methods={methods} onSaved={load} />
        </>
      ) : (
        <p className="muted">Solo la dueña puede cambiar la configuración.</p>
      )}

      <h2>Historial de configuraciones</h2>
      <table className="table">
        <thead>
          <tr>
            <th>Desde</th>
            <th>Tarifa/h</th>
            <th>Ganancia</th>
            <th>Negocio</th>
            <th>Nota</th>
          </tr>
        </thead>
        <tbody>
          {history.map((h) => (
            <tr key={h.id}>
              <td>{displayDate(h.effective_from)}</td>
              <td>{money(h.labor_rate_per_hour)}</td>
              <td>
                {pct(h.default_profit_pct)} {h.pricing_method === 'margin' ? 'margen' : 'markup'}
              </td>
              <td>{pct(h.business_share_pct)}</td>
              <td>{h.note ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
