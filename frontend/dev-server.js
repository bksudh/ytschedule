const http = require('http');
const fs = require('fs');
const path = require('path');

const publicDir = __dirname;
// Support port from CLI arg `--port <num>` or env `PORT`
const argPortIdx = process.argv.indexOf('--port');
const argPort = (argPortIdx !== -1 && process.argv[argPortIdx + 1]) ? Number(process.argv[argPortIdx + 1]) : null;
const port = (Number.isFinite(argPort) && argPort > 0 ? argPort : (Number(process.env.PORT) || 5173));
// Allow overriding backend target port via env or CLI (--backend <port>)
const argBackendIdx = process.argv.indexOf('--backend');
const argBackend = (argBackendIdx !== -1 && process.argv[argBackendIdx + 1]) ? Number(process.argv[argBackendIdx + 1]) : null;
const backendPort = (Number.isFinite(argBackend) && argBackend > 0 ? argBackend : (Number(process.env.BACKEND_PORT) || 3000));
console.log('[DevServer] argv:', process.argv);
console.log('[DevServer] using port:', port);
console.log('[DevServer] proxying /api to backend port:', backendPort);

const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  // Simple proxy for API calls to backend on localhost:3000
  if (urlPath.startsWith('/api/')) {
    const targetHost = 'localhost';
    const targetPort = backendPort;
    const options = {
      hostname: targetHost,
      port: targetPort,
      // Preserve query string for API requests
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: `${targetHost}:${targetPort}`,
      },
    };
    const proxyReq = http.request(options, (proxyRes) => {
      res.statusCode = proxyRes.statusCode || 500;
      Object.entries(proxyRes.headers || {}).forEach(([k, v]) => {
        if (v !== undefined) res.setHeader(k, v);
      });
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (err) => {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Proxy error', message: err.message }));
    });
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      req.pipe(proxyReq);
    } else {
      proxyReq.end();
    }
    return;
  }

  let filePath = path.join(publicDir, urlPath);

  if (urlPath === '/' || urlPath === '') {
    filePath = path.join(publicDir, 'index.html');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(port, () => {
  console.log(`Preview server running at http://localhost:${port}/`);
});
