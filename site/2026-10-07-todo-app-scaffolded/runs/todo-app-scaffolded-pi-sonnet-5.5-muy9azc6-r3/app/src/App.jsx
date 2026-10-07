import { useState } from 'react'

const cols = ['Todo', 'In Progress', 'Done', 'Blocked']
const seed = [
  { t: 'Design onboarding flow', a: 'Maya Chen', p: 'High', c: 'Todo' },
  { t: 'Write API docs', a: 'Liam Ortiz', p: 'Low', c: 'Todo' },
  { t: 'Implement search', a: 'Priya Nair', p: 'High', c: 'In Progress' },
  { t: 'Refactor auth module', a: 'Noah Kim', p: 'Medium', c: 'In Progress' },
  { t: 'Set up CI pipeline', a: 'Ava Brooks', p: 'Medium', c: 'Done' },
  { t: 'Fix login redirect bug', a: 'Maya Chen', p: 'Low', c: 'Done' },
]

export default function App() {
  const [tasks, setTasks] = useState(seed)
  const add = () => {
    const t = prompt('Task title?')
    if (!t) return
    const a = prompt('Assignee?') || 'Unassigned'
    const p = prompt('Priority (High, Medium, Low)?', 'Medium')
    const pr = ['High', 'Medium', 'Low'].find(x => x.toLowerCase() === (p || '').toLowerCase()) || 'Medium'
    setTasks([...tasks, { t, a, p: pr, c: 'Todo' }])
  }
  return (
    <div className="app">
      <header>
        <div>
          <h1>Orbit</h1>
          <p className="sub">Sprint 14</p>
        </div>
        <button className="add" onClick={add}>Add task</button>
      </header>
      <div className="board">
        {cols.map(c => (
          <div className="col" key={c}>
            <h2>{c}</h2>
            {tasks.filter(x => x.c === c).map((x, i) => (
              <div className="card" key={i}>
                <div className="title">{x.t}</div>
                <div className="meta">
                  <span>{x.a}</span>
                  <span className={'badge ' + x.p}>{x.p}</span>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
