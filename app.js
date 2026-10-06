// Personal Organizer.
// Data is always kept in this browser (localStorage). When the app is opened
// from its claude.ai link while signed in, it also syncs to the owner's Claude
// account so the same entries show up on every device (see "Cloud sync").

/* ---------- Storage ---------- */

const STORE_KEY = 'organizer.v1';
const emptyDb = () => ({ tasks: [], categories: [], events: [], notes: [], habits: [], people: [], places: [] });

function load() {
  try {
    return Object.assign(emptyDb(), JSON.parse(localStorage.getItem(STORE_KEY)) || {});
  } catch {
    return emptyDb();
  }
}

function saveLocal() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
  } catch {
    // Storage blocked (e.g. private window); cloud sync still works if available.
  }
}

function save() {
  saveLocal();
  syncToCloud();
}

let db = load();

/* ---------- Cloud sync ---------- */

// Each section is one private document under the viewer's own folder:
// data/users/<id>/<section> = { items: [...] }
const SECTIONS = Object.keys(emptyDb());
const cloud = { store: null, uid: null, ready: false, synced: {}, busy: {}, again: {}, error: false };

const sectionRef = (k) => cloud.store.doc(`data/users/${cloud.uid}/${k}`);
const clone = (x) => JSON.parse(JSON.stringify(x));

function setSyncStatus() {
  const el = document.getElementById('sync-status');
  if (!el) return;
  const saving = SECTIONS.some((k) => cloud.busy[k]);
  el.textContent = !cloud.ready ? 'Saved on this device'
    : cloud.error ? '⚠️ Not synced. Check your connection'
    : saving ? 'Saving…' : '☁️ Synced to your account';
  el.classList.toggle('overdue', cloud.ready && cloud.error);
}

function pushSection(k) {
  if (cloud.busy[k]) { cloud.again[k] = true; return; }
  cloud.busy[k] = true;
  setSyncStatus();
  const json = JSON.stringify(db[k]);
  sectionRef(k).set({ items: JSON.parse(json), updatedAt: Date.now() })
    .then(() => { cloud.synced[k] = json; cloud.error = false; })
    .catch(() => { cloud.error = true; })
    .finally(() => {
      cloud.busy[k] = false;
      if (cloud.again[k]) { cloud.again[k] = false; syncToCloud(); }
      setSyncStatus();
    });
}

function syncToCloud() {
  if (!cloud.ready) return;
  for (const k of SECTIONS) if (JSON.stringify(db[k]) !== cloud.synced[k]) pushSection(k);
}

