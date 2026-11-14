'use strict';
(() => {
  const CFG = window.APP_CONFIG || {};
  // drive.readonly: read the recipes. drive.file: create/update only files this app created
  // (the "Last Made" file). The app can never modify or delete your recipes.
  const SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file';
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
  const LAST_MADE_FILE = CFG.LAST_MADE_FILE || 'Last Made.txt';
  const CONFIGURED = !!CFG.CLIENT_ID && !CFG.CLIENT_ID.startsWith('YOUR_');

  // ---------- persistence (localStorage, best effort) ----------
  const store = {
    get(k, d) {
      try { const v = localStorage.getItem('rr.' + k); return v == null ? d : JSON.parse(v); } catch { return d; }
    },
    set(k, v) { try { localStorage.setItem('rr.' + k, JSON.stringify(v)); } catch { /* full or blocked */ } },
    del(k) { try { localStorage.removeItem('rr.' + k); } catch { /* ignore */ } },
  };

  const state = {
    recipes: store.get('recipes', []),          // [{id, name, modifiedTime, text}]
    lastMade: store.get('lastMade', {}),        // name -> 'YYYY-MM-DD' (as last read from Drive)
    pending: store.get('pending', {}),          // name -> 'YYYY-MM-DD' | '' (cleared) — not yet saved to Drive
    lastMadeFileId: store.get('lastMadeFileId', null),
    folderId: CFG.FOLDER_ID || store.get('folderId2', null),
    folderName: null,
    lastSync: store.get('lastSync', 0),
    sort: store.get('sort', 'name'),
    wake: store.get('wake', true),
    query: '',
  };
  let token = store.get('token', null);         // {value, exp, full}
  if (token && !token.full) token = null;       // older token without verified Drive scopes

  const $ = (s) => document.querySelector(s);
  const els = {
    list: $('#list'), search: $('#search'), sort: $('#sort'), count: $('#count'),
    detail: $('#detail'), status: $('#status'), syncBtn: $('#sync-btn'),
  };

  // ---------- dates ----------
  const pad = (n) => String(n).padStart(2, '0');
  const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const daysAgo = (s) => Math.round((parseDate(todayStr()) - parseDate(s)) / 86400000);
  const formatDate = (s) => parseDate(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  function relative(s) {
    const n = daysAgo(s);
    if (n < 0) return 'in the future';
    if (n === 0) return 'today';
    if (n === 1) return 'yesterday';
    if (n < 14) return `${n} days ago`;
    if (n < 60) return `${Math.round(n / 7)} weeks ago`;
    if (n < 730) return `${Math.round(n / 30.44)} months ago`;
    return `${Math.round(n / 365.25)} years ago`;
  }
  function lastMadeOf(name) {
    if (name in state.pending) return state.pending[name] || null;
    return state.lastMade[name] || null;
  }

  // ---------- "Last Made" file format ----------
  // One line per recipe:  YYYY-MM-DD  Recipe Name   (lines starting with # are comments)
  function parseLastMade(text) {
    const out = {};
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^(\d{4}-\d{2}-\d{2})\s+(.+)$/);
      if (m) out[m[2].trim()] = m[1];
    }
    return out;
  }
  function serializeLastMade(map) {
    const names = Object.keys(map).sort((a, b) => a.localeCompare(b));
    return [
      '# Last time each recipe was made. Format: YYYY-MM-DD  Recipe name',
      '# Written by Rove Recipes. Fine to edit by hand.',
      '',
      ...names.map((n) => `${map[n]}  ${n}`),
      '',
    ].join('\n');
  }

  // ---------- Google auth ----------
  class AuthError extends Error {}
  let tokenClient = null;
  let needConsent = false;
  const tokenValid = () => !!token && token.exp > Date.now() + 60_000;

  function initTokenClient() {
    if (tokenClient || !CONFIGURED || !window.google?.accounts?.oauth2) return;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CFG.CLIENT_ID,
      scope: SCOPES,
      callback: () => {},
    });
    renderAuth();
  }
  if (window.__gisLoaded) initTokenClient();
  else window.addEventListener('gis-loaded', initTokenClient);

  // Must be called synchronously from a user gesture (it may open a popup).
  function getToken() {
    if (tokenValid()) return Promise.resolve(token.value);
    return new Promise((resolve, reject) => {
      if (!CONFIGURED) return reject(new Error('Not configured — set CLIENT_ID in config.js'));
      if (!tokenClient) return reject(new Error('Google sign-in is still loading (or you are offline)'));
      tokenClient.callback = (resp) => {
        if (resp.error) return reject(new AuthError(resp.error_description || resp.error));
        if (!google.accounts.oauth2.hasGrantedAllScopes(resp, ...SCOPES.split(' '))) {
          needConsent = true;
          return reject(new AuthError('Google Drive access was not fully allowed — tap Sign in and tick both boxes'));
        }
        needConsent = false;
        token = { value: resp.access_token, exp: Date.now() + Number(resp.expires_in) * 1000, full: true };
        store.set('token', token);
        store.set('signedInOnce', true);
        renderAuth();
        resolve(token.value);
      };
      tokenClient.error_callback = (err) => reject(new AuthError(
        err?.type === 'popup_closed' ? 'Sign-in window was closed' : (err?.message || 'Sign-in failed')));
      tokenClient.requestAccessToken({ prompt: needConsent ? 'consent' : '' });
    });
  }

  // ---------- Drive API ----------
  async function api(url, opts = {}) {
    if (!tokenValid()) throw new AuthError('Sign in to sync');
    const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token.value}` } });
    if (res.status === 401) {
      token = null; store.del('token'); renderAuth();
      throw new AuthError('Session expired — sign in again');
    }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error?.message || msg; } catch { /* not JSON */ }
      const e = new Error(msg); e.status = res.status; throw e;
    }
    return res;
  }
  const qstr = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  async function listFiles(q, fields = 'id,name,mimeType,modifiedTime') {
    const out = [];
    let pageToken;
    do {
      const p = new URLSearchParams({
        q, fields: `nextPageToken,files(${fields})`, pageSize: '1000',
        supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
      });
      if (pageToken) p.set('pageToken', pageToken);
      const j = await (await api(`${API}/files?${p}`)).json();
      out.push(...j.files);
      pageToken = j.nextPageToken;
    } while (pageToken);
    return out;
  }
  const fileText = async (id) => (await api(`${API}/files/${id}?alt=media&supportsAllDrives=true`)).text();

  async function resolveFolder() {
    if (state.folderId) return state.folderId;
    const name = CFG.FOLDER_NAME || 'Recipes';
    const folders = await listFiles(
      `mimeType='application/vnd.google-apps.folder' and name='${qstr(name)}' and trashed=false`, 'id,name,ownedByMe');
    if (!folders.length) throw new Error(`No Drive folder named "${name}" found — set FOLDER_ID in config.js`);
    // Several folders can share the name; pick the one with the most .md files (prefer ones you own).
    const scored = await mapLimit(folders, 4, async (f) => {
      const kids = await listFiles(`'${f.id}' in parents and trashed=false`, 'id,name');
      return { f, count: kids.filter((k) => /\.md$/i.test(k.name)).length };
    });
    scored.sort((a, b) => (b.count - a.count) || (Number(!!b.f.ownedByMe) - Number(!!a.f.ownedByMe)));
    if (!scored[0].count) {
      throw new Error(`Found ${folders.length} folder(s) named "${name}" but none contain .md files — set FOLDER_ID in config.js`);
    }
    state.folderId = scored[0].f.id;
    store.set('folderId2', state.folderId);
    return state.folderId;
  }

  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    const worker = async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  // ---------- sync ----------
  let syncing = null;
  function sync() {
    if (!syncing) syncing = doSync().finally(() => { syncing = null; renderAuth(); });
    return syncing;
  }

  async function doSync() {
    if (!CONFIGURED) return;
    if (!navigator.onLine) { setStatus('Offline — showing saved recipes'); return; }
    if (!tokenValid()) { renderAuth(); setStatus(''); return; }
    setStatus('Syncing…');
    renderAuth();
    try {
      const folderId = await resolveFolder();
      const files = await listFiles(`'${folderId}' in parents and trashed=false`);

      const known = new Map(state.recipes.map((r) => [r.id, r]));
      const md = files.filter((f) => /\.md$/i.test(f.name));
      if (!md.length) {
        if (!CFG.FOLDER_ID) { state.folderId = null; store.del('folderId2'); } // re-detect next time
        throw new Error('No .md recipe files found in the Drive folder');
      }
      const recipes = await mapLimit(md, 6, async (f) => {
        const name = f.name.replace(/\.md$/i, '');
        const old = known.get(f.id);
        if (old && old.modifiedTime === f.modifiedTime) return { ...old, name };
        return { id: f.id, name, modifiedTime: f.modifiedTime, text: await fileText(f.id) };
      });
      recipes.sort((a, b) => a.name.localeCompare(b.name));
      state.recipes = recipes;
      store.set('recipes', recipes);

      const lm = files.find((f) => f.name === LAST_MADE_FILE);
      state.lastMadeFileId = lm ? lm.id : null;
      state.lastMade = lm ? parseLastMade(await fileText(lm.id)) : {};
      store.set('lastMadeFileId', state.lastMadeFileId);
      store.set('lastMade', state.lastMade);

      if (Object.keys(state.pending).length) await pushLastMade();

      state.lastSync = Date.now();
      store.set('lastSync', state.lastSync);
      setStatus(`Synced ${recipes.length} recipes`);
    } catch (e) {
      handleError(e);
    }
    render();
  }

  // Writes pending "last made" changes, merging with whatever is currently in Drive
  // so edits from another device aren't lost.
  async function pushLastMade() {
    const updates = { ...state.pending };
    const folderId = await resolveFolder();
    let fileId = state.lastMadeFileId;
    let remote = {};
    if (fileId) {
      try { remote = parseLastMade(await fileText(fileId)); } catch (e) { if (e.status === 404) fileId = null; else throw e; }
    }
    if (!fileId) {
      const found = await listFiles(`'${folderId}' in parents and name='${qstr(LAST_MADE_FILE)}' and trashed=false`);
      if (found.length) { fileId = found[0].id; remote = parseLastMade(await fileText(fileId)); }
    }

    const merged = { ...remote };
    for (const [name, date] of Object.entries(updates)) {
      if (date) merged[name] = date; else delete merged[name];
    }
    const body = serializeLastMade(merged);

    if (fileId) {
      try {
        await api(`${UPLOAD_API}/files/${fileId}?uploadType=media&supportsAllDrives=true`, {
          method: 'PATCH', headers: { 'Content-Type': 'text/plain; charset=UTF-8' }, body,
        });
      } catch (e) {
        if (e.status === 403 || e.status === 404) {
          throw new Error(`Can't update "${LAST_MADE_FILE}" — the app can only edit a copy it created. ` +
            'Rename or delete that file in Drive and the app will create a new one.');
        }
        throw e;
      }
    } else {
      const boundary = 'rr' + Math.random().toString(36).slice(2);
      const meta = { name: LAST_MADE_FILE, parents: [folderId], mimeType: 'text/plain' };
      const multipart =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
        `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}\r\n--${boundary}--`;
      const res = await api(`${UPLOAD_API}/files?uploadType=multipart&fields=id&supportsAllDrives=true`, {
        method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart,
      });
      fileId = (await res.json()).id;
    }

    state.lastMadeFileId = fileId;
    state.lastMade = merged;
    for (const [k, v] of Object.entries(updates)) if (state.pending[k] === v) delete state.pending[k];
    store.set('lastMadeFileId', fileId);
    store.set('lastMade', merged);
    store.set('pending', state.pending);
  }

  // Called from a click/change handler, so a sign-in popup is allowed if needed.
  function setLastMade(name, date) {
    state.pending[name] = date;
    store.set('pending', state.pending);
    render();
    if (!navigator.onLine) { setStatus('Offline — will save when back online'); return; }
    getToken()
      .then(() => { setStatus('Saving…'); return pushLastMade(); })
      .then(() => setStatus('Saved to Drive'))
      .catch(handleError)
      .finally(render);
  }

  function handleError(e) {
    console.error(e);
    if (e instanceof AuthError) { renderAuth(); setStatus(e.message, true); }
    else if (!navigator.onLine) setStatus('Offline — showing saved recipes', true);
    else if (e instanceof TypeError && /fetch|network/i.test(e.message)) setStatus('Network error — showing saved recipes', true);
    else setStatus(e.message, true);
  }

  // ---------- UI: status & auth ----------
  let statusTimer = null;
  function setStatus(msg, isError = false) {
    els.status.textContent = msg || '';
    els.status.classList.toggle('error', !!isError);
    clearTimeout(statusTimer);
    if (msg && !isError && !/…|Offline|Tap/.test(msg)) statusTimer = setTimeout(() => { els.status.textContent = ''; }, 4000);
  }

  function renderAuth() {
    const btn = els.syncBtn;
    btn.hidden = !CONFIGURED;
    btn.disabled = !!syncing;
    btn.textContent = syncing ? 'Syncing…' : (tokenValid() || store.get('signedInOnce', false)) ? 'Sync' : 'Sign in';
  }

  els.syncBtn.addEventListener('click', () => {
    getToken().then(() => sync()).catch(handleError);
  });

  // ---------- UI: list ----------
  const normCache = new Map();
  const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  function normed(r) {
    const key = r.id + r.modifiedTime;
    let v = normCache.get(key);
    if (!v) { v = { name: norm(r.name), text: norm(r.text) }; normCache.set(key, v); }
    return v;
  }

  function visibleRecipes() {
    const terms = norm(state.query).split(/\s+/).filter(Boolean);
    const items = [];
    for (const r of state.recipes) {
      let rank = 0;
      if (terms.length) {
        const n = normed(r);
        if (terms.every((t) => n.name.includes(t))) rank = 0;
        else if (terms.every((t) => n.name.includes(t) || n.text.includes(t))) rank = 1;
        else continue;
      }
      items.push({ r, rank, made: lastMadeOf(r.name) });
    }
    const byName = (a, b) => a.r.name.localeCompare(b.r.name);
    const cmp = {
      name: byName,
      recent: (a, b) => (!a.made - !b.made) || (b.made || '').localeCompare(a.made || '') || byName(a, b),
      stale: (a, b) => (!a.made - !b.made) || (a.made || '').localeCompare(b.made || '') || byName(a, b),
    }[state.sort] || byName;
    return items.sort((a, b) => (a.rank - b.rank) || cmp(a, b));
  }

  function renderList() {
    const items = visibleRecipes();
    const current = currentName();
    const frag = document.createDocumentFragment();
    for (const { r, rank, made } of items) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.className = 'item' + (r.name === current ? ' active' : '');
      a.href = '#r=' + encodeURIComponent(r.name);
      if (r.name === current) a.setAttribute('aria-current', 'page');
      const name = document.createElement('span');
      name.className = 'item-name';
      name.textContent = r.name;
      const meta = document.createElement('span');
      meta.className = 'item-meta';
      const bits = [];
      if (made) bits.push('Made ' + relative(made));
      if (rank === 1) bits.push('match in recipe');
      meta.textContent = bits.join(' · ');
      a.append(name, meta);
      li.append(a);
      frag.append(li);
    }
    els.list.replaceChildren(frag);
    const total = state.recipes.length;
    els.count.textContent = state.query ? `${items.length} of ${total}` : `${total} recipe${total === 1 ? '' : 's'}`;
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'empty muted';
      li.textContent = total ? 'No matches.'
        : !CONFIGURED ? 'Setup needed — see README.md.'
        : 'Sign in to load your recipes from Google Drive.';
      els.list.append(li);
    }
  }

  // ---------- UI: detail ----------
  const currentName = () => {
    const m = location.hash.match(/^#r=(.*)$/);
    return m ? decodeURIComponent(m[1]) : null;
  };
  let renderedKey = null;

  // Must match the narrow-layout media query in styles.css.
  const NARROW_QUERY = '(max-width: 799px), (max-width: 1100px) and (orientation: portrait)';
  const isNarrow = () => matchMedia(NARROW_QUERY).matches;

  function setDrawer(open) {
    document.body.classList.toggle('drawer-open', open);
    for (const b of document.querySelectorAll('.toolbar .back')) b.setAttribute('aria-expanded', String(open));
    if (open) els.list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }

  function renderDetail() {
    const name = currentName();
    document.body.classList.toggle('has-recipe', !!name);
    const recipe = name && state.recipes.find((r) => r.name === name);
    const key = recipe ? recipe.id + recipe.modifiedTime : `empty:${name}:${state.recipes.length}:${CONFIGURED}:${tokenValid()}`;

    if (key !== renderedKey) {
      renderedKey = key;
      els.detail.replaceChildren(recipe ? buildRecipe(recipe) : buildPlaceholder(name));
      els.detail.scrollTop = 0;
    }
    if (recipe) renderMadeBar(recipe.name);
    updateWakeLock();
  }

  function buildPlaceholder(name) {
    const div = document.createElement('div');
    div.className = 'placeholder';
    if (name) {
      div.append(toolbar());
      const p = document.createElement('p');
      p.textContent = state.recipes.length ? `Couldn't find "${name}".` : 'Loading…';
      div.append(p);
    } else if (!CONFIGURED) {
      div.innerHTML = '<h2>Setup needed</h2><p>Put your Google OAuth client ID in <code>config.js</code>. See README.md for the steps.</p>';
    } else if (!state.recipes.length && tokenValid()) {
      div.innerHTML = '<h2>No recipes yet</h2><p class="muted">Signed in, but no recipes were loaded. ' +
        'Check the message at the top of the screen, then tap Sync to try again.</p>';
    } else if (!state.recipes.length) {
      div.innerHTML = '<h2>Welcome</h2><p>Sign in with Google to load your recipes from Drive.</p>';
      const b = document.createElement('button');
      b.className = 'btn primary';
      b.textContent = 'Sign in with Google';
      b.addEventListener('click', () => getToken().then(() => sync()).catch(handleError));
      div.append(b);
    } else {
      div.innerHTML = '<p class="muted">Pick a recipe.</p>';
    }
    return div;
  }

  function toolbar() {
    const bar = document.createElement('div');
    bar.className = 'toolbar';
    // Shown only on narrow screens (phone, portrait tablet): slides the recipe list back in.
    const back = document.createElement('button');
    back.className = 'btn back';
    back.type = 'button';
    back.textContent = '☰ Recipes';
    back.setAttribute('aria-controls', 'sidebar');
    back.setAttribute('aria-expanded', 'false');
    back.addEventListener('click', () => setDrawer(!document.body.classList.contains('drawer-open')));
    const right = document.createElement('div');
    right.className = 'toolbar-right';
    bar.append(back, right);
    if ('wakeLock' in navigator) {
      const wake = document.createElement('button');
      wake.className = 'btn toggle';
      wake.type = 'button';
      wake.textContent = 'Keep screen on';
      wake.setAttribute('aria-pressed', String(state.wake));
      wake.addEventListener('click', () => {
        state.wake = !state.wake;
        store.set('wake', state.wake);
        wake.setAttribute('aria-pressed', String(state.wake));
        updateWakeLock();
      });
      right.append(wake);
    }
    return bar;
  }

  function buildRecipe(recipe) {
    const wrap = document.createDocumentFragment();
    wrap.append(toolbar());
    const article = document.createElement('article');
    article.className = 'recipe';
    const html = window.marked ? marked.parse(recipe.text || '') : '';
    article.innerHTML = window.DOMPurify ? DOMPurify.sanitize(html) : html;
    if (!article.querySelector('h1')) {
      const h1 = document.createElement('h1');
      h1.textContent = recipe.name;
      article.prepend(h1);
    }
    for (const a of article.querySelectorAll('a[href]')) { a.target = '_blank'; a.rel = 'noopener'; }
    // Collapsed "last made" dropdown, right-aligned just under "Keep screen on".
    const bar = document.createElement('details');
    bar.className = 'made';
    bar.id = 'made-bar';
    wrap.querySelector('.toolbar-right').append(bar);
    if (!recipe.text.replace(/^#.*$/m, '').trim()) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'This recipe is empty.';
      article.querySelector('h1').after(p);
    }
    wrap.append(article);
    return wrap;
  }

  function renderMadeBar(name) {
    const bar = document.getElementById('made-bar');
    if (!bar) return;
    const made = lastMadeOf(name);
    const today = todayStr();
    const unsynced = name in state.pending;

    const summary = document.createElement('summary');
    summary.textContent = made ? `Made ${relative(made)}` : 'Never made';

    const panel = document.createElement('div');
    panel.className = 'made-panel';
    const when = document.createElement('div');
    when.textContent = made ? `Last made ${formatDate(made)}` : 'Not made yet';
    panel.append(when);
    if (unsynced) {
      const s = document.createElement('div');
      s.className = 'unsynced';
      s.textContent = 'Not saved to Drive yet';
      panel.append(s);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn primary';
    btn.textContent = made === today ? 'Made today ✓' : 'I made this today';
    btn.disabled = made === today;
    btn.addEventListener('click', () => { bar.open = false; setLastMade(name, today); });
    panel.append(btn);

    bar.replaceChildren(summary, panel);
  }

  // Clicking anywhere else closes the "last made" dropdown.
  document.addEventListener('click', (e) => {
    const bar = document.getElementById('made-bar');
    if (bar?.open && !bar.contains(e.target)) bar.open = false;
  });

  // ---------- screen wake lock (keeps the screen on while a recipe is open) ----------
  let wakeLock = null;
  async function updateWakeLock() {
    if (!('wakeLock' in navigator)) return;
    const want = state.wake && !!currentName() && document.visibilityState === 'visible';
    if (want && !wakeLock) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } catch { /* not allowed right now */ }
    } else if (!want && wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }

  // ---------- wiring ----------
  function render() { renderList(); renderDetail(); }

  els.sort.value = state.sort;
  els.sort.addEventListener('change', () => { state.sort = els.sort.value; store.set('sort', state.sort); renderList(); });

  els.search.addEventListener('input', () => { state.query = els.search.value; renderList(); });
  els.search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = visibleRecipes()[0];
      if (first) { location.hash = 'r=' + encodeURIComponent(first.r.name); setDrawer(false); }
    } else if (e.key === 'Escape' && els.search.value) {
      e.stopPropagation();
      els.search.value = ''; state.query = ''; renderList();
    }
  });

  // Picking a recipe (even the one already open) collapses the list on narrow screens.
  els.list.addEventListener('click', (e) => { if (e.target.closest('a.item')) setDrawer(false); });
  $('#scrim').addEventListener('click', () => setDrawer(false));

  window.addEventListener('hashchange', () => {
    setDrawer(false);
    render();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('drawer-open')) {
      setDrawer(false);
    } else if (e.key === '/' && document.activeElement !== els.search && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) {
      e.preventDefault();
      if (currentName() && isNarrow()) setDrawer(true);
      els.search.focus();
    }
  });

  document.addEventListener('visibilitychange', () => {
    updateWakeLock();
    if (document.visibilityState === 'visible' && tokenValid() && Date.now() - state.lastSync > 10 * 60_000) sync();
  });
  window.addEventListener('online', () => { if (tokenValid()) sync(); });
  window.addEventListener('offline', () => setStatus('Offline — showing saved recipes'));

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(console.error));
  }

  document.getElementById('version').textContent = 'v' + (window.APP_VERSION ?? '?');

  render();
  renderAuth();
  sync();
})();
