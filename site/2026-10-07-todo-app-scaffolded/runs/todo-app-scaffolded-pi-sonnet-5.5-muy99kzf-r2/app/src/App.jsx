import { useState } from 'react'

const cols = ['Todo', 'In Progress', 'Done', 'Blocked']
const seed = [
  { t: 'Design onboarding flow', a: 'Maya Chen', p: 'High', c: 0 },
  { t: 'Write API docs', a: 'Leo Park', p: 'Low', c: 0 },
  { t: 'Implement search', a: 'Sam Rivera', p: 'Medium', c: 1 },
  { t: 'Fix login timeout bug', a: 'Priya Nair', p: 'High', c: 1 },
  { t: 'Set up CI pipeline', a: 'Tom Alvarez', p: 'Medium', c: 2 },
  { t: 'Update brand colors', a: 'Maya Chen', p: 'Low', c: 2 },
]

export default function App() {
  const [tasks, setTasks] = useState(seed)
  const add = () => {
    const t = prompt('Task title?')
    if (t) setTasks([...tasks, { t, a: 'Unassigned', p: 'Medium', c: 0 }])
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
        {cols.map((name, i) => (
          <div className="col" key={name}>
            <h2>{name}<span>{tasks.filter(x => x.c === i).length}</span></h2>
            {tasks.filter(x => x.c === i).map((x, j) => (
              <div className="card" key={j}>
                <div className="title">{x.t}</div>
                <div className="meta"><span>{x.a}</span><span className={'badge ' + x.p}>{x.p}</span></div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
