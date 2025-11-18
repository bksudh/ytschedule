/**
 * Main frontend application logic
 * Provides upload with progress, video listing, streaming controls,
 * edit modal, search & filtering, auto-refresh, and notifications.
 */
(function () {
  'use strict';

  /** Configuration */
  const cfg = window.CONFIG || {};
  const API_URL = cfg.API_BASE || cfg.API_URL || '';
  const REFRESH_INTERVAL_MS = Number(cfg.REFRESH_INTERVAL || 10_000);
  const MAX_FILE_SIZE = typeof cfg.MAX_FILE_SIZE === 'number' ? cfg.MAX_FILE_SIZE : (5 * 1024 * 1024 * 1024);
  const ALLOWED_FORMATS = Array.isArray(cfg.ALLOWED_FORMATS) ? cfg.ALLOWED_FORMATS.map(String).map(s => s.toLowerCase()) : ['mp4','avi','mov','mkv','flv'];
  const STATUS = Object.freeze({
    LIBRARY: 'library',
    SCHEDULED: 'scheduled',
    STREAMING: 'streaming',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
  });

  /** State */
  let videos = [];
  let playlists = [];
  let prevStatusById = new Map();
  let currentFilter = '';
  let searchTerm = '';
  const activeUploads = new Map();
  let refreshTimer = null;
  let isRefreshing = false;

  /** Elements */
  const el = {
    health: document.getElementById('health-status'),
    streamsCount: document.getElementById('streams-count'),
    navActiveCount: document.getElementById('nav-active-count'),
    nav: document.getElementById('main-nav'),
    sectionUpload: document.getElementById('section-upload'),
    sectionLibraryUpload: document.getElementById('section-library-upload'),
    sectionVideos: document.getElementById('section-videos'),
    sectionPlaylistForm: document.getElementById('section-playlist-form'),
    sectionPlaylists: document.getElementById('section-playlists'),
    grid: document.getElementById('videos-grid'),
    empty: document.getElementById('empty-state'),
    listLegacy: document.getElementById('videos-list'),
    filters: document.getElementById('filter-buttons'),
    search: document.getElementById('search-input'),
    form: document.getElementById('upload-form'),
    message: document.getElementById('message'),
    progress: document.getElementById('upload-progress'),
    progressBar: document.getElementById('upload-progress-bar'),
    libraryForm: document.getElementById('library-upload-form'),
    libraryMessage: document.getElementById('library-message'),
    libraryProgress: document.getElementById('library-upload-progress'),
    libraryProgressBar: document.getElementById('library-upload-progress-bar'),
    spinner: document.getElementById('global-spinner'),
    playlistForm: document.getElementById('playlist-form'),
    playlistSelector: document.getElementById('playlist-video-selector'),
    playlistMsg: document.getElementById('playlist-message'),
    playlistsList: document.getElementById('playlists-list'),
    playlistsEmpty: document.getElementById('playlists-empty'),
    themeToggle: document.getElementById('theme-toggle'),
    sectionActiveStreams: document.getElementById('section-active-streams'),
    activeStreamsList: document.getElementById('active-streams-list'),
    activeStreamsEmpty: document.getElementById('active-streams-empty'),
    sectionUrlStream: document.getElementById('section-url-stream'),
    urlForm: document.getElementById('url-stream-form'),
    urlSource: document.getElementById('url-source'),
    urlRtmp: document.getElementById('url-rtmpUrl'),
    urlKey: document.getElementById('url-streamKey'),
    urlMsg: document.getElementById('url-message'),
    urlStatus: document.getElementById('url-status'),
    urlStartBtn: document.getElementById('url-start-btn'),
    urlStopBtn: document.getElementById('url-stop-btn'),
    urlScheduleStart: document.getElementById('url-scheduleStart'),
    urlScheduleStop: document.getElementById('url-scheduleStop'),
    urlScheduleBtn: document.getElementById('url-schedule-btn'),
    urlCancelScheduleBtn: document.getElementById('url-cancel-schedule-btn'),
  };

  /** Utilities */
  /**
   * Fetch JSON with error handling
   * @param {string} url
   * @param {RequestInit} [options]
   * @returns {Promise<any>}
   */
  async function fetchJSON(url, options) {
    const res = await fetch(url, { cache: 'no-store', ...(options || {}) });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = await res.text(); } catch (_) {}
      throw new Error(msg || `HTTP ${res.status}`);
    }
    return res.json();
  }

  /**
   * Format date to local string
   * @param {string|number|Date} d
   */
  function fmtDate(d) {
    if (!d) return '—';
    try { return new Date(d).toLocaleString(); } catch (_) { return String(d); }
  }

  /**
   * Format bytes to MB/GB
   * @param {number} bytes
   */
  function fmtBytes(bytes) {
    if (!bytes && bytes !== 0) return '—';
    const gb = bytes / (1024 ** 3);
    if (gb >= 1) return `${gb.toFixed(2)} GB`;
    const mb = bytes / (1024 ** 2);
    return `${mb.toFixed(1)} MB`;
  }

  /**
   * Format seconds to HH:MM:SS
   * @param {number} s
   */
  function fmtDuration(s) {
    if (!s && s !== 0) return '—';
    s = Math.max(0, Math.round(Number(s)) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(sec)}`;
  }

  /** Debounce */
  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  /** Toast notifications */
  function ensureToastContainer() {
    let c = document.getElementById('toast-container');
    if (!c) {
      c = document.createElement('div');
      c.id = 'toast-container';
      c.className = 'toast-container';
      document.body.appendChild(c);
    }
    return c;
  }
  function showToast(message, type = 'info') {
    const c = ensureToastContainer();
    const t = document.createElement('div');
    t.className = `toast toast--${type}`;
    t.textContent = message;
    c.appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
      t.style.transform = 'translateY(10px)';
      setTimeout(() => t.remove(), 300);
    }, 2200);
  }

  /** Loading helpers */
  function setBusy(busy) {
    if (!el.spinner) return;
    el.spinner.hidden = !busy;
    el.spinner.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  /** Theme handling */
  function applyTheme(theme) {
    const t = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('theme', t); } catch (_) {}
    if (el.themeToggle) {
      const icon = t === 'dark' ? 'fa-regular fa-sun' : 'fa-regular fa-moon';
      const label = t === 'dark' ? 'Light' : 'Dark';
      el.themeToggle.innerHTML = `<i class="${icon}"></i> ${label}`;
    }
  }
  function setupTheme() {
    const saved = (() => { try { return localStorage.getItem('theme'); } catch (_) { return null; } })();
    applyTheme(saved || 'light');
    if (el.themeToggle) {
      el.themeToggle.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme') || 'light';
        applyTheme(current === 'light' ? 'dark' : 'light');
      });
    }
  }

  /** Health */
  async function loadHealth() {
    try {
      const data = await fetchJSON(`${API_URL}/health`);
      el.health.textContent = `${data.status} (db: ${data.db})`;
      el.health.className = data.status === 'ok' ? 'ok' : 'warn';
      if (el.streamsCount && typeof data.streams === 'number') {
        el.streamsCount.textContent = String(data.streams);
      }
    } catch (err) {
      el.health.textContent = 'unreachable';
      el.health.className = 'error';
    }
  }

  /** Build status badge HTML */
  function renderBadge(status) {
    const map = {
      [STATUS.LIBRARY]: { cls: 'badge badge--library', icon: 'fa-regular fa-folder', label: 'Library' },
      [STATUS.SCHEDULED]: { cls: 'badge badge--scheduled', icon: 'fa-regular fa-clock', label: 'Scheduled' },
      [STATUS.STREAMING]: { cls: 'badge badge--streaming', icon: 'fa-solid fa-signal', label: 'Streaming' },
      [STATUS.COMPLETED]: { cls: 'badge badge--completed', icon: 'fa-regular fa-circle-check', label: 'Completed' },
      [STATUS.FAILED]: { cls: 'badge badge--failed', icon: 'fa-regular fa-circle-xmark', label: 'Failed' },
      [STATUS.CANCELLED]: { cls: 'badge badge--failed', icon: 'fa-regular fa-circle-stop', label: 'Cancelled' },
    };
    const m = map[status] || map[STATUS.SCHEDULED];
    return `<span class="${m.cls}"><i class="${m.icon}"></i>${m.label}</span>`;
  }

  /** Active Streams UI */
  function createActiveCard(item) {
    const id = item.id;
    const title = item.title || (item.type === 'external' ? 'External URL' : 'Video Stream');
    const started = fmtDate(item.startedAt);
    const plLine = item.type === 'video' && item.playlistName ? `<div><strong>Playlist:</strong> ${escapeHtml(item.playlistName)}</div>` : '';
    const outUrl = item.outputUrl ? `<div><strong>Output:</strong> ${escapeHtml(item.outputUrl)}</div>` : '';
    const progressStr = item.type === 'external'
      ? (typeof item.progress === 'number' ? fmtDuration(item.progress) : '')
      : (typeof item.progress === 'number' ? `${item.progress}%` : '');
    const srcLine = item.type === 'external' && item.sourceUrl ? `<div><strong>Source:</strong> ${escapeHtml(item.sourceUrl)}</div>` : '';
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = id;
    card.dataset.type = item.type;
    card.innerHTML = `
      <div class="card-head" style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <h3 style="margin:0;">${escapeHtml(title)}</h3>
          ${renderBadge(STATUS.STREAMING)}
        </div>
        <div class="card-actions" style="display:flex;gap:8px;">
          <button class="btn warning" data-action="stop-active" data-id="${id}" data-type="${item.type}"><i class="fa-solid fa-stop"></i> Stop</button>
        </div>
      </div>
      <div class="card-body" style="margin-top:12px;display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div>
          <div><strong>Started:</strong> ${started}</div>
          ${srcLine}
          ${plLine}
        </div>
        <div>
          <div><strong>Progress:</strong> ${progressStr || '—'}</div>
          ${outUrl}
        </div>
      </div>
    `;
    return card;
  }

  function renderActiveStreams(items) {
    if (!el.activeStreamsList) return;
    el.activeStreamsList.innerHTML = '';
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) {
      if (el.activeStreamsEmpty) el.activeStreamsEmpty.hidden = false;
      return;
    }
    if (el.activeStreamsEmpty) el.activeStreamsEmpty.hidden = true;
    const frag = document.createDocumentFragment();
    list.forEach(item => frag.appendChild(createActiveCard(item)));
    el.activeStreamsList.appendChild(frag);
  }

  async function loadActiveStreams() {
    try {
      const data = await fetchJSON(`${API_URL}/streams/active`);
      const items = Array.isArray(data && data.active) ? data.active : [];
      renderActiveStreams(items);
      if (el.streamsCount && typeof data.count === 'number') {
        el.streamsCount.textContent = String(data.count);
      }
      if (el.navActiveCount && typeof data.count === 'number') {
        el.navActiveCount.textContent = String(data.count);
      }
    } catch (err) {
      if (el.activeStreamsEmpty) {
        el.activeStreamsEmpty.hidden = false;
        const p = el.activeStreamsEmpty.querySelector('p');
        if (p) p.textContent = 'Unable to load active streams.';
      }
    }
  }

  function setupActiveActions() {
    if (!el.activeStreamsList) return;
    el.activeStreamsList.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('button[data-action="stop-active"]');
      if (!btn) return;
      const id = btn.getAttribute('data-id');
      const type = btn.getAttribute('data-type');
      const ok = confirm('Stop this active stream?');
      if (!ok) return;
      btn.disabled = true; btn.classList.add('loading');
      try {
        if (type === 'external') {
          await fetchJSON(`${API_URL}/videos/url/stream/stop`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ streamId: id })
          });
        } else {
          await fetchJSON(`${API_URL}/videos/${id}/stream/stop`, { method: 'POST' });
        }
        showToast('Stop requested', 'warn');
        await Promise.all([loadActiveStreams(), loadVideos()]);
      } catch (err) {
        showToast(`Failed to stop: ${err.message}`, 'error');
      } finally {
        btn.disabled = false; btn.classList.remove('loading');
      }
    });
  }

  /** Create a card element for a video */
  function createVideoCard(video) {
    const id = video._id;
    const scheduled = video.scheduleTime || video.scheduledAt;
    const errorMsg = video.errorMessage;
    const progress = typeof video.progress === 'number' ? video.progress : 0;
    const status = video.status;
    const canStart = status === STATUS.SCHEDULED;
    const canInstant = status === STATUS.LIBRARY;
    const canStop = status === STATUS.STREAMING;
    const canDelete = [STATUS.COMPLETED, STATUS.FAILED, STATUS.CANCELLED].includes(status) || !canStop;

    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = id;
    card.innerHTML = `
      <div class="card-head" style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <h3 style="margin:0;">${escapeHtml(video.title || 'Untitled')}</h3>
          ${renderBadge(status)}
        </div>
        <div class="card-actions" style="display:flex;gap:8px;">
          ${canStart ? `<button class="btn success" data-action="start" data-id="${id}"><i class="fa-solid fa-play"></i> Start</button>` : ''}
          ${canInstant ? `<button class="btn success" data-action="instant" data-id="${id}"><i class="fa-solid fa-bolt"></i> Instant Live</button>` : ''}
          ${canStop ? `<button class="btn warning" data-action="stop" data-id="${id}"><i class="fa-solid fa-stop"></i> Stop</button>` : ''}
          <button class="btn" data-action="edit" data-id="${id}"><i class="fa-regular fa-pen-to-square"></i> Edit</button>
          ${canDelete ? `<button class="btn danger" data-action="delete" data-id="${id}"><i class="fa-regular fa-trash-can"></i> Delete</button>` : ''}
        </div>
      </div>
      <div class="card-body" style="margin-top:12px;display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div>
          <div><strong>Scheduled:</strong> ${fmtDate(scheduled)}</div>
          <div><strong>Stop At:</strong> ${fmtDate(video.stopTime)}</div>
          <div><strong>Duration:</strong> ${fmtDuration(video.duration)}</div>
          <div><strong>Size:</strong> ${fmtBytes(video.filesize)}</div>
        </div>
        <div>
          <div><strong>Progress:</strong> ${progress}%</div>
          ${status === STATUS.STREAMING ? `<div class="progress" aria-hidden="false"><div class="progress-bar" style="width:${progress}%"></div></div>` : ''}
          ${errorMsg ? `<div class="message error" style="margin-top:6px;">${escapeHtml(errorMsg)}</div>` : ''}
        </div>
      </div>
    `;
    return card;
  }

  /** Escape HTML */
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  /** Render videos into grid using diff updates */
  function renderVideos(newVideos) {
    const byId = new Map(newVideos.map(v => [v._id, v]));
    const existing = Array.from(el.grid.querySelectorAll('[data-id]')).map(e => e.dataset.id);

    // Remove cards not present
    existing.forEach(id => { if (!byId.has(id)) { const node = el.grid.querySelector(`[data-id="${id}"]`); if (node) node.remove(); } });

    // Add or update cards
    newVideos.forEach(v => {
      let card = el.grid.querySelector(`[data-id="${v._id}"]`);
      const prevStatus = prevStatusById.get(v._id);
      if (!card) {
        card = createVideoCard(v);
        el.grid.appendChild(card);
      } else {
        if (prevStatus !== v.status) {
          showToast(`Status changed: "${v.title}" → ${v.status}`, 'info');
          const newCard = createVideoCard(v);
          el.grid.replaceChild(newCard, card);
          card = newCard;
        } else {
          // Update progress only if streaming
          if (v.status === STATUS.STREAMING) {
            const bar = card.querySelector('.progress-bar');
            if (bar) bar.style.width = `${v.progress || 0}%`;
          }
        }
      }
      prevStatusById.set(v._id, v.status);
    });

    // Empty state
    if (newVideos.length === 0) {
      el.empty.hidden = false;
      el.grid.setAttribute('aria-busy', 'false');
    } else {
      el.empty.hidden = true;
    }
  }

  /** Load videos from API and apply filter/search */
  async function loadVideos() {
    try {
      const params = new URLSearchParams();
      params.set('limit', '100');
      if (currentFilter) params.set('status', currentFilter);
      const items = await fetchJSON(`${API_URL}/videos?${params.toString()}`);
      if (!Array.isArray(items)) return;
      const filtered = items.filter(v => {
        const matchesSearch = !searchTerm || String(v.title || '').toLowerCase().includes(searchTerm.toLowerCase());
        return matchesSearch;
      });
      videos = filtered;
      renderVideos(videos);
      renderPlaylistSelector();
      el.grid.setAttribute('aria-busy', 'false');
    } catch (err) {
      showToast(`Unable to load videos: ${err.message}`, 'error');
      el.empty.hidden = false;
      el.empty.querySelector('p')?.replaceChildren(document.createTextNode('Unable to load videos (database may be disconnected).'));
    }
  }

  /** Render playlist video selector using current videos */
  function renderPlaylistSelector() {
    if (!el.playlistSelector) return;
    el.playlistSelector.innerHTML = '';
    // Show only Library videos for playlist selection; multi-select via checkboxes
    const selectable = Array.isArray(videos) ? videos.filter(v => v.status === STATUS.LIBRARY) : [];
    if (!Array.isArray(selectable) || selectable.length === 0) {
      el.playlistSelector.innerHTML = '<div class="message info">No library videos yet. Save videos to Library to add them.</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    selectable.forEach(v => {
      const row = document.createElement('label');
      row.className = 'checkbox-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = v._id;
      cb.name = 'videoIds';
      const title = document.createElement('span');
      title.textContent = `${v.title} (${v.status})`;
      row.appendChild(cb);
      row.appendChild(title);
      frag.appendChild(row);
    });
    el.playlistSelector.appendChild(frag);
  }

  /** Playlists: load & render */
  async function loadPlaylists() {
    try {
      const items = await fetchJSON(`${API_URL}/playlists?limit=50`);
      playlists = Array.isArray(items) ? items : [];
      renderPlaylists(playlists);
    } catch (err) {
      if (el.playlistsEmpty) {
        el.playlistsEmpty.hidden = false;
        const p = el.playlistsEmpty.querySelector('p');
        if (p) p.textContent = 'Unable to load playlists.';
      }
    }
  }

  function renderPlaylists(list) {
    if (!el.playlistsList) return;
    el.playlistsList.innerHTML = '';
    if (!list || list.length === 0) {
      if (el.playlistsEmpty) el.playlistsEmpty.hidden = false;
      return;
    }
    if (el.playlistsEmpty) el.playlistsEmpty.hidden = true;
    const frag = document.createDocumentFragment();
    list.forEach(pl => {
      const card = document.createElement('div');
      card.className = 'card';
      const total = (Array.isArray(pl.videos) ? pl.videos.length : 0) || 0;
      const idx = typeof pl.currentIndex === 'number' ? pl.currentIndex : 0;
      const schedule = pl.scheduleTime;
      const badge = renderBadge(pl.status);
      card.innerHTML = `
        <div class="card-head" style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <h3 style="margin:0;">${escapeHtml(pl.name || 'Untitled Playlist')}</h3>
            ${badge}
          </div>
        </div>
        <div class="card-body" style="margin-top:12px;display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div>
            <div><strong>Scheduled:</strong> ${fmtDate(schedule)}</div>
            <div><strong>Items:</strong> ${idx}/${total}</div>
          </div>
          <div>
            <div><strong>Created:</strong> ${fmtDate(pl.createdAt)}</div>
            <div><strong>Updated:</strong> ${fmtDate(pl.updatedAt)}</div>
          </div>
        </div>
      `;
      frag.appendChild(card);
    });
    el.playlistsList.appendChild(frag);
  }

  /** Playlist form submit */
  function setupPlaylistForm() {
    if (!el.playlistForm) return;
    // Set min attribute to now
    try {
      const input = document.getElementById('playlist-scheduledAt');
      if (input) {
        const pad = (n) => String(n).padStart(2, '0');
        const d = new Date();
        const val = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        input.min = val;
      }
    } catch (_) {}

    el.playlistForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (el.playlistMsg) { el.playlistMsg.textContent = ''; el.playlistMsg.className = 'message'; }
      const name = document.getElementById('playlist-name')?.value?.trim();
      const scheduledAt = document.getElementById('playlist-scheduledAt')?.value;
      const rtmpUrl = document.getElementById('playlist-rtmpUrl')?.value?.trim();
      const streamKey = document.getElementById('playlist-streamKey')?.value?.trim();
      const loop = !!document.getElementById('playlist-loop')?.checked;
      const vids = Array.from(el.playlistSelector.querySelectorAll('input[type="checkbox"][name="videoIds"]:checked')).map(cb => cb.value);
      if (!name) { setPlaylistMessage('Playlist name is required.', 'error'); return; }
      if (!scheduledAt) { setPlaylistMessage('Schedule date/time is required.', 'error'); return; }
      if (!rtmpUrl || !/^rtmps?:\/\//i.test(rtmpUrl)) { setPlaylistMessage('Valid RTMP URL is required.', 'error'); return; }
      if (!streamKey || streamKey.length < 8) { setPlaylistMessage('Stream Key (min 8 chars) is required.', 'error'); return; }
      if (!Array.isArray(vids) || vids.length === 0) { setPlaylistMessage('Select at least one video.', 'error'); return; }

      const btn = el.playlistForm.querySelector('button[type="submit"]');
      if (btn) { btn.disabled = true; btn.classList.add('loading'); }
      try {
        const body = { name, scheduleTime: new Date(scheduledAt).toISOString(), videoIds: vids, rtmpUrl, streamKey, loop };
        const created = await fetchJSON(`${API_URL}/playlists`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        showToast('Playlist created', 'success');
        el.playlistForm.reset();
        await loadPlaylists();
      } catch (err) {
        setPlaylistMessage(err.message || 'Failed to create playlist', 'error');
      } finally {
        if (btn) { btn.disabled = false; btn.classList.remove('loading'); }
      }
    });
  }

  function setPlaylistMessage(text, cls = 'info') {
    if (!el.playlistMsg) return;
    el.playlistMsg.textContent = text;
    el.playlistMsg.className = `message ${cls}`;
  }

  /** Upload with progress via XHR */
  function setupUpload() {
    if (!el.form) return;
    el.form.addEventListener('submit', (e) => {
      e.preventDefault();
      el.message.textContent = '';
      const fileInput = el.form.querySelector('input[name="file"]');
      const titleInput = el.form.querySelector('input[name="title"]');
      const schedInput = el.form.querySelector('input[name="scheduledAt"]');
      const stopInput = el.form.querySelector('input[name="stopAt"]');
      const rtmpInput = el.form.querySelector('input[name="rtmpUrl"]');
      const keyInput = el.form.querySelector('input[name="streamKey"]');
      const loopInput = document.getElementById('loop');

      const file = fileInput?.files?.[0];
      const title = titleInput?.value?.trim();
      const scheduleTime = schedInput?.value;
      const rtmpUrl = rtmpInput?.value?.trim();
      const streamKey = keyInput?.value?.trim();
      const stopAt = stopInput?.value || '';
      const loop = !!loopInput?.checked;

      // Validation
      if (!file) return setMessage('Please choose a video file.', 'error');
      if (!/^video\//.test(file.type || 'video/')) return setMessage('File must be a video.', 'error');
      const ext = String(file.name || '').split('.').pop()?.toLowerCase() || '';
      if (ALLOWED_FORMATS.length && ext && !ALLOWED_FORMATS.includes(ext)) {
        return setMessage(`Unsupported format. Allowed: ${ALLOWED_FORMATS.join(', ')}`, 'error');
      }
      if (file.size > MAX_FILE_SIZE) {
        const gb = (MAX_FILE_SIZE / (1024 ** 3)).toFixed(0);
        return setMessage(`File exceeds ${gb}GB limit.`, 'error');
      }
      if (!title) return setMessage('Title is required.', 'error');
      if (!scheduleTime) return setMessage('Schedule date/time is required.', 'error');
      if (!rtmpUrl) return setMessage('RTMP URL is required.', 'error');
      if (!streamKey || streamKey.length < 16) return setMessage('Stream key must be at least 16 characters.', 'error');
      if (stopAt) {
        const sched = new Date(scheduleTime);
        const stop = new Date(stopAt);
        if (isFinite(sched.getTime()) && isFinite(stop.getTime()) && stop <= sched) {
          return setMessage('Stop time must be later than schedule time.', 'error');
        }
      }

      const submitBtn = el.form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      submitBtn.classList.add('loading');

      const fd = new FormData();
      fd.append('title', title);
      // Backend expects /upload with field name 'video' and 'scheduleTime'
      fd.append('video', file, file.name);
      fd.append('scheduleTime', new Date(scheduleTime).toISOString());
      if (stopAt) fd.append('stopTime', new Date(stopAt).toISOString());
      fd.append('rtmpUrl', rtmpUrl);
      fd.append('streamKey', streamKey);
      fd.append('loop', loop ? 'true' : 'false');

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_URL}/videos/upload`);
      xhr.upload.onprogress = (ev) => {
        if (!ev.lengthComputable) return;
        const pct = Math.round((ev.loaded / ev.total) * 100);
        el.progress.hidden = false;
        el.progressBar.style.width = `${pct}%`;
      };
      xhr.onreadystatechange = () => {
        if (xhr.readyState !== 4) return;
        try {
          const isOk = xhr.status >= 200 && xhr.status < 300;
          const data = isOk ? JSON.parse(xhr.responseText || '{}') : null;
          if (isOk) {
            showToast('Upload successful', 'success');
            el.form.reset();
            loadVideos();
          } else {
            const msg = xhr.responseText || `Upload failed: HTTP ${xhr.status}`;
            setMessage(msg, 'error');
            showToast('Upload failed', 'error');
          }
        } catch (e) {
          setMessage('Unexpected response from server.', 'error');
        }
      };
      xhr.onerror = () => {
        setMessage('Network error during upload.', 'error');
        showToast('Network error', 'error');
      };
      xhr.onloadend = () => {
        submitBtn.disabled = false;
        submitBtn.classList.remove('loading');
        el.progressBar.style.width = '0%';
        el.progress.hidden = true;
      };
      xhr.send(fd);
    });
  }

  /** Simple library upload (store for later, no schedule/RTMP) */
  function setupLibraryUpload() {
    if (!el.libraryForm) return;
    el.libraryForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (el.libraryMessage) { el.libraryMessage.textContent = ''; el.libraryMessage.className = 'message'; }
      const fileInput = el.libraryForm.querySelector('input[name="file"]');
      const titleInput = el.libraryForm.querySelector('input[name="title"]');
      const file = fileInput?.files?.[0];
      const title = titleInput?.value?.trim();
      if (!file) { setLibraryMessage('Please choose a video file.', 'error'); return; }
      if (!/^video\//.test(file.type || 'video/')) { setLibraryMessage('File must be a video.', 'error'); return; }
      const ext = String(file.name || '').split('.').pop()?.toLowerCase() || '';
      if (ALLOWED_FORMATS.length && ext && !ALLOWED_FORMATS.includes(ext)) {
        setLibraryMessage(`Unsupported format. Allowed: ${ALLOWED_FORMATS.join(', ')}`, 'error'); return;
      }
      if (file.size > MAX_FILE_SIZE) { const gb = (MAX_FILE_SIZE / (1024 ** 3)).toFixed(0); setLibraryMessage(`File exceeds ${gb}GB limit.`, 'error'); return; }
      if (!title) { setLibraryMessage('Title is required.', 'error'); return; }

      const submitBtn = el.libraryForm.querySelector('button[type="submit"]');
      if (submitBtn) { submitBtn.disabled = true; submitBtn.classList.add('loading'); }

      const fd = new FormData();
      fd.append('title', title);
      fd.append('file', file, file.name);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_URL}/videos/library`);
      xhr.upload.onprogress = (ev) => {
        if (!ev.lengthComputable) return;
        const pct = Math.round((ev.loaded / ev.total) * 100);
        if (el.libraryProgress) el.libraryProgress.hidden = false;
        if (el.libraryProgressBar) el.libraryProgressBar.style.width = `${pct}%`;
      };
      xhr.onreadystatechange = () => {
        if (xhr.readyState !== 4) return;
        try {
          const isOk = xhr.status >= 200 && xhr.status < 300;
          const data = isOk ? JSON.parse(xhr.responseText || '{}') : null;
          if (isOk) {
            showToast('Saved to library', 'success');
            el.libraryForm.reset();
            loadVideos();
          } else {
            const msg = xhr.responseText || `Upload failed: HTTP ${xhr.status}`;
            setLibraryMessage(msg, 'error');
            showToast('Upload failed', 'error');
          }
        } catch (e) {
          setLibraryMessage('Unexpected response from server.', 'error');
        }
      };
      xhr.onerror = () => {
        setLibraryMessage('Network error during upload.', 'error');
        showToast('Network error', 'error');
      };
      xhr.onloadend = () => {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.classList.remove('loading'); }
        if (el.libraryProgressBar) el.libraryProgressBar.style.width = '0%';
        if (el.libraryProgress) el.libraryProgress.hidden = true;
      };
      xhr.send(fd);
    });
  }

  function setLibraryMessage(text, cls = 'info') {
    if (!el.libraryMessage) return;
    el.libraryMessage.textContent = text;
    el.libraryMessage.className = `message ${cls}`;
  }

  /** Message helper under upload form */
  function setMessage(text, cls = 'info') {
    if (!el.message) return;
    el.message.textContent = text;
    el.message.className = `message ${cls}`;
  }

  /** Streaming controls */
  async function startStream(id, force = false) {
    if (!confirm('Start stream now?')) return;
    try {
      await fetchJSON(`${API_URL}/videos/${id}/stream/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      });
      showToast('Stream started', 'success');
      await loadVideos();
    } catch (err) {
      // If not due yet, offer force start fallback
      if (!force && /Not scheduled yet/i.test(String(err.message || ''))) {
        const ok = confirm('Not scheduled yet. Start instantly anyway?');
        if (ok) return startStream(id, true);
      }
      showToast(`Failed to start: ${err.message}`, 'error');
    }
  }

  /** Instant Live for library items */
  async function startInstant(id) {
    const rtmpUrl = prompt('RTMP URL (e.g., rtmp://a.rtmp.youtube.com/live2)');
    if (!rtmpUrl) return;
    const streamKey = prompt('Stream Key');
    if (!streamKey || streamKey.trim().length < 8) {
      showToast('Valid stream key is required', 'error');
      return;
    }
    try {
      await fetchJSON(`${API_URL}/videos/${id}/stream/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true, rtmpUrl, streamKey }),
      });
      showToast('Instant Live started', 'success');
      await loadVideos();
    } catch (err) {
      showToast(`Instant Live failed: ${err.message}`, 'error');
    }
  }
  async function stopStream(id) {
    if (!confirm('Stop this stream?')) return;
    try {
      await fetchJSON(`${API_URL}/videos/${id}/stream/stop`, { method: 'POST' });
      showToast('Stream stop requested', 'warn');
      await loadVideos();
    } catch (err) {
      showToast(`Failed to stop: ${err.message}`, 'error');
    }
  }
  async function deleteVideo(id) {
    if (!confirm('Delete this video? This cannot be undone.')) return;
    try {
      await fetchJSON(`${API_URL}/videos/${id}`, { method: 'DELETE' });
      showToast('Video deleted', 'success');
      await loadVideos();
    } catch (err) {
      showToast(`Delete failed: ${err.message}`, 'error');
    }
  }
  async function retryStream(id) {
    const v = videos.find(x => x._id === id);
    if (!v) return;
    if (v.status !== STATUS.SCHEDULED) {
      showToast('Retry available only for scheduled videos. Edit to reschedule.', 'info');
      return;
    }
    startStream(id, true);
  }

  /** Edit modal */
  function openEditModal(video) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop open';
    const modal = document.createElement('div');
    modal.className = 'modal open';
    const content = document.createElement('div');
    content.className = 'modal-content';
    content.innerHTML = `
      <div class="modal-header"><h3>Edit Video</h3><button class="btn" data-action="close"><i class="fa-regular fa-xmark"></i> Close</button></div>
      <div class="form-grid">
        <div class="form-row"><label>Title<input type="text" id="edit-title" value="${escapeHtml(video.title || '')}"></label></div>
        <div class="form-row"><label>Schedule<input type="datetime-local" id="edit-schedule" value="${toLocalInputValue(video.scheduleTime || video.scheduledAt)}"></label></div>
        <div class="form-row"><label>Stop At<input type="datetime-local" id="edit-stop" value="${toLocalInputValue(video.stopTime)}"></label></div>
        <div class="form-row"><label>RTMP URL<input type="text" id="edit-rtmp" value="${escapeHtml(video.rtmpUrl || '')}"></label></div>
        <div class="form-row"><label>Stream Key<input type="password" id="edit-key" value="${escapeHtml(video.streamKey || '')}"></label></div>
        <div class="form-row"><label class="checkbox"><input type="checkbox" id="edit-loop" ${video.loop ? 'checked' : ''}><span>Loop video (continuous stream)</span></label></div>
      </div>
      <div class="modal-actions">
        <button class="btn primary" data-action="save"><i class="fa-regular fa-floppy-disk"></i> Save</button>
      </div>
    `;
    modal.appendChild(content);
    document.body.appendChild(backdrop);
    document.body.appendChild(modal);

    const close = () => { backdrop.remove(); modal.remove(); };
    content.querySelector('[data-action="close"]').addEventListener('click', close);
    backdrop.addEventListener('click', close);
    content.querySelector('[data-action="save"]').addEventListener('click', async () => {
      const title = content.querySelector('#edit-title').value.trim();
      const schedule = content.querySelector('#edit-schedule').value;
      const rtmp = content.querySelector('#edit-rtmp').value.trim();
      const key = content.querySelector('#edit-key').value.trim();
      const loop = !!content.querySelector('#edit-loop').checked;
      const stopVal = content.querySelector('#edit-stop').value;
      if (!title) { showToast('Title is required', 'error'); return; }
      if (!schedule) { showToast('Schedule is required', 'error'); return; }
      if (!rtmp) { showToast('RTMP URL is required', 'error'); return; }
      if (!key || key.length < 16) { showToast('Stream key must be >= 16 chars', 'error'); return; }
      if (stopVal) {
        const sched = new Date(schedule);
        const stop = new Date(stopVal);
        if (isFinite(sched.getTime()) && isFinite(stop.getTime()) && stop <= sched) {
          showToast('Stop time must be later than schedule time', 'error');
          return;
        }
      }
      try {
        const body = { title, scheduleTime: new Date(schedule).toISOString(), rtmpUrl: rtmp, streamKey: key, loop };
        if (video.status === STATUS.LIBRARY) { body.status = STATUS.SCHEDULED; }
        if (stopVal) body.stopTime = new Date(stopVal).toISOString();
        const updated = await fetchJSON(`${API_URL}/videos/${video._id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        showToast('Video updated', 'success');
        close();
        await loadVideos();
      } catch (err) {
        showToast(`Update failed: ${err.message}`, 'error');
      }
    });
  }

  /** Convert date to local datetime-local value */
  function toLocalInputValue(d) {
    if (!d) return '';
    const dt = new Date(d);
    const pad = (n) => String(n).padStart(2, '0');
    return `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  }

  /** Wire up controls in cards using event delegation */
  function setupCardActions() {
    el.grid.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-action]');
      if (!btn) return;
      const id = btn.getAttribute('data-id');
      const action = btn.getAttribute('data-action');
      const v = videos.find(x => x._id === id);
      if (!v) return;
      if (action === 'start') return startStream(id);
      if (action === 'instant') return startInstant(id);
      if (action === 'stop') return stopStream(id);
      if (action === 'delete') return deleteVideo(id);
      if (action === 'edit') return openEditModal(v);
      if (action === 'retry') return retryStream(id);
    });
  }

  /** Filters & Search */
  function setupFilters() {
    if (el.filters) {
      el.filters.addEventListener('click', (ev) => {
        const b = ev.target.closest('button[data-status]') || ev.target.closest('button.filter');
        if (!b) return;
        const status = b.getAttribute('data-status') || '';
        setFilter(status, true);
        loadVideos();
      });
    }
    if (el.search) {
      const handler = debounce(() => { searchTerm = el.search.value || ''; loadVideos(); }, 300);
      el.search.addEventListener('input', handler);
    }
  }

  /** Programmatically set filter and update button active state */
  function setFilter(status, silent = false) {
    currentFilter = status || '';
    if (el.filters) {
      const buttons = Array.from(el.filters.querySelectorAll('button.filter'));
      buttons.forEach(btn => {
        const s = btn.getAttribute('data-status') || '';
        btn.classList.toggle('active', s === currentFilter);
      });
    }
    if (!silent) loadVideos();
  }

  /** Navigation: show/hide sections and set default filters */
  function setupNavigation() {
    if (!el.nav) return;
    const showView = (view) => {
      const isPlaylist = view === 'playlist';
      const isLive = view === 'live';
      const isLibrary = view === 'library';
      const isActive = view === 'active';

      // Toggle sections
      if (el.sectionPlaylistForm) el.sectionPlaylistForm.hidden = !isPlaylist;
      if (el.sectionPlaylists) el.sectionPlaylists.hidden = !isPlaylist;
      if (el.sectionUpload) el.sectionUpload.hidden = !(isLive);
      if (el.sectionActiveStreams) el.sectionActiveStreams.hidden = !(isLive || isActive);
      if (el.sectionUrlStream) el.sectionUrlStream.hidden = !(isLive);
      if (el.sectionLibraryUpload) el.sectionLibraryUpload.hidden = !isLibrary;
      if (el.sectionVideos) el.sectionVideos.hidden = isPlaylist || isActive; // hide videos in active view

      // Set default filter per view
      if (isActive) {
        setFilter(STATUS.STREAMING);
      } else if (isLibrary) {
        setFilter(STATUS.LIBRARY);
      } else if (isLive) {
        setFilter(STATUS.SCHEDULED);
      } else {
        setFilter('');
      }

      // Active nav state
      Array.from(el.nav.querySelectorAll('.nav-link')).forEach(b => b.classList.toggle('active', b.getAttribute('data-view') === view));
    };

    el.nav.addEventListener('click', (ev) => {
      const b = ev.target.closest('.nav-link[data-view]');
      if (!b) return;
      const view = b.getAttribute('data-view');
      showView(view);
    });

    // Default view: live
    showView('live');
  }

  /** URL Stream form */
  let externalStreamId = '';
  let urlStatusTimer = null;
  let scheduledJobId = '';
  function setUrlMessage(text, cls = 'info') {
    if (!el.urlMsg) return;
    el.urlMsg.textContent = text;
    el.urlMsg.className = `message ${cls}`;
  }
  function updateUrlStatus(text) {
    if (!el.urlStatus) return;
    el.urlStatus.textContent = text || '';
  }
  function setupUrlStreamForm() {
    if (!el.urlForm) return;
    try {
      if (cfg.DEFAULT_RTMP_URL && el.urlRtmp) {
        el.urlRtmp.value = cfg.DEFAULT_RTMP_URL;
      }
      const help = document.getElementById('yt-help-link');
      if (help && cfg.YOUTUBE_HELP_URL) {
        help.addEventListener('click', (e) => { e.preventDefault(); window.open(cfg.YOUTUBE_HELP_URL, '_blank'); });
      }
    } catch (_) {}

    el.urlForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      setUrlMessage('', 'info');
      updateUrlStatus('');
      const sourceUrl = el.urlSource?.value?.trim();
      const rtmpUrl = el.urlRtmp?.value?.trim();
      const streamKey = el.urlKey?.value?.trim();
      if (!sourceUrl) { setUrlMessage('YouTube URL is required.', 'error'); return; }
      if (!rtmpUrl) { setUrlMessage('RTMP URL is required.', 'error'); return; }
      if (!streamKey || streamKey.length < 8) { setUrlMessage('Stream key must be at least 8 characters.', 'error'); return; }
      el.urlStartBtn.disabled = true; el.urlStartBtn.classList.add('loading');
      try {
        const res = await fetchJSON(`${API_URL}/videos/url/stream/start`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceUrl, rtmpUrl, streamKey })
        });
        externalStreamId = res?.streamId || '';
        if (!externalStreamId) throw new Error('No streamId returned');
        setUrlMessage('External stream started. Opening status...', 'success');
        el.urlStopBtn.hidden = false;
        scheduledJobId = '';
        startUrlStatusPoll();
      } catch (err) {
        setUrlMessage(`Failed to start: ${err.message}`, 'error');
      } finally {
        el.urlStartBtn.disabled = false; el.urlStartBtn.classList.remove('loading');
      }
    });

    el.urlStopBtn.addEventListener('click', async () => {
      if (!externalStreamId) { setUrlMessage('No active external stream.', 'warn'); return; }
      el.urlStopBtn.disabled = true; el.urlStopBtn.classList.add('loading');
      try {
        await fetchJSON(`${API_URL}/videos/url/stream/stop`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ streamId: externalStreamId })
        });
        setUrlMessage('Stop requested.', 'warn');
        stopUrlStatusPoll();
        externalStreamId = '';
        el.urlStopBtn.hidden = true;
        updateUrlStatus('');
      } catch (err) {
        setUrlMessage(`Failed to stop: ${err.message}`, 'error');
      } finally {
        el.urlStopBtn.disabled = false; el.urlStopBtn.classList.remove('loading');
      }
    });

    // Schedule from URL
    if (el.urlScheduleBtn) {
      el.urlScheduleBtn.addEventListener('click', async () => {
        setUrlMessage('', 'info');
        updateUrlStatus('');
        const sourceUrl = el.urlSource?.value?.trim();
        const rtmpUrl = el.urlRtmp?.value?.trim();
        const streamKey = el.urlKey?.value?.trim();
        const scheduleTimeStr = el.urlScheduleStart?.value?.trim();
        const stopTimeStr = el.urlScheduleStop?.value?.trim();
        if (!sourceUrl) { setUrlMessage('YouTube URL is required.', 'error'); return; }
        if (!rtmpUrl) { setUrlMessage('RTMP URL is required.', 'error'); return; }
        if (!streamKey || streamKey.length < 8) { setUrlMessage('Stream key must be at least 8 characters.', 'error'); return; }
        if (!scheduleTimeStr) { setUrlMessage('Please select a schedule start time.', 'error'); return; }
        const scheduleTime = new Date(scheduleTimeStr).toISOString();
        const stopTime = stopTimeStr ? new Date(stopTimeStr).toISOString() : undefined;
        el.urlScheduleBtn.disabled = true; el.urlScheduleBtn.classList.add('loading');
        try {
          const res = await fetchJSON(`${API_URL}/videos/url/stream/schedule`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sourceUrl, rtmpUrl, streamKey, scheduleTime, stopTime })
          });
          scheduledJobId = res?.jobId || res?._id || '';
          if (!scheduledJobId) throw new Error('No jobId returned');
          externalStreamId = '';
          setUrlMessage('Scheduled successfully.', 'success');
          updateUrlStatus(`Scheduled for ${fmtDate(scheduleTime)}`);
          startUrlStatusPoll();
        } catch (err) {
          setUrlMessage(`Failed to schedule: ${err.message}`, 'error');
        } finally {
          el.urlScheduleBtn.disabled = false; el.urlScheduleBtn.classList.remove('loading');
        }
      });
    }

    // Cancel schedule
    if (el.urlCancelScheduleBtn) {
      el.urlCancelScheduleBtn.addEventListener('click', async () => {
        if (!scheduledJobId) { setUrlMessage('No scheduled job to cancel.', 'warn'); return; }
        el.urlCancelScheduleBtn.disabled = true; el.urlCancelScheduleBtn.classList.add('loading');
        try {
          await fetchJSON(`${API_URL}/videos/url/stream/schedule/cancel`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId: scheduledJobId })
          });
          stopUrlStatusPoll();
          setUrlMessage('Schedule cancelled.', 'warn');
          scheduledJobId = '';
          updateUrlStatus('');
        } catch (err) {
          setUrlMessage(`Failed to cancel: ${err.message}`, 'error');
        } finally {
          el.urlCancelScheduleBtn.disabled = false; el.urlCancelScheduleBtn.classList.remove('loading');
        }
      });
    }
  }
  function startUrlStatusPoll() {
    stopUrlStatusPoll();
    if (!externalStreamId && !scheduledJobId) return;
    urlStatusTimer = setInterval(async () => {
      try {
        if (externalStreamId) {
          const s = await fetchJSON(`${API_URL}/videos/url/stream/status/${externalStreamId}`);
          if (!s || !s.active) {
            updateUrlStatus('Inactive');
            if (s && s.error) setUrlMessage(`Stream error: ${s.error}`, 'error');
            return;
          }
          const prog = typeof s.progress === 'number' ? fmtDuration(s.progress) : '';
          const when = s.startedAt ? `since ${fmtDate(s.startedAt)}` : '';
          updateUrlStatus(`Active ${when}${prog ? ' • ' + prog : ''}`);
          return;
        }
        if (scheduledJobId) {
          const j = await fetchJSON(`${API_URL}/videos/url/stream/schedule/status/${scheduledJobId}`);
          if (!j) { updateUrlStatus('Status unavailable'); return; }
          const st = j.status || '';
          if (st === 'scheduled') {
            const when = j.scheduleTime ? fmtDate(j.scheduleTime) : '';
            updateUrlStatus(`Scheduled for ${when}`);
          } else if (st === 'streaming') {
            const prog = typeof j.progress === 'number' ? fmtDuration(j.progress) : '';
            const when = j.startedAt ? `since ${fmtDate(j.startedAt)}` : '';
            updateUrlStatus(`Active ${when}${prog ? ' • ' + prog : ''}`);
          } else if (st === 'completed') {
            updateUrlStatus('Completed');
            scheduledJobId = '';
            stopUrlStatusPoll();
          } else if (st === 'cancelled') {
            updateUrlStatus('Cancelled');
            scheduledJobId = '';
            stopUrlStatusPoll();
          } else if (st === 'failed') {
            updateUrlStatus('Failed');
            if (j.error) setUrlMessage(`Stream error: ${j.error}`, 'error');
            scheduledJobId = '';
            stopUrlStatusPoll();
          } else {
            updateUrlStatus('Status unavailable');
          }
        }
      } catch (_) {
        updateUrlStatus('Status unavailable');
      }
    }, 3000);
  }
  function stopUrlStatusPoll() {
    if (urlStatusTimer) { clearInterval(urlStatusTimer); urlStatusTimer = null; }
  }

  /** Auto-refresh every 10s */
  function startAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(async () => {
      if (isRefreshing) return;
      isRefreshing = true;
      try { await Promise.all([loadVideos(), loadPlaylists(), loadActiveStreams(), loadHealth()]); } finally { isRefreshing = false; }
    }, REFRESH_INTERVAL_MS);
  }

  /** Init */
  async function init() {
    setBusy(true);
    try {
      setupTheme();
      setupNavigation();
      setupUpload();
      setupLibraryUpload();
      setupPlaylistForm();
      setupUrlStreamForm();
      setupActiveActions();
      setupFilters();
      setupCardActions();
      // Load health and videos in parallel to avoid long perceived buffering
      await Promise.all([loadHealth(), loadVideos(), loadPlaylists(), loadActiveStreams()]);
      startAutoRefresh();
    } catch (err) {
      // Ensure spinner never gets stuck if an unexpected error occurs
      console.error(`[UI] Init error: ${err && err.message ? err.message : err}`);
      showToast('Initialization error. Some features may be limited.', 'error');
    } finally {
      setBusy(false);
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();