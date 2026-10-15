import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { CalendarClock, Plus, Trash, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../components/toast.jsx';
import { AppIcon, Button, ease, Field, Segmented, Sheet } from '../components/ui.jsx';
import { plural, timeAgo } from '../format.js';
import { PlatformIcon, PLATFORMS, platformById } from '../platforms.jsx';

const COLUMNS = [
  { id: 'pending', label: 'Pending', hint: 'Requested, not started' },
  { id: 'in_progress', label: 'In Progress', hint: 'Being worked on' },
  { id: 'completed', label: 'Completed', hint: 'Done and shipped' },
];
const GAP = 1024;

// Spread tasks into ordered id lists per column.
function toColumns(tasks) {
  const cols = Object.fromEntries(COLUMNS.map((c) => [c.id, []]));
  for (const t of [...tasks].sort((a, b) => a.order - b.order)) cols[t.status]?.push(t.id);
  return cols;
}

// Date filter presets, per field.
const DATE_PRESETS = {
  created: [
    { id: 'any', label: 'Any time' },
    { id: 'today', label: 'Today' },
    { id: '7d', label: 'Last 7 days' },
    { id: '30d', label: 'Last 30 days' },
    { id: 'custom', label: 'Custom range…' },
  ],
  due: [
    { id: 'any', label: 'Any time' },
    { id: 'overdue', label: 'Overdue' },
    { id: 'today', label: 'Due today' },
    { id: 'next7', label: 'Next 7 days' },
    { id: 'none', label: 'No due date' },
    { id: 'custom', label: 'Custom range…' },
  ],
};

function matchesDate(task, field, preset, from, to) {
  if (preset === 'any') return true;
  const now = Date.now();
  const today = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  const day = 24 * 3600e3;
  const value = field === 'created' ? task.createdAt : task.dueAt;
  if (preset === 'none') return !task.dueAt;
  if (!value) return false;
  const at = new Date(value).getTime();
  switch (preset) {
    case 'today':
      return at >= today && at < today + day;
    case '7d':
      return at >= now - 7 * day;
    case '30d':
      return at >= now - 30 * day;
    case 'overdue':
      return at < now && task.status !== 'completed';
    case 'next7':
      return at >= now && at <= now + 7 * day;
    case 'custom':
      return (!from || at >= new Date(from).getTime()) && (!to || at <= new Date(to).getTime());
    default:
      return true;
  }
}

const columnOf = (cols, id) => (cols[id] ? id : Object.keys(cols).find((k) => cols[k].includes(id)));

export const PRIORITIES = [
  { id: 'urgent', label: 'Urgent', marks: '!!!' },
  { id: 'high', label: 'High', marks: '!!' },
  { id: 'medium', label: 'Medium', marks: '!' },
  { id: 'low', label: 'Low', marks: '' },
];
const priorityOf = (id) => PRIORITIES.find((p) => p.id === id) || PRIORITIES[2];

const DAY = 24 * 3600e3;
const startOfToday = () => new Date(new Date().setHours(0, 0, 0, 0)).getTime();

function dueState(task) {
  if (!task.dueAt) return null;
  const due = new Date(task.dueAt).getTime();
  const now = Date.now();
  if (task.status === 'completed') return 'done';
  if (due < now) return 'overdue';
  if (due - now < DAY) return 'soon';
  return 'later';
}

function formatDue(iso) {
  const d = new Date(iso);
  const today = startOfToday();
  const day = new Date(d).setHours(0, 0, 0, 0);
  const time = d.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' });
  if (day === today) return `Today ${time}`;
  if (day === today + DAY) return `Tomorrow ${time}`;
  if (day === today - DAY) return `Yesterday ${time}`;
  return `${d.toLocaleDateString('en', { day: 'numeric', month: 'short' })} ${time}`;
}

function PriorityTag({ priority }) {
  const p = priorityOf(priority);
  if (p.id === 'medium' || p.id === 'low') return null; // only the ones that need attention get a tag
  return (
    <span className={`tag tag-priority is-${p.id}`}>
      <span className="priority-marks" aria-hidden="true">
        {p.marks}
      </span>
      {p.label}
    </span>
  );
}

function DueTag({ task }) {
  const state = dueState(task);
  if (!state) return null;
  const label = state === 'overdue' ? `Overdue · ${formatDue(task.dueAt)}` : state === 'done' ? `Was due ${formatDue(task.dueAt)}` : `Due ${formatDue(task.dueAt)}`;
  return (
    <span className={`tag tag-due is-${state}`} title={new Date(task.dueAt).toLocaleString()}>
      <CalendarClock size={12} strokeWidth={2.4} />
      {label}
    </span>
  );
}

function TaskTags({ task, client }) {
  const priority = priorityOf(task.priority);
  const showPriority = priority.id === 'urgent' || priority.id === 'high';
  if (!client && !task.platform && !showPriority && !task.dueAt) return null;
  return (
    <div className="task-tags">
      <PriorityTag priority={task.priority} />
      <DueTag task={task} />
      {client && (
        <span className="tag tag-client">
          <AppIcon name={client.name} size={16} />
          {client.name}
        </span>
      )}
      {task.platform && (
        <span className="tag">
          <PlatformIcon id={task.platform} size={12} />
          {platformById(task.platform).label}
        </span>
      )}
    </div>
  );
}

function TaskCard({ task, client, overlay = false, onOpen }) {
  return (
    <div className={`task-card ${overlay ? 'is-lifted' : ''} is-${task.status} priority-${task.priority || 'medium'}`} onClick={onOpen}>
      <TaskTags task={task} client={client} />
      <h4>{task.title}</h4>
      {task.details && <p>{task.details}</p>}
      <footer>
        <span className="task-author">{task.createdBy[0].toUpperCase()}</span>
        <span>
          {task.status === 'completed' && task.completedAt ? `Completed ${timeAgo(task.completedAt)}` : `${task.createdBy} · ${timeAgo(task.createdAt)}`}
        </span>
      </footer>
    </div>
  );
}

function SortableTask({ task, client, onOpen }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
  // dnd-kit owns this element's transform while dragging; the entrance animation lives one level in.
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`task-slot ${isDragging ? 'is-placeholder' : ''}`}
      {...attributes}
      {...listeners}
      aria-roledescription="Draggable card. Press space to pick up, Enter to open."
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !isDragging) onOpen();
        listeners?.onKeyDown?.(e);
      }}
    >
      <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.15 } }} transition={{ duration: 0.3, ease }}>
        <TaskCard task={task} client={client} onOpen={onOpen} />
      </motion.div>
    </div>
  );
}

