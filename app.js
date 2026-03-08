const STORAGE_KEY = 'portal-kanban-simple-v9';
const HISTORY_KEY = 'portal-kanban-simple-history';

const SUPABASE_URL = 'https://elkfckeosvthamsguhaz.supabase.co';
const SUPABASE_KEY = 'sb_publishable_LQurPTAlhxOtE30zXac65g_ojKmI7Nw';

const realtimeClient =
  typeof window !== 'undefined' && window.supabase
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

let realtimeChannel = null;
let remoteRefreshTimer;

const board = document.getElementById('board');
const addProjectButton = document.getElementById('add-project-button');
const undoButton = document.getElementById('undo-button');
const importButton = document.getElementById('import-button');
const newProjectPanel = document.getElementById('new-project-panel');
const newProjectForm = document.getElementById('new-project-form');
const newProjectCancel = document.getElementById('new-project-cancel');
const newProjectName = document.getElementById('new-project-name');
const projectList = document.getElementById('project-list');
const projectFilter = document.getElementById('project-filter');
const assigneeStats = document.getElementById('assignee-stats');
const projectSearch = document.getElementById('project-search');
const syncStatus = document.getElementById('sync-status');
const syncText = document.getElementById('sync-text');
const syncTime = document.getElementById('sync-time');

const assigneeClassMap = {
  Валерия: 'assignee-valeriya',
  Аня: 'assignee-anya',
  Лиза: 'assignee-liza',
};

const assigneeColors = {
  Валерия: 'valeriya',
  Аня: 'anya',
  Лиза: 'liza',
};

const columnDefinitions = [
  { id: 'col-team', title: 'В работе у команды' },
  { id: 'col-me', title: 'Мяч у меня' },
  { id: 'col-client', title: 'Жду клиента' },
  { id: 'col-final', title: 'Финал' },
];

const initialData = {
  columns: {
    'col-team': [
      {
        project: 'Алла и Радион',
        task: 'Аня вносит дополнения из интервью с Инной и готовит доки изменений.',
        assignee: 'Аня',
      },
      {
        project: 'Сивковы',
        task: 'Первый драфт текста + вопросы для второго интервью.',
        assignee: 'Аня',
      },
      {
        project: 'Путь Камино Гриши',
        task: 'Переделка дизайна.',
        assignee: 'Лиза',
      },
    ],
    'col-me': [
      {
        project: 'Пискуновы (книга года)',
        task: 'Договориться об интервью.',
        assignee: 'Валерия',
      },
      {
        project: 'Яша — 1 год',
        task: 'Написать / собрать текст.',
        assignee: 'Валерия',
      },
      {
        project: 'Зина и Борис',
        task: 'Обработать фотосессию и прислать в проект.',
        assignee: 'Валерия',
      },
    ],
    'col-client': [
      {
        project: 'Зина и Борис',
        task: 'Ждём согласование дизайна. Параллельно — редактирование всей съёмки семьи.',
        assignee: 'Валерия',
      },
    ],
    'col-final': [],
  },
  projects: [
    'Алла и Радион',
    'Сивковы',
    'Путь Камино Гриши',
    'Пискуновы (книга года)',
    'Яша — 1 год',
    'Зина и Борис',
  ],
  filter: 'all',
  search: '',
};

let projects = [];
let currentFilter = 'all';
let currentSearch = '';
let knownTaskIds = new Set();
let syncInProgress = false;
let boardDirty = false;

const normalizeName = (value) => value.trim();

const supabaseFetch = async (path, options = {}) => {
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'Supabase error');
  }
  if (response.status === 204) return null;
  return response.json();
};

const fetchTasks = async () =>
  supabaseFetch('/rest/v1/tasks?select=*&order=column_id,sort_index,created_at');

const fetchProjects = async () =>
  supabaseFetch('/rest/v1/projects?select=name&order=created_at');

const insertTask = async (task) =>
  supabaseFetch('/rest/v1/tasks', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(task),
  });

