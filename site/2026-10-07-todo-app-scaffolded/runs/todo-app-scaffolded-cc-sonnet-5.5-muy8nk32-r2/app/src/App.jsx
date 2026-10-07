import { useState } from 'react'

const COLUMNS = ['Todo', 'In Progress', 'Done', 'Blocked']
const PRIORITY = {
  High: { bg: '#fee2e2', fg: '#b91c1c' },
  Medium: { bg: '#fef3c7', fg: '#b45309' },
  Low: { bg: '#dcfce7', fg: '#15803d' },
}

const SEED = [
  { id: 1, title: 'Design onboarding flow', assignee: 'Maya Chen', priority: 'High', status: 'Todo' },
  { id: 2, title: 'Write API documentation', assignee: 'Liam Ortiz', priority: 'Low', status: 'Todo' },
  { id: 3, title: 'Implement search filters', assignee: 'Priya Nair', priority: 'Medium', status: 'In Progress' },
  { id: 4, title: 'Fix login redirect bug', assignee: 'Noah Kim', priority: 'High', status: 'In Progress' },
  { id: 5, title: 'Set up CI pipeline', assignee: 'Sofia Rossi', priority: 'Medium', status: 'Done' },
  { id: 6, title: 'Update brand colors', assignee: 'Ethan Brooks', priority: 'Low', status: 'Done' },
]

export default function App() {
  const [tasks, setTasks] = useState(SEED)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ title: '', assignee: '', priority: 'Medium' })

  const submit = (e) => {
    e.preventDefault()
    if (!form.title.trim()) return
    setTasks([...tasks, { id: Date.now(), ...form, title: form.title.trim(), assignee: form.assignee.trim() || 'Unassigned', status: 'Todo' }])
    setForm({ title: '', assignee: '', priority: 'Medium' })
    setAdding(false)
  }

  const input = { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14 }

  return (
    <div style={{ minHeight: '100vh', background: '#f6f7fb', color: '#111827', fontFamily: 'system-ui, sans-serif' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '24px 32px', background: '#2563eb', color: '#fff' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 26 }}>Orbit</h1>
          <p style={{ margin: '2px 0 0', color: '#dbeafe', fontSize: 14 }}>Sprint 14</p>
        </div>
        <button onClick={() => setAdding(!adding)} style={{ background: '#fff', color: '#1d4ed8', border: 0, borderRadius: 8, padding: '10px 16px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
          Add task
        </button>
      </header>

      {adding && (
        <form onSubmit={submit} style={{ display: 'flex', gap: 8, padding: '16px 32px', flexWrap: 'wrap' }}>
          <input autoFocus placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} style={{ ...input, flex: 1, minWidth: 200 }} />
          <input placeholder="Assignee" value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })} style={input} />
          <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} style={input}>
            {Object.keys(PRIORITY).map((p) => <option key={p}>{p}</option>)}
          </select>
          <button style={{ ...input, background: '#111827', color: '#fff', cursor: 'pointer' }}>Save</button>
        </form>
      )}

      <main style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, padding: 32, alignItems: 'start' }}>
        {COLUMNS.map((col) => {
          const items = tasks.filter((t) => t.status === col)
          return (
            <section key={col} style={{ background: '#eceef4', borderRadius: 12, padding: 14 }}>
              <h2 style={{ margin: '0 0 12px', fontSize: 14, textTransform: 'uppercase', letterSpacing: 0.5, color: '#4b5563' }}>
                {col} <span style={{ color: '#9ca3af' }}>{items.length}</span>
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {items.map((t) => (
                  <article key={t.id} style={{ background: '#fff', borderRadius: 10, padding: 14, boxShadow: '0 1px 3px rgba(0,0,0,.08)' }}>
                    <div style={{ fontWeight: 600, marginBottom: 10 }}>{t.title}</div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, color: '#6b7280' }}>
                      <span>{t.assignee}</span>
                      <span style={{ background: PRIORITY[t.priority].bg, color: PRIORITY[t.priority].fg, padding: '2px 10px', borderRadius: 999, fontWeight: 600, fontSize: 12 }}>{t.priority}</span>
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
