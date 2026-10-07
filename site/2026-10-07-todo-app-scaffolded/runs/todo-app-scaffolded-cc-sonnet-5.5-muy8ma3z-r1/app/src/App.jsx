import { useState } from 'react'

const COLUMNS = ['Todo', 'In Progress', 'Done', 'Blocked']
const PRIORITIES = ['High', 'Medium', 'Low']
const COLORS = {
  High: ['#fee2e2', '#b91c1c'],
  Medium: ['#fef3c7', '#b45309'],
  Low: ['#dcfce7', '#15803d'],
}

const seed = [
  { id: 1, title: 'Design onboarding flow', assignee: 'Maya Chen', priority: 'High', status: 'Todo' },
  { id: 2, title: 'Write API documentation', assignee: 'Liam Ortiz', priority: 'Low', status: 'Todo' },
  { id: 3, title: 'Implement auth refresh', assignee: 'Priya Nair', priority: 'High', status: 'In Progress' },
  { id: 4, title: 'Fix dashboard chart bug', assignee: 'Tom Becker', priority: 'Medium', status: 'In Progress' },
  { id: 5, title: 'Set up CI pipeline', assignee: 'Ana Silva', priority: 'Medium', status: 'Done' },
  { id: 6, title: 'Update brand colors', assignee: 'Maya Chen', priority: 'Low', status: 'Done' },
]

export default function App() {
  const [tasks, setTasks] = useState(seed)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ title: '', assignee: '', priority: 'Medium' })

  const add = (e) => {
    e.preventDefault()
    if (!form.title.trim()) return
    setTasks([...tasks, { id: Date.now(), ...form, title: form.title.trim(), assignee: form.assignee.trim() || 'Unassigned', status: 'Todo' }])
    setForm({ title: '', assignee: '', priority: 'Medium' })
    setOpen(false)
  }

  const s = {
    page: { minHeight: '100vh', background: '#f6f7fb', fontFamily: 'system-ui, sans-serif', color: '#1f2937' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 32px', background: '#2563eb', color: '#fff', borderBottom: '1px solid #1d4ed8' },
    btn: { background: '#4f46e5', color: '#fff', border: 0, borderRadius: 8, padding: '10px 16px', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
    board: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, padding: 32, alignItems: 'start' },
    col: { background: '#eceef4', borderRadius: 12, padding: 14 },
    card: { background: '#fff', borderRadius: 10, padding: 14, marginTop: 10, boxShadow: '0 1px 3px rgba(0,0,0,.08)', border: '1px solid #e5e7eb' },
    input: { padding: 8, borderRadius: 6, border: '1px solid #d1d5db', fontSize: 14 },
  }

  return (
    <div style={s.page}>
      <header style={s.header}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24 }}>Orbit</h1>
          <div style={{ color: '#dbeafe', fontSize: 14 }}>Sprint 14</div>
        </div>
        <button style={{ ...s.btn, background: '#fff', color: '#1d4ed8' }}onClick={() => setOpen(!open)}>Add task</button>
      </header>
      {open && (
        <form onSubmit={add} style={{ display: 'flex', gap: 8, padding: '16px 32px', background: '#fff', borderBottom: '1px solid #e5e7eb' }}>
          <input style={{ ...s.input, flex: 1 }} placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus />
          <input style={s.input} placeholder="Assignee" value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })} />
          <select style={s.input} value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
            {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
          </select>
          <button style={s.btn} type="submit">Add</button>
        </form>
      )}
      <main style={s.board}>
        {COLUMNS.map((c) => {
          const items = tasks.filter((t) => t.status === c)
          return (
            <section key={c} style={s.col}>
              <h2 style={{ margin: 0, fontSize: 14, textTransform: 'uppercase', letterSpacing: 0.5, color: '#4b5563' }}>
                {c} <span style={{ color: '#9ca3af' }}>{items.length}</span>
              </h2>
              {items.map((t) => (
                <div key={t.id} style={s.card}>
                  <div style={{ fontWeight: 600, marginBottom: 10 }}>{t.title}</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, color: '#6b7280' }}>
                    <span>{t.assignee}</span>
                    <span style={{ background: COLORS[t.priority][0], color: COLORS[t.priority][1], padding: '2px 10px', borderRadius: 999, fontWeight: 600, fontSize: 12 }}>{t.priority}</span>
                  </div>
                </div>
              ))}
            </section>
          )
        })}
      </main>
    </div>
  )
}