const updateTask = async (id, updates) =>
  supabaseFetch(`/rest/v1/tasks?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });

const deleteTask = async (id) =>
  supabaseFetch(`/rest/v1/tasks?id=eq.${id}`, {
    method: 'DELETE',
  });

const insertProject = async (name) =>
  supabaseFetch('/rest/v1/projects', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ name }),
  });

const buildTaskKey = (task) =>
  `${task.project}||${task.task}||${task.assignee}||${task.column_id}`;

const formatTime = (date) =>
  date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const setSyncState = (state, message, time) => {
  if (!syncStatus) return;
  syncStatus.classList.remove('is-syncing', 'is-ok', 'is-error');
  if (state) {
    syncStatus.classList.add(`is-${state}`);
  }
  if (syncText && message) {
    syncText.textContent = message;
  }
  if (syncTime) {
    syncTime.textContent = time ? `• ${formatTime(time)}` : '';
  }
};

const markDirty = () => {
  boardDirty = true;
};

const isEditing = () => {
  const active = document.activeElement;
  if (!active) return false;
  if (active.isContentEditable) return true;
  if (active.closest('.quick-input')) return true;
  if (active.matches('input, textarea, select')) return true;
  return false;
};

const refreshFromRemote = async () => {
  if (syncInProgress) return;
  if (isEditing()) {
    scheduleRemoteRefresh();
    return;
  }

  try {
    const remoteSnapshot = await hydrateFromRemote();
    if (remoteSnapshot.taskCount === 0) return;
    projects = remoteSnapshot.projects || [];
    renderProjects();
    renderBoard(remoteSnapshot);
    applyFilter();
    updateAssigneeStats();
    saveLocalSnapshot(remoteSnapshot);
    setSyncState('ok', 'Обновлено', new Date());
  } catch (error) {
    console.warn('Не удалось обновить доску из Supabase', error.message);
    setSyncState('error', 'Ошибка синхронизации', new Date());
  }
};

const scheduleRemoteRefresh = () => {
  clearTimeout(remoteRefreshTimer);
  remoteRefreshTimer = setTimeout(() => {
    refreshFromRemote();
  }, 500);
};

const setupRealtime = () => {
  if (!realtimeClient || realtimeChannel) return;
  realtimeChannel = realtimeClient
    .channel('kanban-updates')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => {
      scheduleRemoteRefresh();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, () => {
      scheduleRemoteRefresh();
    })
    .subscribe();

  // Fallback: periodic refresh if realtime drops.
  setInterval(() => {
    refreshFromRemote();
  }, 20000);
};

const saveHistory = (snapshot) => {
  const history = loadHistory();
  history.push(snapshot);
  while (history.length > 20) history.shift();
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
};

const loadHistory = () => {
  try {
    const saved = localStorage.getItem(HISTORY_KEY);
    if (!saved) return [];
    return JSON.parse(saved) || [];
  } catch (error) {
    return [];
  }
};

const saveLocalSnapshot = (snapshot) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
};

const loadLocalSnapshot = () => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return null;
    return JSON.parse(saved);
  } catch (error) {
    return null;
  }
};

const getSnapshot = () => {
  const columns = {};
  columnDefinitions.forEach(({ id }) => {
    columns[id] = Array.from(document.querySelectorAll(`#${id} .card`)).map((card, index) => ({
      id: card.dataset.taskId || null,
      project: normalizeName(card.querySelector('.card-project')?.textContent || ''),
      task: normalizeName(card.querySelector('.card-task')?.textContent || ''),
      assignee: card.querySelector('.assignee-select')?.value || 'Валерия',
      sort_index: index,
    }));
  });
  return {
    columns,
    projects,
    filter: currentFilter,
    search: currentSearch,
  };
};

const applyAssigneeClass = (card, assignee) => {
  card.classList.remove('assignee-valeriya', 'assignee-anya', 'assignee-liza');
  const className = assigneeClassMap[assignee];
  if (className) {
    card.classList.add(className);
  }
};

