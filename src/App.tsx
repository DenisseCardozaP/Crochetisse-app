import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { ErrorBox } from './ui'
import { friendlyError } from './format'
import Items from './pages/Items'
import Catalogs from './pages/Catalogs'
import Settings from './pages/Settings'
import PriceGroups from './pages/PriceGroups'
import Products from './pages/Products'
import Purchases from './pages/Purchases'
import Inventory from './pages/Inventory'
import Production from './pages/Production'
import Events from './pages/Events'
import Pos from './pages/Pos'
import Orders from './pages/Orders'
import Expenses from './pages/Expenses'
import Earnings from './pages/Earnings'
import Dashboard from './pages/Dashboard'
import WhatToBring from './pages/WhatToBring'

export interface Profile {
  role: 'owner' | 'collaborator'
  display_name: string | null
}

const LOGIN_KEY = 'amigurumis_login'

interface SavedLogin {
  id: string
  email: string
  profile: Profile
}

function readSavedLogin(): SavedLogin | null {
  try {
    const raw = localStorage.getItem(LOGIN_KEY)
    return raw ? (JSON.parse(raw) as SavedLogin) : null
  } catch {
    return null
  }
}

type Tab =
  | 'dashboard'
  | 'bring'
  | 'items'
  | 'prices'
  | 'products'
  | 'purchases'
  | 'inventory'
  | 'production'
  | 'events'
  | 'pos'
  | 'orders'
  | 'expenses'
  | 'earnings'
  | 'payroll'
  | 'catalogs'
  | 'settings'

function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setBusy(false)
    if (error) setError(friendlyError(error.message))
  }

  return (
    <div className="login">
      <h1>Amigurumis</h1>
      <p className="muted">Inicia sesión para administrar tu negocio.</p>
      <form onSubmit={submit}>
        <input
          type="email"
          placeholder="Correo"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="Contraseña"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button className="primary" disabled={busy}>
          {busy ? 'Entrando...' : 'Entrar'}
        </button>
        <ErrorBox message={error} />
      </form>
    </div>
  )
}

function Shell({ email, profile }: { email: string; profile: Profile }) {
  const [tab, setTab] = useState<Tab>(navigator.onLine ? 'dashboard' : 'pos')
  const [menu, setMenu] = useState(false)
  const isOwner = profile.role === 'owner'

  const groups: { title: string; items: { id: Tab; label: string; owner?: boolean }[] }[] = [
    { title: 'Hoy', items: [{ id: 'dashboard', label: 'Panel' }, { id: 'pos', label: 'Vender' }] },
    { title: 'Ventas', items: [{ id: 'orders', label: 'Pedidos' }, { id: 'events', label: 'Bazares' }, { id: 'bring', label: 'Qué llevar' }] },
    { title: 'Taller', items: [{ id: 'production', label: 'Producción' }, { id: 'products', label: 'Productos' }, { id: 'prices', label: 'Precios de venta' }] },
    { title: 'Almacén', items: [{ id: 'items', label: 'Insumos' }, { id: 'purchases', label: 'Compras' }, { id: 'inventory', label: 'Inventario' }, { id: 'catalogs', label: 'Proveedores y categorías' }] },
    {
      title: 'Dinero',
      items: [
        { id: 'expenses', label: 'Gastos' },
        { id: 'earnings', label: 'Finanzas del negocio', owner: true },
        { id: 'payroll', label: 'Mi nómina', owner: true },
      ],
    },
    { title: 'Sistema', items: [{ id: 'settings', label: 'Configuración' }] },
  ]
  const go = (t: Tab) => {
    setTab(t)
    setMenu(false)
  }

  return (
    <div className="shell">
      <div className="mobilebar">
        <button onClick={() => setMenu(true)} aria-label="Abrir menú">
          ☰
        </button>
        <span className="brand">Amigurumis</span>
      </div>
      <div className={menu ? 'scrim open' : 'scrim'} onClick={() => setMenu(false)} />
      <aside className={menu ? 'sidebar open' : 'sidebar'}>
        <div className="brand">Amigurumis</div>
        <div className="brand-sub">Hecho a mano</div>
        {groups.map((g) => {
          const items = g.items.filter((i) => !i.owner || isOwner)
          if (items.length === 0) return null
          return (
            <div key={g.title}>
              <div className="nav-group">{g.title}</div>
              {items.map((i) => (
                <button key={i.id} className={tab === i.id ? 'tab active' : 'tab'} onClick={() => go(i.id)}>
                  {i.label}
                </button>
              ))}
            </div>
          )
        })}
        <div className="side-foot">
          {email}
          <button
            onClick={() => {
              localStorage.removeItem(LOGIN_KEY)
              supabase.auth.signOut()
            }}
          >
            Salir
          </button>
        </div>
      </aside>
      <main className="content">
        {tab === 'dashboard' && <Dashboard isOwner={isOwner} onGo={go} />}
        {tab === 'bring' && <WhatToBring />}
        {tab === 'pos' && <Pos />}
        {tab === 'items' && <Items />}
        {tab === 'prices' && <PriceGroups isOwner={isOwner} />}
        {tab === 'products' && <Products isOwner={isOwner} />}
        {tab === 'purchases' && <Purchases isOwner={isOwner} />}
        {tab === 'inventory' && <Inventory />}
        {tab === 'production' && <Production />}
        {tab === 'events' && <Events />}
        {tab === 'orders' && <Orders />}
        {tab === 'expenses' && <Expenses />}
        {tab === 'earnings' && isOwner && <Earnings view="business" />}
        {tab === 'payroll' && isOwner && <Earnings view="payroll" />}
        {tab === 'catalogs' && <Catalogs />}
        {tab === 'settings' && <Settings isOwner={isOwner} />}
      </main>
    </div>
  )
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [profileError, setProfileError] = useState('')
  // Sin conexión la sesión puede no renovarse; si ya iniciaste sesión antes en este dispositivo, se sigue usando lo guardado.
  const [saved] = useState<SavedLogin | null>(() => readSavedLogin())

  useEffect(() => {
    supabase.auth
      .getSession()
      .then(({ data }) => {
        setSession(data.session)
        if (!data.session) setLoading(false)
      })
      .catch(() => setLoading(false))
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
      if (!s) {
        setProfile(null)
        setLoading(false)
      }
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  const userId = session?.user.id
  useEffect(() => {
    if (!userId) return
    let alive = true
    setLoading(true)
    supabase
      .from('profiles')
      .select('role, display_name')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!alive) return
        if (error) {
          if (saved && saved.id === userId) setProfile(saved.profile)
          else setProfileError(friendlyError(error.message))
        } else {
          const p = (data as Profile | null) ?? null
          setProfile(p)
          if (p && session) localStorage.setItem(LOGIN_KEY, JSON.stringify({ id: userId, email: session.user.email ?? '', profile: p }))
        }
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [userId])

  if (loading) return <p className="muted center">Cargando...</p>
  if (!session) {
    // Sin conexión y con sesión guardada: se puede vender con lo guardado en el dispositivo.
    if (saved && !navigator.onLine) return <Shell email={saved.email} profile={saved.profile} />
    return <Login />
  }
  if (!profile) {
    return (
      <div className="login">
        <h1>Sin acceso</h1>
        <p>Tu usuario todavía no tiene un perfil en el sistema.</p>
        <ErrorBox message={profileError} />
        <button onClick={() => supabase.auth.signOut()}>Salir</button>
      </div>
    )
  }
  return <Shell email={session.user.email ?? ''} profile={profile} />
}
