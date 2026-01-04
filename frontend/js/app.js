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
  const previewCache = new Map();

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
    useLibrarySource: document.getElementById('use-library-source'),
    librarySourceRow: document.getElementById('library-source-row'),
    librarySourceSelect: document.getElementById('library-source-select'),
    libraryEmptyHint: document.getElementById('library-empty-hint'),
    libraryPresentHint: document.getElementById('library-present-hint'),
    goLibraryLink: document.getElementById('go-library-link'),
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
    urlSavedKeys: document.getElementById('url-saved-keys'),
    urlUseSavedKey: document.getElementById('url-use-saved-key'),
    urlDeleteSavedKey: document.getElementById('url-delete-saved-key'),
    urlKeyName: document.getElementById('url-key-name'),
    urlSaveKey: document.getElementById('url-save-key'),
    sectionLogin: document.getElementById('section-login'),
    loginForm: document.getElementById('login-form'),
    loginUser: document.getElementById('login-user'),
    loginPass: document.getElementById('login-pass'),
    loginMessage: document.getElementById('login-message'),
    playlistSavedKeys: document.getElementById('playlist-saved-keys'),
    playlistUseSavedKey: document.getElementById('playlist-use-saved-key'),
    playlistDeleteSavedKey: document.getElementById('playlist-delete-saved-key'),
    playlistKeyName: document.getElementById('playlist-key-name'),
    playlistSaveKey: document.getElementById('playlist-save-key'),
    uploadSavedKeys: document.getElementById('upload-saved-keys'),
    uploadUseSavedKey: document.getElementById('upload-use-saved-key'),
    uploadDeleteSavedKey: document.getElementById('upload-delete-saved-key'),
    uploadKeyName: document.getElementById('upload-key-name'),
    uploadSaveKey: document.getElementById('upload-save-key'),
    overlaySection: document.getElementById('section-overlay'),
    ovCanvas: document.getElementById('overlay-canvas'),
    ovWidth: document.getElementById('ov-width'),
    ovHeight: document.getElementById('ov-height'),
    ovScale: document.getElementById('ov-scale'),
    ovBg: document.getElementById('ov-bg'),
    ovBgOpa: document.getElementById('ov-bg-opa'),
    ovTickerText: document.getElementById('ov-ticker-text'),
    ovTickerSpeed: document.getElementById('ov-ticker-speed'),
    ovTickerFont: document.getElementById('ov-ticker-font'),
    ovTickerSize: document.getElementById('ov-ticker-size'),
    ovTickerBold: document.getElementById('ov-ticker-bold'),
    ovTickerColor: document.getElementById('ov-ticker-color'),
    ovTickerPos: document.getElementById('ov-ticker-pos'),
    ovTickerY: document.getElementById('ov-ticker-y'),
    ovTickerBg: document.getElementById('ov-ticker-bg'),
    ovTickerBgMode: document.getElementById('ov-ticker-bg-mode'),
    ovTickerBg2: document.getElementById('ov-ticker-bg2'),
    ovTickerOpa: document.getElementById('ov-ticker-opa'),
    ovTickerBorderWidth: document.getElementById('ov-ticker-border-width'),
    ovTickerBorderColor: document.getElementById('ov-ticker-border-color'),
    ovTickerBorderOpa: document.getElementById('ov-ticker-border-opa'),
    ovTickerBorderRadius: document.getElementById('ov-ticker-border-radius'),
    ovNlShow: document.getElementById('ov-nl-show'),
    ovNlText: document.getElementById('ov-nl-text'),
    ovNlItems: document.getElementById('ov-nl-items'),
    ovNlPos: document.getElementById('ov-nl-pos'),
    ovNlY: document.getElementById('ov-nl-y'),
    ovNlLabelBg: document.getElementById('ov-nl-label-bg'),
    ovNlLabelOpa: document.getElementById('ov-nl-label-opa'),
    ovNlLabelColor: document.getElementById('ov-nl-label-color'),
    ovNlItemColor: document.getElementById('ov-nl-item-color'),
    ovNlLabelSize: document.getElementById('ov-nl-label-size'),
    ovNlItemSize: document.getElementById('ov-nl-item-size'),
    ovNlAnim: document.getElementById('ov-nl-anim'),
    ovClockEnable: document.getElementById('ov-clock-enable'),
    ovClockFormat: document.getElementById('ov-clock-format'),
    ovClockDate: document.getElementById('ov-clock-date'),
    ovClockSeconds: document.getElementById('ov-clock-seconds'),
    ovClockColor: document.getElementById('ov-clock-color'),
    ovClockSize: document.getElementById('ov-clock-size'),
    ovClockX: document.getElementById('ov-clock-x'),
    ovClockY: document.getElementById('ov-clock-y'),
    ovClockFont: document.getElementById('ov-clock-font'),
    ovClockBold: document.getElementById('ov-clock-bold'),
    ovClockBgEnable: document.getElementById('ov-clock-bg-enable'),
    ovClockBg: document.getElementById('ov-clock-bg'),
    ovClockBgOpa: document.getElementById('ov-clock-bg-opa'),
    ovClockBgPad: document.getElementById('ov-clock-bg-pad'),
    ovClockBgShape: document.getElementById('ov-clock-bg-shape'),
    ovClockBgRadius: document.getElementById('ov-clock-bg-radius'),
    ovClockBorderWidth: document.getElementById('ov-clock-border-width'),
    ovClockBorderColor: document.getElementById('ov-clock-border-color'),
    ovClockBorderOpa: document.getElementById('ov-clock-border-opa'),
    ovClockBorderRadius: document.getElementById('ov-clock-border-radius'),
    ovLogoUrl: document.getElementById('ov-logo-url'),
    ovLogoPos: document.getElementById('ov-logo-pos'),
    ovLogoFile: document.getElementById('ov-logo-file'),
    ovLogoX: document.getElementById('ov-logo-x'),
    ovLogoY: document.getElementById('ov-logo-y'),
    ovLogoSize: document.getElementById('ov-logo-size'),
      ovLogoOpa: document.getElementById('ov-logo-opa'),
      ovLogoRotate: document.getElementById('ov-logo-rotate'),
      ovLtTitle: document.getElementById('ov-lt-title'),
    ovLtSub: document.getElementById('ov-lt-sub'),
    ovLtShow: document.getElementById('ov-lt-show'),
    ovScoreA: document.getElementById('ov-score-a'),
    ovScoreB: document.getElementById('ov-score-b'),
    ovScoreAVal: document.getElementById('ov-score-a-val'),
    ovScoreBVal: document.getElementById('ov-score-b-val'),
    ovBannerText: document.getElementById('ov-banner-text'),
    ovBannerShow: document.getElementById('ov-banner-show'),
    ovStart: document.getElementById('ov-start'),
    ovStop: document.getElementById('ov-stop'),
    ovSave: document.getElementById('ov-save'),
    ovLoad: document.getElementById('ov-load'),
    ovReset: document.getElementById('ov-reset'),
    ovMsg: document.getElementById('ov-message'),
    ovTarget: document.getElementById('ov-target'),
    ovConnect: document.getElementById('ov-connect'),
    ovConnStatus: document.getElementById('ov-conn-status'),
  };

  /** Utilities */
  /**
   * Fetch JSON with error handling
   * @param {string} url
   * @param {RequestInit} [options]
   * @returns {Promise<any>}
   */
  async function fetchJSON(url, options) {
    const res = await fetch(url, { cache: 'no-store', credentials: 'include', ...(options || {}) });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const text = await res.text();
        if (text) {
          try {
            const j = JSON.parse(text);
            msg = (j && (j.error || j.message)) ? (j.error || j.message) : text;
          } catch (_) {
            msg = text;
          }
        }
      } catch (_) {}
      throw new Error(msg || `HTTP ${res.status}`);
    }
    return res.json();
  }

  async function isAuthed() {
    try {
      const r = await fetchJSON(`${API_URL}/auth/me`);
      return !!(r && r.user);
    } catch (_) {
      return false;
    }
  }
  function setAuthState(auth) {
    const authed = !!auth;
    if (el.sectionLogin) el.sectionLogin.hidden = authed;
    if (!authed) {
      if (el.nav) el.nav.style.display = 'none';
      if (el.sectionActiveStreams) el.sectionActiveStreams.hidden = true;
      if (el.sectionUrlStream) el.sectionUrlStream.hidden = true;
      if (el.sectionPlaylistForm) el.sectionPlaylistForm.hidden = true;
      if (el.sectionUpload) el.sectionUpload.hidden = true;
      if (el.sectionLibraryUpload) el.sectionLibraryUpload.hidden = true;
      if (el.sectionVideos) el.sectionVideos.hidden = true;
      if (el.overlaySection) el.overlaySection.hidden = true;
    } else {
      if (el.nav) el.nav.style.display = '';
    }
  }
  function setupLogin() {
    if (!el.loginForm) return;
    try { if (el.loginUser) el.loginUser.focus(); } catch (_) {}
    el.loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const u = el.loginUser ? (el.loginUser.value || '').trim() : '';
      const p = el.loginPass ? (el.loginPass.value || '').trim() : '';
      if (!u || !p) {
        if (el.loginMessage) { el.loginMessage.textContent = 'Enter username and password'; el.loginMessage.className = 'message error'; }
        return;
      }
      try {
        await fetchJSON(`${API_URL}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: u, password: p }),
        });
        if (el.loginMessage) { el.loginMessage.textContent = 'Logged in'; el.loginMessage.className = 'message success'; }
        setAuthState(true);
        ensureIconStyles();
        requestAnimationFrame(() => { try { initMain(); } catch (_) {} });
      } catch (err) {
        if (el.loginMessage) { el.loginMessage.textContent = String(err && err.message ? err.message : 'Login failed'); el.loginMessage.className = 'message error'; }
      }
    });
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
  function ensureIconStyles() {
    if (document.querySelector('link[data-fa]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css';
    l.crossOrigin = 'anonymous';
    l.referrerPolicy = 'no-referrer';
    l.setAttribute('data-fa', '1');
    document.head.appendChild(l);
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
      el.health.textContent = data.status === 'ok' ? 'Connected' : (data.status || 'Unreachable');
      el.health.className = data.status === 'ok' ? 'ok' : (data.status === 'warn' ? 'warn' : 'error');
      if (el.streamsCount && typeof data.streams === 'number') {
        el.streamsCount.textContent = String(data.streams);
      }
    } catch (err) {
      el.health.textContent = 'Unreachable';
      el.health.className = 'error';
    }
  }

  /** Build status badge HTML */
  function renderBadge(status) {
    const map = {
      [STATUS.LIBRARY]: { cls: 'badge badge--library', icon: 'fa-regular fa-folder', label: 'Uploaded' },
      [STATUS.SCHEDULED]: { cls: 'badge badge--scheduled', icon: 'fa-regular fa-clock', label: 'Scheduled' },
      [STATUS.STREAMING]: { cls: 'badge badge--streaming', icon: 'fa-solid fa-signal', label: 'Streaming' },
      [STATUS.COMPLETED]: { cls: 'badge badge--completed', icon: 'fa-regular fa-circle-check', label: 'Completed' },
      [STATUS.FAILED]: { cls: 'badge badge--failed', icon: 'fa-regular fa-circle-xmark', label: 'Failed' },
      [STATUS.CANCELLED]: { cls: 'badge badge--failed', icon: 'fa-regular fa-circle-stop', label: 'Cancelled' },
    };
    const m = map[status] || map[STATUS.SCHEDULED];
    return `<span class="${m.cls}"><i class="${m.icon}"></i>${m.label}</span>`;
  }

  function renderSkeletonGrid(n) {
    if (!el.grid) return;
    el.grid.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      const s = document.createElement('div');
      s.className = 'skeleton-card';
      frag.appendChild(s);
    }
    el.grid.appendChild(frag);
  }

  function renderActiveSkeleton(n) {
    if (!el.activeStreamsList) return;
    el.activeStreamsList.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      const s = document.createElement('div');
      s.className = 'skeleton-card';
      frag.appendChild(s);
    }
    el.activeStreamsList.appendChild(frag);
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
    renderActiveSkeleton(3);
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
        try { await Promise.all([loadActiveStreams(), loadVideos()]); } catch (_) {}
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
    const canInstant = [STATUS.LIBRARY, STATUS.COMPLETED, STATUS.FAILED, STATUS.CANCELLED].includes(status);
    const canStop = status === STATUS.STREAMING;
    const canDelete = [STATUS.COMPLETED, STATUS.FAILED, STATUS.CANCELLED].includes(status) || !canStop;
    const thumb = video.thumbnailUrl || (`${API_URL}/videos/${id}/thumbnail`);
    const statusTag = (s) => {
      if (s === STATUS.STREAMING) return 'streaming';
      if (s === STATUS.SCHEDULED) return 'scheduled';
      if (s === STATUS.COMPLETED) return 'completed';
      if (s === STATUS.FAILED) return 'failed';
      if (s === STATUS.LIBRARY) return 'library';
      return '';
    };

    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = id;
    const label = (status === STATUS.LIBRARY) ? 'UPLOADED' : String(status).toUpperCase();
    card.innerHTML = `
      <div class="thumb">
        ${thumb ? `<img src="${escapeHtml(thumb)}" alt="">` : ``}
        <span class="tag ${statusTag(status)}">${label}</span>
      </div>
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
    const imgEl = card.querySelector('.thumb img');
    const ensurePreview = async () => {
      try {
        if (previewCache.has(id)) {
          const dataUrl = previewCache.get(id);
          if (dataUrl) {
            if (imgEl) { imgEl.src = dataUrl; imgEl.style.display = ''; }
            else {
              const ni = document.createElement('img');
              ni.src = dataUrl;
              ni.alt = '';
              const container = card.querySelector('.thumb');
              const tag = container.querySelector('.tag');
              if (tag) container.insertBefore(ni, tag); else container.appendChild(ni);
            }
          }
          return;
        }
        const thumbUrl = await regenerateThumbnail(id);
        if (thumbUrl) {
          if (imgEl) { imgEl.src = thumbUrl; imgEl.style.display = ''; }
          else {
            const ni = document.createElement('img');
            ni.src = thumbUrl;
            ni.alt = '';
            const container = card.querySelector('.thumb');
            const tag = container.querySelector('.tag');
            if (tag) container.insertBefore(ni, tag); else container.appendChild(ni);
          }
        }
      } catch (_) {}
    };
    if (!imgEl) {
      ensurePreview();
    } else {
      let loaded = false;
      imgEl.addEventListener('load', () => { loaded = true; });
      imgEl.addEventListener('error', () => { handleThumbError(id, imgEl, card); }, { once: true });
      setTimeout(() => { if (!loaded || imgEl.naturalWidth === 0) ensurePreview(); }, 800);
    }
    return card;
  }

  /** Escape HTML */
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  async function tryHead(url) {
    try {
      const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      return res.ok;
    } catch (_) {
      return false;
    }
  }
  async function regenerateThumbnail(id) {
    try {
      const out = await fetchJSON(`${API_URL}/videos/${id}/thumbnail/regenerate`, { method: 'POST' });
      return out && out.thumbnailUrl ? out.thumbnailUrl : `${API_URL}/videos/${id}/thumbnail`;
    } catch (_) {
      return `${API_URL}/videos/${id}/thumbnail`;
    }
  }
  async function handleThumbError(id, imgEl, card) {
    try {
      const newUrl = await regenerateThumbnail(id);
      if (imgEl) {
        imgEl.src = newUrl;
        imgEl.style.display = '';
        return;
      } else {
        const ni = document.createElement('img');
        ni.src = newUrl;
        ni.alt = '';
        const container = card.querySelector('.thumb');
        const tag = container.querySelector('.tag');
        if (tag) container.insertBefore(ni, tag); else container.appendChild(ni);
        return;
      }
    } catch (_) {}
    const ensurePreview = async () => {
      try {
        if (previewCache.has(id)) {
          const dataUrl = previewCache.get(id);
          if (dataUrl) {
            if (imgEl) { imgEl.src = dataUrl; imgEl.style.display = ''; }
            else {
              const ni = document.createElement('img');
              ni.src = dataUrl;
              ni.alt = '';
              const container = card.querySelector('.thumb');
              const tag = container.querySelector('.tag');
              if (tag) container.insertBefore(ni, tag); else container.appendChild(ni);
            }
          }
          return;
        }
        const dataUrl = await generateVideoPreview(id);
        if (dataUrl) {
          previewCache.set(id, dataUrl);
          if (imgEl) { imgEl.src = dataUrl; imgEl.style.display = ''; }
          else {
            const ni = document.createElement('img');
            ni.src = dataUrl;
            ni.alt = '';
            const container = card.querySelector('.thumb');
            const tag = container.querySelector('.tag');
            if (tag) container.insertBefore(ni, tag); else container.appendChild(ni);
          }
        }
      } catch (_) {}
    };
    await ensurePreview();
  }
  async function generateVideoPreview(id) {
    try {
      const url = `${API_URL}/videos/${id}/file`;
      return await new Promise((resolve) => {
        const v = document.createElement('video');
        v.src = url;
        v.muted = true;
        v.preload = 'metadata';
        v.playsInline = true;
        const cleanup = () => { try { v.pause(); } catch (_) {} try { v.removeAttribute('src'); v.load(); } catch (_) {} try { v.remove(); } catch (_) {} };
        const onSeeked = () => {
          try {
            const vw = v.videoWidth || 480;
            const vh = v.videoHeight || 270;
            const tw = 480;
            const th = Math.max(1, Math.round(vh * (tw / vw)));
            const c = document.createElement('canvas');
            c.width = tw;
            c.height = th;
            const ctx = c.getContext('2d');
            ctx.drawImage(v, 0, 0, tw, th);
            const data = c.toDataURL('image/jpeg', 0.85);
            cleanup();
            resolve(data);
          } catch (_) {
            cleanup();
            resolve('');
          }
        };
        v.addEventListener('loadeddata', () => {
          try {
            const t = Math.min(1, Number.isFinite(v.duration) ? v.duration : 1);
            v.currentTime = t;
            v.addEventListener('seeked', onSeeked, { once: true });
          } catch (_) {
            cleanup();
            resolve('');
          }
        }, { once: true });
        v.addEventListener('error', () => { cleanup(); resolve(''); }, { once: true });
      });
    } catch (_) {
      return '';
    }
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
    el.grid.setAttribute('aria-busy', 'true');
    renderSkeletonGrid(6);
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
      renderLibrarySourceSelect();
      renderOverlayTargets();
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

  /** Render library source select for scheduling from Library */
  function renderLibrarySourceSelect() {
    if (!el.librarySourceSelect) return;
    // Preserve current selection
    const prev = el.librarySourceSelect.value || '';
    el.librarySourceSelect.innerHTML = '';
    const optDefault = document.createElement('option');
    optDefault.value = '';
    optDefault.textContent = 'Select a Library video…';
    el.librarySourceSelect.appendChild(optDefault);
    const selectable = Array.isArray(videos) ? videos.filter(v => v.status === STATUS.LIBRARY) : [];
    selectable.forEach(v => {
      const o = document.createElement('option');
      o.value = v._id;
      const sizeStr = typeof v.filesize === 'number' ? fmtBytes(v.filesize) : '';
      const durStr = typeof v.duration === 'number' ? fmtDuration(v.duration) : '';
      o.textContent = `${v.title || 'Untitled'} ${durStr ? '• ' + durStr : ''} ${sizeStr ? '• ' + sizeStr : ''}`;
      el.librarySourceSelect.appendChild(o);
    });
    // Restore selection if still present
    if (prev && selectable.some(v => v._id === prev)) {
      el.librarySourceSelect.value = prev;
    }
    if (el.libraryEmptyHint && el.libraryPresentHint) {
      const hasItems = selectable.length > 0;
      el.libraryEmptyHint.hidden = hasItems;
      el.libraryPresentHint.hidden = !hasItems;
    }
  }

  function renderOverlayTargets() {
    if (!el.ovTarget) return;
    const prev = el.ovTarget.value || '';
    el.ovTarget.innerHTML = '';
    const optLive = document.createElement('option');
    optLive.value = 'live';
    optLive.textContent = 'Active Live (auto)';
    el.ovTarget.appendChild(optLive);
    const selectable = Array.isArray(videos) ? videos.filter(v => ['streaming','scheduled'].includes(v.status)) : [];
    selectable.forEach(v => {
      const o = document.createElement('option');
      o.value = v._id;
      o.textContent = `${v.title || 'Untitled'} • ${v.status}`;
      el.ovTarget.appendChild(o);
    });
    if (prev && (prev === 'live' || selectable.some(v => v._id === prev))) {
      el.ovTarget.value = prev;
    } else {
      el.ovTarget.value = 'live';
    }
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
    // Toggle between Upload vs Library source
    try {
      const fileRow = el.form.querySelector('#file')?.closest('.form-row');
      const titleInput = el.form.querySelector('input[name="title"]');
      if (el.useLibrarySource) {
        const applyToggle = () => {
          const useLib = !!el.useLibrarySource.checked;
          if (fileRow) fileRow.hidden = useLib;
          if (el.librarySourceRow) el.librarySourceRow.hidden = !useLib;
          const fileInput = el.form.querySelector('input[name="file"]');
          if (fileInput) {
            if (useLib) { fileInput.removeAttribute('required'); }
            else { fileInput.setAttribute('required', ''); }
            fileInput.value = '';
          }
          if (titleInput) {
            titleInput.placeholder = useLib ? 'Use Library title or override' : ' ';
          }
          if (useLib && el.goLibraryLink) {
            el.goLibraryLink.addEventListener('click', (ev) => {
              ev.preventDefault();
              const btn = document.querySelector('.main-nav .nav-link[data-view="library"]');
              if (btn) btn.click();
            });
          }
        };
        applyToggle();
        el.useLibrarySource.addEventListener('change', applyToggle);
      }
    } catch (_) {}

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
      const repeatInput = document.getElementById('repeatDaily');

      const useLib = !!el.useLibrarySource?.checked;
      const libId = el.librarySourceSelect?.value || '';
      const file = fileInput?.files?.[0];
      const title = titleInput?.value?.trim();
      const scheduleTime = schedInput?.value;
      const rtmpUrl = rtmpInput?.value?.trim();
      const streamKey = keyInput?.value?.trim();
      const stopAt = stopInput?.value || '';
      const loop = !!loopInput?.checked;
      const repeatDaily = !!repeatInput?.checked;

      // Validation
      if (useLib) {
        if (!libId) return setMessage('Select a Library video.', 'error');
      } else {
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
      }
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

      if (useLib) {
        // Schedule existing Library video via PUT
        const body = {
          scheduleTime: new Date(scheduleTime).toISOString(),
          rtmpUrl,
          streamKey,
          status: 'scheduled',
          loop,
          repeatDaily,
        };
        if (stopAt) body.stopTime = new Date(stopAt).toISOString();
        if (title) body.title = title; // optional override
        fetchJSON(`${API_URL}/videos/${libId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then(() => {
          showToast('Scheduled from Library', 'success');
          el.form.reset();
          // Keep toggle state ON to allow next scheduling; re-render select
          el.useLibrarySource.checked = true;
          loadVideos();
        }).catch((err) => {
          setMessage(err.message || 'Failed to schedule from Library.', 'error');
        }).finally(() => {
          submitBtn.disabled = false;
          submitBtn.classList.remove('loading');
        });
      } else {
        const useChunked = file.size > (50 * 1024 * 1024);
        if (useChunked) {
          const uploadId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
          let chunkSize = 8 * 1024 * 1024;
          try {
            const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
            const mbps = conn && typeof conn.downlink === 'number' ? conn.downlink : 0;
            if (mbps >= 100) chunkSize = 32 * 1024 * 1024;
            else if (mbps >= 20) chunkSize = 16 * 1024 * 1024;
            else if (mbps >= 5) chunkSize = 8 * 1024 * 1024;
            else chunkSize = 4 * 1024 * 1024;
          } catch (_) {}
          const total = Math.ceil(file.size / chunkSize);
          let sent = 0;
          const sendChunk = (index) => {
            const start = index * chunkSize;
            const end = Math.min(file.size, start + chunkSize);
            const blob = file.slice(start, end);
            const fd = new FormData();
            fd.append('uploadId', uploadId);
            fd.append('index', String(index));
            fd.append('total', String(total));
            fd.append('filename', file.name);
            fd.append('chunk', blob, `chunk-${index}`);
            if (index === total - 1) {
              fd.append('title', title);
              fd.append('scheduleTime', new Date(scheduleTime).toISOString());
              if (stopAt) fd.append('stopTime', new Date(stopAt).toISOString());
              fd.append('rtmpUrl', rtmpUrl);
              fd.append('streamKey', streamKey);
              fd.append('loop', loop ? 'true' : 'false');
              fd.append('repeatDaily', repeatDaily ? 'true' : 'false');
            }
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `${API_URL}/videos/upload/chunk`);
            xhr.upload.onprogress = (ev) => {
              const loaded = Number(ev.loaded || 0);
              const pct = Math.round(((sent + loaded) / file.size) * 100);
              el.progress.hidden = false;
              el.progressBar.style.width = `${pct}%`;
            };
            xhr.onreadystatechange = () => {
              if (xhr.readyState !== 4) return;
              const ok = xhr.status >= 200 && xhr.status < 300;
              if (!ok) {
                const msg = xhr.responseText || `Upload failed: HTTP ${xhr.status}`;
                setMessage(msg, 'error');
                showToast('Upload failed', 'error');
                submitBtn.disabled = false;
                submitBtn.classList.remove('loading');
                el.progressBar.style.width = '0%';
                el.progress.hidden = true;
                return;
              }
              sent += blob.size;
              if (index + 1 < total) {
                sendChunk(index + 1);
              } else {
                showToast('Upload successful', 'success');
                el.form.reset();
                loadVideos();
                submitBtn.disabled = false;
                submitBtn.classList.remove('loading');
                el.progressBar.style.width = '0%';
                el.progress.hidden = true;
              }
            };
            xhr.onerror = () => {
              setMessage('Network error during upload.', 'error');
              showToast('Network error', 'error');
              submitBtn.disabled = false;
              submitBtn.classList.remove('loading');
              el.progressBar.style.width = '0%';
              el.progress.hidden = true;
            };
            xhr.send(fd);
          };
          sendChunk(0);
        } else {
          const fd = new FormData();
          fd.append('title', title);
          fd.append('video', file, file.name);
          fd.append('scheduleTime', new Date(scheduleTime).toISOString());
          if (stopAt) fd.append('stopTime', new Date(stopAt).toISOString());
          fd.append('rtmpUrl', rtmpUrl);
          fd.append('streamKey', streamKey);
          fd.append('loop', loop ? 'true' : 'false');
          fd.append('repeatDaily', repeatDaily ? 'true' : 'false');
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
        }
      }
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
    const rtmpUrl = prompt('RTMP URL (e.g., rtmps://a.rtmp.youtube.com/live2)');
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
      try { await loadVideos(); } catch (_) {}
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
      const isOverlay = view === 'overlay';

      // Toggle sections
      if (el.sectionPlaylistForm) el.sectionPlaylistForm.hidden = !isPlaylist;
      if (el.sectionPlaylists) el.sectionPlaylists.hidden = !isPlaylist;
      if (el.sectionUpload) el.sectionUpload.hidden = !(isLive);
      if (el.sectionActiveStreams) el.sectionActiveStreams.hidden = !(isLive || isActive);
      if (el.sectionUrlStream) el.sectionUrlStream.hidden = !(isLive);
      if (el.sectionLibraryUpload) el.sectionLibraryUpload.hidden = !isLibrary;
      if (el.sectionVideos) el.sectionVideos.hidden = isPlaylist || isActive || isOverlay;
      if (el.overlaySection) el.overlaySection.hidden = !isOverlay;

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

    // Default view: active
    showView('active');
  }

  /** URL Stream form */
  let externalStreamId = '';
  let urlStatusTimer = null;
  let scheduledJobId = '';
  let savedKeys = [];
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

  function populateSavedKeysSelect(select) {
    if (!select) return;
    const prev = select.value || '';
    select.innerHTML = '<option value="">Select saved key…</option>';
    const frag = document.createDocumentFragment();
    (savedKeys || []).forEach(k => {
      const opt = document.createElement('option');
      opt.value = String(k._id || '');
      opt.textContent = String(k.name || '');
      frag.appendChild(opt);
    });
    select.appendChild(frag);
    if (prev) select.value = prev;
  }
  async function loadSavedKeys() {
    try {
      const items = await fetchJSON(`${API_URL}/keys`);
      savedKeys = Array.isArray(items) ? items : [];
      populateSavedKeysSelect(el.urlSavedKeys);
      populateSavedKeysSelect(el.playlistSavedKeys);
      populateSavedKeysSelect(el.uploadSavedKeys);
    } catch (_) {
      savedKeys = [];
      populateSavedKeysSelect(el.urlSavedKeys);
      populateSavedKeysSelect(el.playlistSavedKeys);
      populateSavedKeysSelect(el.uploadSavedKeys);
    }
  }
  function getSavedKeyById(id) {
    const sid = String(id || '');
    return (savedKeys || []).find(k => String(k._id || '') === sid) || null;
  }
  function setupSavedKeysUI() {
    if (el.urlUseSavedKey) {
      el.urlUseSavedKey.addEventListener('click', () => {
        const id = el.urlSavedKeys?.value || '';
        const k = getSavedKeyById(id);
        if (!k) { showToast('Select a saved key', 'info'); return; }
        if (el.urlRtmp) el.urlRtmp.value = String(k.rtmpUrl || '');
        if (el.urlKey) el.urlKey.value = String(k.streamKey || '');
        showToast('Applied saved key', 'success');
      });
    }
    if (el.urlSaveKey) {
      el.urlSaveKey.addEventListener('click', async () => {
        const name = el.urlKeyName?.value?.trim() || '';
        const rtmpUrl = el.urlRtmp?.value?.trim() || '';
        const streamKey = el.urlKey?.value?.trim() || '';
        if (!name) { showToast('Enter a name', 'error'); return; }
        if (!rtmpUrl) { showToast('Enter RTMP URL', 'error'); return; }
        if (!streamKey || streamKey.length < 8) { showToast('Key must be >= 8 chars', 'error'); return; }
        el.urlSaveKey.disabled = true; el.urlSaveKey.classList.add('loading');
        try {
          await fetchJSON(`${API_URL}/keys`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, rtmpUrl, streamKey })
          });
          el.urlKeyName.value = '';
          await loadSavedKeys();
          showToast('Saved key', 'success');
        } catch (err) {
          showToast(`Save failed: ${err.message}`, 'error');
        } finally {
          el.urlSaveKey.disabled = false; el.urlSaveKey.classList.remove('loading');
        }
      });
    }
    if (el.urlDeleteSavedKey) {
      el.urlDeleteSavedKey.addEventListener('click', async () => {
        const id = el.urlSavedKeys?.value || '';
        if (!id) { showToast('Select a saved key', 'info'); return; }
        const ok = confirm('Delete this saved key?');
        if (!ok) return;
        el.urlDeleteSavedKey.disabled = true; el.urlDeleteSavedKey.classList.add('loading');
        try {
          await fetchJSON(`${API_URL}/keys/${id}`, { method: 'DELETE' });
          await loadSavedKeys();
          showToast('Deleted', 'warn');
        } catch (err) {
          showToast(`Delete failed: ${err.message}`, 'error');
        } finally {
          el.urlDeleteSavedKey.disabled = false; el.urlDeleteSavedKey.classList.remove('loading');
        }
      });
    }
    if (el.playlistUseSavedKey) {
      el.playlistUseSavedKey.addEventListener('click', () => {
        const id = el.playlistSavedKeys?.value || '';
        const k = getSavedKeyById(id);
        if (!k) { showToast('Select a saved key', 'info'); return; }
        const rtmpEl = document.getElementById('playlist-rtmpUrl');
        const keyEl = document.getElementById('playlist-streamKey');
        if (rtmpEl) rtmpEl.value = String(k.rtmpUrl || '');
        if (keyEl) keyEl.value = String(k.streamKey || '');
        showToast('Applied saved key', 'success');
      });
    }
    if (el.playlistSaveKey) {
      el.playlistSaveKey.addEventListener('click', async () => {
        const name = el.playlistKeyName?.value?.trim() || '';
        const rtmpEl = document.getElementById('playlist-rtmpUrl');
        const keyEl = document.getElementById('playlist-streamKey');
        const rtmpUrl = rtmpEl?.value?.trim() || '';
        const streamKey = keyEl?.value?.trim() || '';
        if (!name) { showToast('Enter a name', 'error'); return; }
        if (!rtmpUrl) { showToast('Enter RTMP URL', 'error'); return; }
        if (!streamKey || streamKey.length < 8) { showToast('Key must be >= 8 chars', 'error'); return; }
        el.playlistSaveKey.disabled = true; el.playlistSaveKey.classList.add('loading');
        try {
          await fetchJSON(`${API_URL}/keys`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, rtmpUrl, streamKey })
          });
          el.playlistKeyName.value = '';
          await loadSavedKeys();
          showToast('Saved key', 'success');
        } catch (err) {
          showToast(`Save failed: ${err.message}`, 'error');
        } finally {
          el.playlistSaveKey.disabled = false; el.playlistSaveKey.classList.remove('loading');
        }
      });
    }
    if (el.playlistDeleteSavedKey) {
      el.playlistDeleteSavedKey.addEventListener('click', async () => {
        const id = el.playlistSavedKeys?.value || '';
        if (!id) { showToast('Select a saved key', 'info'); return; }
        const ok = confirm('Delete this saved key?');
        if (!ok) return;
        el.playlistDeleteSavedKey.disabled = true; el.playlistDeleteSavedKey.classList.add('loading');
        try {
          await fetchJSON(`${API_URL}/keys/${id}`, { method: 'DELETE' });
          await loadSavedKeys();
          showToast('Deleted', 'warn');
        } catch (err) {
          showToast(`Delete failed: ${err.message}`, 'error');
        } finally {
          el.playlistDeleteSavedKey.disabled = false; el.playlistDeleteSavedKey.classList.remove('loading');
        }
      });
    }
    if (el.uploadUseSavedKey) {
      el.uploadUseSavedKey.addEventListener('click', () => {
        const id = el.uploadSavedKeys?.value || '';
        const k = getSavedKeyById(id);
        if (!k) { showToast('Select a saved key', 'info'); return; }
        const rtmpEl = document.getElementById('rtmpUrl');
        const keyEl = document.getElementById('streamKey');
        if (rtmpEl) rtmpEl.value = String(k.rtmpUrl || '');
        if (keyEl) keyEl.value = String(k.streamKey || '');
        showToast('Applied saved key', 'success');
      });
    }
    if (el.uploadSaveKey) {
      el.uploadSaveKey.addEventListener('click', async () => {
        const name = el.uploadKeyName?.value?.trim() || '';
        const rtmpEl = document.getElementById('rtmpUrl');
        const keyEl = document.getElementById('streamKey');
        const rtmpUrl = rtmpEl?.value?.trim() || '';
        const streamKey = keyEl?.value?.trim() || '';
        if (!name) { showToast('Enter a name', 'error'); return; }
        if (!rtmpUrl) { showToast('Enter RTMP URL', 'error'); return; }
        if (!streamKey || streamKey.length < 8) { showToast('Key must be >= 8 chars', 'error'); return; }
        el.uploadSaveKey.disabled = true; el.uploadSaveKey.classList.add('loading');
        try {
          await fetchJSON(`${API_URL}/keys`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, rtmpUrl, streamKey })
          });
          el.uploadKeyName.value = '';
          await loadSavedKeys();
          showToast('Saved key', 'success');
        } catch (err) {
          showToast(`Save failed: ${err.message}`, 'error');
        } finally {
          el.uploadSaveKey.disabled = false; el.uploadSaveKey.classList.remove('loading');
        }
      });
    }
    if (el.uploadDeleteSavedKey) {
      el.uploadDeleteSavedKey.addEventListener('click', async () => {
        const id = el.uploadSavedKeys?.value || '';
        if (!id) { showToast('Select a saved key', 'info'); return; }
        const ok = confirm('Delete this saved key?');
        if (!ok) return;
        el.uploadDeleteSavedKey.disabled = true; el.uploadDeleteSavedKey.classList.add('loading');
        try {
          await fetchJSON(`${API_URL}/keys/${id}`, { method: 'DELETE' });
          await loadSavedKeys();
          showToast('Deleted', 'warn');
        } catch (err) {
          showToast(`Delete failed: ${err.message}`, 'error');
        } finally {
          el.uploadDeleteSavedKey.disabled = false; el.uploadDeleteSavedKey.classList.remove('loading');
        }
      });
    }
  }

  function rgba(hex, op) {
    const h = String(hex || '#000000').replace('#', '');
    const r = parseInt(h.substring(0, 2), 16) || 0;
    const g = parseInt(h.substring(2, 4), 16) || 0;
    const b = parseInt(h.substring(4, 6), 16) || 0;
    const a = Math.max(0, Math.min(1, Number(op || 1)));
    return `rgba(${r},${g},${b},${a})`;
  }

  class OverlayRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
      this.running = false;
      this.lastTs = 0;
      this.state = this.defaultState();
      this.raf = null;
    }
    defaultState() {
      return {
        width: this.canvas ? this.canvas.width : 1280,
        height: this.canvas ? this.canvas.height : 720,
        scale: 1,
        bg: '#000000',
        bgOpa: 0,
        ticker: {
          text: '',
          speed: 120,
          font: 'Segoe UI',
          size: 24,
          bold: false,
          color: '#ffffff',
          pos: 'bottom',
          y: null,
          bg: '#000000',
          bg2: '#000000',
          bgMode: 'solid',
          opa: 0.4,
          offset: 0,
          borderWidth: 0,
          borderColor: '#ffffff',
          borderOpa: 1,
          borderRadius: 0,
        },
        nowLive: {
          show: false,
          text: 'NOW LIVE',
          items: '',
          pos: 'tl',
          y: 0,
          labelBg: '#ff0000',
          labelOpa: 0.8,
          labelColor: '#ffffff',
          itemColor: '#ffffff',
          labelSize: 18,
          itemSize: 16,
          anim: 'pulse',
          offset: 0,
        },
        clock: {
          enable: false,
          format: '24',
          showDate: false,
          showSeconds: true,
          color: '#ffffff',
          size: 20,
          x: (this.canvas ? this.canvas.width : 1280) / 2,
          y: 8,
          font: 'Segoe UI',
          bold: false,
          bgEnable: false,
          bgColor: '#000000',
          bgOpa: 0.4,
          bgPad: 8,
          bgShape: 'rounded', // rect | rounded | pill
          bgRadius: 10,
          borderWidth: 0,
          borderColor: '#ffffff',
          borderOpa: 1,
          borderRadius: 10,
        },
        logo: {
          url: '',
          pos: 'tr',
          x: null,
          y: null,
          size: 80,
          width: null,
          height: null,
          rotate: 0,
          opa: 0.8,
          img: null,
        },
        lowerThird: {
          show: false,
          title: '',
          sub: '',
        },
        scoreboard: {
          a: '',
          b: '',
          aVal: 0,
          bVal: 0,
        },
        banner: {
          show: false,
          text: '',
        },
      };
    }
    setSize(w, h) {
      if (!this.canvas) return;
      const W = Math.max(320, Math.round(Number(w) || 1280));
      const H = Math.max(240, Math.round(Number(h) || 720));
      this.canvas.width = W;
      this.canvas.height = H;
      this.state.width = W;
      this.state.height = H;
    }
    setScale(s) {
      const val = Math.max(0.5, Math.min(3, Number(s) || 1));
      this.state.scale = val;
    }
    update(partial) {
      Object.assign(this.state, partial || {});
    }
    updateTicker(partial) {
      Object.assign(this.state.ticker, partial || {});
    }
    updateClock(partial) {
      Object.assign(this.state.clock, partial || {});
    }
    updateNowLive(partial) {
      Object.assign(this.state.nowLive, partial || {});
    }
    updateLogo(partial) {
      Object.assign(this.state.logo, partial || {});
      if (partial && typeof partial.url === 'string' && partial.url !== this.state.logo.url) {
        this.state.logo.img = null;
        this.state.logo.width = null;
        this.state.logo.height = null;
      }
    }
    updateLowerThird(partial) {
      Object.assign(this.state.lowerThird, partial || {});
    }
    updateScoreboard(partial) {
      Object.assign(this.state.scoreboard, partial || {});
    }
    updateBanner(partial) {
      Object.assign(this.state.banner, partial || {});
    }
    reset() {
      this.stop();
      this.state = this.defaultState();
      this.setSize(this.state.width, this.state.height);
    }
    start() {
      if (!this.ctx || this.running) return;
      this.running = true;
      const loop = (ts) => {
        if (!this.running) return;
        const dt = this.lastTs ? (ts - this.lastTs) / 1000 : 0;
        this.lastTs = ts;
        this.render(dt);
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    }
    stop() {
      this.running = false;
      if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; }
    }
    clear() {
      if (!this.ctx) return;
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    drawBackground() {
      if (!this.ctx) return;
      if (this.state.bgOpa > 0) {
        this.ctx.fillStyle = rgba(this.state.bg, this.state.bgOpa);
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      }
    }
    drawTicker(dt) {
      const t = this.state.ticker;
      if (!t.text) return;
      const ctx = this.ctx;
      const H = this.canvas.height;
      const size = Math.max(10, Number(t.size) || 24);
      const bandH = size + 12;
      const yVal = Number.isFinite(Number(t.y)) ? Number(t.y) : null;
      let bandTop = 0;
      if (t.pos === 'top') {
        const offset = Math.max(0, yVal || 0);
        bandTop = Math.max(0, Math.min(H - bandH, offset));
      } else if (t.pos === 'bottom') {
        const offset = Math.max(0, yVal || 0);
        bandTop = Math.max(0, Math.min(H - bandH, H - bandH - offset));
      } else {
        const cy = yVal ?? (H - bandH - 8);
        bandTop = Math.max(0, Math.min(H - bandH, cy - bandH / 2));
      }
      const y = bandTop + bandH / 2;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, bandTop, this.canvas.width, bandH);
      ctx.clip();
      if (t.opa > 0) {
        const mode = String(t.bgMode || 'solid');
        if (mode === 'hgrad') {
          const g = ctx.createLinearGradient(0, 0, this.canvas.width, 0);
          g.addColorStop(0, rgba(t.bg, t.opa));
          g.addColorStop(1, rgba(t.bg2 || t.bg, t.opa));
          ctx.fillStyle = g;
          ctx.fillRect(0, bandTop, this.canvas.width, bandH);
        } else if (mode === 'vgrad') {
          const g = ctx.createLinearGradient(0, bandTop, 0, bandTop + bandH);
          g.addColorStop(0, rgba(t.bg, t.opa));
          g.addColorStop(1, rgba(t.bg2 || t.bg, t.opa));
          ctx.fillStyle = g;
          ctx.fillRect(0, bandTop, this.canvas.width, bandH);
        } else {
          ctx.fillStyle = rgba(t.bg, t.opa);
          ctx.fillRect(0, bandTop, this.canvas.width, bandH);
        }
      }
      const bw = Math.max(0, Number(t.borderWidth) || 0);
      const bo = Math.max(0, Math.min(1, Number(t.borderOpa)));
      if (bw > 0 && bo > 0) {
        ctx.lineWidth = bw;
        ctx.strokeStyle = rgba(t.borderColor || '#ffffff', bo);
        const r = Math.max(0, Math.min(Number(t.borderRadius) || 0, bandH / 2));
        if (r > 0) {
          ctx.beginPath();
          const x1 = 0; const x2 = this.canvas.width;
          const y1 = bandTop; const y2 = bandTop + bandH;
          ctx.moveTo(x1 + r, y1);
          ctx.lineTo(x2 - r, y1);
          ctx.quadraticCurveTo(x2, y1, x2, y1 + r);
          ctx.lineTo(x2, y2 - r);
          ctx.quadraticCurveTo(x2, y2, x2 - r, y2);
          ctx.lineTo(x1 + r, y2);
          ctx.quadraticCurveTo(x1, y2, x1, y2 - r);
          ctx.lineTo(x1, y1 + r);
          ctx.quadraticCurveTo(x1, y1, x1 + r, y1);
          ctx.closePath();
          ctx.stroke();
        } else {
          ctx.strokeRect(0, bandTop, this.canvas.width, bandH);
        }
      }
      const weight = t.bold ? 'bold ' : '';
      ctx.font = `${weight}${size}px ${t.font || 'Segoe UI'}, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = t.color || '#ffffff';
      const speed = Math.max(10, Number(t.speed) || 120);
      t.offset = (typeof t.offset === 'number' ? t.offset : 0) + speed * dt;
      const gap = 40;
      const text = String(t.text);
      const w = ctx.measureText(text).width;
      const tile = w + gap;
      let x = this.canvas.width - (t.offset % tile);
      while (x > -w) {
        ctx.fillText(text, x, y);
        x -= tile;
      }
      ctx.restore();
    }
    drawNowLive(dt) {
      const nl = this.state.nowLive;
      if (!nl.show) return;
      const ctx = this.ctx;
      const padX = 10;
      const padY = 6;
      const labelSize = Math.max(10, Number(nl.labelSize) || 18);
      const itemSize = Math.max(10, Number(nl.itemSize) || 16);
      const linesRaw = String(nl.items || '').split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0);
      const W = this.canvas.width;
      const H = this.canvas.height;
      const pos = String(nl.pos || 'tl');
      const isTop = pos.includes('t') || pos === 'custom';
      const isLeft = pos.includes('l') || pos === 'custom';
      const baseYOff = Math.max(0, Number(nl.y) || 0);
      const labelText = String(nl.text || 'NOW LIVE');
      nl.offset = (typeof nl.offset === 'number' ? nl.offset : 0) + dt;
      const t = nl.offset;
      const anim = String(nl.anim || 'pulse');
      const pulseScale = anim === 'pulse' ? (1 + 0.06 * Math.sin((this.lastTs || 0) / 300)) : 1;
      ctx.save();
      ctx.font = `${Math.round(labelSize * pulseScale)}px ${'Segoe UI'}, sans-serif`;
      const labelW = ctx.measureText(labelText).width + padX * 2;
      const labelH = Math.round(labelSize * pulseScale) + padY * 2;
      let x = isLeft ? 8 : (W - labelW - 8);
      let y = isTop ? (8 + baseYOff) : (H - labelH - 8 - baseYOff);
      if (anim === 'slide') {
        x += Math.sin(t * 2) * 12;
      } else if (anim === 'bounce') {
        y += Math.sin(t * 3) * 6;
      }
      ctx.fillStyle = rgba(nl.labelBg || '#ff0000', Number(nl.labelOpa) || 0);
      ctx.fillRect(x, y, labelW, labelH);
      ctx.fillStyle = nl.labelColor || '#ffffff';
      ctx.textAlign = isLeft ? 'start' : 'end';
      ctx.textBaseline = 'middle';
      const tx = isLeft ? (x + padX) : (x + labelW - padX);
      const ty = y + labelH / 2;
      ctx.fillText(labelText, tx, ty);
      if (anim === 'shine') {
        const bandW = Math.max(40, Math.floor(labelW * 0.35));
        const sX = x + ((t * 80) % (labelW + bandW)) - bandW;
        const g = ctx.createLinearGradient(sX, y, sX + bandW, y + labelH);
        g.addColorStop(0, 'rgba(255,255,255,0)');
        g.addColorStop(0.5, 'rgba(255,255,255,0.25)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x, y, labelW, labelH);
      }
      ctx.font = `${itemSize}px ${'Segoe UI'}, sans-serif`;
      ctx.textAlign = isLeft ? 'start' : 'end';
      ctx.textBaseline = 'top';
      ctx.fillStyle = nl.itemColor || '#ffffff';
      let itemX = x;
      const advance = (isTop ? 1 : -1);
      const baseStart = isTop ? (y + labelH + 4) : (y - 4);
      let itemY = baseStart;
      if (anim === 'scroll' && linesRaw.length > 0) {
        const ih = itemSize + padY;
        const totalH = linesRaw.length * (ih + 2);
        const spd = 30;
        const shift = (t * spd) % totalH;
        itemY = baseStart - advance * shift;
      }
      for (let i = 0; i < linesRaw.length; i++) {
        const line = linesRaw[i];
        const tw = ctx.measureText(line).width + padX * 2;
        const iw = Math.min(Math.max(labelW, tw), W - 16);
        const ih = itemSize + padY;
        const rx = isLeft ? itemX : (W - iw - 8);
        const ry = itemY;
        ctx.fillStyle = rgba('#000000', 0.25);
        ctx.fillRect(rx, ry, iw, ih);
        ctx.fillStyle = nl.itemColor || '#ffffff';
        const tx2 = isLeft ? (rx + padX) : (rx + iw - padX);
        const ty2 = ry + padY / 2;
        ctx.fillText(line, tx2, ty2);
        itemY += advance * (ih + 2);
      }
      ctx.restore();
    }
    drawClock() {
      const c = this.state.clock;
      if (!c.enable) return;
      const ctx = this.ctx;
      const size = Math.max(10, Number(c.size) || 20);
      const weight = c.bold ? 'bold ' : '';
      const fontFamily = c.font || 'Segoe UI';
      ctx.font = `${weight}${size}px ${fontFamily}, sans-serif`;
      const textColor = c.color || '#ffffff';
      ctx.fillStyle = textColor;
      const d = new Date();
      const hh = d.getHours();
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      const h12 = ((hh + 11) % 12) + 1;
      const ampm = hh >= 12 ? 'PM' : 'AM';
      const time = c.format === '12'
        ? `${h12}:${mm}${c.showSeconds ? ':' + ss : ''} ${ampm}`
        : `${String(hh).padStart(2,'0')}:${mm}${c.showSeconds ? ':' + ss : ''}`;
      const date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const text = c.showDate ? `${date} ${time}` : time;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const x = Number.isFinite(c.x) ? c.x : (this.canvas.width / 2);
      const y = Number.isFinite(c.y) ? c.y : 8;
      const tw = ctx.measureText(text).width;
      const pad = Math.max(0, Number(c.bgPad) || 0);
      const bw = tw + pad * 2;
      const bh = size + pad * 2;
      const bx = x - bw / 2;
      const by = y - pad;
      const shape = String(c.bgShape || 'rounded');
      let rad = 0;
      if (shape === 'pill') rad = bh / 2;
      else if (shape === 'rounded') rad = Math.max(0, Number(c.bgRadius) || 0);
      if (c.bgEnable) {
        ctx.fillStyle = rgba(c.bgColor || '#000000', Number(c.bgOpa) || 0);
        if (rad > 0) {
          ctx.beginPath();
          const r = rad;
          const x2 = bx + bw;
          const y2 = by + bh;
          ctx.moveTo(bx + r, by);
          ctx.lineTo(x2 - r, by);
          ctx.quadraticCurveTo(x2, by, x2, by + r);
          ctx.lineTo(x2, y2 - r);
          ctx.quadraticCurveTo(x2, y2, x2 - r, y2);
          ctx.lineTo(bx + r, y2);
          ctx.quadraticCurveTo(bx, y2, bx, y2 - r);
          ctx.lineTo(bx, by + r);
          ctx.quadraticCurveTo(bx, by, bx + r, by);
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.fillRect(bx, by, bw, bh);
        }
      }
      const bwid = Math.max(0, Number(c.borderWidth) || 0);
      const bopa = Math.max(0, Math.min(1, Number(c.borderOpa)));
      if (bwid > 0 && bopa > 0) {
        ctx.lineWidth = bwid;
        ctx.strokeStyle = rgba(c.borderColor || '#ffffff', bopa);
        const rr = shape === 'pill' ? bh / 2 : Math.max(0, Number(c.borderRadius ?? c.bgRadius) || 0);
        if (rr > 0) {
          ctx.beginPath();
          const r = rr;
          const x2 = bx + bw;
          const y2 = by + bh;
          ctx.moveTo(bx + r, by);
          ctx.lineTo(x2 - r, by);
          ctx.quadraticCurveTo(x2, by, x2, by + r);
          ctx.lineTo(x2, y2 - r);
          ctx.quadraticCurveTo(x2, y2, x2 - r, y2);
          ctx.lineTo(bx + r, y2);
          ctx.quadraticCurveTo(bx, y2, bx, y2 - r);
          ctx.lineTo(bx, by + r);
          ctx.quadraticCurveTo(bx, by, bx + r, by);
          ctx.closePath();
          ctx.stroke();
        } else {
          ctx.strokeRect(bx, by, bw, bh);
        }
      }
      ctx.fillStyle = textColor;
      ctx.fillText(text, x, y);
      ctx.textAlign = 'start';
    }
    async ensureLogo() {
      const l = this.state.logo;
      if (!l.url || l.img) return;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      return await new Promise((resolve) => {
        img.onload = () => { l.img = img; resolve(true); };
        img.onerror = () => resolve(false);
        img.src = l.url;
      });
    }
    async drawLogo() {
      const l = this.state.logo;
      if (!l.url) return;
      await this.ensureLogo();
      if (!l.img) return;
      const ctx = this.ctx;
      const s = Math.max(20, Number(l.size) || 80);
      const iw = Number(l.img.naturalWidth || l.img.width || s) || s;
      const ih = Number(l.img.naturalHeight || l.img.height || s) || s;
      const ar = iw > 0 && ih > 0 ? (iw / ih) : 1;
      let w = Number.isFinite(l.width) ? Math.max(20, Number(l.width)) : Math.round(s * ar);
      let h = Number.isFinite(l.height) ? Math.max(20, Number(l.height)) : s;
      const opa = Math.max(0, Math.min(1, Number(l.opa) || 1));
      const rotDeg = Number.isFinite(Number(l.rotate)) ? Number(l.rotate) : 0;
      const rotRad = rotDeg * Math.PI / 180;
      ctx.globalAlpha = opa;
      let x = 8, y = 8;
      const clamp = (v, min, max) => Math.max(min, Math.min(max, Number(v)));
      if (l.pos === 'custom' && Number.isFinite(l.x) && Number.isFinite(l.y)) {
        x = clamp(l.x, 0, this.canvas.width - w);
        y = clamp(l.y, 0, this.canvas.height - h);
      } else {
        if (l.pos === 'tl') { x = 8; y = 8; }
        if (l.pos === 'tr') { x = this.canvas.width - w - 8; y = 8; }
        if (l.pos === 'bl') { x = 8; y = this.canvas.height - h - 8; }
        if (l.pos === 'br') { x = this.canvas.width - w - 8; y = this.canvas.height - h - 8; }
      }
      ctx.save();
      const cx = x + w / 2;
      const cy = y + h / 2;
      if (rotRad !== 0) {
        ctx.translate(cx, cy);
        ctx.rotate(rotRad);
        ctx.drawImage(l.img, -w / 2, -h / 2, w, h);
      } else {
        ctx.drawImage(l.img, x, y, w, h);
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }
    drawLowerThird() {
      const lt = this.state.lowerThird;
      if (!lt.show) return;
      const ctx = this.ctx;
      const H = this.canvas.height;
      const w = Math.min(this.canvas.width - 40, 640);
      const h = 80;
      const x = (this.canvas.width - w) / 2;
      const y = H - h - 24;
      ctx.fillStyle = rgba('#000000', 0.4);
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#ffffff';
      ctx.font = '24px Segoe UI, sans-serif';
      ctx.fillText(String(lt.title || ''), x + 16, y + 34);
      ctx.font = '16px Segoe UI, sans-serif';
      ctx.fillText(String(lt.sub || ''), x + 16, y + 60);
    }
    drawScoreboard() {
      const sb = this.state.scoreboard;
      if (!sb.a && !sb.b) return;
      const ctx = this.ctx;
      const w = 280;
      const h = 48;
      const x = (this.canvas.width - w) / 2;
      const y = 8;
      ctx.fillStyle = rgba('#000000', 0.4);
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#ffffff';
      ctx.font = '20px Segoe UI, sans-serif';
      const txtA = `${String(sb.a || '')} ${Number(sb.aVal || 0)}`;
      const txtB = `${Number(sb.bVal || 0)} ${String(sb.b || '')}`;
      ctx.textAlign = 'start';
      ctx.fillText(txtA, x + 12, y + 30);
      ctx.textAlign = 'end';
      ctx.fillText(txtB, x + w - 12, y + 30);
      ctx.textAlign = 'start';
    }
    drawBanner() {
      const b = this.state.banner;
      if (!b.show || !b.text) return;
      const ctx = this.ctx;
      const w = Math.min(this.canvas.width - 40, 720);
      const h = 48;
      const x = (this.canvas.width - w) / 2;
      const y = this.canvas.height - h - 8;
      ctx.fillStyle = rgba('#ff0000', 0.7);
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#ffffff';
      ctx.font = '20px Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(b.text || ''), x + w / 2, y + 30);
      ctx.textAlign = 'start';
    }
    render(dt) {
      if (!this.ctx) return;
      this.clear();
      this.drawBackground();
      this.drawTicker(dt);
      this.drawNowLive(dt);
      this.drawClock();
      this.drawLogo();
      this.drawLowerThird();
      this.drawScoreboard();
      this.drawBanner();
    }
  }

  let overlay = null;
  let ovEventSource = null;
  let sseUpdating = false;
  let pushTimer = null;
  function setupOverlayStudio() {
    if (!el.ovCanvas) return;
    overlay = new OverlayRenderer(el.ovCanvas);
    const setMsg = (t, cls) => { if (el.ovMsg) { el.ovMsg.textContent = t || ''; el.ovMsg.className = `message ${cls||'info'}`; } };
    const syncBase = () => {
      const w = Number(el.ovWidth?.value || overlay.state.width);
      const h = Number(el.ovHeight?.value || overlay.state.height);
      overlay.setSize(w, h);
      overlay.setScale(Number(el.ovScale?.value || 1));
      overlay.update({ bg: el.ovBg?.value || '#000000', bgOpa: Number(el.ovBgOpa?.value || 0) });
    };
    const syncTicker = () => {
      overlay.updateTicker({
        text: el.ovTickerText?.value || '',
        speed: Number(el.ovTickerSpeed?.value || 120),
        font: el.ovTickerFont?.value || 'Segoe UI',
        size: Number(el.ovTickerSize?.value || 24),
        bold: !!el.ovTickerBold?.checked,
        color: el.ovTickerColor?.value || '#ffffff',
        pos: el.ovTickerPos?.value || 'bottom',
        y: Number(el.ovTickerY?.value || overlay.state.ticker.y),
        bg: el.ovTickerBg?.value || '#000000',
        bg2: el.ovTickerBg2?.value || overlay.state.ticker.bg2 || '#000000',
        bgMode: el.ovTickerBgMode?.value || overlay.state.ticker.bgMode || 'solid',
        opa: Number(el.ovTickerOpa?.value || 0.4),
        borderWidth: Number(el.ovTickerBorderWidth?.value || overlay.state.ticker.borderWidth || 0),
        borderColor: el.ovTickerBorderColor?.value || overlay.state.ticker.borderColor || '#ffffff',
        borderOpa: Number(el.ovTickerBorderOpa?.value || overlay.state.ticker.borderOpa || 1),
        borderRadius: Number(el.ovTickerBorderRadius?.value || overlay.state.ticker.borderRadius || 0),
      });
    };
    const syncNowLive = () => {
      overlay.updateNowLive({
        show: !!el.ovNlShow?.checked,
        text: el.ovNlText?.value || overlay.state.nowLive.text,
        items: el.ovNlItems?.value || overlay.state.nowLive.items,
        pos: el.ovNlPos?.value || overlay.state.nowLive.pos,
        y: Number(el.ovNlY?.value || overlay.state.nowLive.y || 0),
        labelBg: el.ovNlLabelBg?.value || overlay.state.nowLive.labelBg,
        labelOpa: Number(el.ovNlLabelOpa?.value || overlay.state.nowLive.labelOpa),
        labelColor: el.ovNlLabelColor?.value || overlay.state.nowLive.labelColor,
        itemColor: el.ovNlItemColor?.value || overlay.state.nowLive.itemColor,
        labelSize: Number(el.ovNlLabelSize?.value || overlay.state.nowLive.labelSize),
        itemSize: Number(el.ovNlItemSize?.value || overlay.state.nowLive.itemSize),
        anim: el.ovNlAnim?.value || overlay.state.nowLive.anim,
      });
    };
    const syncClock = () => {
      overlay.updateClock({
        enable: !!el.ovClockEnable?.checked,
        format: el.ovClockFormat?.value || '24',
        showDate: !!el.ovClockDate?.checked,
        showSeconds: !!el.ovClockSeconds?.checked,
        color: el.ovClockColor?.value || '#ffffff',
        size: Number(el.ovClockSize?.value || 20),
        x: Number(el.ovClockX?.value || overlay.state.clock.x),
        y: Number(el.ovClockY?.value || overlay.state.clock.y),
        font: el.ovClockFont?.value || overlay.state.clock.font,
        bold: !!el.ovClockBold?.checked,
        bgEnable: !!el.ovClockBgEnable?.checked,
        bgColor: el.ovClockBg?.value || overlay.state.clock.bgColor,
        bgOpa: Number(el.ovClockBgOpa?.value || overlay.state.clock.bgOpa),
        bgPad: Number(el.ovClockBgPad?.value || overlay.state.clock.bgPad),
        bgShape: el.ovClockBgShape?.value || overlay.state.clock.bgShape,
        bgRadius: Number(el.ovClockBgRadius?.value || overlay.state.clock.bgRadius),
        borderWidth: Number(el.ovClockBorderWidth?.value || overlay.state.clock.borderWidth || 0),
        borderColor: el.ovClockBorderColor?.value || overlay.state.clock.borderColor || '#ffffff',
        borderOpa: Number(el.ovClockBorderOpa?.value || overlay.state.clock.borderOpa || 1),
        borderRadius: Number(el.ovClockBorderRadius?.value || overlay.state.clock.borderRadius || overlay.state.clock.bgRadius || 0),
      });
    };
    const syncLogo = () => {
      const xRaw = el.ovLogoX?.value;
      const yRaw = el.ovLogoY?.value;
      const xVal = (typeof xRaw === 'string' && xRaw.length > 0) ? Number(xRaw) : overlay.state.logo.x;
      const yVal = (typeof yRaw === 'string' && yRaw.length > 0) ? Number(yRaw) : overlay.state.logo.y;
      const posRaw = el.ovLogoPos?.value || 'tr';
      const pos = (posRaw === 'custom' || Number.isFinite(xVal) || Number.isFinite(yVal)) ? 'custom' : posRaw;
      overlay.updateLogo({
        url: el.ovLogoUrl?.value || '',
        pos,
        x: xVal,
        y: yVal,
        size: Number(el.ovLogoSize?.value || 80),
        opa: Number(el.ovLogoOpa?.value || 0.8),
        rotate: Number(el.ovLogoRotate?.value || 0),
      });
    };
    const syncLowerThird = () => {
      overlay.updateLowerThird({
        show: !!el.ovLtShow?.checked,
        title: el.ovLtTitle?.value || '',
        sub: el.ovLtSub?.value || '',
      });
    };
    const syncScoreboard = () => {
      overlay.updateScoreboard({
        a: el.ovScoreA?.value || '',
        b: el.ovScoreB?.value || '',
        aVal: Number(el.ovScoreAVal?.value || 0),
        bVal: Number(el.ovScoreBVal?.value || 0),
      });
    };
    const syncBanner = () => {
      overlay.updateBanner({
        show: !!el.ovBannerShow?.checked,
        text: el.ovBannerText?.value || '',
      });
    };
    const syncAll = () => { syncBase(); syncTicker(); syncNowLive(); syncClock(); syncLogo(); syncLowerThird(); syncScoreboard(); syncBanner(); };
    const handlers = [
      el.ovWidth, el.ovHeight, el.ovScale, el.ovBg, el.ovBgOpa,
      el.ovTickerText, el.ovTickerSpeed, el.ovTickerFont, el.ovTickerSize, el.ovTickerBold, el.ovTickerColor, el.ovTickerPos, el.ovTickerBg, el.ovTickerBgMode, el.ovTickerBg2, el.ovTickerOpa,
      el.ovTickerBorderWidth, el.ovTickerBorderColor, el.ovTickerBorderOpa, el.ovTickerBorderRadius,
      el.ovTickerY,
      el.ovNlShow, el.ovNlText, el.ovNlItems, el.ovNlPos, el.ovNlY, el.ovNlLabelBg, el.ovNlLabelOpa, el.ovNlLabelColor, el.ovNlItemColor, el.ovNlLabelSize, el.ovNlItemSize, el.ovNlAnim,
      el.ovClockEnable, el.ovClockFormat, el.ovClockDate, el.ovClockSeconds, el.ovClockColor, el.ovClockSize,
      el.ovClockX, el.ovClockY,
      el.ovClockFont, el.ovClockBold,
      el.ovClockBgEnable, el.ovClockBg, el.ovClockBgOpa, el.ovClockBgPad, el.ovClockBgShape, el.ovClockBgRadius,
      el.ovClockBorderWidth, el.ovClockBorderColor, el.ovClockBorderOpa, el.ovClockBorderRadius,
      el.ovLogoUrl, el.ovLogoPos, el.ovLogoSize, el.ovLogoOpa,
      el.ovLogoX, el.ovLogoY, el.ovLogoRotate,
      el.ovLtTitle, el.ovLtSub, el.ovLtShow,
      el.ovScoreA, el.ovScoreB, el.ovScoreAVal, el.ovScoreBVal,
      el.ovBannerText, el.ovBannerShow
    ].filter(Boolean);
    handlers.forEach((node) => {
      const isSelect = String(node.tagName || '').toLowerCase() === 'select';
      const ev = (node.type === 'checkbox' || isSelect) ? 'change' : 'input';
      node.addEventListener(ev, () => {
        syncAll();
        maybePush();
      });
    });
    function updateLogoXYEnabled() {
      const mode = (el.ovLogoPos?.value || 'tr');
      const enabled = mode === 'custom';
      if (el.ovLogoX) { el.ovLogoX.disabled = !enabled; el.ovLogoX.parentElement?.classList.toggle('disabled', !enabled); }
      if (el.ovLogoY) { el.ovLogoY.disabled = !enabled; el.ovLogoY.parentElement?.classList.toggle('disabled', !enabled); }
    }
    if (el.ovLogoPos) {
      el.ovLogoPos.addEventListener('change', () => {
        updateLogoXYEnabled();
        syncLogo();
        maybePush();
      });
    }
    if (el.ovLogoX) {
      el.ovLogoX.addEventListener('input', () => {
        if (el.ovLogoPos) el.ovLogoPos.value = 'custom';
        updateLogoXYEnabled();
        syncLogo();
        maybePush();
      });
    }
    if (el.ovLogoY) {
      el.ovLogoY.addEventListener('input', () => {
        if (el.ovLogoPos) el.ovLogoPos.value = 'custom';
        updateLogoXYEnabled();
        syncLogo();
        maybePush();
      });
    }
    if (el.ovLogoFile) {
      el.ovLogoFile.addEventListener('change', () => {
        const f = el.ovLogoFile.files && el.ovLogoFile.files[0];
        if (!f) return;
        const okTypes = ['image/png','image/jpeg','image/jpg','image/webp','image/gif'];
        if (!okTypes.includes(f.type)) { showToast('Invalid image type', 'error'); return; }
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = String(reader.result || '');
          overlay.updateLogo({ url: dataUrl });
          if (el.ovLogoUrl) el.ovLogoUrl.value = dataUrl;
          syncLogo();
          maybePush();
        };
        reader.onerror = () => showToast('Image load failed', 'error');
        reader.readAsDataURL(f);
      });
    }
    function updateTickerYEnabled() {
      if (el.ovTickerY) { el.ovTickerY.disabled = false; el.ovTickerY.parentElement?.classList.remove('disabled'); }
    }
    function updateTickerBgInputsEnabled() {
      const mode = (el.ovTickerBgMode?.value || 'solid');
      const enabled = mode !== 'solid';
      if (el.ovTickerBg2) { el.ovTickerBg2.disabled = !enabled; el.ovTickerBg2.parentElement?.classList.toggle('disabled', !enabled); }
    }
    if (el.ovTickerPos) {
      el.ovTickerPos.addEventListener('change', () => {
        updateTickerYEnabled();
        syncAll();
        maybePush();
      });
    }
    if (el.ovTickerBgMode) {
      el.ovTickerBgMode.addEventListener('change', () => {
        updateTickerBgInputsEnabled();
        syncAll();
        maybePush();
      });
    }
    function updateNowLiveYEnabled() {
      const mode = (el.ovNlPos?.value || 'tl');
      const enabled = mode === 'custom' || mode.includes('t') || mode.includes('b');
      if (el.ovNlY) { el.ovNlY.disabled = !enabled; el.ovNlY.parentElement?.classList.toggle('disabled', !enabled); }
    }
    if (el.ovNlPos) {
      el.ovNlPos.addEventListener('change', () => {
        updateNowLiveYEnabled();
        syncAll();
        maybePush();
      });
    }
    syncAll();
    updateTickerYEnabled();
    updateTickerBgInputsEnabled();
    updateNowLiveYEnabled();
    updateLogoXYEnabled();
    let draggingClock = false;
    let dragDX = 0;
    let dragDY = 0;
    let draggingLogo = false;
    let resizingLogo = false;
    let resizingLogoMode = null;
    let logoDX = 0;
    let logoDY = 0;
    function getMouse(ev) {
      const r = el.ovCanvas.getBoundingClientRect();
      const sx = el.ovCanvas.width / r.width;
      const sy = el.ovCanvas.height / r.height;
      return { x: (ev.clientX - r.left) * sx, y: (ev.clientY - r.top) * sy };
    }
    function clockRect() {
      if (!overlay || !overlay.ctx) return null;
      const c = overlay.state.clock;
      if (!c.enable) return null;
      const size = Math.max(10, Number(c.size) || 20);
      overlay.ctx.font = `${size}px Segoe UI, sans-serif`;
      const d = new Date();
      const hh = d.getHours();
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      const h12 = ((hh + 11) % 12) + 1;
      const ampm = hh >= 12 ? 'PM' : 'AM';
      const time = c.format === '12' ? `${h12}:${mm}:${ss} ${ampm}` : `${String(hh).padStart(2,'0')}:${mm}:${ss}`;
      const date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const text = c.showDate ? `${date} ${time}` : time;
      const w = overlay.ctx.measureText(text).width;
      const h = size + 10;
      const x = Number.isFinite(c.x) ? c.x : (el.ovCanvas.width / 2);
      const y = Number.isFinite(c.y) ? c.y : 8;
      return { x: x - w / 2, y, w, h };
    }
    el.ovCanvas.addEventListener('mousedown', (ev) => {
      const cr = clockRect();
      if (!cr) return;
      const m = getMouse(ev);
      if (m.x >= cr.x && m.x <= cr.x + cr.w && m.y >= cr.y && m.y <= cr.y + cr.h) {
        draggingClock = true;
        const cx = Number.isFinite(overlay.state.clock.x) ? overlay.state.clock.x : (el.ovCanvas.width / 2);
        const cy = Number.isFinite(overlay.state.clock.y) ? overlay.state.clock.y : 8;
        dragDX = m.x - cx;
        dragDY = m.y - cy;
      }
    });
    function logoRect() {
      if (!overlay || !overlay.ctx) return null;
      const l = overlay.state.logo;
      if (!l.url || !overlay.state.logo.img) return null;
      const s = Math.max(20, Number(l.size) || 80);
      const iw = Number(l.img.naturalWidth || l.img.width || s) || s;
      const ih = Number(l.img.naturalHeight || l.img.height || s) || s;
      const ar = iw > 0 && ih > 0 ? (iw / ih) : 1;
      const w = Number.isFinite(l.width) ? Math.max(20, Number(l.width)) : Math.round(s * ar);
      const h = Number.isFinite(l.height) ? Math.max(20, Number(l.height)) : s;
      let x = 8, y = 8;
      if (l.pos === 'custom' && Number.isFinite(l.x) && Number.isFinite(l.y)) {
        x = Math.max(0, Math.min(el.ovCanvas.width - w, Number(l.x)));
        y = Math.max(0, Math.min(el.ovCanvas.height - h, Number(l.y)));
      } else {
        if (l.pos === 'tl') { x = 8; y = 8; }
        if (l.pos === 'tr') { x = el.ovCanvas.width - w - 8; y = 8; }
        if (l.pos === 'bl') { x = 8; y = el.ovCanvas.height - h - 8; }
        if (l.pos === 'br') { x = el.ovCanvas.width - w - 8; y = el.ovCanvas.height - h - 8; }
      }
      return { x, y, w, h };
    }
    el.ovCanvas.addEventListener('mousedown', (ev) => {
      const m = getMouse(ev);
      const lr = logoRect();
      if (lr) {
        const nearCorner = (Math.abs(m.x - (lr.x + lr.w)) <= 12) && (Math.abs(m.y - (lr.y + lr.h)) <= 12);
        const nearRight = (Math.abs(m.x - (lr.x + lr.w)) <= 8) && (m.y >= lr.y + 4) && (m.y <= lr.y + lr.h - 4);
        const nearBottom = (Math.abs(m.y - (lr.y + lr.h)) <= 8) && (m.x >= lr.x + 4) && (m.x <= lr.x + lr.w - 4);
        if (nearCorner) {
          resizingLogo = true;
          resizingLogoMode = 'corner';
        } else if (nearRight) {
          resizingLogo = true;
          resizingLogoMode = 'right';
        } else if (nearBottom) {
          resizingLogo = true;
          resizingLogoMode = 'bottom';
        } else if (m.x >= lr.x && m.x <= lr.x + lr.w && m.y >= lr.y && m.y <= lr.y + lr.h) {
          draggingLogo = true;
          logoDX = m.x - lr.x;
          logoDY = m.y - lr.y;
          overlay.updateLogo({ pos: 'custom', x: lr.x, y: lr.y });
          if (el.ovLogoPos) el.ovLogoPos.value = 'custom';
          updateLogoXYEnabled();
          if (el.ovLogoX) el.ovLogoX.value = String(lr.x);
          if (el.ovLogoY) el.ovLogoY.value = String(lr.y);
          maybePush();
        }
      }
    });
    window.addEventListener('mousemove', (ev) => {
      if (!draggingClock) return;
      const m = getMouse(ev);
      const cr = clockRect();
      const w = cr ? cr.w : 0;
      const h = cr ? cr.h : 0;
      let nx = m.x - dragDX;
      let ny = m.y - dragDY;
      const minX = w / 2;
      const maxX = el.ovCanvas.width - w / 2;
      const minY = 0;
      const maxY = el.ovCanvas.height - h;
      if (nx < minX) nx = minX;
      if (nx > maxX) nx = maxX;
      if (ny < minY) ny = minY;
      if (ny > maxY) ny = maxY;
      overlay.updateClock({ x: nx, y: ny });
      if (el.ovClockX) el.ovClockX.value = String(nx);
      if (el.ovClockY) el.ovClockY.value = String(ny);
      maybePush();
    });
    window.addEventListener('mousemove', (ev) => {
      const m = getMouse(ev);
      const lr = logoRect();
      if (draggingLogo && lr) {
        let nx = m.x - logoDX;
        let ny = m.y - logoDY;
        nx = Math.max(0, Math.min(el.ovCanvas.width - lr.w, nx));
        ny = Math.max(0, Math.min(el.ovCanvas.height - lr.h, ny));
        overlay.updateLogo({ pos: 'custom', x: nx, y: ny });
        if (el.ovLogoX) el.ovLogoX.value = String(nx);
        if (el.ovLogoY) el.ovLogoY.value = String(ny);
        maybePush();
      } else if (resizingLogo && lr) {
        const keepAspect = !!ev.shiftKey;
        let nx = Math.max(lr.x, Math.min(el.ovCanvas.width - 8, m.x));
        let ny = Math.max(lr.y, Math.min(el.ovCanvas.height - 8, m.y));
        let newW = Math.max(20, Math.min(el.ovCanvas.width - lr.x, nx - lr.x));
        let newH = Math.max(20, Math.min(el.ovCanvas.height - lr.y, ny - lr.y));
        if (resizingLogoMode === 'right') {
          overlay.updateLogo({ width: newW, pos: 'custom' });
          if (el.ovLogoPos) el.ovLogoPos.value = 'custom';
        } else if (resizingLogoMode === 'bottom') {
          overlay.updateLogo({ height: newH, pos: 'custom' });
          if (el.ovLogoPos) el.ovLogoPos.value = 'custom';
        } else {
          if (keepAspect && lr.h > 0) {
            const r = lr.w / lr.h;
            if ((nx - lr.x) / (ny - lr.y) > r) {
              newW = Math.round(newH * r);
            } else {
              newH = Math.round(newW / r);
            }
          }
          overlay.updateLogo({ width: newW, height: newH, pos: 'custom' });
          if (el.ovLogoPos) el.ovLogoPos.value = 'custom';
        }
        if (el.ovLogoSize) el.ovLogoSize.value = String(newH);
        maybePush();
      }
    });
    window.addEventListener('mouseup', () => { draggingClock = false; draggingLogo = false; resizingLogo = false; resizingLogoMode = null; });
    if (el.ovStart) {
      el.ovStart.addEventListener('click', (e) => {
        e.preventDefault();
        syncAll();
        overlay.start();
        setMsg('Overlay started', 'success');
      });
    }
    if (el.ovStop) {
      el.ovStop.addEventListener('click', (e) => {
        e.preventDefault();
        overlay.stop();
        overlay.clear();
        setMsg('Overlay stopped', 'warn');
      });
    }
    if (el.ovReset) {
      el.ovReset.addEventListener('click', (e) => {
        e.preventDefault();
        overlay.reset();
        if (el.ovWidth) el.ovWidth.value = String(overlay.state.width);
        if (el.ovHeight) el.ovHeight.value = String(overlay.state.height);
        if (el.ovScale) el.ovScale.value = String(overlay.state.scale);
        if (el.ovBg) el.ovBg.value = String(overlay.state.bg);
        if (el.ovBgOpa) el.ovBgOpa.value = String(overlay.state.bgOpa);
        if (el.ovTickerText) el.ovTickerText.value = String(overlay.state.ticker.text);
        if (el.ovTickerSpeed) el.ovTickerSpeed.value = String(overlay.state.ticker.speed);
        if (el.ovTickerFont) el.ovTickerFont.value = String(overlay.state.ticker.font);
        if (el.ovTickerSize) el.ovTickerSize.value = String(overlay.state.ticker.size);
        if (el.ovTickerBold) el.ovTickerBold.checked = !!overlay.state.ticker.bold;
        if (el.ovTickerColor) el.ovTickerColor.value = String(overlay.state.ticker.color);
        if (el.ovTickerPos) el.ovTickerPos.value = String(overlay.state.ticker.pos);
        if (el.ovTickerBgMode) el.ovTickerBgMode.value = String(overlay.state.ticker.bgMode);
        if (el.ovTickerY) el.ovTickerY.value = String(overlay.state.ticker.y ?? '');
        if (el.ovTickerBg) el.ovTickerBg.value = String(overlay.state.ticker.bg);
        if (el.ovTickerBg2) el.ovTickerBg2.value = String(overlay.state.ticker.bg2);
        if (el.ovTickerOpa) el.ovTickerOpa.value = String(overlay.state.ticker.opa);
        if (el.ovTickerBorderWidth) el.ovTickerBorderWidth.value = String(overlay.state.ticker.borderWidth);
        if (el.ovTickerBorderColor) el.ovTickerBorderColor.value = String(overlay.state.ticker.borderColor);
        if (el.ovTickerBorderOpa) el.ovTickerBorderOpa.value = String(overlay.state.ticker.borderOpa);
        if (el.ovTickerBorderRadius) el.ovTickerBorderRadius.value = String(overlay.state.ticker.borderRadius);
        if (el.ovNlShow) el.ovNlShow.checked = !!overlay.state.nowLive.show;
        if (el.ovNlText) el.ovNlText.value = String(overlay.state.nowLive.text);
        if (el.ovNlItems) el.ovNlItems.value = String(overlay.state.nowLive.items);
        if (el.ovNlPos) el.ovNlPos.value = String(overlay.state.nowLive.pos);
        if (el.ovNlY) el.ovNlY.value = String(overlay.state.nowLive.y);
        if (el.ovNlLabelBg) el.ovNlLabelBg.value = String(overlay.state.nowLive.labelBg);
        if (el.ovNlLabelOpa) el.ovNlLabelOpa.value = String(overlay.state.nowLive.labelOpa);
        if (el.ovNlLabelColor) el.ovNlLabelColor.value = String(overlay.state.nowLive.labelColor);
        if (el.ovNlItemColor) el.ovNlItemColor.value = String(overlay.state.nowLive.itemColor);
        if (el.ovNlLabelSize) el.ovNlLabelSize.value = String(overlay.state.nowLive.labelSize);
        if (el.ovNlItemSize) el.ovNlItemSize.value = String(overlay.state.nowLive.itemSize);
        if (el.ovNlAnim) el.ovNlAnim.value = String(overlay.state.nowLive.anim);
        if (el.ovClockEnable) el.ovClockEnable.checked = !!overlay.state.clock.enable;
        if (el.ovClockFormat) el.ovClockFormat.value = String(overlay.state.clock.format);
        if (el.ovClockDate) el.ovClockDate.checked = !!overlay.state.clock.showDate;
        if (el.ovClockColor) el.ovClockColor.value = String(overlay.state.clock.color);
        if (el.ovClockSize) el.ovClockSize.value = String(overlay.state.clock.size);
        if (el.ovClockX) el.ovClockX.value = String(overlay.state.clock.x);
        if (el.ovClockY) el.ovClockY.value = String(overlay.state.clock.y);
        if (el.ovClockFont) el.ovClockFont.value = String(overlay.state.clock.font);
        if (el.ovClockBold) el.ovClockBold.checked = !!overlay.state.clock.bold;
        if (el.ovClockBgEnable) el.ovClockBgEnable.checked = !!overlay.state.clock.bgEnable;
        if (el.ovClockBg) el.ovClockBg.value = String(overlay.state.clock.bgColor);
        if (el.ovClockBgOpa) el.ovClockBgOpa.value = String(overlay.state.clock.bgOpa);
        if (el.ovClockBgPad) el.ovClockBgPad.value = String(overlay.state.clock.bgPad);
        if (el.ovClockBgShape) el.ovClockBgShape.value = String(overlay.state.clock.bgShape);
        if (el.ovClockBgRadius) el.ovClockBgRadius.value = String(overlay.state.clock.bgRadius);
        if (el.ovLogoUrl) el.ovLogoUrl.value = String(overlay.state.logo.url);
        if (el.ovLogoPos) el.ovLogoPos.value = String(overlay.state.logo.pos);
        if (el.ovLogoX) el.ovLogoX.value = String(overlay.state.logo.x ?? '');
        if (el.ovLogoY) el.ovLogoY.value = String(overlay.state.logo.y ?? '');
        if (el.ovLogoSize) el.ovLogoSize.value = String(overlay.state.logo.size);
        if (el.ovLogoOpa) el.ovLogoOpa.value = String(overlay.state.logo.opa);
        if (el.ovLogoRotate) el.ovLogoRotate.value = String(overlay.state.logo.rotate || 0);
        if (el.ovLtTitle) el.ovLtTitle.value = String(overlay.state.lowerThird.title);
        if (el.ovLtSub) el.ovLtSub.value = String(overlay.state.lowerThird.sub);
        if (el.ovLtShow) el.ovLtShow.checked = !!overlay.state.lowerThird.show;
        if (el.ovScoreA) el.ovScoreA.value = String(overlay.state.scoreboard.a);
        if (el.ovScoreB) el.ovScoreB.value = String(overlay.state.scoreboard.b);
        if (el.ovScoreAVal) el.ovScoreAVal.value = String(overlay.state.scoreboard.aVal);
        if (el.ovScoreBVal) el.ovScoreBVal.value = String(overlay.state.scoreboard.bVal);
        if (el.ovBannerText) el.ovBannerText.value = String(overlay.state.banner.text);
        if (el.ovBannerShow) el.ovBannerShow.checked = !!overlay.state.banner.show;
        syncAll();
        setMsg('Reset', 'info');
      });
    }
    const presetKey = 'overlayPreset';
    if (el.ovSave) {
      el.ovSave.addEventListener('click', (e) => {
        e.preventDefault();
        const data = JSON.stringify(overlay.state);
        try { localStorage.setItem(presetKey, data); setMsg('Preset saved', 'success'); } catch (_) { setMsg('Save failed', 'error'); }
      });
    }
    if (el.ovLoad) {
      el.ovLoad.addEventListener('click', (e) => {
        e.preventDefault();
        try {
          const raw = localStorage.getItem(presetKey);
          if (!raw) { setMsg('No preset found', 'info'); return; }
          const st = JSON.parse(raw);
          overlay.update(st);
          overlay.updateTicker(st.ticker || {});
          overlay.updateClock(st.clock || {});
          overlay.updateNowLive(st.nowLive || {});
          overlay.updateLogo(st.logo || {});
          overlay.updateLowerThird(st.lowerThird || {});
          overlay.updateScoreboard(st.scoreboard || {});
          overlay.updateBanner(st.banner || {});
          if (el.ovWidth) el.ovWidth.value = String(st.width || overlay.state.width);
          if (el.ovHeight) el.ovHeight.value = String(st.height || overlay.state.height);
          if (el.ovScale) el.ovScale.value = String(st.scale || overlay.state.scale);
          if (el.ovBg) el.ovBg.value = String(st.bg || overlay.state.bg);
          if (el.ovBgOpa) el.ovBgOpa.value = String(st.bgOpa || overlay.state.bgOpa);
          if (el.ovTickerText) el.ovTickerText.value = String((st.ticker && st.ticker.text) || '');
          if (el.ovTickerSpeed) el.ovTickerSpeed.value = String((st.ticker && st.ticker.speed) || 120);
          if (el.ovTickerFont) el.ovTickerFont.value = String((st.ticker && st.ticker.font) || 'Segoe UI');
          if (el.ovTickerSize) el.ovTickerSize.value = String((st.ticker && st.ticker.size) || 24);
          if (el.ovTickerBold) el.ovTickerBold.checked = !!(st.ticker && st.ticker.bold);
          if (el.ovTickerColor) el.ovTickerColor.value = String((st.ticker && st.ticker.color) || '#ffffff');
          if (el.ovTickerPos) el.ovTickerPos.value = String((st.ticker && st.ticker.pos) || 'bottom');
          if (el.ovTickerBgMode) el.ovTickerBgMode.value = String((st.ticker && st.ticker.bgMode) || overlay.state.ticker.bgMode);
          if (el.ovTickerBg) el.ovTickerBg.value = String((st.ticker && st.ticker.bg) || '#000000');
          if (el.ovTickerBg2) el.ovTickerBg2.value = String((st.ticker && st.ticker.bg2) || overlay.state.ticker.bg2);
          if (el.ovTickerOpa) el.ovTickerOpa.value = String((st.ticker && st.ticker.opa) || 0.4);
          if (el.ovTickerBorderWidth) el.ovTickerBorderWidth.value = String((st.ticker && st.ticker.borderWidth) || overlay.state.ticker.borderWidth);
          if (el.ovTickerBorderColor) el.ovTickerBorderColor.value = String((st.ticker && st.ticker.borderColor) || overlay.state.ticker.borderColor);
          if (el.ovTickerBorderOpa) el.ovTickerBorderOpa.value = String((st.ticker && st.ticker.borderOpa) || overlay.state.ticker.borderOpa);
          if (el.ovTickerBorderRadius) el.ovTickerBorderRadius.value = String((st.ticker && st.ticker.borderRadius) || overlay.state.ticker.borderRadius);
          if (el.ovNlShow) el.ovNlShow.checked = !!(st.nowLive && st.nowLive.show);
          if (el.ovNlText) el.ovNlText.value = String((st.nowLive && st.nowLive.text) || overlay.state.nowLive.text);
          if (el.ovNlItems) el.ovNlItems.value = String((st.nowLive && st.nowLive.items) || overlay.state.nowLive.items);
          if (el.ovNlPos) el.ovNlPos.value = String((st.nowLive && st.nowLive.pos) || overlay.state.nowLive.pos);
          if (el.ovNlY) el.ovNlY.value = String((st.nowLive && st.nowLive.y) || overlay.state.nowLive.y);
          if (el.ovNlLabelBg) el.ovNlLabelBg.value = String((st.nowLive && st.nowLive.labelBg) || overlay.state.nowLive.labelBg);
          if (el.ovNlLabelOpa) el.ovNlLabelOpa.value = String((st.nowLive && st.nowLive.labelOpa) || overlay.state.nowLive.labelOpa);
          if (el.ovNlLabelColor) el.ovNlLabelColor.value = String((st.nowLive && st.nowLive.labelColor) || overlay.state.nowLive.labelColor);
          if (el.ovNlItemColor) el.ovNlItemColor.value = String((st.nowLive && st.nowLive.itemColor) || overlay.state.nowLive.itemColor);
          if (el.ovNlLabelSize) el.ovNlLabelSize.value = String((st.nowLive && st.nowLive.labelSize) || overlay.state.nowLive.labelSize);
          if (el.ovNlItemSize) el.ovNlItemSize.value = String((st.nowLive && st.nowLive.itemSize) || overlay.state.nowLive.itemSize);
          if (el.ovNlAnim) el.ovNlAnim.value = String((st.nowLive && st.nowLive.anim) || overlay.state.nowLive.anim);
        if (el.ovClockEnable) el.ovClockEnable.checked = !!(st.clock && st.clock.enable);
        if (el.ovClockFormat) el.ovClockFormat.value = String((st.clock && st.clock.format) || '24');
        if (el.ovClockDate) el.ovClockDate.checked = !!(st.clock && st.clock.showDate);
        if (el.ovClockSeconds) el.ovClockSeconds.checked = !!(st.clock && st.clock.showSeconds);
        if (el.ovClockColor) el.ovClockColor.value = String((st.clock && st.clock.color) || '#ffffff');
        if (el.ovClockSize) el.ovClockSize.value = String((st.clock && st.clock.size) || 20);
        if (el.ovClockX) el.ovClockX.value = String((st.clock && st.clock.x) || overlay.state.clock.x);
        if (el.ovClockY) el.ovClockY.value = String((st.clock && st.clock.y) || overlay.state.clock.y);
        if (el.ovClockFont) el.ovClockFont.value = String((st.clock && st.clock.font) || overlay.state.clock.font);
        if (el.ovClockBold) el.ovClockBold.checked = !!(st.clock && st.clock.bold);
        if (el.ovClockBgEnable) el.ovClockBgEnable.checked = !!(st.clock && st.clock.bgEnable);
        if (el.ovClockBg) el.ovClockBg.value = String((st.clock && st.clock.bgColor) || overlay.state.clock.bgColor);
        if (el.ovClockBgOpa) el.ovClockBgOpa.value = String((st.clock && st.clock.bgOpa) || overlay.state.clock.bgOpa);
        if (el.ovClockBgPad) el.ovClockBgPad.value = String((st.clock && st.clock.bgPad) || overlay.state.clock.bgPad);
        if (el.ovClockBgShape) el.ovClockBgShape.value = String((st.clock && st.clock.bgShape) || overlay.state.clock.bgShape);
        if (el.ovClockBgRadius) el.ovClockBgRadius.value = String((st.clock && st.clock.bgRadius) || overlay.state.clock.bgRadius);
        if (el.ovClockBorderWidth) el.ovClockBorderWidth.value = String((st.clock && st.clock.borderWidth) || overlay.state.clock.borderWidth);
        if (el.ovClockBorderColor) el.ovClockBorderColor.value = String((st.clock && st.clock.borderColor) || overlay.state.clock.borderColor);
        if (el.ovClockBorderOpa) el.ovClockBorderOpa.value = String((st.clock && st.clock.borderOpa) || overlay.state.clock.borderOpa);
        if (el.ovClockBorderRadius) el.ovClockBorderRadius.value = String((st.clock && st.clock.borderRadius) || overlay.state.clock.borderRadius);
          if (el.ovLogoUrl) el.ovLogoUrl.value = String((st.logo && st.logo.url) || '');
          if (el.ovLogoPos) el.ovLogoPos.value = String((st.logo && st.logo.pos) || 'tr');
          if (el.ovLogoX) el.ovLogoX.value = String((st.logo && st.logo.x) ?? '');
          if (el.ovLogoY) el.ovLogoY.value = String((st.logo && st.logo.y) ?? '');
          if (el.ovLogoSize) el.ovLogoSize.value = String((st.logo && st.logo.size) || 80);
          if (el.ovLogoOpa) el.ovLogoOpa.value = String((st.logo && st.logo.opa) || 0.8);
          if (el.ovLogoRotate) el.ovLogoRotate.value = String((st.logo && st.logo.rotate) || 0);
          if (el.ovLtTitle) el.ovLtTitle.value = String((st.lowerThird && st.lowerThird.title) || '');
          if (el.ovLtSub) el.ovLtSub.value = String((st.lowerThird && st.lowerThird.sub) || '');
          if (el.ovLtShow) el.ovLtShow.checked = !!(st.lowerThird && st.lowerThird.show);
          if (el.ovScoreA) el.ovScoreA.value = String((st.scoreboard && st.scoreboard.a) || '');
          if (el.ovScoreB) el.ovScoreB.value = String((st.scoreboard && st.scoreboard.b) || '');
          if (el.ovScoreAVal) el.ovScoreAVal.value = String((st.scoreboard && st.scoreboard.aVal) || 0);
          if (el.ovScoreBVal) el.ovScoreBVal.value = String((st.scoreboard && st.scoreboard.bVal) || 0);
          if (el.ovBannerText) el.ovBannerText.value = String((st.banner && st.banner.text) || '');
          if (el.ovBannerShow) el.ovBannerShow.checked = !!(st.banner && st.banner.show);
          syncAll();
          setMsg('Preset loaded', 'success');
        } catch (_) {
          setMsg('Load failed', 'error');
        }
      });
    }

    const targetId = () => el.ovTarget?.value || '';
    const setConn = (text) => { if (el.ovConnStatus) el.ovConnStatus.textContent = text || ''; };
    const disconnect = () => {
      if (ovEventSource) { try { ovEventSource.close(); } catch (_) {} ovEventSource = null; }
      setConn('Disconnected');
      if (el.ovConnect) el.ovConnect.innerHTML = '<i class="fa-solid fa-plug"></i> Connect';
    };
    const connect = () => {
      disconnect();
      const id = targetId();
      if (!id) { setMsg('Select a target', 'error'); return; }
      const url = id === 'live' ? `${API_URL}/videos/overlay/live/sse` : `${API_URL}/videos/${id}/overlay/sse`;
      try {
        ovEventSource = new EventSource(url, { withCredentials: true });
        ovEventSource.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data || '{}');
            sseUpdating = true;
            overlay.update(data || {});
            overlay.updateTicker((data && data.ticker) || {});
            overlay.updateClock((data && data.clock) || {});
            overlay.updateNowLive((data && data.nowLive) || {});
            overlay.updateLogo((data && data.logo) || {});
            overlay.updateLowerThird((data && data.lowerThird) || {});
            overlay.updateScoreboard((data && data.scoreboard) || {});
            overlay.updateBanner((data && data.banner) || {});
            if (el.ovWidth && data.width) el.ovWidth.value = String(data.width);
            if (el.ovHeight && data.height) el.ovHeight.value = String(data.height);
            if (el.ovScale && data.scale) el.ovScale.value = String(data.scale);
            if (el.ovBg && data.bg) el.ovBg.value = String(data.bg);
            if (el.ovBgOpa && typeof data.bgOpa !== 'undefined') el.ovBgOpa.value = String(data.bgOpa);
            if (el.ovTickerText && data.ticker && typeof data.ticker.text === 'string') el.ovTickerText.value = String(data.ticker.text);
            if (el.ovTickerSpeed && data.ticker && typeof data.ticker.speed !== 'undefined') el.ovTickerSpeed.value = String(data.ticker.speed);
            if (el.ovTickerFont && data.ticker && typeof data.ticker.font === 'string') el.ovTickerFont.value = String(data.ticker.font);
            if (el.ovTickerSize && data.ticker && typeof data.ticker.size !== 'undefined') el.ovTickerSize.value = String(data.ticker.size);
            if (el.ovTickerBold && data.ticker && typeof data.ticker.bold !== 'undefined') el.ovTickerBold.checked = !!data.ticker.bold;
            if (el.ovTickerColor && data.ticker && typeof data.ticker.color === 'string') el.ovTickerColor.value = String(data.ticker.color);
            if (el.ovTickerPos && data.ticker && typeof data.ticker.pos === 'string') el.ovTickerPos.value = String(data.ticker.pos);
            if (el.ovTickerBgMode && data.ticker && typeof data.ticker.bgMode === 'string') el.ovTickerBgMode.value = String(data.ticker.bgMode);
            if (el.ovTickerBg && data.ticker && typeof data.ticker.bg === 'string') el.ovTickerBg.value = String(data.ticker.bg);
            if (el.ovTickerBg2 && data.ticker && typeof data.ticker.bg2 === 'string') el.ovTickerBg2.value = String(data.ticker.bg2);
            if (el.ovTickerBorderWidth && data.ticker && typeof data.ticker.borderWidth !== 'undefined') el.ovTickerBorderWidth.value = String(data.ticker.borderWidth);
            if (el.ovTickerBorderColor && data.ticker && typeof data.ticker.borderColor === 'string') el.ovTickerBorderColor.value = String(data.ticker.borderColor);
            if (el.ovTickerBorderOpa && data.ticker && typeof data.ticker.borderOpa !== 'undefined') el.ovTickerBorderOpa.value = String(data.ticker.borderOpa);
            if (el.ovTickerBorderRadius && data.ticker && typeof data.ticker.borderRadius !== 'undefined') el.ovTickerBorderRadius.value = String(data.ticker.borderRadius);
            if (el.ovTickerOpa && data.ticker && typeof data.ticker.opa !== 'undefined') el.ovTickerOpa.value = String(data.ticker.opa);
            if (el.ovClockEnable && data.clock && typeof data.clock.enable !== 'undefined') el.ovClockEnable.checked = !!data.clock.enable;
            if (el.ovClockFormat && data.clock && typeof data.clock.format === 'string') el.ovClockFormat.value = String(data.clock.format);
            if (el.ovClockDate && data.clock && typeof data.clock.showDate !== 'undefined') el.ovClockDate.checked = !!data.clock.showDate;
            if (el.ovClockColor && data.clock && typeof data.clock.color === 'string') el.ovClockColor.value = String(data.clock.color);
            if (el.ovClockSeconds && data.clock && typeof data.clock.showSeconds !== 'undefined') el.ovClockSeconds.checked = !!data.clock.showSeconds;
            if (el.ovClockSize && data.clock && typeof data.clock.size !== 'undefined') el.ovClockSize.value = String(data.clock.size);
            if (el.ovClockX && data.clock && typeof data.clock.x !== 'undefined') el.ovClockX.value = String(data.clock.x);
            if (el.ovClockY && data.clock && typeof data.clock.y !== 'undefined') el.ovClockY.value = String(data.clock.y);
            if (el.ovClockFont && data.clock && typeof data.clock.font === 'string') el.ovClockFont.value = String(data.clock.font);
            if (el.ovClockBold && data.clock && typeof data.clock.bold !== 'undefined') el.ovClockBold.checked = !!data.clock.bold;
            if (el.ovClockBgEnable && data.clock && typeof data.clock.bgEnable !== 'undefined') el.ovClockBgEnable.checked = !!data.clock.bgEnable;
            if (el.ovClockBg && data.clock && typeof data.clock.bgColor === 'string') el.ovClockBg.value = String(data.clock.bgColor);
            if (el.ovClockBgOpa && data.clock && typeof data.clock.bgOpa !== 'undefined') el.ovClockBgOpa.value = String(data.clock.bgOpa);
            if (el.ovClockBgPad && data.clock && typeof data.clock.bgPad !== 'undefined') el.ovClockBgPad.value = String(data.clock.bgPad);
            if (el.ovClockBgShape && data.clock && typeof data.clock.bgShape === 'string') el.ovClockBgShape.value = String(data.clock.bgShape);
            if (el.ovClockBgRadius && data.clock && typeof data.clock.bgRadius !== 'undefined') el.ovClockBgRadius.value = String(data.clock.bgRadius);
            if (el.ovClockBorderWidth && data.clock && typeof data.clock.borderWidth !== 'undefined') el.ovClockBorderWidth.value = String(data.clock.borderWidth);
            if (el.ovClockBorderColor && data.clock && typeof data.clock.borderColor === 'string') el.ovClockBorderColor.value = String(data.clock.borderColor);
            if (el.ovClockBorderOpa && data.clock && typeof data.clock.borderOpa !== 'undefined') el.ovClockBorderOpa.value = String(data.clock.borderOpa);
            if (el.ovClockBorderRadius && data.clock && typeof data.clock.borderRadius !== 'undefined') el.ovClockBorderRadius.value = String(data.clock.borderRadius);
            if (el.ovLogoUrl && data.logo && typeof data.logo.url === 'string') el.ovLogoUrl.value = String(data.logo.url);
            if (el.ovLogoPos && data.logo && typeof data.logo.pos === 'string') el.ovLogoPos.value = String(data.logo.pos);
            if (el.ovLogoX && data.logo && typeof data.logo.x !== 'undefined') el.ovLogoX.value = String(data.logo.x ?? '');
            if (el.ovLogoY && data.logo && typeof data.logo.y !== 'undefined') el.ovLogoY.value = String(data.logo.y ?? '');
            if (el.ovLogoSize && data.logo && typeof data.logo.size !== 'undefined') el.ovLogoSize.value = String(data.logo.size);
            if (el.ovLogoOpa && data.logo && typeof data.logo.opa !== 'undefined') el.ovLogoOpa.value = String(data.logo.opa);
            if (el.ovLogoRotate && data.logo && typeof data.logo.rotate !== 'undefined') el.ovLogoRotate.value = String(data.logo.rotate);
            if (el.ovLtTitle && data.lowerThird && typeof data.lowerThird.title === 'string') el.ovLtTitle.value = String(data.lowerThird.title);
            if (el.ovLtSub && data.lowerThird && typeof data.lowerThird.sub === 'string') el.ovLtSub.value = String(data.lowerThird.sub);
            if (el.ovLtShow && data.lowerThird && typeof data.lowerThird.show !== 'undefined') el.ovLtShow.checked = !!data.lowerThird.show;
            if (el.ovScoreA && data.scoreboard && typeof data.scoreboard.a === 'string') el.ovScoreA.value = String(data.scoreboard.a);
            if (el.ovScoreB && data.scoreboard && typeof data.scoreboard.b === 'string') el.ovScoreB.value = String(data.scoreboard.b);
            if (el.ovScoreAVal && data.scoreboard && typeof data.scoreboard.aVal !== 'undefined') el.ovScoreAVal.value = String(data.scoreboard.aVal);
            if (el.ovScoreBVal && data.scoreboard && typeof data.scoreboard.bVal !== 'undefined') el.ovScoreBVal.value = String(data.scoreboard.bVal);
            if (el.ovBannerText && data.banner && typeof data.banner.text === 'string') el.ovBannerText.value = String(data.banner.text);
            if (el.ovBannerShow && data.banner && typeof data.banner.show !== 'undefined') el.ovBannerShow.checked = !!data.banner.show;
            sseUpdating = false;
            setConn('Connected');
          } catch (_) {}
        };
        ovEventSource.onerror = () => { setConn('Disconnected'); };
        if (el.ovConnect) el.ovConnect.innerHTML = '<i class="fa-solid fa-plug-circle-xmark"></i> Disconnect';
        setConn('Connected');
        setMsg('Connected to target overlay', 'success');
      } catch (e) {
        setConn('Failed');
        setMsg('Failed to connect', 'error');
      }
    };
    const pushNow = async () => {
      const id = targetId();
      if (!id) return;
      if (sseUpdating) return;
      try {
        const path = id === 'live' ? `${API_URL}/videos/overlay/live` : `${API_URL}/videos/${id}/overlay`;
        await fetchJSON(path, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(overlay.state),
        });
        setConn('Synced');
      } catch (_) {
        setConn('Sync error');
      }
    };
    const maybePush = () => {
      if (!el.ovTarget || !el.ovTarget.value) return;
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = setTimeout(pushNow, 200);
    };
    if (el.ovConnect) {
      el.ovConnect.addEventListener('click', (e) => {
        e.preventDefault();
        if (ovEventSource) return disconnect();
        connect();
      });
    }
    if (el.ovTarget) {
      el.ovTarget.addEventListener('change', () => {
        disconnect();
        setConn('');
      });
    }
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

  async function initMain() {
    setupNavigation();
    setupUpload();
    setupLibraryUpload();
    setupPlaylistForm();
    setupUrlStreamForm();
    setupSavedKeysUI();
    setupOverlayStudio();
    setupActiveActions();
    setupFilters();
    setupCardActions();
    Promise.all([loadHealth(), loadVideos(), loadPlaylists(), loadActiveStreams()]).catch(() => {});
    loadSavedKeys().catch(() => {});
    startAutoRefresh();
  }
  async function init() {
    setBusy(true);
    try {
      setupTheme();
      await loadHealth();
      const authed = await isAuthed();
      if (!authed) {
        window.location.href = '/login';
        return;
      } else {
        setupLogin();
        setAuthState(true);
        ensureIconStyles();
        await initMain();
      }
    } catch (err) {
      console.error(`[UI] Init error: ${err && err.message ? err.message : err}`);
      showToast('Initialization error. Some features may be limited.', 'error');
    } finally {
      setBusy(false);
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