const renderProjects = () => {
  projectList.innerHTML = '';
  projects.forEach((name) => {
    const chip = document.createElement('span');
    chip.className = 'project-chip';
    chip.textContent = name;
    projectList.appendChild(chip);
  });

  projectFilter.innerHTML = '';
  const allOption = document.createElement('option');
  allOption.value = 'all';
  allOption.textContent = 'Все проекты';
  projectFilter.appendChild(allOption);

  projects.forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    projectFilter.appendChild(option);
  });
  projectFilter.value = currentFilter;
};

const matchesSearch = (project) => {
  if (!currentSearch) return true;
  return project.toLowerCase().includes(currentSearch.toLowerCase());
};

const applyFilter = () => {
  document.querySelectorAll('.card').forEach((card) => {
    const project = card.querySelector('.card-project')?.textContent || '';
    const filterOk = currentFilter === 'all' || project === currentFilter;
    const searchOk = matchesSearch(project);
    if (filterOk && searchOk) {
      card.style.display = '';
    } else {
      card.style.display = 'none';
    }
  });
};

const updateAssigneeStats = () => {
  const counts = { Валерия: 0, Аня: 0, Лиза: 0 };
  document.querySelectorAll('.card').forEach((card) => {
    if (card.style.display === 'none') return;
    const assignee = card.querySelector('.assignee-select')?.value;
    if (assignee && counts[assignee] !== undefined) {
      counts[assignee] += 1;
    }
  });

  assigneeStats.innerHTML = '';
  Object.keys(counts).forEach((name) => {
    const pill = document.createElement('div');
    pill.className = 'assignee-pill';
    pill.innerHTML = `
      <span class="assignee-dot ${assigneeColors[name]}"></span>
      <span>${name}: ${counts[name]}</span>
    `;
    assigneeStats.appendChild(pill);
  });
};

const createCardElement = ({ id, project, task, assignee }) => {
  const card = document.createElement('div');
  card.className = 'card';
  if (id) card.dataset.taskId = id;
  card.innerHTML = `
    <div class="card-header">
      <div class="card-project-line">
        <span class="card-project-label">Проект:</span>
        <span class="card-project" contenteditable="true">${project}</span>
      </div>
      <div class="card-actions">
        <button class="archive-button" type="button">Архивировать</button>
        <div class="card-handle" title="Перетащить">⋮⋮</div>
      </div>
    </div>
    <div class="card-task" contenteditable="true">${task}</div>
    <div class="card-assignee">
      <span class="assignee-label">Исполнитель:</span>
      <select class="assignee-select">
        <option value="Валерия" ${assignee === 'Валерия' ? 'selected' : ''}>Валерия</option>
        <option value="Аня" ${assignee === 'Аня' ? 'selected' : ''}>Аня</option>
        <option value="Лиза" ${assignee === 'Лиза' ? 'selected' : ''}>Лиза</option>
      </select>
    </div>
  `;
  applyAssigneeClass(card, assignee);
  return card;
};

const createQuickInput = (columnId) => {
  const wrapper = document.createElement('div');
  wrapper.className = 'quick-input';
  wrapper.innerHTML = `
    <input type="text" placeholder="Быстрая задача" />
    <select aria-label="Проект">
      <option value="" selected disabled>Выбрать проект</option>
      ${projects.map((name) => `<option value="${name}">${name}</option>`).join('')}
    </select>
  `;

  const input = wrapper.querySelector('input');
  const select = wrapper.querySelector('select');

  const submit = () => {
    const task = normalizeName(input.value);
    const project = normalizeName(select.value);
    if (!task) return;
    if (!project) {
      select.focus();
      return;
    }
    markDirty();
    saveBoardWithHistory();

    const card = createCardElement({ project, task, assignee: 'Валерия' });
    const list = document.getElementById(columnId);
    list.insertBefore(card, wrapper);
    wrapper.remove();
    applyFilter();
    updateAssigneeStats();
    syncBoard();
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
    if (event.key === 'Escape') {
      wrapper.remove();
    }
  });

  const cleanupIfEmpty = () => {
    if (!input.value.trim()) {
      wrapper.remove();
    }
  };

  input.addEventListener('blur', cleanupIfEmpty);
  select.addEventListener('blur', cleanupIfEmpty);

  return wrapper;
};

