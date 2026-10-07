import { useState } from 'react'

const COLUMNS = ['Todo', 'In Progress', 'Done', 'Blocked']
const COLORS = {
  High: ['#fee2e2', '#b91c1c'],
  Medium: ['#fef3c7', '#b45309'],
  Low: ['#dcfce7', '#15803d'],
}

const seed = [
  { id: 1, title: 'Design onboarding flow', assignee: 'Maya Chen', priority: 'High', status: 'Todo' },
  { id: 2, title: 'Write API documentation', assignee: 'Liam Ortiz', priority: 'Low', status: 'Todo' },
  { id: 3, title: 'Implement notifications', assignee: 'Priya Nair', priority: 'Medium', status: 'In Progress' },
  { id: 4, title: 'Fix login timeout bug', assignee: 'Noah Kim', priority: 'High', status: 'In Progress' },
  { id: 5, title: 'Set up CI pipeline', assignee: 'Sara Berg', priority: 'Medium', status: 'Done' },
  { id: 6, title: 'Update brand colors', assignee: 'Maya Chen', priority: 'Low', status: 'Done' },
]

export default function App() {
  const [tasks, setTasks] = useState(seed)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ title: '', assignee: '', priority: 'Medium', status: 'Todo' })

  const add = (e) => {
    e.preventDefault()
    if (!form.title.trim()) return
    setTasks([...tasks, { ...form, id: Date.now(), assignee: form.assignee.trim() || 'Unassigned' }])
    setForm({ title: '', assignee: '', priority: 'Medium', status: 'Todo' })
    setOpen(false)
  }

  const input = { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14 }

  return (
    <div style={{ minHeight: '100vh', background: '#f6f7fb', color: '#111827', fontFamily: 'system-ui, sans-serif' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '24px 40px', background: '#2563eb', color: '#fff', borderBottom: '1px solid #1d4ed8' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 28 }}>Orbit</h1>
          <p style={{ margin: '2px 0 0', color: '#dbeafe' }}>Sprint 14</p>
        </div>
        <button onClick={() => setOpen(!open)} style={{ background: '#fff', color: '#1d4ed8', border: 0, borderRadius: 8, padding: '10px 18px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
          Add task
        </button>
      </header>

      {open && (
        <form onSubmit={add} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', padding: '16px 40px', background: '#fff', borderBottom: '1px solid #e5e7eb' }}>
          <input autoFocus placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} style={{ ...input, flex: 1, minWidth: 200 }} />
          <input placeholder="Assignee" value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })} style={input} />
          <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} style={input}>
            {Object.keys(COLORS).map((p) => <option key={p}>{p}</option>)}
          </select>
          <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} style={input}>
            {COLUMNS.map((c) => <option key={c}>{c}</option>)}
          </select>
          <button style={{ ...input, background: '#4f46e5', color: '#fff', border: 0, cursor: 'pointer' }}>Save</button>
        </form>
      )}

      <main style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 24, padding: 40, alignItems: 'start' }}>
        {COLUMNS.map((col) => {
          const items = tasks.filter((t) => t.status === col)
          return (
            <section key={col} style={{ background: '#eceef5', borderRadius: 12, padding: 16 }}>
              <h2 style={{ margin: '0 0 14px', fontSize: 15, display: 'flex', justifyContent: 'space-between' }}>
                {col}
                <span style={{ color: '#6b7280', fontWeight: 500 }}>{items.length}</span>
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {items.map((t) => (
                  <article key={t.id} style={{ background: '#fff', borderRadius: 10, padding: 14, boxShadow: '0 1px 3px rgba(0,0,0,.08)' }}>
                    <div style={{ fontWeight: 600, marginBottom: 10 }}>{t.title}</div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 13, color: '#6b7280' }}>{t.assignee}</span>
                      <span style={{ fontSize: 12, fontWeight: 600, padding: '3px 10px', borderRadius: 999, background: COLORS[t.priority][0], color: COLORS[t.priority][1] }}>
                        {t.priority}
                      </span>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )
        })}
      </main>
    </div>
  )
}
