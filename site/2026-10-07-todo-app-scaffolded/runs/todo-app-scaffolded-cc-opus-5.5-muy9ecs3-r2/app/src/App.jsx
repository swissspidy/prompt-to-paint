import { useState } from 'react';

const COLUMNS = [
  { id: 'todo', title: 'Todo', dot: '#94a3b8' },
  { id: 'progress', title: 'In Progress', dot: '#3b82f6' },
  { id: 'done', title: 'Done', dot: '#22c55e' },
  { id: 'blocked', title: 'Blocked', dot: '#ef4444' },
];

const PRIORITY = {
  High: { bg: '#fee2e2', fg: '#b91c1c' },
  Medium: { bg: '#fef3c7', fg: '#b45309' },
  Low: { bg: '#dcfce7', fg: '#15803d' },
};

const SEED = [
  { id: 1, title: 'Design onboarding flow', assignee: 'Maya Chen', priority: 'High', column: 'todo' },
  { id: 2, title: 'Write API rate-limit docs', assignee: 'Leo Park', priority: 'Low', column: 'todo' },
  { id: 3, title: 'Implement search filters', assignee: 'Priya Nair', priority: 'High', column: 'progress' },
  { id: 4, title: 'Refactor auth middleware', assignee: 'Sam Ortiz', priority: 'Medium', column: 'progress' },
  { id: 5, title: 'Set up CI pipeline', assignee: 'Jordan Lee', priority: 'Medium', column: 'done' },
  { id: 6, title: 'Fix avatar upload bug', assignee: 'Ava Brooks', priority: 'Low', column: 'done' },
];

const initials = (name) => name.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase();

const s = {
  page: { minHeight: '100vh', background: '#f6f7fb', color: '#0f172a', fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif', margin: 0 },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 32px', background: '#2563eb', borderBottom: '1px solid #1d4ed8' },
  brand: { display: 'flex', alignItems: 'center', gap: 12 },
  logo: { width: 36, height: 36, borderRadius: 10, background: 'rgba(255,255,255,.18)', border: '1px solid rgba(255,255,255,.35)', display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 700 },
  h1: { margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em', color: '#fff' },
  sub: { margin: 0, fontSize: 13, color: '#dbeafe' },
  headerBtn: { background: '#fff', color: '#1d4ed8', border: 'none', borderRadius: 8, padding: '10px 16px', fontSize: 14, fontWeight: 600, cursor: 'pointer', boxShadow: '0 1px 2px rgba(15,23,42,.15)' },
  btn: { background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 16px', fontSize: 14, fontWeight: 600, cursor: 'pointer', boxShadow: '0 1px 2px rgba(79,70,229,.3)' },
  board: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 20, padding: 32, maxWidth: 1400, margin: '0 auto' },
  col: { background: '#eef0f5', borderRadius: 12, padding: 14, minHeight: 300 },
  colHead: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 4px 12px', fontSize: 14, fontWeight: 600 },
  count: { marginLeft: 'auto', background: '#fff', color: '#64748b', borderRadius: 999, padding: '1px 8px', fontSize: 12, fontWeight: 600 },
  card: { background: '#fff', borderRadius: 10, padding: 14, marginBottom: 10, border: '1px solid #e5e7eb', boxShadow: '0 1px 2px rgba(15,23,42,.04)' },
  title: { margin: '0 0 12px', fontSize: 14, fontWeight: 600, lineHeight: 1.4 },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  person: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#475569' },
  avatar: { width: 24, height: 24, borderRadius: '50%', background: '#e0e7ff', color: '#4338ca', fontSize: 11, fontWeight: 700, display: 'grid', placeItems: 'center' },
  input: { width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, marginBottom: 8, fontFamily: 'inherit' },
};

export default function App() {
  const [tasks, setTasks] = useState(SEED);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ title: '', assignee: '', priority: 'Medium' });

  const submit = (e) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    setTasks((t) => [...t, { id: Date.now(), title: form.title.trim(), assignee: form.assignee.trim() || 'Unassigned', priority: form.priority, column: 'todo' }]);
    setForm({ title: '', assignee: '', priority: 'Medium' });
    setAdding(false);
  };

  return (
    <div style={s.page}>
      <header style={s.header}>
        <div style={s.brand}>
          <div style={s.logo}>O</div>
          <div>
            <h1 style={s.h1}>Orbit</h1>
            <p style={s.sub}>Sprint 14</p>
          </div>
        </div>
        <button style={s.headerBtn} onClick={() => setAdding((a) => !a)}>+ Add task</button>
      </header>
      <main style={s.board}>
        {COLUMNS.map((c) => {
          const list = tasks.filter((t) => t.column === c.id);
          return (
            <section key={c.id} style={s.col}>
              <div style={s.colHead}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.dot }} />
                {c.title}
                <span style={s.count}>{list.length}</span>
              </div>
              {c.id === 'todo' && adding && (
                <form style={s.card} onSubmit={submit}>
                  <input autoFocus style={s.input} placeholder="Task title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
                  <input style={s.input} placeholder="Assignee" value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })} />
                  <div style={s.row}>
                    <select style={{ ...s.input, width: 'auto', marginBottom: 0 }} value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                      <option>High</option><option>Medium</option><option>Low</option>
                    </select>
                    <button type="submit" style={{ ...s.btn, padding: '7px 12px', fontSize: 13 }}>Add</button>
                  </div>
                </form>
              )}
              {list.length === 0 && !(c.id === 'todo' && adding) && (
                <p style={{ margin: 0, padding: '24px 8px', textAlign: 'center', fontSize: 13, color: '#94a3b8', border: '1px dashed #cbd5e1', borderRadius: 10 }}>No tasks</p>
              )}
              {list.map((t) => (
                <article key={t.id} style={s.card}>
                  <p style={s.title}>{t.title}</p>
                  <div style={s.row}>
                    <span style={s.person}><span style={s.avatar}>{initials(t.assignee)}</span>{t.assignee}</span>
                    <span style={{ background: PRIORITY[t.priority].bg, color: PRIORITY[t.priority].fg, fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 999 }}>{t.priority}</span>
                  </div>
                </article>
              ))}
            </section>
          );
        })}
      </main>
    </div>
  );
}