const clearTaskForms = () => {
  document.querySelectorAll('.quick-input').forEach((form) => form.remove());
};

const createTask = (columnId) => {
  clearTaskForms();
  const list = document.getElementById(columnId);
  const input = createQuickInput(columnId);
  list.prepend(input);
  input.querySelector('input')?.focus();
};

const createColumnElement = ({ id, title }, cards) => {
  const section = document.createElement('section');
  section.className = 'column';
  section.innerHTML = `
    <div class="column-header">
      <span>${title}</span>
      <button class="column-add" type="button" title="Добавить задачу">+</button>
    </div>
    <div class="column-list" id="${id}"></div>
  `;

  const list = section.querySelector('.column-list');
  cards.forEach((card) => list.appendChild(createCardElement(card)));

  const addButton = section.querySelector('.column-add');
  addButton.addEventListener('click', () => createTask(id));

  return section;
};

const renderBoard = (data) => {
  board.innerHTML = '';
  columnDefinitions.forEach((column) => {
    const cards = data.columns[column.id] || [];
    board.appendChild(createColumnElement(column, cards));
  });

  document.querySelectorAll('.column-list').forEach((column) => {
    new Sortable(column, {
      group: 'kanban',
      animation: 150,
      ghostClass: 'sortable-ghost',
      dragClass: 'sortable-drag',
      fallbackOnBody: true,
      swapThreshold: 0.65,
      handle: '.card-handle',
      onStart: () => saveBoardWithHistory(),
      onEnd: () => {
        markDirty();
        updateAssigneeStats();
        syncBoard();
      },
    });
  });
};

const hydrateFromRemote = async () => {
  const [tasks, projectRows] = await Promise.all([fetchTasks(), fetchProjects()]);
  const columns = {
    'col-team': [],
    'col-me': [],
    'col-client': [],
    'col-final': [],
  };
  knownTaskIds = new Set();

  tasks.forEach((task) => {
    knownTaskIds.add(task.id);
    if (!columns[task.column_id]) return;
    columns[task.column_id].push({
      id: task.id,
      project: task.project,
      task: task.task,
      assignee: task.assignee,
    });
  });

  projects = projectRows?.map((row) => row.name) || [];
  if (projects.length === 0) {
    const projectSet = new Set(tasks.map((task) => task.project));
    projects = Array.from(projectSet);
  }

  return {
    columns,
    projects,
    filter: currentFilter,
    search: currentSearch,
    taskCount: tasks.length,
  };
};

const importToSupabase = async () => {
  if (!confirm('Импортировать задачи? Новые будут добавлены, существующие не удаляются.')) {
    return;
  }

  saveBoardWithHistory();
  const snapshot = getSnapshot();
  setSyncState('syncing', 'Синхронизация...', new Date());

  try {
    const [remoteTasks, remoteProjects] = await Promise.all([fetchTasks(), fetchProjects()]);
    const remoteTaskKeys = new Set(remoteTasks.map((task) => buildTaskKey(task)));
    const remoteProjectNames = new Set(remoteProjects.map((row) => row.name));

    const missingProjects = snapshot.projects.filter(
      (name) => name && !remoteProjectNames.has(name)
    );

    if (missingProjects.length) {
      await supabaseFetch('/rest/v1/projects', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(missingProjects.map((name) => ({ name }))),
      });
    }

    const updates = [];
    const inserts = [];

    Object.keys(snapshot.columns).forEach((columnId) => {
      snapshot.columns[columnId].forEach((card, index) => {
        const payload = {
          project: card.project,
          task: card.task,
          assignee: card.assignee,
          column_id: columnId,
          sort_index: index,
          updated_at: new Date().toISOString(),
        };

        if (card.id) {
          updates.push({ id: card.id, payload });
        } else {
          const key = buildTaskKey(payload);
          if (!remoteTaskKeys.has(key)) {
            inserts.push(payload);
            remoteTaskKeys.add(key);
          }
        }
      });
    });

    await Promise.all(updates.map((item) => updateTask(item.id, item.payload)));

    if (inserts.length) {
      await supabaseFetch('/rest/v1/tasks', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(inserts),
      });
    }

    const remoteSnapshot = await hydrateFromRemote();
    projects = remoteSnapshot.projects || [];
    renderProjects();
    renderBoard(remoteSnapshot);
    applyFilter();
    updateAssigneeStats();
    saveLocalSnapshot(remoteSnapshot);
    setSyncState('ok', 'Синхронизировано', new Date());
  } catch (error) {
    alert('Не удалось импортировать задачи. Проверьте доступ к Supabase.');
    console.warn(error);
    setSyncState('error', 'Ошибка синхронизации', new Date());
  }
};

