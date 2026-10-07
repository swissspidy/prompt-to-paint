import { useState } from 'react';

const INITIAL_TASKS = [
  {
    id: '1',
    title: 'Design system tokens & typography review',
    assignee: 'Elena Rostova',
    priority: 'High',
    column: 'Todo',
  },
  {
    id: '2',
    title: 'Research WebGL canvas performance bottlenecks',
    assignee: 'Marcus Chen',
    priority: 'Medium',
    column: 'Todo',
  },
  {
    id: '3',
    title: 'Integrate OAuth 2.0 social login flow',
    assignee: 'Sarah Jenkins',
    priority: 'High',
    column: 'In Progress',
  },
  {
    id: '4',
    title: 'Refactor navigation state management',
    assignee: 'Alex Rivera',
    priority: 'Low',
    column: 'In Progress',
  },
  {
    id: '5',
    title: 'Audit accessibility for checkout modal',
    assignee: 'David Kim',
    priority: 'Medium',
    column: 'Done',
  },
  {
    id: '6',
    title: 'Setup automated end-to-end test pipeline',
    assignee: 'Priya Patel',
    priority: 'Low',
    column: 'Done',
  },
];

const COLUMNS = ['Todo', 'In Progress', 'Done', 'Blocked'];

const PRIORITY_STYLES = {
  High: {
    bg: '#fef2f2',
    text: '#b91c1c',
    border: '#fecaca',
    dot: '#ef4444',
  },
  Medium: {
    bg: '#fffbeb',
    text: '#b45309',
    border: '#fde68a',
    dot: '#f59e0b',
  },
  Low: {
    bg: '#f0fdf4',
    text: '#15803d',
    border: '#bbf7d0',
    dot: '#22c55e',
  },
};

const COLUMN_THEMES = {
  Todo: {
    badgeBg: '#f1f5f9',
    badgeText: '#475569',
    dot: '#94a3b8',
  },
  'In Progress': {
    badgeBg: '#eff6ff',
    badgeText: '#1d4ed8',
    dot: '#3b82f6',
  },
  Done: {
    badgeBg: '#f0fdf4',
    badgeText: '#15803d',
    dot: '#22c55e',
  },
  Blocked: {
    badgeBg: '#fef2f2',
    badgeText: '#b91c1c',
    dot: '#ef4444',
  },
};

const AVATAR_COLORS = [
  { bg: '#e0e7ff', text: '#3730a3' },
  { bg: '#fce7f3', text: '#9d174d' },
  { bg: '#ccfbf1', text: '#115e59' },
  { bg: '#ffedd5', text: '#9a3412' },
  { bg: '#ede9fe', text: '#5b21b6' },
  { bg: '#fee2e2', text: '#991b1b' },
];

