const columns = [
  {
    title: 'Todo',
    tasks: [
      { title: 'Map onboarding flow', assignee: 'Maya Chen', priority: 'High' },
      { title: 'Draft release notes', assignee: 'Owen Brooks', priority: 'Medium' },
    ],
  },
  {
    title: 'In Progress',
    tasks: [
      { title: 'Build analytics cards', assignee: 'Priya Shah', priority: 'High' },
      { title: 'QA mobile navigation', assignee: 'Leo Martin', priority: 'Low' },
    ],
  },
  {
    title: 'Done',
    tasks: [
      { title: 'Finalize brand palette', assignee: 'Ava Wilson', priority: 'Medium' },
      { title: 'Set up team retro', assignee: 'Noah Kim', priority: 'Low' },
    ],
  },
  {
    title: 'Blocked',
    tasks: [],
  },
]

const priorityClass = {
  High: 'priority-high',
  Medium: 'priority-medium',
  Low: 'priority-low',
}

export default function App() {
  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Sprint 14</p>
          <h1>Orbit</h1>
        </div>
        <button className="add-button" type="button">+ Add task</button>
      </section>

      <section className="board" aria-label="Orbit sprint task board">
        {columns.map((column) => (
          <article className="column" key={column.title}>
            <header className="column-header">
              <h2>{column.title}</h2>
              <span>{column.tasks.length}</span>
            </header>
            <div className="task-list">
              {column.tasks.map((task) => (
                <div className="task-card" key={task.title}>
                  <div className="card-topline">
                    <span className={`priority ${priorityClass[task.priority]}`}>{task.priority}</span>
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
