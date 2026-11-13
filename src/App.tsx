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

type Tab = 'items' | 'prices' | 'products' | 'purchases' | 'inventory' | 'production' | 'events' | 'pos' | 'orders' | 'catalogs' | 'settings'

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
  const [tab, setTab] = useState<Tab>(navigator.onLine ? 'items' : 'pos')
  const isOwner = profile.role === 'owner'

  return (
    <div className="shell">
      <header className="topbar">
        <strong className="brand">Amigurumis</strong>
        <nav>
          <button className={tab === 'pos' ? 'tab active' : 'tab'} onClick={() => setTab('pos')}>
            Vender
          </button>
          <button className={tab === 'items' ? 'tab active' : 'tab'} onClick={() => setTab('items')}>
            Insumos
          </button>
          <button className={tab === 'prices' ? 'tab active' : 'tab'} onClick={() => setTab('prices')}>
            Precios de venta
          </button>
          <button className={tab === 'products' ? 'tab active' : 'tab'} onClick={() => setTab('products')}>
            Productos
          </button>
          <button className={tab === 'purchases' ? 'tab active' : 'tab'} onClick={() => setTab('purchases')}>
            Compras
          </button>
          <button className={tab === 'inventory' ? 'tab active' : 'tab'} onClick={() => setTab('inventory')}>
            Inventario
          </button>
          <button className={tab === 'orders' ? 'tab active' : 'tab'} onClick={() => setTab('orders')}>
            Pedidos
          </button>
          <button className={tab === 'events' ? 'tab active' : 'tab'} onClick={() => setTab('events')}>
            Bazares
          </button>
          <button className={tab === 'production' ? 'tab active' : 'tab'} onClick={() => setTab('production')}>
            Producción
          </button>
          <button className={tab === 'catalogs' ? 'tab active' : 'tab'} onClick={() => setTab('catalogs')}>
            Proveedores y categorías
          </button>
          <button className={tab === 'settings' ? 'tab active' : 'tab'} onClick={() => setTab('settings')}>
            Configuración
          </button>
        </nav>
        <span className="spacer" />
        <span className="muted small">{email}</span>
        <button
          onClick={() => {
            localStorage.removeItem(LOGIN_KEY)
            supabase.auth.signOut()
          }}
        >
          Salir
        </button>
      </header>
      <main className="content">
        {tab === 'pos' && <Pos />}
        {tab === 'items' && <Items />}
        {tab === 'prices' && <PriceGroups isOwner={isOwner} />}
        {tab === 'products' && <Products isOwner={isOwner} />}
        {tab === 'purchases' && <Purchases isOwner={isOwner} />}
        {tab === 'inventory' && <Inventory />}
        {tab === 'production' && <Production />}
        {tab === 'events' && <Events />}
        {tab === 'orders' && <Orders />}
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