async function startCloud() {
  if (!window.claude?.use) return;
  const [store, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
  const id = store && user ? await user.id() : null;
  if (!id) return;
  cloud.store = store;
  cloud.uid = id;
  try {
    const snaps = await Promise.all(SECTIONS.map((k) => sectionRef(k).get()));
    SECTIONS.forEach((k, i) => {
      const snap = snaps[i];
      if (snap.exists) {
        // The account copy wins: it is what every device shares.
        db[k] = clone(snap.data().items || []);
        cloud.synced[k] = JSON.stringify(db[k]);
      } else {
        // Nothing in the account yet: anything already in this browser gets uploaded.
        cloud.synced[k] = '[]';
      }
    });
  } catch {
    return; // Stay device-only for this visit.
  }
  cloud.ready = true;
  reviveRecurring();
  saveLocal();
  syncToCloud();
  render();

  // Live updates from other devices.
  for (const k of SECTIONS) {
    sectionRef(k).onSnapshot((snap) => {
      if (!snap.exists || snap.metadata.hasPendingWrites || cloud.busy[k]) return;
      const json = JSON.stringify(snap.data().items || []);
      if (json === cloud.synced[k] || json === JSON.stringify(db[k])) { cloud.synced[k] = json; return; }
      cloud.synced[k] = json;
      db[k] = JSON.parse(json);
      saveLocal();
      if (!modal.open) render();
    }, () => { cloud.error = true; setSyncStatus(); });
  }
}

/* ---------- Helpers ---------- */

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => ymd(new Date());
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 864e5);
const fmtDate = (s) => (s ? parseYmd(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '');
const fmtTime = (t) => {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};
const byDue = (a, b) => (a.due || '9999').localeCompare(b.due || '9999');
const byTime = (a, b) => (a.time || '').localeCompare(b.time || '');
const find = (list, id) => db[list].find((x) => x.id === id);
const catLabel = (c) => `${c.emoji} ${esc(c.name)}`;
const mapUrl = (p) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.address || [p.name, p.area].filter(Boolean).join(' '))}`;

// "🏠 Home" -> { emoji: '🏠', name: 'Home' }. Text without a leading emoji gets a tag emoji.
function splitEmoji(text) {
  const m = text.trim().match(/^((?:\p{Extended_Pictographic}|\p{Regional_Indicator})[\uFE0F\u200D\p{Extended_Pictographic}\p{Emoji_Modifier}]*)\s*(.*)$/u);
  return m ? { emoji: m[1], name: m[2].trim() || m[1] } : { emoji: '🏷️', name: text.trim() };
}
const remove = (list, id) => { db[list] = db[list].filter((x) => x.id !== id); };

function dueLabel(due) {
  if (!due) return '';
  const diff = daysBetween(todayStr(), due);
  if (diff < 0) return `<span class="meta overdue">Overdue · ${fmtDate(due)}</span>`;
  if (diff === 0) return '<span class="meta">Today</span>';
  if (diff === 1) return '<span class="meta">Tomorrow</span>';
  return `<span class="meta">${fmtDate(due)}</span>`;
}

const PLACE_TYPES = {
  coffee: '☕ Coffee',
  bar: '🍸 Bar',
  restaurant: '🍽️ Restaurant',
  dessert: '🍰 Dessert',
  activity: '🎟️ Activity',
  other: '📍 Other',
};

const PERSON_KINDS = {
  order: { label: 'Go-to orders', one: 'order', hint: 'e.g. Starbucks: Venti iced oat latte, 2 pumps vanilla' },
  favorite: { label: 'Favorites', one: 'favorite', hint: 'e.g. Flowers: peonies' },
  idea: { label: 'Date ideas & plans', one: 'idea', hint: 'e.g. Sunset picnic at the park' },
  date: { label: 'Important dates', one: 'date', hint: 'e.g. Birthday, Anniversary' },
};

/* ---------- App state ---------- */

const state = {
  view: 'today',
  taskFilter: 'open',
  taskCat: 'all',
  taskHigh: false,
  taskMonth: false,
  calMonth: todayStr().slice(0, 7),
  calDay: todayStr(),
  noteQuery: '',
  personId: null,
  placeFilter: 'todo',
  placeType: 'all',
};

const TITLES = {
  today: 'Today', tasks: 'Tasks', calendar: 'Calendar', notes: 'Notes',
  habits: 'Habits', people: 'People', places: 'Places to try',
};

const main = document.getElementById('main');
const modal = document.getElementById('modal');

function render() {
  document.getElementById('view-title').textContent =
    state.view === 'people' && state.personId ? (find('people', state.personId)?.name || 'People') : TITLES[state.view];
  document.querySelectorAll('#tabs button').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === state.view));
  main.innerHTML = views[state.view]();
  setSyncStatus();
}

function go(view) {
  state.view = view;
  if (view !== 'people') state.personId = null;
  render();
  window.scrollTo(0, 0);
}

/* ---------- Shared bits ---------- */

function taskRow(t) {
  return `
    <div class="row ${t.done ? 'done' : ''}" data-action="edit-task" data-id="${t.id}">
      <button class="check ${t.done ? 'on' : ''}" data-action="toggle-task" data-id="${t.id}" aria-label="Mark done">${t.done ? '✓' : ''}</button>
      <div class="grow">
        <div class="title">${esc(t.title)}</div>
        <div class="task-meta">${t.recurring && t.done ? `<span class="meta">Comes back ${fmtDate(t.due)}</span>` : dueLabel(t.due)}${t.recurring ? `<span class="meta">${repeatLabel(t)}</span>` : ''}${t.category && find('categories', t.category) ? `<span class="cat-tag">${catLabel(find('categories', t.category))}</span>` : ''}</div>
      </div>
      <span class="prio ${t.priority || 'normal'}" title="${esc(t.priority || 'normal')} priority"></span>
    </div>`;
}

function eventRow(e) {
  return `
    <div class="row" data-action="edit-event" data-id="${e.id}">
      <div class="grow">
        <div class="title">${esc(e.title)}</div>
        <span class="meta">${e.time ? fmtTime(e.time) : 'All day'}${e.notes ? ' · ' + esc(e.notes) : ''}</span>
      </div>
    </div>`;
}

const empty = (msg) => `<div class="empty">${msg}</div>`;

// Next yearly occurrence of every "important date" saved under People.
function upcomingDates(withinDays) {
  const t = todayStr();
  const year = Number(t.slice(0, 4));
  const out = [];
  for (const p of db.people) {
    for (const it of p.items) {
      if (it.kind !== 'date' || !it.date) continue;
      let next = `${year}${it.date.slice(4)}`;
      if (next < t) next = `${year + 1}${it.date.slice(4)}`;
      const inDays = daysBetween(t, next);
      if (inDays <= withinDays) out.push({ person: p, item: it, next, inDays });
    }
  }
  return out.sort((a, b) => a.inDays - b.inDays);
}

/* ---------- Views ---------- */

const views = {
  today() {
    const t = todayStr();
    const tasks = db.tasks.filter((x) => !x.done && x.due && x.due <= t).sort(byDue);
    const events = db.events.filter((e) => e.date === t).sort(byTime);
    const soon = db.events.filter((e) => e.date > t && e.date <= addDays(t, 7))
      .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
    const dates = upcomingDates(30);
    const toTry = db.places.filter((p) => !p.visited);
    const pick = toTry.length ? toTry[Math.floor(parseYmd(t) / 864e5) % toTry.length] : null;

    return `
      <p class="meta" style="margin-top:-6px">${parseYmd(t).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p>

      <section>
        <h2>Due today & overdue</h2>
        <div class="list">${tasks.map(taskRow).join('') || empty('Nothing due. Nice! 🎉')}</div>
      </section>

      <section>
        <h2>Today's schedule</h2>
        <div class="list">${events.map(eventRow).join('') || empty('No events today.')}</div>
      </section>

      ${db.habits.length ? `
      <section>
        <h2>Habits</h2>
        <div class="list">${db.habits.map((h) => {
          const on = !!h.log[t];
          return `<div class="row ${on ? 'done' : ''}" data-action="toggle-habit" data-id="${h.id}" data-day="${t}">
            <button class="check ${on ? 'on' : ''}" aria-label="Done today">${on ? '✓' : ''}</button>
            <div class="grow"><div class="title">${esc(h.name)}</div><span class="meta">🔥 ${streak(h)} day streak</span></div>
          </div>`;
        }).join('')}</div>
      </section>` : ''}

      ${dates.length ? `
      <section>
        <h2>Coming up (next 30 days)</h2>
        <div class="list">${dates.map((d) => `
          <div class="row" data-action="open-person" data-id="${d.person.id}">
            <div class="grow"><div class="title">${esc(d.person.name)} · ${esc(d.item.text)}</div>
            <span class="meta ${d.inDays <= 7 ? 'overdue' : ''}">${d.inDays === 0 ? 'Today!' : `in ${d.inDays} day${d.inDays === 1 ? '' : 's'}`} · ${fmtDate(d.next)}</span></div>
          </div>`).join('')}</div>
      </section>` : ''}

      ${soon.length ? `
      <section>
        <h2>This week</h2>
        <div class="list">${soon.map((e) => `
          <div class="row" data-action="edit-event" data-id="${e.id}">
            <div class="grow"><div class="title">${esc(e.title)}</div>
            <span class="meta">${fmtDate(e.date)}${e.time ? ' · ' + fmtTime(e.time) : ''}</span></div>
          </div>`).join('')}</div>
      </section>` : ''}

      ${pick ? `
      <section>
        <h2>Today's place to try</h2>
        <div class="card suggest">
          <h3>${esc(pick.name)}</h3>
          <div class="meta">${PLACE_TYPES[pick.type] || ''}${pick.area ? ' · ' + esc(pick.area) : ''}</div>
          ${placeLinks(pick)}
        </div>
      </section>` : ''}

      <section>
        <h2>Backup</h2>
        <p class="meta">${cloud.ready
          ? 'Your entries are saved to your Claude account, so they show up on any device where you open this link. You can also keep a copy of your own.'
          : 'Your entries are saved in this browser. Open the app from its claude.ai link while signed in to sync across devices. Export a backup now and then.'}</p>
        <div class="backup">
          <button class="btn ghost small" data-action="export">⬇️ Export backup</button>
          <button class="btn ghost small" data-action="import">⬆️ Import backup</button>
        </div>
      </section>`;
  },

  tasks() {
    const f = state.taskFilter;
    const c = state.taskCat;
    if (c !== 'all' && c !== 'none' && !find('categories', c)) state.taskCat = 'all';
    const t0 = todayStr();
    const monthEnd = ymd(new Date(Number(t0.slice(0, 4)), Number(t0.slice(5, 7)), 0));
    // "This month": due by the end of this month (overdue included), or no due date at all.
    const thisMonth = (t) => !t.due || t.due <= monthEnd;
    const isHigh = (t) => t.priority === 'high';
    const byStatus = db.tasks.filter((t) => (f === 'open' ? !t.done : f === 'done' ? t.done : true))
      .filter((t) => !state.taskHigh || isHigh(t))
      .filter((t) => !state.taskMonth || thisMonth(t));
    const statusOnly = db.tasks.filter((t) => (f === 'open' ? !t.done : f === 'done' ? t.done : true));
    const inCat = (t, id) => (id === 'all' ? true : id === 'none' ? !find('categories', t.category) : t.category === id);
    let list = byStatus.filter((t) => inCat(t, state.taskCat));
    const count = (id) => byStatus.filter((t) => inCat(t, id)).length;
    const active = find('categories', state.taskCat);
    const prioRank = { high: 0, normal: 1, low: 2 };
    list = list.sort((a, b) => byDue(a, b) || prioRank[a.priority || 'normal'] - prioRank[b.priority || 'normal']);
    return `
      <div class="chips">
        ${['open', 'done', 'all'].map((k) =>
          `<button class="chip ${f === k ? 'active' : ''}" data-action="task-filter" data-value="${k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}
      </div>
      <div class="chips">
        <button class="chip ${state.taskHigh ? 'active' : ''}" data-action="task-high" aria-pressed="${state.taskHigh}">🔥 High priority <span class="count">${statusOnly.filter(isHigh).length}</span></button>
        <button class="chip ${state.taskMonth ? 'active' : ''}" data-action="task-month" aria-pressed="${state.taskMonth}">📆 This month <span class="count">${statusOnly.filter(thisMonth).length}</span></button>
      </div>
      <div class="chips">
        <button class="chip ${state.taskCat === 'all' ? 'active' : ''}" data-action="task-cat" data-value="all">📋 All <span class="count">${count('all')}</span></button>
        ${db.categories.map((cat) => `<button class="chip ${state.taskCat === cat.id ? 'active' : ''}" data-action="task-cat" data-value="${cat.id}">${catLabel(cat)} <span class="count">${count(cat.id)}</span></button>`).join('')}
        ${db.categories.length && db.tasks.some((t) => !find('categories', t.category)) ? `<button class="chip ${state.taskCat === 'none' ? 'active' : ''}" data-action="task-cat" data-value="none">📥 No category <span class="count">${count('none')}</span></button>` : ''}
        <button class="chip add-chip" data-action="add-category">＋ Category</button>
      </div>
      ${active ? `<button class="btn ghost small edit-cat" data-action="edit-category" data-id="${active.id}">✏️ Edit ${catLabel(active)}</button>` : ''}
      <div class="list">${list.map(taskRow).join('') || empty(f === 'done' ? 'No finished tasks here yet.' : 'No tasks here. Tap ＋ to add one.')}</div>`;
  },

  calendar() {
    const [y, m] = state.calMonth.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const start = new Date(first);
    start.setDate(1 - first.getDay());
    const t = todayStr();
    let cells = '';
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const s = ymd(d);
      const hasEvent = db.events.some((e) => e.date === s);
      const hasTask = db.tasks.some((x) => !x.done && x.due === s);
      cells += `<button class="cal-day ${d.getMonth() !== m - 1 ? 'other' : ''} ${s === t ? 'today' : ''} ${s === state.calDay ? 'sel' : ''}"
        data-action="cal-day" data-value="${s}">${d.getDate()}
        <span class="dots">${hasEvent ? '<i class="dot"></i>' : ''}${hasTask ? '<i class="dot task"></i>' : ''}</span></button>`;
    }
    const day = state.calDay;
    const events = db.events.filter((e) => e.date === day).sort(byTime);
    const tasks = db.tasks.filter((x) => x.due === day);
    return `
      <div class="cal-head">
        <button class="btn ghost small" data-action="cal-month" data-value="-1">‹</button>
        <strong>${first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</strong>
        <button class="btn ghost small" data-action="cal-month" data-value="1">›</button>
      </div>
      <div class="cal-grid">
        ${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => `<div class="cal-dow">${d}</div>`).join('')}
        ${cells}
      </div>
      <section style="margin-top:18px">
        <div class="sec-head"><h2>${fmtDate(day)}</h2>
          <button class="btn ghost small" data-action="add-event">＋ Event</button></div>
        <div class="list">
          ${events.map(eventRow).join('')}
          ${tasks.map(taskRow).join('')}
          ${!events.length && !tasks.length ? empty('Nothing planned.') : ''}
        </div>
      </section>`;
  },

  notes() {
    return `
      <input class="search" id="note-search" type="search" placeholder="Search notes…" value="${esc(state.noteQuery)}">
      <div id="note-list">${noteList()}</div>`;
  },

  habits() {
    if (!db.habits.length) return empty('No habits yet. Tap ＋ to start tracking one (e.g. “Drink water”, “Gym”).');
    const t = todayStr();
    const days = Array.from({ length: 7 }, (_, i) => addDays(t, i - 6));
    return `<div class="list">${db.habits.map((h) => `
      <div class="card">
        <div class="habit-top" data-action="edit-habit" data-id="${h.id}">
          <h3>${esc(h.name)}</h3><span class="meta">🔥 ${streak(h)} day streak</span>
        </div>
        <div class="habit-days">${days.map((d) => `
          <button class="habit-day ${h.log[d] ? 'on' : ''}" data-action="toggle-habit" data-id="${h.id}" data-day="${d}">
            ${parseYmd(d).toLocaleDateString(undefined, { weekday: 'narrow' })}<b>${parseYmd(d).getDate()}</b>
          </button>`).join('')}
        </div>
      </div>`).join('')}</div>`;
  },

  people() {
    if (state.personId) return personDetail(find('people', state.personId));
    if (!db.people.length) {
      return empty('Keep track of the people who matter: their go-to orders, favorites, date ideas and important dates.<br><br>Tap ＋ to add someone.');
    }
    return `<div class="list">${db.people.map((p) => {
      const counts = Object.keys(PERSON_KINDS).map((k) => p.items.filter((i) => i.kind === k).length);
      return `<div class="row" data-action="open-person" data-id="${p.id}">
        <div class="grow"><div class="title">💛 ${esc(p.name)}</div>
        <span class="meta">${counts[0]} orders · ${counts[1]} favorites · ${counts[2]} ideas · ${counts[3]} dates</span></div>
        <span class="meta">›</span>
      </div>`;
    }).join('')}</div>`;
  },

  places() {
    const f = state.placeFilter;
    const type = state.placeType;
    const list = db.places
      .filter((p) => (f === 'todo' ? !p.visited : f === 'visited' ? p.visited : true))
      .filter((p) => type === 'all' || p.type === type)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return `
      <div class="chips">
        ${[['todo', 'To try'], ['visited', 'Been there'], ['all', 'All']].map(([k, l]) =>
          `<button class="chip ${f === k ? 'active' : ''}" data-action="place-filter" data-value="${k}">${l}</button>`).join('')}
      </div>
      <div class="chips">
        ${[['all', 'All types'], ...Object.entries(PLACE_TYPES)].map(([k, l]) =>
          `<button class="chip ${type === k ? 'active' : ''}" data-action="place-type" data-value="${k}">${l}</button>`).join('')}
      </div>
      ${f !== 'visited' && list.some((p) => !p.visited) ? '<button class="btn ghost" style="width:100%;margin-bottom:12px" data-action="pick-place">🎲 Pick one for me</button>' : ''}
      <div class="list">${list.map((p) => `
        <div class="row ${p.visited ? 'done' : ''}" data-action="edit-place" data-id="${p.id}">
          <button class="check ${p.visited ? 'on' : ''}" data-action="toggle-place" data-id="${p.id}" aria-label="Visited">${p.visited ? '✓' : ''}</button>
          <div class="grow">
            <div class="title">${esc(p.name)}</div>
            <div class="meta">${PLACE_TYPES[p.type] || ''}${p.area ? ' · ' + esc(p.area) : ''}${p.rating ? ` · <span class="stars">${'★'.repeat(p.rating)}</span>` : ''}</div>
            ${p.notes ? `<div class="meta">${esc(p.notes)}</div>` : ''}
            ${placeLinks(p)}
          </div>
        </div>`).join('') || empty(f === 'visited' ? 'No places checked off yet.' : 'Saved a spot on Instagram? Tap ＋ and paste the link here.')}</div>`;
  },
};

