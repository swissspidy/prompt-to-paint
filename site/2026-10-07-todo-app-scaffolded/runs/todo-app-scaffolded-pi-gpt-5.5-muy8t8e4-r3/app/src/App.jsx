const columns = [
  {
    title: 'Todo',
    accent: '#64748b',
    tasks: [
      { title: 'Map onboarding flow', assignee: 'Maya Chen', priority: 'High' },
      { title: 'Draft research questions', assignee: 'Noah Patel', priority: 'Medium' },
    ],
  },
  {
    title: 'In Progress',
    accent: '#4f46e5',
    tasks: [
      { title: 'Build task card states', assignee: 'Ava Brooks', priority: 'High' },
      { title: 'Polish dashboard copy', assignee: 'Leo Martin', priority: 'Low' },
    ],
  },
  {
    title: 'Done',
    accent: '#10b981',
    tasks: [
      { title: 'Create sprint brief', assignee: 'Iris Wong', priority: 'Medium' },
      { title: 'Review design tokens', assignee: 'Sam Rivera', priority: 'Low' },
    ],
  },
  {
    title: 'Blocked',
    accent: '#ef4444',
    tasks: [],
  },
]

const priorityClass = {
  High: 'priority high',
  Medium: 'priority medium',
  Low: 'priority low',
}

export default function App() {
  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">Task Board</p>
          <h1>Orbit</h1>
          <p className="subtitle">Sprint 14</p>
        </div>
        <button className="add-button">+ Add task</button>
      </section>

      <section className="board" aria-label="Orbit task board">
        {columns.map((column) => (
          <article className="column" key={column.title}>
            <header className="column-header">
              <div className="column-title-wrap">
                <span className="column-dot" style={{ backgroundColor: column.accent }} />
                <h2>{column.title}</h2>
              </div>
              <span className="count">{column.tasks.length}</span>
            </header>

            <div className="cards">
              {column.tasks.map((task) => (
                <div className="card" key={task.title}>
                  <div className="card-topline">
                    <span className={priorityClass[task.priority]}>{task.priority}</span>
                  </div>
                  <h3>{task.title}</h3>
                  <p>{task.assignee}</p>
                </div>
              ))}
            </div>
          </article>
        ))}
      </section>
    </main>
  )
}
