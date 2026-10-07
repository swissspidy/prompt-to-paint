import { useState } from 'react'

const COLUMNS = [
  { id: 'todo', title: 'Todo', dot: '#94a3b8' },
  { id: 'progress', title: 'In Progress', dot: '#3b82f6' },
  { id: 'done', title: 'Done', dot: '#22c55e' },
  { id: 'blocked', title: 'Blocked', dot: '#ef4444' },
]

const SEED = [
  { id: 1, title: 'Design onboarding flow', assignee: 'Maya Chen', priority: 'High', status: 'todo' },
  { id: 2, title: 'Write API documentation', assignee: 'Liam Patel', priority: 'Low', status: 'todo' },
  { id: 3, title: 'Implement OAuth login', assignee: 'Sofia Reyes', priority: 'High', status: 'progress' },
  { id: 4, title: 'Refactor dashboard charts', assignee: 'Noah Kim', priority: 'Medium', status: 'progress' },
  { id: 5, title: 'Set up CI pipeline', assignee: 'Ava Johnson', priority: 'Medium', status: 'done' },
  { id: 6, title: 'Fix mobile nav bug', assignee: 'Ethan Brooks', priority: 'Low', status: 'done' },
]

const PRIORITY = {
  High: { bg: '#fee2e2', fg: '#b91c1c' },
  Medium: { bg: '#fef3c7', fg: '#b45309' },
  Low: { bg: '#dcfce7', fg: '#15803d' },
}

const initials = (n) => n.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase()

const s = {
  page: { minHeight: '100vh', background: '#f6f7f9', fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif', color: '#0f172a', margin: 0 },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 32px', background: '#2563eb', color: '#fff' },
  brand: { display: 'flex', alignItems: 'center', gap: 12 },
  logo: { width: 36, height: 36, borderRadius: 10, background: 'rgba(255,255,255,.18)', display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 700 },
  h1: { margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em' },
  sub: { margin: 0, fontSize: 13, color: '#dbeafe' },
  btn: { background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 16px', fontSize: 14, fontWeight: 600, cursor: 'pointer', boxShadow: '0 1px 2px rgba(0,0,0,.08)' },
  board: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 20, padding: 32, maxWidth: 1440, margin: '0 auto' },
  col: { background: '#eef0f4', borderRadius: 12, padding: 14, minHeight: 300 },
  colHead: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px 12px', fontWeight: 600, fontSize: 14 },
  count: { marginLeft: 'auto', background: '#fff', color: '#64748b', borderRadius: 999, padding: '2px 8px', fontSize: 12, fontWeight: 600 },
  card: { background: '#fff', borderRadius: 10, padding: 14, marginBottom: 10, border: '1px solid #e5e7eb', boxShadow: '0 1px 2px rgba(15,23,42,.04)' },
  title: { margin: '0 0 12px', fontSize: 15, fontWeight: 600, lineHeight: 1.35 },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  who: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#475569' },
  avatar: { width: 24, height: 24, borderRadius: '50%', background: '#e0e7ff', color: '#4338ca', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700 },
  badge: { fontSize: 12, fontWeight: 600, borderRadius: 999, padding: '3px 10px' },
  input: { width: '100%', boxSizing: 'border-box', padding: '9px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, marginBottom: 10, fontFamily: 'inherit' },
}

export default function App() {
  const [tasks, setTasks] = useState(SEED)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ title: '', assignee: '', priority: 'Medium', status: 'todo' })

  const submit = (e) => {
    e.preventDefault()
    if (!form.title.trim()) return
    setTasks((t) => [...t, { ...form, title: form.title.trim(), assignee: form.assignee.trim() || 'Unassigned', id: Date.now() }])
    setForm({ title: '', assignee: '', priority: 'Medium', status: 'todo' })
    setOpen(false)
  }

  return (
    <div style={s.page}>
      <header style={s.header}>
        <div style={s.brand}>
          <div style={s.logo}>O</div>
          <div>
            <h1 style={s.h1}>Orbit</h1>
            <p style={s.sub}>Sprint 14</p>
          </div>
        </div>
        <button style={{ ...s.btn, background: '#fff', color: '#1d4ed8' }} onClick={() => setOpen(true)}>+ Add task</button>
      </header>

      <main style={s.board}>
        {COLUMNS.map((c) => {
          const list = tasks.filter((t) => t.status === c.id)
          return (
            <section key={c.id} style={s.col}>
              <div style={s.colHead}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.dot }} />
                {c.title}
                <span style={s.count}>{list.length}</span>
              </div>
              {list.map((t) => (
                <article key={t.id} style={s.card}>
                  <p style={s.title}>{t.title}</p>
                  <div style={s.row}>
                    <div style={s.who}>
                      <span style={s.avatar}>{initials(t.assignee)}</span>
                      {t.assignee}
                    </div>
                    <span style={{ ...s.badge, background: PRIORITY[t.priority].bg, color: PRIORITY[t.priority].fg }}>{t.priority}</span>
                  </div>
                </article>
              ))}
            </section>
          )
        })}
      </main>

      {open && (
        <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.35)', display: 'grid', placeItems: 'center' }}>
          <form onClick={(e) => e.stopPropagation()} onSubmit={submit} style={{ background: '#fff', borderRadius: 12, padding: 24, width: 360, boxShadow: '0 20px 40px rgba(0,0,0,.15)' }}>
            <h2 style={{ margin: '0 0 16px', fontSize: 18 }}>New task</h2>
            <input autoFocus style={s.input} placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <input style={s.input} placeholder="Assignee" value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })} />
            <select style={s.input} value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
              <option>High</option><option>Medium</option><option>Low</option>
            </select>
            <select style={s.input} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              {COLUMNS.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
              <button type="button" onClick={() => setOpen(false)} style={{ ...s.btn, background: '#f1f5f9', color: '#334155', boxShadow: 'none' }}>Cancel</button>
              <button type="submit" style={s.btn}>Add task</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
