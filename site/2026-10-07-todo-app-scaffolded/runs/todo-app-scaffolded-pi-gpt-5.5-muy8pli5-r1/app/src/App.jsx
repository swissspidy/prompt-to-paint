const columns = [
  {
    title: 'Todo',
    tasks: [
      { title: 'Map onboarding flow', assignee: 'Maya Chen', priority: 'High' },
      { title: 'Draft release notes', assignee: 'Noah Patel', priority: 'Medium' },
    ],
  },
  {
    title: 'In Progress',
    tasks: [
      { title: 'Build analytics cards', assignee: 'Ava Brooks', priority: 'High' },
      { title: 'QA mobile navigation', assignee: 'Leo Martin', priority: 'Low' },
    ],
  },
  {
    title: 'Done',
    tasks: [
      { title: 'Set up design tokens', assignee: 'Iris Walker', priority: 'Medium' },
      { title: 'Archive legacy tickets', assignee: 'Sam Rivera', priority: 'Low' },
    ],
  },
  {
    title: 'Blocked',
    tasks: [
      { title: 'Resolve API rate limit', assignee: 'Nina Kim', priority: 'High' },
      { title: 'Confirm legal copy', assignee: 'Owen Lee', priority: 'Medium' },
    ],
  },
]

function TaskCard({ task }) {
  return (
    <article className="task-card">
      <div className="card-topline">
        <span className={`priority priority-${task.priority.toLowerCase()}`}>
          {task.priority}
        </span>
      </div>
      <h3>{task.title}</h3>
      <p>{task.assignee}</p>
    </article>
  )
}

function Column({ column }) {
  return (
    <section className="board-column">
      <div className="column-header">
        <h2>{column.title}</h2>
        <span>{column.tasks.length}</span>
      </div>
      <div className="task-list">
        {column.tasks.map((task) => (
          <TaskCard key={`${column.title}-${task.title}`} task={task} />
        ))}
      </div>
    </section>
  )
}

export default function App() {
  return (
    <main className="orbit-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Sprint 14</p>
          <h1>Orbit</h1>
        </div>
        <button type="button" className="add-task-button">+ Add task</button>
      </header>

      <section className="board" aria-label="Orbit task board">
        {columns.map((column) => (
          <Column key={column.title} column={column} />
        ))}
      </section>
    </main>
  )
}
