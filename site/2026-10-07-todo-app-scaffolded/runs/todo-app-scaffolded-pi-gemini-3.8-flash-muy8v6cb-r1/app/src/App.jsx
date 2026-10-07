import React, { useState } from 'react';

const INITIAL_TASKS = [
  {
    id: 't-1',
    title: 'Design system tokens & typography review',
    assignee: 'Sarah Jenkins',
    priority: 'High',
    status: 'Todo',
  },
  {
    id: 't-2',
    title: 'Research OAuth 2.0 PKCE flow for desktop client',
    assignee: 'Alex Rivera',
    priority: 'Medium',
    status: 'Todo',
  },
  {
    id: 't-3',
    title: 'Migrate user session management to Redis cluster',
    assignee: 'David Kim',
    priority: 'High',
    status: 'In Progress',
  },
  {
    id: 't-4',
    title: 'Implement real-time notification websocket handler',
    assignee: 'Elena Rostova',
    priority: 'Medium',
    status: 'In Progress',
  },
  {
    id: 't-5',
    title: 'Audit Postgres query latency and add composite index',
    assignee: 'Marcus Chen',
    priority: 'Low',
    status: 'Done',
  },
  {
    id: 't-6',
    title: 'Setup automated end-to-end Cypress smoke tests',
    assignee: 'Olivia Vance',
    priority: 'Low',
    status: 'Done',
  },
];