const syncBoard = async () => {
  if (syncInProgress) return;
  syncInProgress = true;
  setSyncState('syncing', 'Синхронизация...', new Date());
  const snapshot = getSnapshot();

  try {
    const currentIds = new Set();

    for (const columnId of Object.keys(snapshot.columns)) {
      const cards = snapshot.columns[columnId];
      for (let index = 0; index < cards.length; index += 1) {
        const card = cards[index];
        const payload = {
          project: card.project,
          task: card.task,
          assignee: card.assignee,
          column_id: columnId,
          sort_index: index,
          updated_at: new Date().toISOString(),
        };

        if (card.id) {
          currentIds.add(card.id);
          await updateTask(card.id, payload);
        } else {
          const created = await insertTask(payload);
          const createdRow = created?.[0];
          if (createdRow?.id) {
            const newId = createdRow.id;
            const cardEl = document.querySelector(`#${columnId} .card:nth-child(${index + 1})`);
            if (cardEl) {
              cardEl.dataset.taskId = newId;
            }
            currentIds.add(newId);
          }
        }
      }
    }

    const toDelete = [...knownTaskIds].filter((id) => !currentIds.has(id));
    await Promise.all(toDelete.map((id) => deleteTask(id)));
    knownTaskIds = currentIds;

    saveLocalSnapshot(snapshot);
    boardDirty = false;
    setSyncState('ok', 'Синхронизировано', new Date());
  } catch (error) {
    console.warn('Ошибка синхронизации:', error.message);
    setSyncState('error', 'Ошибка синхронизации', new Date());
  } finally {
    syncInProgress = false;
  }
};

const saveBoardWithHistory = () => {
  const current = loadLocalSnapshot();
  if (current) {
    saveHistory(current);
  }
  saveLocalSnapshot(getSnapshot());
};

const restoreFromSnapshot = (snapshot) => {
  if (!snapshot) return;
  projects = snapshot.projects || [];
  currentFilter = snapshot.filter || 'all';
  currentSearch = snapshot.search || '';
  projectSearch.value = currentSearch;
  renderProjects();
  renderBoard(snapshot);
  applyFilter();
  updateAssigneeStats();
  saveLocalSnapshot(snapshot);
  syncBoard();
};

const countSnapshotTasks = (snapshot) => {
  if (!snapshot?.columns) return 0;
  return Object.values(snapshot.columns).reduce((sum, items) => sum + items.length, 0);
};

addProjectButton.addEventListener('click', () => {
  newProjectPanel.classList.toggle('is-hidden');
  newProjectName.focus();
});

importButton.addEventListener('click', importToSupabase);

undoButton.addEventListener('click', () => {
  const history = loadHistory();
  const snapshot = history.pop();
  if (!snapshot) return;
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  restoreFromSnapshot(snapshot);
});

newProjectCancel.addEventListener('click', () => newProjectPanel.classList.add('is-hidden'));

newProjectForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  saveBoardWithHistory();

  const name = normalizeName(newProjectName.value);
  if (!name) return;
  if (!projects.includes(name)) {
    projects.push(name);
    renderProjects();
    saveLocalSnapshot(getSnapshot());
    try {
      await insertProject(name);
    } catch (error) {
      console.warn('Не удалось создать проект в Supabase', error.message);
    }
  }
  newProjectName.value = '';
  newProjectPanel.classList.add('is-hidden');
});

