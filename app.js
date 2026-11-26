// Sherman admin dashboard. Every privileged read/write is re-checked in
// Supabase (admin_* functions and study_classes RLS); this page only renders.
(() => {
  const cfg = window.SHERMAN_CONFIG || {};
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => Number(v || 0).toLocaleString('it-IT');
  const date = (v, opts = { day: 'numeric', month: 'short', year: 'numeric' }) => (v ? new Date(v).toLocaleDateString('it-IT', opts) : '—');
  const time = (v) => new Date(v).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  const KINDS = { class: 'Study club', event: 'Night', lab: 'Masterclass' };
  // Outline icons (24px grid, currentColor) for compact row actions.
  const svg = (d) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const shield = '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>';
  const ICONS = {
    makeAdmin: svg(`${shield}<path d="M12 8v6M9 11h6"/>`),
    removeAdmin: svg(`${shield}<path d="M9 11h6"/>`),
    key: svg('<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>'),
    trash: svg('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/>'),
  };
  const iconButton = (icon, label, attrs, extra = '') =>
    `<button class="btn icon-action${extra}" title="${esc(label)}" aria-label="${esc(label)}" ${attrs}>${icon}</button>`;

  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    document.body.innerHTML = '<p style="padding:32px">Configurazione mancante: crea <code>dashboard/config.js</code> da <code>config.example.js</code>.</p>';
    return;
  }
  const db = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  let me = null;

  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), 3200);
  }
  const fail = (e) => toast(e?.message || 'Qualcosa è andato storto');

  function confirmAction(text) {
    const d = $('#confirm-dialog');
    $('#confirm-text').textContent = text;
    d.returnValue = '';
    d.showModal();
    return new Promise((ok) => d.addEventListener('close', () => ok(d.returnValue === 'yes'), { once: true }));
  }

  // ---------- Auth ----------
  async function boot() {
    const { data } = await db.auth.getSession();
    const user = data.session?.user;
    if (!user) return showLogin();
    const { data: admin, error } = await db.rpc('has_role', { _user_id: user.id, _role: 'admin' });
    if (error || !admin) {
      await db.auth.signOut();
      return showLogin('Questo account non ha il ruolo di amministratore.');
    }
    me = user;
    $('#me-email').textContent = user.email;
    $('#login').hidden = true;
    $('#app').hidden = false;
    show(location.hash.slice(1) || 'insights');
  }
  function showLogin(message = '') {
    $('#app').hidden = true;
    $('#login').hidden = false;
    $('#login-error').textContent = message;
  }
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    // Staff usernames (e.g. "sherman") map to non-deliverable admin addresses.
    const id = String(f.get('email')).trim().toLowerCase();
    const email = id.includes('@') ? id : `${id}@admin.sherman.invalid`;
    const { error } = await db.auth.signInWithPassword({ email, password: f.get('password') });
    btn.disabled = false;
    if (error) return showLogin('Email o password non corretti.');
    boot();
  });
  $('#sign-out').addEventListener('click', async () => {
    await db.auth.signOut();
    showLogin();
  });

  // ---------- Navigation ----------
  const loaders = { insights: loadInsights, users: loadUsers, events: loadEvents };
  function show(view) {
    if (!loaders[view]) view = 'insights';
    history.replaceState(null, '', '#' + view);
    $$('.view').forEach((v) => (v.hidden = v.id !== 'view-' + view));
    $$('.nav-item').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
    loaders[view]().catch(fail);
  }
  $$('.nav-item').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));

  // ---------- Insights ----------
  let days = 30;
  $$('#period button').forEach((b) =>
    b.addEventListener('click', () => {
      days = Number(b.dataset.days);
      $$('#period button').forEach((x) => x.classList.toggle('on', x === b));
      loadInsights().catch(fail);
    }),
  );

  const plural = (n, one, many) => `${num(n)} ${Number(n) === 1 ? one : many}`;
  const shortDay = (d) => date(d, { day: 'numeric', month: 'short' });
  const longDay = (d) => date(d, { weekday: 'long', day: 'numeric', month: 'long' });
  const hours = (m) => (m >= 120 ? `${num(Math.round((m / 60) * 10) / 10)} h` : `${num(m)} min`);

  // Line chart you can scrub like in the app: hover, drag or use the arrow keys.
  function lineChart(el, points, key, unit, { average = false, cumulativeFrom = null } = {}) {
    let values = points.map((p) => Number(p[key] || 0));
    if (cumulativeFrom != null) { let t = Number(cumulativeFrom); values = values.map((v) => (t += v)); }
    if (!values.length) { el.innerHTML = '<p class="muted">Nessun dato.</p>'; return; }
    const W = 600, H = 180, top = 12, bottom = 8;
    const peak = Math.max(1, ...values);
    const x = (i) => (values.length === 1 ? W / 2 : (i / (values.length - 1)) * W);
    const y = (v) => top + (H - top - bottom) * (1 - v / peak);
    const pts = values.map((v, i) => [x(i), y(v)]);
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], m = (ax + bx) / 2;
      d += ` C${m},${ay} ${m},${by} ${bx},${by}`;
    }
    const grid = [0, 1, 2, 3].map((i) => { const gy = H - bottom - (i * (H - top - bottom)) / 3; return `<line x1="0" x2="${W}" y1="${gy}" y2="${gy}" stroke="#e0e4dc"/>`; }).join('');
    const last = pts[pts.length - 1];
    const sum = values.reduce((a, b) => a + b, 0);
    const summary = cumulativeFrom != null ? values[values.length - 1]
      : average ? Math.round((sum / values.length) * 10) / 10 : sum;
    const label = cumulativeFrom != null ? 'Ora' : average ? 'Media' : 'Totale';
    const gid = 'g' + Math.random().toString(36).slice(2);
    el.innerHTML = `
      <div class="chart-box" tabindex="0" role="slider" aria-label="${esc(`${label} ${num(summary)} ${unit}. Usa le frecce per leggere ogni giorno.`)}"
        aria-valuemin="0" aria-valuemax="${values.length - 1}">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
          <defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#bce69d" stop-opacity=".6"/><stop offset="1" stop-color="#bce69d" stop-opacity="0"/></linearGradient></defs>
          ${grid}
          <path d="${d} L${last[0]},${H - bottom} L${pts[0][0]},${H - bottom} Z" fill="url(#${gid})"/>
          <path d="${d}" fill="none" stroke="#14382d" stroke-width="2.5" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
        </svg>
        <span class="chart-guide" hidden></span><span class="chart-dot" hidden></span>
        <div class="chart-tip" role="status" hidden></div>
      </div>
      <div class="chart-axis"><span>${esc(shortDay(points[0].day))}</span><strong>${label} ${num(summary)} ${unit}</strong><span>${esc(shortDay(points[points.length - 1].day))}</span></div>`;

    const box = el.querySelector('.chart-box'), guide = box.querySelector('.chart-guide'),
      dot = box.querySelector('.chart-dot'), tip = box.querySelector('.chart-tip');
    let current = -1;
    const show = (i) => {
      current = Math.max(0, Math.min(values.length - 1, i));
      const px = (x(current) / W) * 100, py = (y(values[current]) / H) * 100;
      guide.style.left = dot.style.left = `${px}%`;
      dot.style.top = `${py}%`;
      tip.innerHTML = `<span>${esc(longDay(points[current].day))}</span><strong>${num(values[current])} ${esc(unit)}</strong>`;
      tip.style.left = `${Math.min(88, Math.max(12, px))}%`;
      guide.hidden = dot.hidden = tip.hidden = false;
      box.setAttribute('aria-valuenow', current);
      box.setAttribute('aria-valuetext', `${longDay(points[current].day)}: ${num(values[current])} ${unit}`);
    };
    const hide = () => { guide.hidden = dot.hidden = tip.hidden = true; current = -1; };
    const at = (e) => {
      const r = box.getBoundingClientRect();
      show(Math.round(((e.clientX - r.left) / r.width) * (values.length - 1)));
    };
    box.addEventListener('pointerdown', (e) => { box.setPointerCapture(e.pointerId); at(e); });
    box.addEventListener('pointermove', at);
    box.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
    box.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') setTimeout(hide, 1800); });
    box.addEventListener('blur', hide);
    box.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (e.key === 'Home') show(0);
      else if (e.key === 'End') show(values.length - 1);
      else if (step) show(current < 0 ? values.length - 1 : current + step);
      else return;
      e.preventDefault();
    });
  }

  let stats = null;
  async function loadInsights() {
    const { data: s, error } = await db.rpc('admin_insights', { _days: days });
    if (error) throw error;
    stats = s;
    const kpis = [
      ['users', 'Utenti totali', num(s.users), `+${num(s.new_users)} negli ultimi ${s.days} giorni`],
      ['active', 'Utenti attivi', num(s.active_users), 'Almeno una sessione di focus'],
      ['focus', 'Minuti di focus', num(s.focus_minutes), plural(s.focus_sessions, 'sessione completata', 'sessioni completate')],
      ['bookings', 'Prenotazioni', num(s.bookings), 'Confermate nel periodo'],
      ['events', 'Eventi in programma', num(s.upcoming_events), plural(s.admins, 'amministratore', 'amministratori')],
    ];
    $('#kpis').innerHTML = kpis.map(([k, l, v, sub]) => `
      <button class="kpi" data-kpi="${k}" aria-label="${esc(`${l}: ${v}. Apri i dettagli`)}">
        <div class="kpi-label">${esc(l)}<span class="kpi-more" aria-hidden="true">→</span></div>
        <div class="kpi-value">${v}</div><div class="kpi-sub">${esc(sub)}</div>
      </button>`).join('');
    const daily = s.daily || [];
    lineChart($('#chart-signups'), daily, 'signups', 'nuovi');
    lineChart($('#chart-focus'), daily, 'focus_minutes', 'min');
    lineChart($('#chart-active'), daily, 'active_users', 'utenti', { average: true });
    const kinds = s.events_by_kind || [];
    $('#by-kind').innerHTML = kinds.length
      ? Object.keys(KINDS).map((k) => {
          const e = kinds.find((x) => x.kind === k) || { events: 0, booked: 0, capacity: 0 };
          const fill = e.capacity ? Math.round((e.booked / e.capacity) * 100) : 0;
          return `<div><div class="kind-row"><span><span class="badge ${k}">${KINDS[k]}</span> ${plural(e.events, 'evento', 'eventi')}</span><strong>${num(e.booked)} / ${num(e.capacity)} posti · ${fill}%</strong></div><div class="bar"><span style="width:${fill}%"></span></div></div>`;
        }).join('')
      : '<p class="muted">Nessun evento nel periodo.</p>';
  }
  $('#kpis').addEventListener('click', (e) => {
    const card = e.target.closest('[data-kpi]');
    if (card) openDetail(card.dataset.kpi).catch(fail);
  });

  // ---------- KPI details ----------
  const detail = $('#detail-dialog');
  detail.querySelector('[data-close]').addEventListener('click', () => detail.close());
  detail.addEventListener('click', (e) => { if (e.target === detail) detail.close(); });
  const stat = (label, value) => `<div class="mini"><span>${esc(label)}</span><strong>${value}</strong></div>`;
  const peakOf = (daily, key) => daily.reduce((b, p) => (Number(p[key]) > Number(b[key] || 0) ? p : b), daily[0] || {});
  const person = (name, sub, value) => `<li><div><strong>${esc(name || 'Senza nome')}</strong><small>${esc(sub)}</small></div><span>${value}</span></li>`;
  async function topStudents() {
    const { data, error } = await db.rpc('admin_top_students', { _days: stats.days, _limit: 8 });
    if (error) throw error;
    return data.length
      ? `<ol class="rank">${data.map((u) => person(u.full_name, `${plural(u.sessions, 'sessione', 'sessioni')} · ${plural(u.active_days, 'giorno attivo', 'giorni attivi')}`, hours(Number(u.minutes)))).join('')}</ol>`
      : '<p class="muted">Nessuna sessione nel periodo.</p>';
  }
  async function eventRows(filter, sort, empty) {
    const { data, error } = await db.rpc('admin_events');
    if (error) throw error;
    const rows = data.filter(filter).sort(sort).slice(0, 8);
    return rows.length
      ? `<ol class="rank">${rows.map((e) => {
          const fill = Math.min(100, Math.round((e.booked / e.capacity) * 100));
          return `<li><div><strong>${esc(e.title)}</strong><small>${esc(KINDS[e.kind] || e.kind)} · ${esc(longDay(e.starts_at))} · ${esc(e.location)}</small><div class="bar"><span style="width:${fill}%"></span></div></div><span>${num(e.booked)}/${num(e.capacity)}</span></li>`;
        }).join('')}</ol>`
      : `<p class="muted">${empty}</p>`;
  }

  async function openDetail(kind) {
    const s = stats, daily = s.daily || [], n = daily.length || 1;
    const since = new Date(daily[0]?.day || Date.now());
    const sum = (k) => daily.reduce((a, p) => a + Number(p[k] || 0), 0);
    const avg = (k) => num(Math.round((sum(k) / n) * 10) / 10);
    const peakLine = (k, one, many) => { const p = peakOf(daily, k); return Number(p[k]) ? `${plural(p[k], one, many)} · ${shortDay(p.day)}` : '—'; };
    const views = {
      users: {
        title: 'Utenti totali', sub: `Crescita della community negli ultimi ${s.days} giorni.`,
        stats: [['Iscritti', num(s.users)], ['Nuovi nel periodo', `+${num(s.new_users)}`],
          ['Crescita', s.users_before ? `+${Math.round((s.new_users / s.users_before) * 100)}%` : '—'], ['Giorno migliore', peakLine('signups', 'nuovo iscritto', 'nuovi iscritti')]],
        chart: ['Iscritti totali', 'signups', 'utenti', { cumulativeFrom: s.users_before ?? s.users - s.new_users }],
        list: ['Ultimi iscritti', async () => {
          const { data, error } = await db.rpc('admin_users', { _search: '', _limit: 8, _offset: 0 });
          if (error) throw error;
          return `<ol class="rank">${data.map((u) => person(u.full_name, u.email, esc(date(u.created_at)))).join('')}</ol>`;
        }],
      },
      active: {
        title: 'Utenti attivi', sub: 'Studenti con almeno una sessione di focus.',
        stats: [['Attivi nel periodo', num(s.active_users)], ['Media al giorno', avg('active_users')],
          ['Giorno più attivo', peakLine('active_users', 'utente', 'utenti')], ['Sul totale', s.users ? `${Math.round((s.active_users / s.users) * 100)}%` : '—']],
        chart: ['Utenti attivi al giorno', 'active_users', 'utenti', { average: true }],
        list: ['Studenti più costanti', topStudents],
      },
      focus: {
        title: 'Minuti di focus', sub: 'Tempo di studio registrato con Deep Focus.',
        stats: [['Totale', hours(Number(s.focus_minutes))], ['Sessioni completate', num(s.focus_sessions)],
          ['Media per sessione', s.focus_sessions ? `${num(Math.round((s.focus_minutes / s.focus_sessions) * 10) / 10)} min` : '—'], ['Giorno migliore', peakLine('focus_minutes', 'min', 'min')]],
        chart: ['Minuti di focus al giorno', 'focus_minutes', 'min'],
        list: ['Chi ha studiato di più', topStudents],
      },
      bookings: {
        title: 'Prenotazioni', sub: 'Posti confermati negli eventi.',
        stats: [['Nel periodo', num(s.bookings)], ['Media al giorno', avg('bookings')],
          ['Giorno migliore', peakLine('bookings', 'prenotazione', 'prenotazioni')], ['Eventi in programma', num(s.upcoming_events)]],
        chart: ['Prenotazioni al giorno', 'bookings', 'prenotazioni'],
        list: ['Eventi più prenotati', () => eventRows((e) => new Date(e.starts_at) >= since, (a, b) => b.booked - a.booked, 'Nessun evento nel periodo.')],
      },
      events: {
        title: 'Eventi in programma', sub: 'Quanto si stanno riempiendo i prossimi eventi.',
        stats: [['In programma', num(s.upcoming_events)]],
        list: ['Prossimi eventi', async () => {
          const { data, error } = await db.rpc('admin_events');
          if (error) throw error;
          const up = data.filter((e) => new Date(e.starts_at) > Date.now());
          const seats = up.reduce((a, e) => a + e.capacity, 0), booked = up.reduce((a, e) => a + Number(e.booked), 0);
          $('#detail-stats').innerHTML += stat('Posti totali', num(seats)) + stat('Prenotati', num(booked)) + stat('Riempimento', seats ? `${Math.round((booked / seats) * 100)}%` : '—');
          return eventRows((e) => new Date(e.starts_at) > Date.now(), (a, b) => new Date(a.starts_at) - new Date(b.starts_at), 'Nessun evento in programma.');
        }],
      },
    };
    const v = views[kind];
    $('#detail-title').textContent = v.title;
    $('#detail-sub').textContent = v.sub;
    $('#detail-stats').innerHTML = v.stats.map(([l, val]) => stat(l, esc(val))).join('');
    $('#detail-chart-card').hidden = !v.chart;
    if (v.chart) {
      $('#detail-chart-title').textContent = v.chart[0];
      lineChart($('#detail-chart'), daily, v.chart[1], v.chart[2], v.chart[3]);
    }
    $('#detail-list-title').textContent = v.list[0];
    $('#detail-list').innerHTML = '<p class="muted">Caricamento…</p>';
    if (!detail.open) detail.showModal();
    try { $('#detail-list').innerHTML = await v.list[1](); }
    catch (e) { $('#detail-list').innerHTML = `<p class="error">${esc(e.message)}</p>`; }
  }

  // ---------- Users ----------
  const PAGE = 50;
  let page = 0, search = '', searchTimer;
  $('#user-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { search = e.target.value; page = 0; loadUsers().catch(fail); }, 300);
  });
  $('#prev').addEventListener('click', () => { page = Math.max(0, page - 1); loadUsers().catch(fail); });
  $('#next').addEventListener('click', () => { page++; loadUsers().catch(fail); });

  let usersRequest = 0;
  async function loadUsers() {
    const ticket = ++usersRequest;
    const { data, error } = await db.rpc('admin_users', { _search: search, _limit: PAGE, _offset: page * PAGE });
    if (ticket !== usersRequest) return; // A newer search or page already rendered.
    if (error) throw error;
    const total = Number(data[0]?.total_count || 0);
    $('#users-count').textContent = `${num(total)} utenti${search ? ' trovati' : ''}`;
    $('#page-label').textContent = total ? `${page * PAGE + 1}–${Math.min(total, (page + 1) * PAGE)} di ${num(total)}` : '';
    $('#prev').disabled = page === 0;
    $('#next').disabled = (page + 1) * PAGE >= total;
    $('#users-body').innerHTML = data.length
      ? data.map((u) => `
        <tr>
          <td><strong>${esc(u.full_name || 'Senza nome')}</strong><small>${esc(u.email)}</small></td>
          <td>${esc(u.university || '—')}</td>
          <td>${num(u.total_points)}</td>
          <td>${num(u.focus_sessions)} sess.<small>${num(u.focus_minutes)} min</small></td>
          <td>${num(u.bookings)}</td>
          <td>${date(u.created_at)}</td>
          <td>${date(u.last_sign_in_at)}</td>
          <td>${u.is_admin ? '<span class="badge admin">Admin</span>' : '<span class="badge">Utente</span>'}</td>
          <td><div class="row-actions">
            ${u.id === me.id ? '' : iconButton(u.is_admin ? ICONS.removeAdmin : ICONS.makeAdmin, u.is_admin ? 'Rimuovi admin' : 'Rendi admin', `data-role="${esc(u.id)}" data-admin="${u.is_admin ? '0' : '1'}" data-name="${esc(u.full_name || u.email)}"`)}
            ${iconButton(ICONS.key, 'Reimposta password', `data-reset="${esc(u.id)}" data-name="${esc(u.full_name || u.email)}"`)}
            ${u.id === me.id ? '' : iconButton(ICONS.trash, 'Elimina utente', `data-remove="${esc(u.id)}" data-name="${esc(u.full_name || u.email)}"`, ' danger-text')}
          </div></td>
        </tr>`).join('')
      : '<tr><td colspan="9" class="empty">Nessun utente trovato.</td></tr>';
  }
  // Create, reset and delete run in the admin-users Edge Function, which
  // re-checks the admin role and holds the service key server-side.
  async function manageUser(payload) {
    const { data, error } = await db.functions.invoke('admin-users', { body: payload });
    if (error) {
      const body = await error.context?.json?.().catch(() => null);
      throw new Error(body?.error || error.message);
    }
    return data;
  }
  function formDialog(id, onSubmit) {
    const d = $(`#${id}-dialog`), f = $(`#${id}-form`), err = $(`#${id}-error`);
    d.querySelector('[data-close]').addEventListener('click', () => d.close());
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = f.querySelector('[type=submit]');
      btn.disabled = true;
      err.textContent = '';
      try {
        await onSubmit(new FormData(f));
        d.close();
        loadUsers().catch(fail);
      } catch (x) {
        err.textContent = x.message;
      } finally {
        btn.disabled = false;
      }
    });
    return (prepare) => { f.reset(); err.textContent = ''; prepare?.(); d.showModal(); };
  }
  const openNewUser = formDialog('user', async (f) => {
    await manageUser({ action: 'create', full_name: f.get('full_name').trim(), email: f.get('email').trim(), password: f.get('password') });
    toast('Utente creato');
  });
  $('#new-user').addEventListener('click', () => openNewUser());
  let resetting = null;
  const openReset = formDialog('password', async (f) => {
    await manageUser({ action: 'reset', user_id: resetting, password: f.get('password') });
    toast('Password aggiornata');
  });

  $('#users-body').addEventListener('click', async (e) => {
    const reset = e.target.closest('[data-reset]'), remove = e.target.closest('[data-remove]');
    if (reset) {
      resetting = reset.dataset.reset;
      return openReset(() => ($('#password-who').textContent = reset.dataset.name));
    }
    if (remove) {
      if (!(await confirmAction(`Eliminare definitivamente ${remove.dataset.name}? Sessioni, prenotazioni, messaggi e dati collegati verranno cancellati.`))) return;
      try {
        await manageUser({ action: 'delete', user_id: remove.dataset.remove });
        toast('Utente eliminato');
        loadUsers().catch(fail);
      } catch (x) { fail(x); }
      return;
    }
    const b = e.target.closest('[data-role]');
    if (!b) return;
    const makeAdmin = b.dataset.admin === '1';
    if (!(await confirmAction(makeAdmin ? `Dare a ${b.dataset.name} l’accesso da amministratore?` : `Rimuovere il ruolo di amministratore a ${b.dataset.name}?`))) return;
    const { error } = await db.rpc('admin_set_admin', { _user: b.dataset.role, _admin: makeAdmin });
    if (error) return fail(error);
    toast(makeAdmin ? 'Ruolo admin assegnato' : 'Ruolo admin rimosso');
    loadUsers().catch(fail);
  });

  // ---------- Events ----------
  let events = [], when = 'upcoming';
  $$('#event-filter button').forEach((b) =>
    b.addEventListener('click', () => {
      when = b.dataset.when;
      $$('#event-filter button').forEach((x) => x.classList.toggle('on', x === b));
      renderEvents();
    }),
  );

  async function loadEvents() {
    const { data, error } = await db.rpc('admin_events');
    if (error) throw error;
    events = data;
    renderEvents();
  }
  function renderEvents() {
    const now = Date.now();
    const list = events
      .filter((e) => (when === 'upcoming' ? new Date(e.ends_at) >= now : new Date(e.ends_at) < now))
      .sort((a, b) => (when === 'upcoming' ? 1 : -1) * (new Date(a.starts_at) - new Date(b.starts_at)));
    $('#events-list').innerHTML = list.length
      ? list.map((e) => {
          const fill = Math.min(100, Math.round((e.booked / e.capacity) * 100));
          return `
          <article class="card event">
            <div><span class="badge ${esc(e.kind)}">${esc(KINDS[e.kind] || e.kind)}</span></div>
            <h3>${esc(e.title)}</h3>
            <div class="meta">${esc(date(e.starts_at, { weekday: 'short', day: 'numeric', month: 'long' }))} · ${time(e.starts_at)}–${time(e.ends_at)}<br>${esc(e.location)}</div>
            <div><div class="kind-row"><span class="muted">Prenotazioni</span><strong>${num(e.booked)} / ${num(e.capacity)}</strong></div><div class="bar"><span style="width:${fill}%"></span></div></div>
            <div class="actions"><button class="btn small" data-edit="${esc(e.id)}">Modifica</button><button class="btn small" data-delete="${esc(e.id)}">Elimina</button></div>
          </article>`;
        }).join('')
      : `<p class="card empty">${when === 'upcoming' ? 'Nessun evento in programma.' : 'Nessun evento passato.'}</p>`;
  }

  const dialog = $('#event-dialog'), form = $('#event-form');
  let editing = null;
  const localInput = (iso) => { const d = new Date(iso); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
  function openEditor(ev) {
    editing = ev?.id || null;
    form.reset();
    $('#event-error').textContent = '';
    $('#event-title').textContent = ev ? 'Modifica evento' : 'Nuovo evento';
    if (ev) {
      for (const k of ['kind', 'title', 'description', 'location', 'capacity']) form.elements[k].value = ev[k] ?? '';
      form.elements.starts_at.value = localInput(ev.starts_at);
      form.elements.ends_at.value = localInput(ev.ends_at);
    }
    dialog.showModal();
  }
  $('#new-event').addEventListener('click', () => openEditor());
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const starts = new Date(f.get('starts_at')), ends = new Date(f.get('ends_at'));
    if (ends <= starts) return ($('#event-error').textContent = 'La fine deve essere dopo l’inizio.');
    const row = {
      kind: f.get('kind'),
      title: f.get('title').trim(),
      description: f.get('description').trim() || null,
      location: f.get('location').trim(),
      starts_at: starts.toISOString(),
      ends_at: ends.toISOString(),
      capacity: Number(f.get('capacity')),
    };
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    const { error } = editing
      ? await db.from('study_classes').update(row).eq('id', editing)
      : await db.from('study_classes').insert({ ...row, created_by: me.id });
    btn.disabled = false;
    if (error) return ($('#event-error').textContent = error.message);
    dialog.close();
    toast(editing ? 'Evento aggiornato' : 'Evento creato');
    loadEvents().catch(fail);
  });
  $('#events-list').addEventListener('click', async (e) => {
    const edit = e.target.closest('[data-edit]'), del = e.target.closest('[data-delete]');
    if (edit) openEditor(events.find((x) => x.id === edit.dataset.edit));
    if (del) {
      const ev = events.find((x) => x.id === del.dataset.delete);
      if (!(await confirmAction(`Eliminare “${ev.title}”? Le ${ev.booked} prenotazioni verranno cancellate.`))) return;
      const { error } = await db.from('study_classes').delete().eq('id', ev.id);
      if (error) return fail(error);
      toast('Evento eliminato');
      loadEvents().catch(fail);
    }
  });

  boot().catch(fail);
})();