function Column({ column, ids, tasks, clients, onAdd, onOpen }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  return (
    <section className={`board-col col-${column.id} ${isOver ? 'is-over' : ''}`} aria-label={column.label}>
      <header className="board-col-head">
        <span className="col-dot" />
        <h2>{column.label}</h2>
        <span className="col-count">{ids.length}</span>
        <button type="button" className="icon-btn" onClick={() => onAdd(column.id)} aria-label={`Add a card to ${column.label}`} title={`Add to ${column.label}`}>
          <Plus size={18} strokeWidth={2.4} />
        </button>
      </header>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} className="board-col-body">
          <AnimatePresence initial={false}>
            {ids.map((id) => (
              <SortableTask key={id} task={tasks[id]} client={clients[tasks[id].clientId]} onOpen={() => onOpen(tasks[id])} />
            ))}
          </AnimatePresence>
          {ids.length === 0 && <p className="col-empty">{column.hint}. Drop a card here.</p>}
        </div>
      </SortableContext>
    </section>
  );
}

// ISO time -> the local "YYYY-MM-DDTHH:mm" a datetime-local input expects.
function toLocalInput(iso) {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function TaskSheet({ draft, clients, onClose, onSaved, onDeleted }) {
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [clientId, setClientId] = useState('');
  const [platform, setPlatform] = useState('none');
  const [status, setStatus] = useState('pending');
  const [priority, setPriority] = useState('medium');
  const [due, setDue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isNew = !draft?.id;

  useEffect(() => {
    if (!draft) return;
    setTitle(draft.title || '');
    setDetails(draft.details || '');
    setClientId(draft.clientId || '');
    setPlatform(draft.platform || 'none');
    setStatus(draft.status || 'pending');
    setPriority(draft.priority || 'medium');
    setDue(draft.dueAt ? toLocalInput(draft.dueAt) : '');
    setError('');
    setBusy(false);
    setConfirmDelete(false);
  }, [draft]);

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const body = {
      title,
      details,
      clientId: clientId || null,
      platform: platform === 'none' ? null : platform,
      status,
      priority,
      dueAt: due ? new Date(due).toISOString() : null,
    };
    try {
      const { task } = isNew ? await api('/tasks', { method: 'POST', body }) : await api(`/tasks/${draft.id}`, { method: 'PATCH', body });
      onSaved(task, isNew);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirmDelete) return setConfirmDelete(true);
    setBusy(true);
    try {
      await api(`/tasks/${draft.id}`, { method: 'DELETE' });
      onDeleted(draft.id);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const sortedClients = Object.values(clients).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <Sheet open={Boolean(draft)} onClose={onClose} title={isNew ? 'New Card' : 'Edit Card'} subtitle={isNew ? 'Describe the change and tag the client it is for.' : `Added by ${draft?.createdBy} ${timeAgo(draft?.createdAt)}`} width={520}>
      <form onSubmit={onSubmit} className="sheet-body">
        <Field label="Title" error={error}>
          {(id) => <input id={id} className="input" placeholder="Add retry when the PACS is offline" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus />}
        </Field>
        <Field label="Details">
          {(id) => <textarea id={id} className="input textarea" rows={4} placeholder="Optional. Steps, site, who asked for it." value={details} onChange={(e) => setDetails(e.target.value)} maxLength={4000} />}
        </Field>
        <Field label="Client">
          {(id) => (
            <select id={id} className="input select" value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">No client</option>
              {sortedClients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div className="field">
          <span className="field-label">Platform</span>
          <Segmented
            label="Platform"
            size="sm"
            value={platform}
            onChange={setPlatform}
            options={[{ id: 'none', label: 'Any' }, ...PLATFORMS.map((p) => ({ id: p.id, label: p.label, icon: <PlatformIcon id={p.id} size={13} /> }))]}
          />
        </div>
        <div className="field">
          <span className="field-label">Priority</span>
          <Segmented label="Priority" size="sm" value={priority} onChange={setPriority} options={PRIORITIES.map((p) => ({ id: p.id, label: p.label }))} />
        </div>
        <Field label="Due" hint="Optional. Shown on the card, red once it has passed.">
          {(id) => (
            <div className="due-input">
              <input id={id} className="input" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
              {due && (
                <button type="button" className="icon-btn" onClick={() => setDue('')} aria-label="Clear the due date">
                  <X size={16} strokeWidth={2.4} />
                </button>
              )}
            </div>
          )}
        </Field>
        <div className="field">
          <span className="field-label">Status</span>
          <Segmented label="Status" size="sm" value={status} onChange={setStatus} options={COLUMNS.map((c) => ({ id: c.id, label: c.label }))} />
        </div>
        <div className="sheet-actions">
          {!isNew && (
            <Button variant={confirmDelete ? 'danger' : 'plain'} icon={Trash} onClick={remove} disabled={busy} className="sheet-action-left">
              {confirmDelete ? 'Delete Card?' : 'Delete'}
            </Button>
          )}
          <Button variant="plain" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy} disabled={!title.trim()}>
            {isNew ? 'Add Card' : 'Save'}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

export default function Board() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [tasks, setTasks] = useState(null); // id -> task
  const [clients, setClients] = useState({}); // id -> client
  const [columns, setColumns] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState('');
  const dragFrom = useRef(null);
  const lastDrop = useRef(0); // the click that ends a drag must not open the card
  const filter = params.get('client') || 'all';
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [dateField, setDateField] = useState('created');
  const [datePreset, setDatePreset] = useState('any');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const filtering = priorityFilter !== 'all' || datePreset !== 'any';
  const clearFilters = () => {
    setPriorityFilter('all');
    setDatePreset('any');
    setFrom('');
    setTo('');
  };

  const load = useCallback(async () => {
    try {
      const [t, c] = await Promise.all([api('/tasks'), api('/clients')]);
      setTasks(Object.fromEntries(t.tasks.map((x) => [x.id, x])));
      setClients(Object.fromEntries(c.clients.map((x) => [x.id, x])));
      setColumns(toColumns(t.tasks));
    } catch (err) {
      setError(err.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 160, tolerance: 6 } }),
    // Space picks a card up and drops it; Enter is left free to open the card.
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] } }),
  );

  // Columns shown after the client filter; drag and drop works on the filtered view.
  const visible = useMemo(() => {
    if (!columns) return null;
    const keep = (t) =>
      t &&
      (filter === 'all' || t.clientId === filter) &&
      (priorityFilter === 'all' || (t.priority || 'medium') === priorityFilter) &&
      matchesDate(t, dateField, datePreset, from, to);
    return Object.fromEntries(Object.entries(columns).map(([k, ids]) => [k, ids.filter((id) => keep(tasks[id]))]));
  }, [columns, filter, tasks, priorityFilter, dateField, datePreset, from, to]);
  const shownCount = visible ? Object.values(visible).reduce((n, ids) => n + ids.length, 0) : 0;
  const totalCount = Object.keys(tasks || {}).length;

  function onDragStart({ active }) {
    setActiveId(active.id);
    dragFrom.current = columnOf(columns, active.id);
  }

  // Moving across columns happens live while dragging, so the gap opens where the card will land.
  function onDragOver({ active, over }) {
    if (!over) return;
    setColumns((cols) => {
      const from = columnOf(cols, active.id);
      const to = columnOf(cols, over.id);
      if (!from || !to || from === to) return cols;
      const target = cols[to];
      const overIndex = target.indexOf(over.id);
      const index = overIndex >= 0 ? overIndex : target.length;
      return {
        ...cols,
        [from]: cols[from].filter((id) => id !== active.id),
        [to]: [...target.slice(0, index), active.id, ...target.slice(index)],
      };
    });
  }

  async function onDragEnd({ active, over }) {
    setActiveId(null);
    lastDrop.current = Date.now();
    if (!over) {
      setColumns(toColumns(Object.values(tasks)));
      return;
    }
    let next = columns;
    const col = columnOf(columns, active.id);
    const oldIndex = columns[col].indexOf(active.id);
    const newIndex = columns[col].indexOf(over.id);
    if (newIndex >= 0 && oldIndex !== newIndex) {
      next = { ...columns, [col]: arrayMove(columns[col], oldIndex, newIndex) };
      setColumns(next);
    }

    // New position halfway between the neighbours it landed between.
    const ids = next[col];
    const at = ids.indexOf(active.id);
    const before = tasks[ids[at - 1]]?.order;
    const after = tasks[ids[at + 1]]?.order;
    const order = before !== undefined && after !== undefined ? (before + after) / 2 : before !== undefined ? before + GAP : after !== undefined ? after - GAP : GAP;

    const task = tasks[active.id];
    if (task.status === col && task.order === order) return;
    const moved = { ...task, status: col, order };
    setTasks((all) => ({ ...all, [task.id]: moved }));
    try {
      const { task: saved } = await api(`/tasks/${task.id}`, { method: 'PATCH', body: { status: col, order } });
      setTasks((all) => ({ ...all, [saved.id]: saved }));
      if (dragFrom.current !== col) toast(`Moved to ${COLUMNS.find((c) => c.id === col).label}`);
    } catch (err) {
      toast(err.message, 'error');
      load();
    }
  }

  const counts = useMemo(() => {
    const out = {};
    for (const t of Object.values(tasks || {})) if (t.clientId && t.status !== 'completed') out[t.clientId] = (out[t.clientId] || 0) + 1;
    return out;
  }, [tasks]);
  const taggedClients = Object.values(clients)
    .filter((c) => counts[c.id] || c.id === filter)
    .sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0) || a.name.localeCompare(b.name));
  const open = Object.values(tasks || {}).filter((t) => t.status !== 'completed').length;

  return (
    <>
      <header className="large-header">
        <div>
          <p className="eyebrow">Changes and requests</p>
          <h1>Board</h1>
          <p className="page-sub">{tasks ? `${plural(open, 'open card')} · drag cards between columns` : ' '}</p>
        </div>
        <div className="header-tools">
          <Button icon={Plus} onClick={() => setDraft({ status: 'pending', clientId: filter !== 'all' ? filter : '' })}>
            New Card
          </Button>
        </div>
      </header>

      {error && <p className="load-error">{error}</p>}

      {tasks && (
        <div className="chip-row" role="tablist" aria-label="Filter by client">
          <button type="button" role="tab" aria-selected={filter === 'all'} className={`chip ${filter === 'all' ? 'is-active' : ''}`} onClick={() => setParams({})}>
            All clients
          </button>
          {taggedClients.map((c) => (
            <button key={c.id} type="button" role="tab" aria-selected={filter === c.id} className={`chip ${filter === c.id ? 'is-active' : ''}`} onClick={() => setParams({ client: c.id })}>
              <AppIcon name={c.name} size={18} />
              {c.name}
              {counts[c.id] ? <span className="chip-count">{counts[c.id]}</span> : null}
            </button>
          ))}
        </div>
      )}

      {tasks && (
        <div className="filter-row">
          <Segmented
            label="Priority"
            size="sm"
            value={priorityFilter}
            onChange={setPriorityFilter}
            options={[{ id: 'all', label: 'Any priority' }, ...PRIORITIES.map((p) => ({ id: p.id, label: p.label }))]}
          />
          <div className="date-filter">
            <Segmented
              label="Filter by"
              size="sm"
              value={dateField}
              onChange={(v) => {
                setDateField(v);
                setDatePreset('any');
              }}
              options={[
                { id: 'created', label: 'Created' },
                { id: 'due', label: 'Due' },
              ]}
            />
            <select id="date-preset" className="input select select-sm" aria-label="Date range" value={datePreset} onChange={(e) => setDatePreset(e.target.value)}>
              {DATE_PRESETS[dateField].map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            {datePreset === 'custom' && (
              <span className="date-range">
                <input id="date-from" className="input input-sm" type="datetime-local" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} />
                <span>to</span>
                <input id="date-to" className="input input-sm" type="datetime-local" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} />
              </span>
            )}
          </div>
          {filtering && (
            <span className="filter-summary">
              {shownCount} of {plural(totalCount, 'card')}
              <button type="button" className="link" onClick={clearFilters}>
                Clear
              </button>
            </span>
          )}
        </div>
      )}

      {!visible && !error && (
        <div className="board">
          {COLUMNS.map((c) => (
            <div key={c.id} className="board-col skeleton" style={{ minHeight: 360 }} />
          ))}
        </div>
      )}

      {visible && (
        <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => (setActiveId(null), setColumns(toColumns(Object.values(tasks))))}>
          <motion.div className="board" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease }}>
            {COLUMNS.map((c) => (
              <Column
                key={c.id}
                column={c}
                ids={visible[c.id]}
                tasks={tasks}
                clients={clients}
                onAdd={(status) => setDraft({ status, clientId: filter !== 'all' ? filter : '' })}
                onOpen={(task) => Date.now() - lastDrop.current > 250 && setDraft(task)}
              />
            ))}
          </motion.div>
          <DragOverlay dropAnimation={{ duration: 260, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }}>
            {activeId ? <TaskCard task={tasks[activeId]} client={clients[tasks[activeId].clientId]} overlay /> : null}
          </DragOverlay>
        </DndContext>
      )}

      <TaskSheet
        draft={draft}
        clients={clients}
        onClose={() => setDraft(null)}
        onSaved={(task, isNew) => {
          setDraft(null);
          const all = { ...tasks, [task.id]: task };
          setTasks(all);
          setColumns(toColumns(Object.values(all)));
          toast(isNew ? 'Card added' : 'Card updated');
        }}
        onDeleted={(id) => {
          setDraft(null);
          const { [id]: _gone, ...rest } = tasks;
          setTasks(rest);
          setColumns(toColumns(Object.values(rest)));
          toast('Card deleted');
        }}
      />
    </>
  );
}
