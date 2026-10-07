import { useState } from 'react'

const COLUMNS = ['Todo', 'In Progress', 'Done', 'Blocked']

const SEED = [
  { id: 1, title: 'Design onboarding flow', assignee: 'Maya Chen', priority: 'High', status: 'Todo' },
  { id: 2, title: 'Write API documentation', assignee: 'Liam Patel', priority: 'Low', status: 'Todo' },
  { id: 3, title: 'Implement auth middleware', assignee: 'Sofia Reyes', priority: 'High', status: 'In Progress' },
  { id: 4, title: 'Refactor settings page', assignee: 'Noah Kim', priority: 'Medium', status: 'In Progress' },
  { id: 5, title: 'Set up CI pipeline', assignee: 'Ava Johnson', priority: 'Medium', status: 'Done' },
  { id: 6, title: 'Fix login redirect bug', assignee: 'Ethan Brooks', priority: 'Low', status: 'Done' },
]

const PRIORITY = {
  High: { bg: '#fdecec', fg: '#c0362c' },
  Medium: { bg: '#fff4e0', fg: '#b26a00' },
  Low: { bg: '#e8f5ec', fg: '#2e7d4f' },
}

const DOT = { Todo: '#94a3b8', 'In Progress': '#3b82f6', Done: '#22c55e', Blocked: '#ef4444' }

const initials = (n) => n.split(' ').map((p) => p[0]).join('')

export default function App() {
  const [tasks, setTasks] = useState(SEED)

  const addTask = () => {
    const title = window.prompt('Task title')
    if (!title || !title.trim()) return
    setTasks((t) => [
      ...t,
      { id: Date.now(), title: title.trim(), assignee: 'Unassigned', priority: 'Medium', status: 'Todo' },
    ])
  }

  return (
    <div style={s.page}>
      <header style={s.header}>
        <div>
          <h1 style={s.title}>Orbit</h1>
          <div style={s.subtitle}>Sprint 14</div>
        </div>
        <button style={s.button} onClick={addTask}>+ Add task</button>
      </header>
      <main style={s.board}>
        {COLUMNS.map((col) => {
          const items = tasks.filter((t) => t.status === col)
          return (
            <section key={col} style={s.column}>
              <div style={s.colHead}>
                <span style={{ ...s.dot, background: DOT[col] }} />
                <span style={s.colTitle}>{col}</span>
                <span style={s.count}>{items.length}</span>
              </div>
              <div style={s.list}>
                {items.length === 0 && <div style={s.empty}>No tasks</div>}
                {items.map((t) => (
                  <article key={t.id} style={s.card}>
                    <div style={s.cardTitle}>{t.title}</div>
                    <div style={s.cardFoot}>
                      <div style={s.assignee}>
                        <span style={s.avatar}>{initials(t.assignee)}</span>
                        {t.assignee}
                      </div>
                      <span style={{ ...s.badge, background: PRIORITY[t.priority].bg, color: PRIORITY[t.priority].fg }}>
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

const s = {
  page: { minHeight: '100vh', background: '#f6f7f9', fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, sans-serif', color: '#1f2937', margin: 0 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 32px', background: '#2563eb', color: '#fff' },
  title: { margin: 0, fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em' },
  subtitle: { fontSize: 14, color: '#dbeafe', marginTop: 2 },
  button: { background: '#fff', color: '#1d4ed8', border: 'none', borderRadius: 8, padding: '10px 16px', fontSize: 14, fontWeight: 600, cursor: 'pointer', boxShadow: '0 1px 2px rgba(0,0,0,.08)' },
  board: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 20, padding: 32, alignItems: 'start' },
  column: { background: '#eef0f3', borderRadius: 12, padding: 14 },
  colHead: { display: 'flex', alignItems: 'center', gap: 8, padding: '2px 4px 12px' },
  dot: { width: 8, height: 8, borderRadius: '50%' },
  colTitle: { fontWeight: 600, fontSize: 14 },
  count: { marginLeft: 'auto', fontSize: 12, color: '#6b7280', background: '#fff', borderRadius: 10, padding: '2px 8px' },
  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  empty: { fontSize: 13, color: '#9ca3af', textAlign: 'center', padding: '20px 0', border: '1px dashed #d1d5db', borderRadius: 10 },
  card: { background: '#fff', borderRadius: 10, padding: 14, border: '1px solid #e5e7eb', boxShadow: '0 1px 2px rgba(16,24,40,.04)' },
  cardTitle: { fontSize: 15, fontWeight: 600, marginBottom: 12 },
  cardFoot: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  assignee: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#4b5563' },
  avatar: { width: 24, height: 24, borderRadius: '50%', background: '#e0e7ff', color: '#4338ca', fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  badge: { fontSize: 12, fontWeight: 600, padding: '3px 10px', borderRadius: 999 },
}