function getAvatarStyle(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % AVATAR_COLORS.length;
  return AVATAR_COLORS[index];
}

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(' ');
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function App() {
  const [tasks, setTasks] = useState(INITIAL_TASKS);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskAssignee, setNewTaskAssignee] = useState('');
  const [newTaskPriority, setNewTaskPriority] = useState('Medium');
  const [newTaskColumn, setNewTaskColumn] = useState('Todo');
  const [searchQuery, setSearchQuery] = useState('');

  const handleOpenModal = (defaultCol = 'Todo') => {
    setNewTaskColumn(defaultCol);
    setNewTaskTitle('');
    setNewTaskAssignee('');
    setNewTaskPriority('Medium');
    setIsModalOpen(true);
  };

  const handleAddTask = (e) => {
    e.preventDefault();
    if (!newTaskTitle.trim()) return;

    const newTask = {
      id: Date.now().toString(),
      title: newTaskTitle.trim(),
      assignee: newTaskAssignee.trim() || 'Unassigned',
      priority: newTaskPriority,
      column: newTaskColumn,
    };

    setTasks((prev) => [...prev, newTask]);
    setIsModalOpen(false);
    setNewTaskTitle('');
    setNewTaskAssignee('');
  };

  const handleMoveTask = (taskId, targetColumn) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, column: targetColumn } : t))
    );
  };

  const handleDeleteTask = (taskId) => {
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
  };

  const filteredTasks = tasks.filter((t) => {
    if (!searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase();
    return (
      t.title.toLowerCase().includes(query) ||
      t.assignee.toLowerCase().includes(query) ||
      t.priority.toLowerCase().includes(query)
    );
  });

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', backgroundColor: '#f8fafc' }}>
      {/* Top Header */}
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
          boxShadow: '0 2px 4px rgba(37, 99, 235, 0.15)',
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
              border: '1px solid rgba(255, 255, 255, 0.3)',
            }}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#ffffff"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(-30 12 12)" />
            </svg>
          </div>
          <div>
            <h1
              style={{
                fontSize: '22px',
                fontWeight: '700',
                color: '#ffffff',
                letterSpacing: '-0.02em',
                margin: 0,
                lineHeight: 1.2,
              }}
            >
              Orbit
            </h1>
            <p
              style={{
                margin: '2px 0 0 0',
                fontSize: '13px',
                fontWeight: '500',
                color: '#dbeafe',
                letterSpacing: '0.01em',
              }}
            >
              Sprint 14
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ position: 'relative' }}>
            <input
              type="text"
              placeholder="Filter tasks..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                padding: '8px 12px 8px 34px',
                fontSize: '13px',
                borderRadius: '8px',
                border: '1px solid rgba(255, 255, 255, 0.3)',
                outline: 'none',
                width: '180px',
                backgroundColor: 'rgba(255, 255, 255, 0.95)',
                color: '#0f172a',
                transition: 'all 0.15s ease',
              }}
              onFocus={(e) => {
                e.target.style.backgroundColor = '#ffffff';
                e.target.style.width = '220px';
              }}
              onBlur={(e) => {
                e.target.style.backgroundColor = 'rgba(255, 255, 255, 0.95)';
                e.target.style.width = '180px';
              }}
            />
            <svg
              style={{
                position: 'absolute',
                left: '10px',
                top: '50%',
                transform: 'translateY(-50%)',
                color: '#64748b',
                pointerEvents: 'none',
              }}
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </div>

          <button
            onClick={() => handleOpenModal('Todo')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              backgroundColor: '#ffffff',
              color: '#2563eb',
              padding: '9px 18px',
              borderRadius: '8px',
              fontSize: '13px',
              fontWeight: '600',
              border: 'none',
              cursor: 'pointer',
              boxShadow: '0 1px 3px rgba(0, 0, 0, 0.1)',
              transition: 'all 0.15s ease',
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

      {/* Main Board Container */}
      <main
        style={{
          flex: 1,
          padding: '28px 32px',
          maxWidth: '1440px',
          width: '100%',
          margin: '0 auto',
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
          {COLUMNS.map((column) => {
            const columnTasks = filteredTasks.filter((t) => t.column === column);
            const theme = COLUMN_THEMES[column];

            return (
              <div
                key={column}
                style={{
                  backgroundColor: '#f1f5f9',
                  borderRadius: '12px',
                  padding: '16px',
                  minHeight: '480px',
                  display: 'flex',
                  flexDirection: 'column',
                  border: '1px solid #e2e8f0',
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
                    <div
                      style={{
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        backgroundColor: theme.dot,
                      }}
                    />
                    <h2
                      style={{
                        fontSize: '15px',
                        fontWeight: '700',
                        color: '#1e293b',
                        margin: 0,
                      }}
                    >
                      {column}
                    </h2>
                    <span
                      style={{
                        fontSize: '12px',
                        fontWeight: '600',
                        backgroundColor: theme.badgeBg,
                        color: theme.badgeText,
                        padding: '2px 8px',
                        borderRadius: '10px',
                        marginLeft: '4px',
                      }}
                    >
                      {columnTasks.length}
                    </span>
                  </div>

                  <button
                    onClick={() => handleOpenModal(column)}
                    title={`Add task to ${column}`}
                    style={{
                      border: 'none',
                      background: 'none',
                      color: '#64748b',
                      cursor: 'pointer',
                      padding: '4px',
                      borderRadius: '6px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      transition: 'background-color 0.15s ease',
                    }}
                    onMouseOver={(e) => {
                      e.currentTarget.style.backgroundColor = '#e2e8f0';
                      e.currentTarget.style.color = '#0f172a';
                    }}
                    onMouseOut={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent';
                      e.currentTarget.style.color = '#64748b';
                    }}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </button>
                </div>

                {/* Task Cards List */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', flex: 1 }}>
                  {columnTasks.map((task) => {
                    const priorityStyle = PRIORITY_STYLES[task.priority] || PRIORITY_STYLES.Medium;
                    const avatarStyle = getAvatarStyle(task.assignee);

                    return (
                      <div
                        key={task.id}
                        style={{
                          backgroundColor: '#ffffff',
                          borderRadius: '10px',
                          padding: '16px',
                          boxShadow: '0 1px 3px rgba(0, 0, 0, 0.05), 0 1px 2px rgba(0, 0, 0, 0.03)',
                          border: '1px solid #e2e8f0',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '12px',
                          position: 'relative',
                          transition: 'transform 0.15s ease, box-shadow 0.15s ease',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.transform = 'translateY(-2px)';
                          e.currentTarget.style.boxShadow =
                            '0 4px 6px -1px rgba(0, 0, 0, 0.08), 0 2px 4px -1px rgba(0, 0, 0, 0.04)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.transform = 'translateY(0)';
                          e.currentTarget.style.boxShadow =
                            '0 1px 3px rgba(0, 0, 0, 0.05), 0 1px 2px rgba(0, 0, 0, 0.03)';
                        }}
                      >
                        {/* Priority Badge & Card Header */}
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                          }}
                        >
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '5px',
                              fontSize: '11px',
                              fontWeight: '600',
                              padding: '2px 8px',
                              borderRadius: '6px',
                              backgroundColor: priorityStyle.bg,
                              color: priorityStyle.text,
                              border: `1px solid ${priorityStyle.border}`,
                              letterSpacing: '0.02em',
                            }}
                          >
                            <span
                              style={{
                                width: '5px',
                                height: '5px',
                                borderRadius: '50%',
                                backgroundColor: priorityStyle.dot,
                              }}
                            />
                            {task.priority}
                          </span>

                          {/* Quick Column Movement / Action */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <select
                              value={task.column}
                              onChange={(e) => handleMoveTask(task.id, e.target.value)}
                              style={{
                                fontSize: '11px',
                                color: '#64748b',
                                border: '1px solid #e2e8f0',
                                borderRadius: '6px',
                                padding: '2px 4px',
                                backgroundColor: '#f8fafc',
                                cursor: 'pointer',
                                outline: 'none',
                              }}
                              title="Move to column"
                            >
                              {COLUMNS.map((col) => (
                                <option key={col} value={col}>
                                  {col}
                                </option>
                              ))}
                            </select>

                            <button
                              onClick={() => handleDeleteTask(task.id)}
                              title="Delete task"
                              style={{
                                background: 'none',
                                border: 'none',
                                color: '#94a3b8',
                                cursor: 'pointer',
                                padding: '2px 4px',
                                borderRadius: '4px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                              onMouseOver={(e) => (e.currentTarget.style.color = '#ef4444')}
                              onMouseOut={(e) => (e.currentTarget.style.color = '#94a3b8')}
                            >
                              <svg
                                width="13"
                                height="13"
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
                        </div>

                        {/* Title */}
                        <div
                          style={{
                            fontSize: '14px',
                            fontWeight: '600',
                            color: '#1e293b',
                            lineHeight: 1.4,
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
                            paddingTop: '6px',
                            borderTop: '1px solid #f1f5f9',
                          }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                            }}
                          >
                            <div
                              style={{
                                width: '24px',
                                height: '24px',
                                borderRadius: '50%',
                                backgroundColor: avatarStyle.bg,
                                color: avatarStyle.text,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: '10px',
                                fontWeight: '700',
                                border: '1px solid rgba(0,0,0,0.06)',
                              }}
                            >
                              {getInitials(task.assignee)}
                            </div>
                            <span
                              style={{
                                fontSize: '12px',
                                fontWeight: '500',
                                color: '#475569',
                              }}
                            >
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
                        border: '2px dashed #e2e8f0',
                        borderRadius: '8px',
                        marginTop: '8px',
                      }}
                    >
                      No tasks in this column
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
            backgroundColor: 'rgba(15, 23, 42, 0.45)',
            backdropFilter: 'blur(3px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
            padding: '16px',
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsModalOpen(false);
          }}
        >
          <div
            style={{
              backgroundColor: '#ffffff',
              borderRadius: '14px',
              width: '100%',
              maxWidth: '460px',
              padding: '24px',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
              border: '1px solid #e2e8f0',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '18px',
              }}
            >
              <h3
                style={{
                  fontSize: '17px',
                  fontWeight: '700',
                  color: '#0f172a',
                  margin: 0,
                }}
              >
                Add New Task
              </h3>
              <button
                onClick={() => setIsModalOpen(false)}
                style={{
                  border: 'none',
                  background: 'none',
                  cursor: 'pointer',
                  color: '#94a3b8',
                  padding: '4px',
                  borderRadius: '6px',
                }}
                onMouseOver={(e) => (e.currentTarget.style.color = '#0f172a')}
                onMouseOut={(e) => (e.currentTarget.style.color = '#94a3b8')}
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

            <form onSubmit={handleAddTask}>
              <div style={{ marginBottom: '14px' }}>
                <label
                  style={{
                    display: 'block',
                    fontSize: '13px',
                    fontWeight: '600',
                    color: '#334155',
                    marginBottom: '6px',
                  }}
                >
                  Task Title *
                </label>
                <input
                  type="text"
                  placeholder="e.g. Design system tokens"
                  value={newTaskTitle}
                  onChange={(e) => setNewTaskTitle(e.target.value)}
                  autoFocus
                  required
                  style={{
                    width: '100%',
                    padding: '9px 12px',
                    borderRadius: '8px',
                    border: '1px solid #cbd5e1',
                    fontSize: '14px',
                    outline: 'none',
                    backgroundColor: '#f8fafc',
                  }}
                  onFocus={(e) => (e.target.style.borderColor = '#4f46e5')}
                  onBlur={(e) => (e.target.style.borderColor = '#cbd5e1')}
                />
              </div>

              <div style={{ marginBottom: '14px' }}>
                <label
                  style={{
                    display: 'block',
                    fontSize: '13px',
                    fontWeight: '600',
                    color: '#334155',
                    marginBottom: '6px',
                  }}
                >
                  Assignee
                </label>
                <input
                  type="text"
                  placeholder="e.g. Elena Rostova"
                  value={newTaskAssignee}
                  onChange={(e) => setNewTaskAssignee(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '9px 12px',
                    borderRadius: '8px',
                    border: '1px solid #cbd5e1',
                    fontSize: '14px',
                    outline: 'none',
                    backgroundColor: '#f8fafc',
                  }}
                  onFocus={(e) => (e.target.style.borderColor = '#4f46e5')}
                  onBlur={(e) => (e.target.style.borderColor = '#cbd5e1')}
                />
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '12px',
                  marginBottom: '22px',
                }}
              >
                <div>
                  <label
                    style={{
                      display: 'block',
                      fontSize: '13px',
                      fontWeight: '600',
                      color: '#334155',
                      marginBottom: '6px',
                    }}
                  >
                    Priority
                  </label>
                  <select
                    value={newTaskPriority}
                    onChange={(e) => setNewTaskPriority(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '9px 10px',
                      borderRadius: '8px',
                      border: '1px solid #cbd5e1',
                      fontSize: '13px',
                      outline: 'none',
                      backgroundColor: '#f8fafc',
                      cursor: 'pointer',
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
                      fontWeight: '600',
                      color: '#334155',
                      marginBottom: '6px',
                    }}
                  >
                    Column
                  </label>
                  <select
                    value={newTaskColumn}
                    onChange={(e) => setNewTaskColumn(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '9px 10px',
                      borderRadius: '8px',
                      border: '1px solid #cbd5e1',
                      fontSize: '13px',
                      outline: 'none',
                      backgroundColor: '#f8fafc',
                      cursor: 'pointer',
                    }}
                  >
                    {COLUMNS.map((col) => (
                      <option key={col} value={col}>
                        {col}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  style={{
                    padding: '8px 16px',
                    borderRadius: '8px',
                    fontSize: '13px',
                    fontWeight: '600',
                    color: '#475569',
                    backgroundColor: '#f1f5f9',
                    border: '1px solid #e2e8f0',
                    cursor: 'pointer',
                  }}
                  onMouseOver={(e) => (e.currentTarget.style.backgroundColor = '#e2e8f0')}
                  onMouseOut={(e) => (e.currentTarget.style.backgroundColor = '#f1f5f9')}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  style={{
                    padding: '8px 18px',
                    borderRadius: '8px',
                    fontSize: '13px',
                    fontWeight: '600',
                    color: '#ffffff',
                    backgroundColor: '#4f46e5',
                    border: 'none',
                    cursor: 'pointer',
                    boxShadow: '0 1px 2px rgba(79, 70, 229, 0.3)',
                  }}
                  onMouseOver={(e) => (e.currentTarget.style.backgroundColor = '#4338ca')}
                  onMouseOut={(e) => (e.currentTarget.style.backgroundColor = '#4f46e5')}
                >
                  Create Task
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
