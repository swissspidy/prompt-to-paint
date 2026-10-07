import { useState } from 'react'

const COLS = ['Todo', 'In Progress', 'Done', 'Blocked']
const COLORS = { High: ['#fee2e2', '#b91c1c'], Medium: ['#fef3c7', '#b45309'], Low: ['#dcfce7', '#15803d'] }

const seed = [
  { id: 1, title: 'Design onboarding flow', assignee: 'Maya Chen', priority: 'High', col: 'Todo' },
  { id: 2, title: 'Write API docs', assignee: 'Liam Ortiz', priority: 'Low', col: 'Todo' },
  { id: 3, title: 'Implement auth service', assignee: 'Priya Nair', priority: 'High', col: 'In Progress' },
  { id: 4, title: 'Refactor billing page', assignee: 'Tom Becker', priority: 'Medium', col: 'In Progress' },
  { id: 5, title: 'Set up CI pipeline', assignee: 'Ava Johnson', priority: 'Medium', col: 'Done' },
  { id: 6, title: 'Fix navbar alignment', assignee: 'Sam Wu', priority: 'Low', col: 'Done' },
]

export default function App() {
  const [tasks, setTasks] = useState(seed)
  const add = () => {
    const title = prompt('Task title?')
    if (!title) return
    const assignee = prompt('Assignee?') || 'Unassigned'
    const p = prompt('Priority (High, Medium, Low)?', 'Medium')
    const priority = ['High', 'Medium', 'Low'].find(x => x.toLowerCase() === (p || '').toLowerCase()) || 'Medium'
    setTasks([...tasks, { id: Date.now(), title, assignee, priority, col: 'Todo' }])
  }
  return (
    <div style={{ minHeight: '100vh', background: '#f6f7fb', color: '#1f2937', fontFamily: 'system-ui, sans-serif', padding: 32, boxSizing: 'border-box' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28, background: '#2563eb', color: '#fff', padding: '16px 20px', borderRadius: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 28 }}>Orbit</h1>
          <p style={{ margin: '4px 0 0', color: '#dbeafe' }}>Sprint 14</p>
        </div>
        <button onClick={add} style={{ background: '#fff', color: '#1d4ed8', border: 0, borderRadius: 8, padding: '10px 16px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>+ Add task</button>
      </header>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, alignItems: 'start' }}>
        {COLS.map(c => (
          <section key={c} style={{ background: '#eceef5', borderRadius: 12, padding: 14 }}>
            <h2 style={{ fontSize: 14, margin: '0 0 12px', textTransform: 'uppercase', letterSpacing: 1, color: '#4b5563' }}>
              {c} <span style={{ color: '#9ca3af' }}>{tasks.filter(t => t.col === c).length}</span>
            </h2>
            {tasks.filter(t => t.col === c).map(t => (
              <div key={t.id} style={{ background: '#fff', borderRadius: 10, padding: 14, marginBottom: 10, boxShadow: '0 1px 3px rgba(0,0,0,.08)' }}>
                <div style={{ fontWeight: 600, marginBottom: 10 }}>{t.title}</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, color: '#6b7280' }}>
                  <span>{t.assignee}</span>
                  <span style={{ background: COLORS[t.priority][0], color: COLORS[t.priority][1], padding: '2px 10px', borderRadius: 999, fontWeight: 600, fontSize: 12 }}>{t.priority}</span>
                </div>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  )
}