function placeLinks(p) {
  return `<div class="place-links">
    <a class="place-link" href="${esc(mapUrl(p))}" target="_blank" rel="noopener">🗺️ Map</a>
    ${safeUrl(p.link) ? `<a class="place-link" href="${esc(p.link)}" target="_blank" rel="noopener">📸 Saved post</a>` : ''}
  </div>`;
}

function noteList() {
  const q = state.noteQuery.trim().toLowerCase();
  const list = db.notes
    .filter((n) => !q || `${n.title} ${n.body} ${n.tag}`.toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (!list.length) return empty(q ? 'No matching notes.' : 'No notes yet. Tap ＋ to write one.');
  return `<div class="note-grid">${list.map((n) => `
    <div class="card note" data-action="edit-note" data-id="${n.id}">
      <h3>${esc(n.title || 'Untitled')}</h3>
      ${n.tag ? `<span class="tag">${esc(n.tag)}</span>` : ''}
      <p>${esc(n.body)}</p>
    </div>`).join('')}</div>`;
}

function personDetail(p) {
  if (!p) { state.personId = null; return views.people(); }
  return `
    <button class="back" data-action="back-people">‹ All people</button>
    ${Object.entries(PERSON_KINDS).map(([kind, k]) => {
      let items = p.items.filter((i) => i.kind === kind);
      if (kind === 'date') items = items.sort((a, b) => (a.date || '').slice(5).localeCompare((b.date || '').slice(5)));
      if (kind === 'idea') items = items.sort((a, b) => Number(a.done) - Number(b.done));
      return `
      <section>
        <div class="sec-head"><h2>${k.label}</h2>
          <button class="btn ghost small" data-action="add-person-item" data-kind="${kind}">＋ Add</button></div>
        <div class="list">${items.map((i) => `
          <div class="row ${i.done ? 'done' : ''}" data-action="edit-person-item" data-id="${i.id}">
            ${kind === 'idea' ? `<button class="check ${i.done ? 'on' : ''}" data-action="toggle-person-item" data-id="${i.id}" aria-label="Done">${i.done ? '✓' : ''}</button>` : ''}
            <div class="grow">
              <div class="title">${esc(i.text)}</div>
              ${i.date ? `<div class="meta">${kind === 'date' ? parseYmd(i.date).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : 'Planned: ' + fmtDate(i.date)}</div>` : ''}
              ${i.details ? `<div class="meta">${esc(i.details)}</div>` : ''}
            </div>
          </div>`).join('') || empty(`No ${k.label.toLowerCase()} yet.`)}</div>
      </section>`;
    }).join('')}
    <button class="btn danger" data-action="edit-person">Rename or delete ${esc(p.name)}</button>`;
}

function streak(h) {
  let d = todayStr();
  if (!h.log[d]) d = addDays(d, -1);
  let n = 0;
  while (h.log[d]) { n++; d = addDays(d, -1); }
  return n;
}

/* ---------- Confirm box (in-app, since some browsers block pop-ups) ---------- */

const confirmBox = document.getElementById('confirm');

function ask(message, { ok = 'OK', danger = false, okOnly = false } = {}) {
  return new Promise((resolve) => {
    confirmBox.innerHTML = `
      <form method="dialog">
        <p class="confirm-msg">${esc(message)}</p>
        <div class="modal-actions"><div class="right">
          ${okOnly ? '' : '<button type="button" class="btn ghost" data-ans="no">Cancel</button>'}
          <button type="button" class="btn ${danger ? 'danger-solid' : ''}" data-ans="yes">${esc(ok)}</button>
        </div></div>
      </form>`;
    const done = (v) => { confirmBox.close(); resolve(v); };
    confirmBox.querySelector('[data-ans="yes"]').onclick = () => done(true);
    const no = confirmBox.querySelector('[data-ans="no"]');
    if (no) no.onclick = () => done(false);
    confirmBox.oncancel = () => resolve(false);
    confirmBox.showModal();
  });
}

/* ---------- Form modal ---------- */

// fields: [{ name, label, type, options, required, placeholder }]
function openForm({ title, fields, values = {}, onSave, onDelete }) {
  modal.innerHTML = `
    <form method="dialog">
      <h3>${esc(title)}</h3>
      ${fields.map((f) => {
        const v = values[f.name] ?? '';
        const common = `name="${f.name}" ${f.required ? 'required' : ''} placeholder="${esc(f.placeholder || '')}"`;
        let input;
        if (f.type === 'checkbox') {
          return `<label class="check-label"><input type="checkbox" name="${f.name}" ${v ? 'checked' : ''}> ${esc(f.label)}</label>`;
        }
        if (f.type === 'repeat') {
          return `<div class="repeat-row" data-show-if="${f.showIf}" ${values[f.showIf] ? '' : 'hidden'}>
            <span>Every</span>
            <input type="number" name="repeatEvery" min="1" max="365" inputmode="numeric" value="${esc(values.repeatEvery || 1)}" aria-label="How many">
            <select name="repeatUnit" aria-label="Days, weeks or months">${Object.entries(REPEAT_UNITS).map(([k, l]) =>
              `<option value="${k}" ${(values.repeatUnit || 'weeks') === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
          </div>`;
        }
        if (f.type === 'textarea') input = `<textarea ${common}>${esc(v)}</textarea>`;
        else if (f.type === 'select') {
          input = `<select name="${f.name}">${Object.entries(f.options).map(([k, l]) =>
            `<option value="${esc(k)}" ${String(v) === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
        } else input = `<input type="${f.type || 'text'}" ${common} value="${esc(v)}">`;
        return `<label>${esc(f.label)}${input}</label>`;
      }).join('')}
      <div class="modal-actions">
        ${onDelete ? '<button type="button" class="btn danger" data-modal="delete">Delete</button>' : ''}
        <div class="right">
          <button type="button" class="btn ghost" data-modal="cancel">Cancel</button>
          <button type="submit" class="btn">Save</button>
        </div>
      </div>
    </form>`;

  const form = modal.querySelector('form');
  // Show fields that depend on a checkbox (e.g. the repeat options) only when it's checked.
  form.querySelectorAll('[data-show-if]').forEach((el) => {
    const box = form.querySelector(`[name="${el.dataset.showIf}"]`);
    box.onchange = () => { el.hidden = !box.checked; };
  });
  form.onsubmit = (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    for (const k in data) if (typeof data[k] === 'string') data[k] = data[k].trim();
    onSave(data);
    save();
    modal.close();
    render();
  };
  modal.querySelector('[data-modal="cancel"]').onclick = () => modal.close();
  const del = modal.querySelector('[data-modal="delete"]');
  if (del) del.onclick = async () => {
    if (!(await ask('Delete this? This cannot be undone.', { ok: 'Delete', danger: true }))) return;
    onDelete();
    save();
    modal.close();
    render();
  };
  modal.showModal();
  form.querySelector('input, textarea')?.focus();
}

/* ---------- Forms per item type ---------- */

const PRIORITIES = { normal: 'Normal', high: 'High', low: 'Low' };
const REPEAT_UNITS = { days: 'days', weeks: 'weeks', months: 'months' };

function repeatLabel(t) {
  const n = Number(t.repeatEvery) || 1;
  const unit = n === 1 ? t.repeatUnit.slice(0, -1) : t.repeatUnit;
  return n === 1 ? `🔁 Every ${unit}` : `🔁 Every ${n} ${unit}`;
}

// Next due date: count from the due date, or from today if that's later (done late or no date).
function nextDue(t) {
  const t0 = todayStr();
  const base = t.due && t.due > t0 ? t.due : t0;
  const n = Math.max(1, Number(t.repeatEvery) || 1);
  if (t.repeatUnit === 'days') return addDays(base, n);
  if (t.repeatUnit === 'weeks') return addDays(base, n * 7);
  // Months: keep the same day of month, or the last day if the month is shorter (Jan 31 -> Feb 28).
  const d = parseYmd(base);
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d.getDate(), lastDay));
  return ymd(target);
}

function toggleTask(t) {
  if (t.recurring && !t.done) {
    t.prevDue = t.due || '';
    t.due = nextDue(t);
    t.done = true;
    toast(`🔁 Nice! “${t.title}” comes back ${fmtDate(t.due)}`);
  } else if (t.recurring && t.done) {
    // Undo a check-off: put the old due date back.
    t.due = t.prevDue ?? t.due;
    t.done = false;
  } else {
    t.done = !t.done;
  }
}

// Recurring tasks that were checked off come back once their next due date arrives.
function reviveRecurring() {
  const t0 = todayStr();
  let changed = false;
  for (const t of db.tasks) {
    if (t.recurring && t.done && t.due && t.due <= t0) { t.done = false; delete t.prevDue; changed = true; }
  }
  if (changed) save();
}

let toastTimer;
function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

function taskForm(task) {
  openForm({
    title: task ? 'Edit task' : 'New task',
    fields: [
      { name: 'title', label: 'Task', required: true, placeholder: 'What needs doing?' },
      { name: 'due', label: 'Due date', type: 'date' },
      { name: 'priority', label: 'Priority', type: 'select', options: PRIORITIES },
      { name: 'category', label: 'Category', type: 'select',
        options: Object.fromEntries([['', '— None —'], ...db.categories.map((c) => [c.id, `${c.emoji} ${c.name}`])]) },
      { name: 'newCategory', label: '…or create a new category', placeholder: 'e.g. 🏠 Home  (emoji optional)' },
      { name: 'recurring', label: '🔁 Repeats', type: 'checkbox' },
      { name: 'repeat', type: 'repeat', showIf: 'recurring' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
    values: task || {
      due: state.view === 'calendar' ? state.calDay : '',
      category: state.view === 'tasks' && find('categories', state.taskCat) ? state.taskCat : '',
    },
    onSave: (d) => {
      if (d.newCategory) d.category = addCategory(d.newCategory).id;
      delete d.newCategory;
      d.recurring = !!d.recurring;
      d.repeatEvery = Math.min(365, Math.max(1, parseInt(d.repeatEvery, 10) || 1));
      if (task) Object.assign(task, d);
      else db.tasks.push({ id: uid(), done: false, createdAt: Date.now(), ...d });
    },
    onDelete: task && (() => remove('tasks', task.id)),
  });
}

// Reuses an existing category with the same name instead of making a duplicate.
function addCategory(text) {
  const { emoji, name } = splitEmoji(text);
  const existing = db.categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  const cat = { id: uid(), emoji, name };
  db.categories.push(cat);
  return cat;
}

function categoryForm(cat) {
  openForm({
    title: cat ? 'Edit category' : 'New category',
    fields: [
      { name: 'emoji', label: 'Emoji', placeholder: '🏠', required: true },
      { name: 'name', label: 'Name', required: true, placeholder: 'e.g. Home, Work, Errands' },
    ],
    values: cat || { emoji: '🏷️' },
    onSave: (d) => {
      if (cat) Object.assign(cat, d);
      else { const c = addCategory(`${d.emoji} ${d.name}`); state.taskCat = c.id; }
    },
    onDelete: cat && (() => {
      remove('categories', cat.id);
      db.tasks.forEach((t) => { if (t.category === cat.id) t.category = ''; });
      state.taskCat = 'all';
    }),
  });
}

function eventForm(ev, date) {
  openForm({
    title: ev ? 'Edit event' : 'New event',
    fields: [
      { name: 'title', label: 'Event', required: true, placeholder: 'Dinner with friends' },
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'time', label: 'Time (optional)', type: 'time' },
      { name: 'notes', label: 'Notes / location', type: 'textarea' },
    ],
    values: ev || { date: date || todayStr() },
    onSave: (d) => (ev ? Object.assign(ev, d) : db.events.push({ id: uid(), ...d })),
    onDelete: ev && (() => remove('events', ev.id)),
  });
}

function noteForm(note) {
  openForm({
    title: note ? 'Edit note' : 'New note',
    fields: [
      { name: 'title', label: 'Title' },
      { name: 'tag', label: 'Tag (optional)', placeholder: 'e.g. ideas, home, work' },
      { name: 'body', label: 'Note', type: 'textarea' },
    ],
    values: note || {},
    onSave: (d) => (note ? Object.assign(note, d, { updatedAt: Date.now() })
      : db.notes.push({ id: uid(), updatedAt: Date.now(), ...d })),
    onDelete: note && (() => remove('notes', note.id)),
  });
}

function habitForm(h) {
  openForm({
    title: h ? 'Edit habit' : 'New habit',
    fields: [{ name: 'name', label: 'Habit', required: true, placeholder: 'e.g. Read 10 pages' }],
    values: h || {},
    onSave: (d) => (h ? Object.assign(h, d) : db.habits.push({ id: uid(), log: {}, ...d })),
    onDelete: h && (() => remove('habits', h.id)),
  });
}

function personForm(p) {
  openForm({
    title: p ? 'Edit person' : 'Add a person',
    fields: [{ name: 'name', label: 'Name', required: true, placeholder: 'e.g. Wife, Mom, Best friend' }],
    values: p || {},
    onSave: (d) => {
      if (p) Object.assign(p, d);
      else { const n = { id: uid(), items: [], ...d }; db.people.push(n); state.personId = n.id; }
    },
    onDelete: p && (() => { remove('people', p.id); state.personId = null; }),
  });
}

function personItemForm(person, kind, item) {
  const k = PERSON_KINDS[kind];
  const fields = [{ name: 'text', label: kind === 'date' ? 'What is it?' : k.one[0].toUpperCase() + k.one.slice(1), required: true, placeholder: k.hint }];
  if (kind === 'date') fields.push({ name: 'date', label: 'Date', type: 'date', required: true });
  if (kind === 'idea') fields.push({ name: 'date', label: 'Planned for (optional)', type: 'date' });
  fields.push({ name: 'details', label: 'Details', type: 'textarea' });
  openForm({
    title: `${item ? 'Edit' : 'Add'} ${k.one}`,
    fields,
    values: item || {},
    onSave: (d) => (item ? Object.assign(item, d) : person.items.push({ id: uid(), kind, done: false, ...d })),
    onDelete: item && (() => { person.items = person.items.filter((i) => i.id !== item.id); }),
  });
}

function placeForm(p) {
  openForm({
    title: p ? 'Edit place' : 'Save a place',
    fields: [
      { name: 'name', label: 'Name', required: true, placeholder: 'e.g. Blue Bottle Coffee' },
      { name: 'type', label: 'Type', type: 'select', options: PLACE_TYPES },
      { name: 'area', label: 'Neighborhood / city', placeholder: 'e.g. Downtown' },
      { name: 'address', label: 'Address (optional, makes the map exact)', placeholder: 'e.g. 123 Main St, Austin' },
      { name: 'link', label: 'Instagram or website link', type: 'url', placeholder: 'https://instagram.com/p/…' },
      { name: 'notes', label: 'Notes', type: 'textarea', placeholder: 'What to order, who recommended it…' },
      { name: 'rating', label: 'Rating (after you go)', type: 'select', options: { '': '—', 1: '★', 2: '★★', 3: '★★★', 4: '★★★★', 5: '★★★★★' } },
    ],
    values: p || { type: state.placeType !== 'all' ? state.placeType : 'coffee' },
    onSave: (d) => {
      d.rating = d.rating ? Number(d.rating) : null;
      if (p) Object.assign(p, d);
      else db.places.push({ id: uid(), visited: false, createdAt: Date.now(), ...d });
    },
    onDelete: p && (() => remove('places', p.id)),
  });
}

/* ---------- Actions (clicks) ---------- */

// Inside an embedded viewer, file downloads are blocked, so only offer Copy there.
const inFrame = window.self !== window.top;

const currentPerson = () => find('people', state.personId);

const actions = {
  add() {
    ({
      today: () => taskForm(),
      tasks: () => taskForm(),
      calendar: () => eventForm(null, state.calDay),
      notes: () => noteForm(),
      habits: () => habitForm(),
      people: () => (state.personId ? personItemForm(currentPerson(), 'order') : personForm()),
      places: () => placeForm(),
    })[state.view]();
  },
  'edit-task': ({ id }) => taskForm(find('tasks', id)),
  'toggle-task': ({ id }) => { toggleTask(find('tasks', id)); save(); render(); },
  'task-filter': ({ value }) => { state.taskFilter = value; render(); },
  'task-cat': ({ value }) => { state.taskCat = value; render(); },
  'task-high': () => { state.taskHigh = !state.taskHigh; render(); },
  'task-month': () => { state.taskMonth = !state.taskMonth; render(); },
  'add-category': () => categoryForm(),
  'edit-category': ({ id }) => categoryForm(find('categories', id)),

  'edit-event': ({ id }) => eventForm(find('events', id)),
  'add-event': () => eventForm(null, state.calDay),
  'cal-day': ({ value }) => { state.calDay = value; state.calMonth = value.slice(0, 7); render(); },
  'cal-month': ({ value }) => {
    const [y, m] = state.calMonth.split('-').map(Number);
    const d = new Date(y, m - 1 + Number(value), 1);
    state.calMonth = ymd(d).slice(0, 7);
    render();
  },

  'edit-note': ({ id }) => noteForm(find('notes', id)),

  'edit-habit': ({ id }) => habitForm(find('habits', id)),
  'toggle-habit': ({ id, day }) => {
    const h = find('habits', id);
    if (h.log[day]) delete h.log[day]; else h.log[day] = true;
    save(); render();
  },

  'open-person': ({ id }) => { state.view = 'people'; state.personId = id; render(); window.scrollTo(0, 0); },
  'back-people': () => { state.personId = null; render(); },
  'edit-person': () => personForm(currentPerson()),
  'add-person-item': ({ kind }) => personItemForm(currentPerson(), kind),
  'edit-person-item': ({ id }) => {
    const p = currentPerson();
    const item = p.items.find((i) => i.id === id);
    personItemForm(p, item.kind, item);
  },
  'toggle-person-item': ({ id }) => {
    const item = currentPerson().items.find((i) => i.id === id);
    item.done = !item.done; save(); render();
  },

  'edit-place': ({ id }) => placeForm(find('places', id)),
  'toggle-place': ({ id }) => { const p = find('places', id); p.visited = !p.visited; save(); render(); },
  'place-filter': ({ value }) => { state.placeFilter = value; render(); },
  'place-type': ({ value }) => { state.placeType = value; render(); },
  'pick-place': () => {
    const pool = db.places.filter((p) => !p.visited && (state.placeType === 'all' || p.type === state.placeType));
    const p = pool[Math.floor(Math.random() * pool.length)];
    if (!p) return;
    ask(`🎲 How about ${p.name}${p.area ? ' (' + p.area + ')' : ''}?`, { ok: 'Show me' })
      .then((yes) => yes && placeForm(p));
  },

  export() {
    const json = JSON.stringify(db, null, 2);
    modal.innerHTML = `
      <form method="dialog">
        <h3>Export backup</h3>
        <p class="meta">Copy this text and keep it somewhere safe, like a note or an email to yourself.
          To restore it, use Import backup and paste it in.</p>
        <textarea id="backup-text" readonly>${esc(json)}</textarea>
        <div class="modal-actions">
          ${inFrame ? '' : '<button type="button" class="btn ghost" data-modal="download">Download file</button>'}
          <div class="right">
            <button type="button" class="btn ghost" data-modal="cancel">Close</button>
            <button type="button" class="btn" data-modal="copy">Copy</button>
          </div>
        </div>
      </form>`;
    const text = modal.querySelector('#backup-text');
    modal.querySelector('[data-modal="cancel"]').onclick = () => modal.close();
    modal.querySelector('[data-modal="copy"]').onclick = (e) => {
      navigator.clipboard?.writeText(json)
        .then(() => { e.target.textContent = 'Copied ✓'; })
        .catch(() => { text.focus(); text.select(); });
    };
    const dl = modal.querySelector('[data-modal="download"]');
    if (dl) dl.onclick = () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      a.download = `organizer-backup-${todayStr()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    modal.showModal();
  },
  import() {
    modal.innerHTML = `
      <form method="dialog">
        <h3>Import backup</h3>
        <p class="meta">Paste the backup text below, or choose a backup file.
          This replaces everything currently in the app.</p>
        <textarea id="import-text" placeholder='{"tasks": [ ... ]}'></textarea>
        <button type="button" class="btn ghost small" data-modal="file">Choose a file instead</button>
        <p class="meta overdue" id="import-error" hidden></p>
        <div class="modal-actions"><div class="right">
          <button type="button" class="btn ghost" data-modal="cancel">Cancel</button>
          <button type="submit" class="btn">Replace my data</button>
        </div></div>
      </form>`;
    modal.querySelector('[data-modal="cancel"]').onclick = () => modal.close();
    modal.querySelector('[data-modal="file"]').onclick = () => document.getElementById('import-file').click();
    modal.querySelector('form').onsubmit = (e) => {
      e.preventDefault();
      const err = modal.querySelector('#import-error');
      try {
        restore(modal.querySelector('#import-text').value);
        modal.close();
      } catch (ex) {
        err.textContent = 'That doesn\'t look like a backup from this app. Paste the full text from Export backup.';
        err.hidden = false;
      }
    };
    modal.showModal();
  },
};

document.addEventListener('click', (e) => {
  const tab = e.target.closest('#tabs button');
  if (tab) return go(tab.dataset.view);
  const el = e.target.closest('[data-action]');
  if (!el || el.closest('dialog')) return;
  if (e.target.closest('a')) return; // let links open normally
  e.stopPropagation();
  actions[el.dataset.action]?.(el.dataset);
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'note-search') {
    state.noteQuery = e.target.value;
    document.getElementById('note-list').innerHTML = noteList();
  }
});

function restore(text) {
  const data = JSON.parse(text);
  if (typeof data !== 'object' || !data || Array.isArray(data)) throw new Error('Not a backup');
  db = Object.assign(emptyDb(), data);
  save();
  render();
}

document.getElementById('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const area = document.getElementById('import-text');
  if (area) area.value = await file.text();
});

// Re-render when the day changes (e.g. app left open overnight).
let lastDay = todayStr();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && todayStr() !== lastDay) { lastDay = todayStr(); reviveRecurring(); render(); }
});

/* ---------- Offline support ---------- */

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

reviveRecurring();
render();
startCloud();