projectFilter.addEventListener('change', (event) => {
  saveBoardWithHistory();
  currentFilter = event.target.value;
  applyFilter();
  updateAssigneeStats();
  saveLocalSnapshot(getSnapshot());
});

projectSearch.addEventListener('input', (event) => {
  saveBoardWithHistory();
  currentSearch = event.target.value.trim();
  applyFilter();
  updateAssigneeStats();
  saveLocalSnapshot(getSnapshot());
});

const init = async () => {
  const localSnapshot = loadLocalSnapshot();
  currentFilter = localSnapshot?.filter || 'all';
  currentSearch = localSnapshot?.search || '';
  projectSearch.value = currentSearch;

  try {
    const remoteSnapshot = await hydrateFromRemote();
    if (remoteSnapshot.taskCount > 0) {
      projects = remoteSnapshot.projects || [];
      renderProjects();
      renderBoard(remoteSnapshot);
      applyFilter();
      updateAssigneeStats();
      saveLocalSnapshot(remoteSnapshot);
      setSyncState('ok', 'Синхронизировано', new Date());
      return;
    }

    if (localSnapshot && countSnapshotTasks(localSnapshot) > 0) {
      projects = localSnapshot.projects || [];
      renderProjects();
      renderBoard(localSnapshot);
      applyFilter();
      updateAssigneeStats();
      return;
    }

    projects = initialData.projects || [];
    renderProjects();
    renderBoard(initialData);
    applyFilter();
    updateAssigneeStats();
    saveLocalSnapshot(initialData);
    setSyncState('ok', 'Синхронизировано', new Date());
  } catch (error) {
    console.warn('Не удалось загрузить данные из Supabase', error.message);
    if (localSnapshot) {
      projects = localSnapshot.projects || [];
      renderProjects();
      renderBoard(localSnapshot);
      applyFilter();
      updateAssigneeStats();
      setSyncState('error', 'Автономный режим', new Date());
    }
  }
};

init().then(setupRealtime);

setInterval(() => {
  if (boardDirty && !syncInProgress && !isEditing()) {
    syncBoard();
  }
}, 5000);

let saveTimeout;
const scheduleSave = () => {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    markDirty();
    saveBoardWithHistory();
  }, 300);
};

document.addEventListener('input', (event) => {
  if (event.target.matches('[contenteditable="true"]')) {
    markDirty();
    scheduleSave();
  }
});

document.addEventListener('change', (event) => {
  if (event.target.classList.contains('assignee-select')) {
    const card = event.target.closest('.card');
    if (!card) return;
    markDirty();
    applyAssigneeClass(card, event.target.value);
    updateAssigneeStats();
    saveBoardWithHistory();
    syncBoard();
  }
});

document.addEventListener('click', (event) => {
  const archiveButton = event.target.closest('.archive-button');
  if (!archiveButton) return;
  const card = archiveButton.closest('.card');
  if (!card) return;
  markDirty();
  saveBoardWithHistory();
  card.remove();
  applyFilter();
  updateAssigneeStats();
  syncBoard();
});

document.addEventListener(
  'blur',
  (event) => {
    if (!event.target.classList.contains('card-project')) return;
    const card = event.target.closest('.card');
    if (!card) return;
    const name = normalizeName(event.target.textContent);
    if (!name) {
      event.target.textContent = 'Проект';
      return;
    }
    saveBoardWithHistory();
    if (!projects.includes(name)) {
      projects.push(name);
      renderProjects();
    }
    applyFilter();
    updateAssigneeStats();
    markDirty();
    syncBoard();
  },
  true
);

document.addEventListener(
  'blur',
  (event) => {
    if (!event.target.classList.contains('card-task')) return;
    markDirty();
    saveBoardWithHistory();
    syncBoard();
  },
  true
);

window.createTask = createTask;
