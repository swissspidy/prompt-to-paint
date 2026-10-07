import React, { useState } from 'react';

const INITIAL_TASKS = [
  {
    id: 't-1',
    title: 'Design system audit & token cleanup',
    assignee: 'Sarah Lin',
    priority: 'High',
    column: 'Todo',
  },
  {
    id: 't-2',
    title: 'Research OAuth 2.1 migration specs',
    assignee: 'Alex Chen',
    priority: 'Medium',
    column: 'Todo',
  },
  {
    id: 't-3',
    title: 'Implement real-time WebSocket sync',
    assignee: 'David Miller',
    priority: 'High',
    column: 'In Progress',
  },
  {
    id: 't-4',
    title: 'Draft release notes for v2.4.0',
    assignee: 'Elena Rostova',
    priority: 'Low',
    column: 'In Progress',
  },
  {
    id: 't-5',
    title: 'Optimize image processing pipeline',
    assignee: 'Marcus Vance',
    priority: 'Medium',
    column: 'Done',
  },
  {
    id: 't-6',
    title: 'Set up automated lighthouse CI tests',
    assignee: 'Maya Patel',
    priority: 'Low',
    column: 'Done',
  },
];

const COLUMNS = [
  { id: 'Todo', name: 'Todo', color: '#6366f1' },
  { id: 'In Progress', name: 'In Progress', color: '#0ea5e9' },
  { id: 'Done', name: 'Done', color: '#10b981' },
  { id: 'Blocked', name: 'Blocked', color: '#ef4444' },
];

const PRIORITY_CONFIG = {
  High: {
    bg: '#fef2f2',
    text: '#b91c1c',
    border: '#fecaca',
    indicator: '#ef4444',
  },
  Medium: {
    bg: '#fffbeb',
    text: '#b45309',
    border: '#fde68a',
    indicator: '#f59e0b',
  },
  Low: {
    bg: '#f0fdf4',
    text: '#15803d',
    border: '#bbf7d0',
    indicator: '#22c55e',
  },
};

const AVATAR_PALETTES = [
  { bg: '#e0e7ff', text: '#3730a3' },
  { bg: '#fce7f3', text: '#9d174d' },
  { bg: '#dbeafe', text: '#1e40af' },
  { bg: '#dcfce7', text: '#166534' },
  { bg: '#ffedd5', text: '#9a3412' },
  { bg: '#f3e8ff', text: '#6b21a8' },
  { bg: '#ccfbf1', text: '#115e59' },
];

function getAvatarStyle(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_PALETTES[Math.abs(hash) % AVATAR_PALETTES.length];
}

function getInitials(name) {
  return name
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || 'U';
}