const COLUMNS = [
  { id: 'Todo', title: 'Todo', color: '#6366f1' },
  { id: 'In Progress', title: 'In Progress', color: '#f59e0b' },
  { id: 'Done', title: 'Done', color: '#10b981' },
  { id: 'Blocked', title: 'Blocked', color: '#ef4444' },
];

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function getAvatarColor(name) {
  const colors = [
    '#3b82f6', '#8b5cf6', '#ec4899', '#f97316', '#10b981', '#06b6d4', '#6366f1'
  ];
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

export default function App() {
  const [tasks, setTasks] = useState(INITIAL_TASKS);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newAssignee, setNewAssignee] = useState('');
  const [newPriority, setNewPriority] = useState('Medium');
  const [newStatus, setNewStatus] = useState('Todo');
  const [draggedTaskId, setDraggedTaskId] = useState(null);
  const [dragOverColumn, setDragOverColumn] = useState(null);

  const handleAddTask = (e) => {
    e.preventDefault();
    if (!newTitle.trim()) return;

    const newTask = {
      id: `t-${Date.now()}`,
      title: newTitle.trim(),
      assignee: newAssignee.trim() || 'Unassigned',
      priority: newPriority,
      status: newStatus,
    };

    setTasks((prev) => [...prev, newTask]);
    setNewTitle('');
    setNewAssignee('');
    setNewPriority('Medium');
    setNewStatus('Todo');
    setIsModalOpen(false);
  };

  const moveTask = (taskId, newColumn) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, status: newColumn } : t))
    );
  };

  const deleteTask = (taskId) => {
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
  };

  const getPriorityStyle = (priority) => {
    switch (priority) {
      case 'High':
        return { bg: '#fef2f2', text: '#b91c1c', border: '#fecaca', dot: '#ef4444' };
      case 'Medium':
        return { bg: '#fffbeb', text: '#b45309', border: '#fde68a', dot: '#f59e0b' };
      case 'Low':
      default:
        return { bg: '#f0fdf4', text: '#15803d', border: '#bbf7d0', dot: '#22c55e' };
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', backgroundColor: '#f8fafc' }}>
      {/* Top Navbar Header */}
      <header
        style={{
          backgroundColor: '#2563eb',
          borderBottom: '1px solid #1d4ed8',
          padding: '16px 32px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          position: 'sticky',
          top: 0,
          zIndex: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div
            style={{
              width: '38px',
              height: '38px',
              borderRadius: '10px',
              background: 'rgba(255, 255, 255, 0.2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <circle cx="12" cy="12" r="8" strokeDasharray="4 4" />
              <circle cx="19" cy="8" r="1.5" fill="#ffffff" />
            </svg>
          </div>
          <div>
            <h1
              style={{
                fontSize: '22px',
                fontWeight: 700,
                color: '#ffffff',
                letterSpacing: '-0.02em',
                lineHeight: 1.2,
                margin: 0,
              }}
            >
              Orbit
            </h1>
            <p
              style={{
                fontSize: '13px',
                fontWeight: 500,
                color: '#dbeafe',
                marginTop: '2px',
                margin: 0,
              }}
            >
              Sprint 14
            </p>
          </div>
        </div>

        <button
          onClick={() => setIsModalOpen(true)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            backgroundColor: '#ffffff',
            color: '#2563eb',
            border: 'none',
            borderRadius: '8px',
            padding: '9px 18px',
            fontSize: '14px',
            fontWeight: 600,
            cursor: 'pointer',
            boxShadow: '0 1px 3px rgba(0, 0, 0, 0.15)',
            transition: 'background-color 0.15s ease',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#f1f5f9')}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = '#ffffff')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Add task
        </button>
      </header>

      {/* Main Board Container */}
      <main style={{ flex: 1, padding: '32px', maxWidth: '1600px', width: '100%', margin: '0 auto' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
            gap: '20px',
            alignItems: 'start',
          }}
        >
          {COLUMNS.map((column) => {
            const columnTasks = tasks.filter((t) => t.status === column.id);
            return (
              <div
                key={column.id}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOverColumn(column.id);
                }}
                onDragLeave={(e) => {
                  if (e.currentTarget.contains(e.relatedTarget)) return;
                  setDragOverColumn(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOverColumn(null);
                  if (draggedTaskId) {
                    moveTask(draggedTaskId, column.id);
                    setDraggedTaskId(null);
                  }
                }}
                style={{
                  backgroundColor: dragOverColumn === column.id ? '#eef2ff' : '#f1f5f9',
                  border: dragOverColumn === column.id ? '1px dashed #6366f1' : '1px solid #e2e8f0',
                  borderRadius: '12px',
                  padding: '16px',
                  minHeight: '540px',
                  display: 'flex',
                  flexDirection: 'column',
                  transition: 'background-color 0.15s ease, border-color 0.15s ease',
                }}
              >
                {/* Column Header */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: '16px',
                    padding: '2px 4px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span
                      style={{
                        width: '10px',
                        height: '10px',
                        borderRadius: '50%',
                        backgroundColor: column.color,
                        display: 'inline-block',
                      }}
                    />
                    <h2 style={{ fontSize: '15px', fontWeight: 650, color: '#1e293b' }}>
                      {column.title}
                    </h2>
                    <span
                      style={{
                        backgroundColor: '#e2e8f0',
                        color: '#475569',
                        fontSize: '12px',
                        fontWeight: 600,
                        padding: '1px 7px',
                        borderRadius: '10px',
                        minWidth: '20px',
                        textAlign: 'center',
                      }}
                    >
                      {columnTasks.length}
                    </span>
                  </div>
                  <button
                    onClick={() => {
                      setNewStatus(column.id);
                      setIsModalOpen(true);
                    }}
                    title={`Add task to ${column.title}`}
                    style={{
                      border: 'none',
                      background: 'none',
                      color: '#64748b',
                      cursor: 'pointer',
                      padding: '4px',
                      borderRadius: '4px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </button>
                </div>

                {/* Tasks List */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', flex: 1 }}>
                  {columnTasks.map((task) => {
                    const pStyle = getPriorityStyle(task.priority);
                    return (
                      <div
                        key={task.id}
                        draggable
                        onDragStart={() => setDraggedTaskId(task.id)}
                        onDragEnd={() => setDraggedTaskId(null)}
                        style={{
                          backgroundColor: '#ffffff',
                          borderRadius: '10px',
                          padding: '16px',
                          border: '1px solid #e2e8f0',
                          boxShadow: draggedTaskId === task.id
                            ? '0 10px 15px -3px rgba(0, 0, 0, 0.1)'
                            : '0 1px 3px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.02)',
                          opacity: draggedTaskId === task.id ? 0.5 : 1,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '14px',
                          cursor: 'grab',
                          transition: 'transform 0.12s ease, box-shadow 0.12s ease',
                        }}
                      >
                        {/* Priority Badge & Actions */}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '5px',
                              backgroundColor: pStyle.bg,
                              color: pStyle.text,
                              border: `1px solid ${pStyle.border}`,
                              fontSize: '11px',
                              fontWeight: 650,
                              padding: '2px 8px',
                              borderRadius: '6px',
                              letterSpacing: '0.02em',
                            }}
                          >
                            <span
                              style={{
                                width: '6px',
                                height: '6px',
                                borderRadius: '50%',
                                backgroundColor: pStyle.dot,
                              }}
                            />
                            {task.priority}
                          </span>

                          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            {/* Column switcher select */}
                            <select
                              value={task.status}
                              onChange={(e) => moveTask(task.id, e.target.value)}
                              style={{
                                fontSize: '11px',
                                color: '#64748b',
                                border: '1px solid #e2e8f0',
                                borderRadius: '4px',
                                padding: '2px 4px',
                                backgroundColor: '#f8fafc',
                                cursor: 'pointer',
                              }}
                              title="Move task"
                            >
                              {COLUMNS.map((col) => (
                                <option key={col.id} value={col.id}>
                                  {col.title}
                                </option>
                              ))}
                            </select>

                            <button
                              onClick={() => deleteTask(task.id)}
                              title="Delete task"
                              style={{
                                border: 'none',
                                background: 'transparent',
                                color: '#94a3b8',
                                cursor: 'pointer',
                                padding: '2px 4px',
                                borderRadius: '4px',
                                display: 'flex',
                                alignItems: 'center',
                              }}
                              onMouseEnter={(e) => (e.currentTarget.style.color = '#ef4444')}
                              onMouseLeave={(e) => (e.currentTarget.style.color = '#94a3b8')}
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="18" y1="6" x2="6" y2="18" />
                                <line x1="6" y1="6" x2="18" y2="18" />
                              </svg>
                            </button>
                          </div>
                        </div>

                        {/* Title */}
                        <div
                          style={{
                            fontSize: '14px',
                            fontWeight: 600,
                            color: '#1e293b',
                            lineHeight: 1.45,
                          }}
                        >
                          {task.title}
                        </div>

                        {/* Assignee Footer */}
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            paddingTop: '8px',
                            borderTop: '1px solid #f1f5f9',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <div
                              style={{
                                width: '26px',
                                height: '26px',
                                borderRadius: '50%',
                                backgroundColor: getAvatarColor(task.assignee),
                                color: '#ffffff',
                                display: 'flex',
                                alignItems: 'center',
                                justifySelf: 'center',
                                justifyContent: 'center',
                                fontSize: '11px',
                                fontWeight: 700,
                                flexShrink: 0,
                              }}
                            >
                              {getInitials(task.assignee)}
                            </div>
                            <span style={{ fontSize: '13px', color: '#475569', fontWeight: 500 }}>
                              {task.assignee}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  {columnTasks.length === 0 && (
                    <div
                      style={{
                        padding: '32px 16px',
                        textAlign: 'center',
                        color: '#94a3b8',
                        fontSize: '13px',
                        border: '1px dashed #cbd5e1',
                        borderRadius: '8px',
                        backgroundColor: '#ffffff',
                      }}
                    >
                      No tasks yet
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </main>

      {/* Add Task Modal */}
      {isModalOpen && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(15, 23, 42, 0.4)',
            backdropFilter: 'blur(3px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          }}
          onClick={() => setIsModalOpen(false)}
        >
          <div
            style={{
              backgroundColor: '#ffffff',
              borderRadius: '12px',
              padding: '24px',
              width: '100%',
              maxWidth: '460px',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '18px',
              }}
            >
              <h3 style={{ fontSize: '18px', fontWeight: 700, color: '#0f172a' }}>
                Add New Task
              </h3>
              <button
                onClick={() => setIsModalOpen(false)}
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: '#94a3b8',
                  cursor: 'pointer',
                  padding: '4px',
                  display: 'flex',
                }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleAddTask} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#334155', marginBottom: '6px' }}>
                  Task Title
                </label>
                <input
                  type="text"
                  placeholder="e.g. Implement user authentication"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  autoFocus
                  required
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    fontSize: '14px',
                    borderRadius: '8px',
                    border: '1px solid #cbd5e1',
                    outline: 'none',
                    backgroundColor: '#ffffff',
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#334155', marginBottom: '6px' }}>
                  Assignee
                </label>
                <input
                  type="text"
                  placeholder="e.g. Maya Lin"
                  value={newAssignee}
                  onChange={(e) => setNewAssignee(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    fontSize: '14px',
                    borderRadius: '8px',
                    border: '1px solid #cbd5e1',
                    outline: 'none',
                    backgroundColor: '#ffffff',
                  }}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#334155', marginBottom: '6px' }}>
                    Priority
                  </label>
                  <select
                    value={newPriority}
                    onChange={(e) => setNewPriority(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '10px 12px',
                      fontSize: '14px',
                      borderRadius: '8px',
                      border: '1px solid #cbd5e1',
                      outline: 'none',
                      backgroundColor: '#ffffff',
                    }}
                  >
                    <option value="Low">Low</option>
                    <option value="Medium">Medium</option>
                    <option value="High">High</option>
                  </select>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#334155', marginBottom: '6px' }}>
                    Column
                  </label>
                  <select
                    value={newStatus}
                    onChange={(e) => setNewStatus(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '10px 12px',
                      fontSize: '14px',
                      borderRadius: '8px',
                      border: '1px solid #cbd5e1',
                      outline: 'none',
                      backgroundColor: '#ffffff',
                    }}
                  >
                    {COLUMNS.map((col) => (
                      <option key={col.id} value={col.id}>
                        {col.title}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '12px' }}>
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  style={{
                    padding: '9px 16px',
                    fontSize: '14px',
                    fontWeight: 500,
                    borderRadius: '8px',
                    border: '1px solid #cbd5e1',
                    backgroundColor: '#ffffff',
                    color: '#475569',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  style={{
                    padding: '9px 18px',
                    fontSize: '14px',
                    fontWeight: 600,
                    borderRadius: '8px',
                    border: 'none',
                    backgroundColor: '#4f46e5',
                    color: '#ffffff',
                    cursor: 'pointer',
                    boxShadow: '0 1px 3px rgba(79, 70, 229, 0.25)',
                  }}
                >
                  Create task
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
