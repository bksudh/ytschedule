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
    SCHEDULED: 'scheduled',
    STREAMING: 'streaming',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
  });

  /** State */
  let videos = [];
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
    grid: document.getElementById('videos-grid'),
    empty: document.getElementById('empty-state'),
    listLegacy: document.getElementById('videos-list'),
    filters: document.getElementById('filter-buttons'),
    search: document.getElementById('search-input'),
    form: document.getElementById('upload-form'),
    message: document.getElementById('message'),
    progress: document.getElementById('upload-progress'),
    progressBar: document.getElementById('upload-progress-bar'),
    spinner: document.getElementById('global-spinner'),
  };

  /** Utilities */
  /**
   * Fetch JSON with error handling
   * @param {string} url
   * @param {RequestInit} [options]
   * @returns {Promise<any>}
   */
  async function fetchJSON(url, options) {
    const res = await fetch(url, options);
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
      [STATUS.SCHEDULED]: { cls: 'badge badge--scheduled', icon: 'fa-regular fa-clock', label: 'Scheduled' },
      [STATUS.STREAMING]: { cls: 'badge badge--streaming', icon: 'fa-solid fa-signal', label: 'Streaming' },
      [STATUS.COMPLETED]: { cls: 'badge badge--completed', icon: 'fa-regular fa-circle-check', label: 'Completed' },
      [STATUS.FAILED]: { cls: 'badge badge--failed', icon: 'fa-regular fa-circle-xmark', label: 'Failed' },
      [STATUS.CANCELLED]: { cls: 'badge badge--failed', icon: 'fa-regular fa-circle-stop', label: 'Cancelled' },
    };
    const m = map[status] || map[STATUS.SCHEDULED];
    return `<span class="${m.cls}"><i class="${m.icon}"></i>${m.label}</span>`;
  }

  /** Create a card element for a video */
  function createVideoCard(video) {
    const id = video._id;
    const scheduled = video.scheduleTime || video.scheduledAt;
    const errorMsg = video.errorMessage;
    const progress = typeof video.progress === 'number' ? video.progress : 0;
    const status = video.status;
    const canStart = status === STATUS.SCHEDULED;
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
          ${canStop ? `<button class="btn warning" data-action="stop" data-id="${id}"><i class="fa-solid fa-stop"></i> Stop</button>` : ''}
          <button class="btn" data-action="edit" data-id="${id}"><i class="fa-regular fa-pen-to-square"></i> Edit</button>
          ${canDelete ? `<button class="btn danger" data-action="delete" data-id="${id}"><i class="fa-regular fa-trash-can"></i> Delete</button>` : ''}
        </div>
      </div>
      <div class="card-body" style="margin-top:12px;display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div>
          <div><strong>Scheduled:</strong> ${fmtDate(scheduled)}</div>
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
      el.grid.setAttribute('aria-busy', 'false');
    } catch (err) {
      showToast(`Unable to load videos: ${err.message}`, 'error');
      el.empty.hidden = false;
      el.empty.querySelector('p')?.replaceChildren(document.createTextNode('Unable to load videos (database may be disconnected).'));
    }
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
      const rtmpInput = el.form.querySelector('input[name="rtmpUrl"]');
      const keyInput = el.form.querySelector('input[name="streamKey"]');

      const file = fileInput?.files?.[0];
      const title = titleInput?.value?.trim();
      const scheduleTime = schedInput?.value;
      const rtmpUrl = rtmpInput?.value?.trim();
      const streamKey = keyInput?.value?.trim();

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

      const submitBtn = el.form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      submitBtn.classList.add('loading');

      const fd = new FormData();
      fd.append('title', title);
      // Backend expects /upload with field name 'video' and 'scheduleTime'
      fd.append('video', file, file.name);
      fd.append('scheduleTime', new Date(scheduleTime).toISOString());
      fd.append('rtmpUrl', rtmpUrl);
      fd.append('streamKey', streamKey);

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
      showToast(`Failed to start: ${err.message}`, 'error');
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
        <div class="form-row"><label>RTMP URL<input type="text" id="edit-rtmp" value="${escapeHtml(video.rtmpUrl || '')}"></label></div>
        <div class="form-row"><label>Stream Key<input type="password" id="edit-key" value="${escapeHtml(video.streamKey || '')}"></label></div>
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
      if (!title) { showToast('Title is required', 'error'); return; }
      if (!schedule) { showToast('Schedule is required', 'error'); return; }
      if (!rtmp) { showToast('RTMP URL is required', 'error'); return; }
      if (!key || key.length < 16) { showToast('Stream key must be >= 16 chars', 'error'); return; }
      try {
        const body = { title, scheduleTime: new Date(schedule).toISOString(), rtmpUrl: rtmp, streamKey: key };
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
        currentFilter = status;
        Array.from(el.filters.querySelectorAll('button.filter')).forEach(btn => btn.classList.toggle('active', btn === b));
        loadVideos();
      });
    }
    if (el.search) {
      const handler = debounce(() => { searchTerm = el.search.value || ''; loadVideos(); }, 300);
      el.search.addEventListener('input', handler);
    }
  }

  /** Auto-refresh every 10s */
  function startAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(async () => {
      if (isRefreshing) return;
      isRefreshing = true;
      try { await loadVideos(); } finally { isRefreshing = false; }
    }, REFRESH_INTERVAL_MS);
  }

  /** Init */
  async function init() {
    setBusy(true);
    try {
      setupUpload();
      setupFilters();
      setupCardActions();
      // Load health and videos in parallel to avoid long perceived buffering
      await Promise.all([loadHealth(), loadVideos()]);
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