export default function App() {
  const [tasks, setTasks] = useState(INITIAL_TASKS);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [draggedTaskId, setDraggedTaskId] = useState(null);
  const [dragOverCol, setDragOverCol] = useState(null);

  // Form state
  const [newTitle, setNewTitle] = useState('');
  const [newAssignee, setNewAssignee] = useState('');
  const [newPriority, setNewPriority] = useState('Medium');
  const [newColumn, setNewColumn] = useState('Todo');

  const handleAddTask = (e) => {
    e.preventDefault();
    if (!newTitle.trim()) return;

    const newTask = {
      id: 't-' + Date.now(),
      title: newTitle.trim(),
      assignee: newAssignee.trim() || 'Alex Chen',
      priority: newPriority,
      column: newColumn,
    };

    setTasks((prev) => [...prev, newTask]);
    setNewTitle('');
    setNewAssignee('');
    setNewPriority('Medium');
    setNewColumn('Todo');
    setIsModalOpen(false);
  };

  const moveTask = (taskId, targetColumn) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, column: targetColumn } : t))
    );
  };

  const deleteTask = (taskId) => {
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
  };

  const handleDragStart = (e, taskId) => {
    setDraggedTaskId(taskId);
    e.dataTransfer.setData('text/plain', taskId);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e, colId) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverCol !== colId) {
      setDragOverCol(colId);
    }
  };

  const handleDragLeave = (colId) => {
    if (dragOverCol === colId) {
      setDragOverCol(null);
    }
  };

  const handleDrop = (e, targetColumn) => {
    e.preventDefault();
    const taskId = e.dataTransfer.getData('text/plain') || draggedTaskId;
    if (taskId) {
      moveTask(taskId, targetColumn);
    }
    setDraggedTaskId(null);
    setDragOverCol(null);
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: '#f8fafc',
        display: 'flex',
        flexDirection: 'column',
        color: '#0f172a',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      }}
    >
      {/* Top Header */}
      <header
        style={{
          backgroundColor: '#2563eb',
          borderBottom: '1px solid #1d4ed8',
          padding: '16px 36px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          position: 'sticky',
          top: 0,
          zIndex: 20,
          boxShadow: '0 2px 4px rgba(37, 99, 235, 0.15)',
        }}
      >
        {/* Brand / Sprint Info */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div
            style={{
              width: '38px',
              height: '38px',
              borderRadius: '10px',
              background: 'rgba(255, 255, 255, 0.2)',
              backdropFilter: 'blur(4px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#ffffff',
              border: '1px solid rgba(255, 255, 255, 0.3)',
            }}
          >
            {/* Orbital Icon */}
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="4" />
              <path d="M21.17 8A10 10 0 0 0 4.27 17.5" />
              <path d="M2.83 16A10 10 0 0 0 19.73 6.5" />
            </svg>
          </div>
          <div>
            <h1
              style={{
                fontSize: '22px',
                fontWeight: 700,
                color: '#ffffff',
                lineHeight: '1.2',
                letterSpacing: '-0.025em',
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
                margin: '2px 0 0 0',
              }}
            >
              Sprint 14
            </p>
          </div>
        </div>

        {/* Right side Actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '13px',
              color: '#ffffff',
              backgroundColor: 'rgba(255, 255, 255, 0.15)',
              padding: '6px 12px',
              borderRadius: '6px',
              border: '1px solid rgba(255, 255, 255, 0.25)',
              fontWeight: 500,
            }}
          >
            <span
              style={{
                width: '7px',
                height: '7px',
                borderRadius: '50%',
                backgroundColor: '#86efac',
                display: 'inline-block',
              }}
            />
            <span>{tasks.length} tasks</span>
          </div>

          <button
            onClick={() => setIsModalOpen(true)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              backgroundColor: '#ffffff',
              color: '#1d4ed8',
              border: 'none',
              borderRadius: '7px',
              padding: '8px 16px',
              fontSize: '14px',
              fontWeight: 600,
              cursor: 'pointer',
              boxShadow: '0 1px 3px rgba(0, 0, 0, 0.12)',
              transition: 'background-color 0.15s ease, transform 0.1s ease',
            }}
            onMouseOver={(e) => (e.currentTarget.style.backgroundColor = '#f1f5f9')}
            onMouseOut={(e) => (e.currentTarget.style.backgroundColor = '#ffffff')}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Add task
          </button>
        </div>
      </header>

      {/* Main Board View */}
      <main
        style={{
          flex: 1,
          padding: '32px 36px',
          maxWidth: '1440px',
          width: '100%',
          margin: '0 auto',
          boxSizing: 'border-box',
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
            gap: '20px',
            alignItems: 'start',
          }}
        >
          {COLUMNS.map((col) => {
            const columnTasks = tasks.filter((t) => t.column === col.id);
            const isTargetCol = dragOverCol === col.id;

            return (
              <div
                key={col.id}
                onDragOver={(e) => handleDragOver(e, col.id)}
                onDragLeave={() => handleDragLeave(col.id)}
                onDrop={(e) => handleDrop(e, col.id)}
                style={{
                  backgroundColor: isTargetCol ? '#e2e8f0' : '#f1f5f9',
                  borderRadius: '12px',
                  padding: '16px',
                  border: isTargetCol ? '2px dashed #3b82f6' : '1px solid #e2e8f0',
                  minHeight: '520px',
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
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        backgroundColor: col.color,
                      }}
                    />
                    <h2
                      style={{
                        fontSize: '15px',
                        fontWeight: 600,
                        color: '#1e293b',
                        margin: 0,
                        letterSpacing: '-0.01em',
                      }}
                    >
                      {col.name}
                    </h2>
                  </div>
                  <span
                    style={{
                      fontSize: '12px',
                      fontWeight: 600,
                      color: '#475569',
                      backgroundColor: '#e2e8f0',
                      padding: '2px 8px',
                      borderRadius: '12px',
                    }}
                  >
                    {columnTasks.length}
                  </span>
                </div>

                {/* Cards Container */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px',
                    flex: 1,
                  }}
                >
                  {columnTasks.map((task) => {
                    const prio = PRIORITY_CONFIG[task.priority] || PRIORITY_CONFIG.Medium;
                    const avatar = getAvatarStyle(task.assignee);
                    const isDragging = draggedTaskId === task.id;

                    return (
                      <div
                        key={task.id}
                        draggable
                        onDragStart={(e) => handleDragStart(e, task.id)}
                        onDragEnd={() => setDraggedTaskId(null)}
                        style={{
                          backgroundColor: '#ffffff',
                          borderRadius: '8px',
                          padding: '16px',
                          border: '1px solid #e2e8f0',
                          boxShadow: '0 1px 3px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.02)',
                          cursor: 'grab',
                          opacity: isDragging ? 0.45 : 1,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '12px',
                          position: 'relative',
                          transition: 'transform 0.15s ease, box-shadow 0.15s ease',
                        }}
                      >
                        {/* Title & Delete */}
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            justifyContent: 'space-between',
                            gap: '10px',
                          }}
                        >
                          <span
                            style={{
                              fontSize: '14px',
                              fontWeight: 600,
                              color: '#1e293b',
                              lineHeight: '1.4',
                              flex: 1,
                            }}
                          >
                            {task.title}
                          </span>
                          <button
                            onClick={() => deleteTask(task.id)}
                            title="Delete task"
                            style={{
                              background: 'transparent',
                              border: 'none',
                              color: '#94a3b8',
                              cursor: 'pointer',
                              padding: '2px',
                              borderRadius: '4px',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0,
                            }}
                            onMouseOver={(e) => (e.currentTarget.style.color = '#ef4444')}
                            onMouseOut={(e) => (e.currentTarget.style.color = '#94a3b8')}
                          >
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
                        </div>

                        {/* Card Meta: Priority badge & Assignee */}
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            paddingTop: '8px',
                            borderTop: '1px solid #f1f5f9',
                          }}
                        >
                          {/* Priority badge */}
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '6px',
                              fontSize: '12px',
                              fontWeight: 600,
                              backgroundColor: prio.bg,
                              color: prio.text,
                              border: `1px solid ${prio.border}`,
                              padding: '2px 8px',
                              borderRadius: '6px',
                            }}
                          >
                            <span
                              style={{
                                width: '6px',
                                height: '6px',
                                borderRadius: '50%',
                                backgroundColor: prio.indicator,
                              }}
                            />
                            {task.priority}
                          </span>

                          {/* Assignee */}
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '6px',
                            }}
                            title={`Assignee: ${task.assignee}`}
                          >
                            <span
                              style={{
                                width: '24px',
                                height: '24px',
                                borderRadius: '50%',
                                backgroundColor: avatar.bg,
                                color: avatar.text,
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: '11px',
                                fontWeight: 700,
                              }}
                            >
                              {getInitials(task.assignee)}
                            </span>
                            <span
                              style={{
                                fontSize: '13px',
                                color: '#475569',
                                fontWeight: 500,
                                maxWidth: '110px',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {task.assignee}
                            </span>
                          </div>
                        </div>

                        {/* Quick column mover buttons */}
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'flex-end',
                            gap: '6px',
                            paddingTop: '4px',
                          }}
                        >
                          {COLUMNS.filter((c) => c.id !== task.column).map((target) => (
                            <button
                              key={target.id}
                              onClick={() => moveTask(task.id, target.id)}
                              style={{
                                fontSize: '11px',
                                fontWeight: 500,
                                color: '#64748b',
                                backgroundColor: '#f8fafc',
                                border: '1px solid #e2e8f0',
                                borderRadius: '4px',
                                padding: '2px 8px',
                                cursor: 'pointer',
                                transition: 'all 0.15s ease',
                              }}
                              onMouseOver={(e) => {
                                e.currentTarget.style.backgroundColor = '#e2e8f0';
                                e.currentTarget.style.color = '#0f172a';
                              }}
                              onMouseOut={(e) => {
                                e.currentTarget.style.backgroundColor = '#f8fafc';
                                e.currentTarget.style.color = '#64748b';
                              }}
                            >
                              → {target.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}

                  {columnTasks.length === 0 && (
                    <div
                      style={{
                        padding: '40px 16px',
                        textAlign: 'center',
                        color: '#94a3b8',
                        fontSize: '13px',
                        border: '1px dashed #cbd5e1',
                        borderRadius: '8px',
                        backgroundColor: 'rgba(255, 255, 255, 0.4)',
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
            inset: 0,
            backgroundColor: 'rgba(15, 23, 42, 0.45)',
            backdropFilter: 'blur(3px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            padding: '16px',
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsModalOpen(false);
          }}
        >
          <div
            style={{
              backgroundColor: '#ffffff',
              borderRadius: '12px',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.05)',
              width: '100%',
              maxWidth: '460px',
              padding: '24px',
              border: '1px solid #e2e8f0',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '20px',
              }}
            >
              <div>
                <h3
                  style={{
                    margin: 0,
                    fontSize: '18px',
                    fontWeight: 700,
                    color: '#0f172a',
                  }}
                >
                  Create new task
                </h3>
                <p
                  style={{
                    margin: '2px 0 0 0',
                    fontSize: '13px',
                    color: '#64748b',
                  }}
                >
                  Add a task to Sprint 14
                </p>
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#64748b',
                  cursor: 'pointer',
                  padding: '4px',
                  borderRadius: '4px',
                  lineHeight: 1,
                }}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <form
              onSubmit={handleAddTask}
              style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}
            >
              <div>
                <label
                  style={{
                    display: 'block',
                    fontSize: '13px',
                    fontWeight: 600,
                    color: '#334155',
                    marginBottom: '6px',
                  }}
                >
                  Title
                </label>
                <input
                  type="text"
                  required
                  autoFocus
                  placeholder="e.g. Implement user activity log"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    border: '1px solid #cbd5e1',
                    fontSize: '14px',
                    outline: 'none',
                    boxSizing: 'border-box',
                    fontFamily: 'inherit',
                  }}
                />
              </div>

              <div>
                <label
                  style={{
                    display: 'block',
                    fontSize: '13px',
                    fontWeight: 600,
                    color: '#334155',
                    marginBottom: '6px',
                  }}
                >
                  Assignee
                </label>
                <input
                  type="text"
                  placeholder="e.g. Alex Chen"
                  value={newAssignee}
                  onChange={(e) => setNewAssignee(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    border: '1px solid #cbd5e1',
                    fontSize: '14px',
                    outline: 'none',
                    boxSizing: 'border-box',
                    fontFamily: 'inherit',
                  }}
                />
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '12px',
                }}
              >
                <div>
                  <label
                    style={{
                      display: 'block',
                      fontSize: '13px',
                      fontWeight: 600,
                      color: '#334155',
                      marginBottom: '6px',
                    }}
                  >
                    Priority
                  </label>
                  <select
                    value={newPriority}
                    onChange={(e) => setNewPriority(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: '6px',
                      border: '1px solid #cbd5e1',
                      fontSize: '14px',
                      outline: 'none',
                      backgroundColor: '#ffffff',
                      fontFamily: 'inherit',
                    }}
                  >
                    <option value="High">High</option>
                    <option value="Medium">Medium</option>
                    <option value="Low">Low</option>
                  </select>
                </div>

                <div>
                  <label
                    style={{
                      display: 'block',
                      fontSize: '13px',
                      fontWeight: 600,
                      color: '#334155',
                      marginBottom: '6px',
                    }}
                  >
                    Column
                  </label>
                  <select
                    value={newColumn}
                    onChange={(e) => setNewColumn(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: '6px',
                      border: '1px solid #cbd5e1',
                      fontSize: '14px',
                      outline: 'none',
                      backgroundColor: '#ffffff',
                      fontFamily: 'inherit',
                    }}
                  >
                    {COLUMNS.map((col) => (
                      <option key={col.id} value={col.id}>
                        {col.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: '10px',
                  marginTop: '12px',
                }}
              >
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  style={{
                    padding: '8px 16px',
                    borderRadius: '6px',
                    border: '1px solid #cbd5e1',
                    backgroundColor: '#ffffff',
                    color: '#475569',
                    fontSize: '14px',
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  style={{
                    padding: '8px 18px',
                    borderRadius: '6px',
                    border: 'none',
                    backgroundColor: '#2563eb',
                    color: '#ffffff',
                    fontSize: '14px',
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  Add task
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
