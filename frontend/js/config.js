/**
 * Environment-specific frontend configuration
 * Auto-detects production vs development and exposes useful constants.
 *
 * Usage: window.CONFIG.API_URL (alias: API_BASE)
 */
(function () {
  const explicitEnv = window.CONFIG_ENV; // optional override: 'development' | 'production'
  const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname) || window.location.protocol === 'file:';
  const ENV = explicitEnv || (isLocal ? 'development' : 'production');

  // API base: always use same-origin '/api'.
  // The dev preview server proxies '/api' to backend at localhost:3000.
  const API_URL = `${window.location.origin}/api`;

  /** @type {Intl.DateTimeFormatOptions} */
  const DATE_FORMAT = {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  };

  window.CONFIG = {
    ENV,
    IS_DEV: ENV === 'development',
    API_URL,
    API_BASE: API_URL, // alias for backward compatibility
    REFRESH_INTERVAL: 10_000,
    MAX_FILE_SIZE: 5 * 1024 * 1024 * 1024, // 5GB
    ALLOWED_FORMATS: ['mp4', 'avi', 'mov', 'mkv', 'flv'],
    DEFAULT_RTMP_URL: 'rtmp://a.rtmp.youtube.com/live2',
    DATE_FORMAT,
    YOUTUBE_HELP_URL: 'https://support.google.com/youtube/answer/2474026',
  };
})();