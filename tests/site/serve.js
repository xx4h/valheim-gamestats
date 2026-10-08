// The page as nginx serves it, for the tests: site/ and the data in pieces as the collector writes them (index.json +
// c/, made from fixture/data.json by collector/chunks.py into CHUNKS before the tests start). Icons, terrain and Steam
// images aren't there — the page has to cope without them.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'site');
const CHUNKS = process.env.CHUNKS || path.join(__dirname, '.chunks');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.json': 'application/json' };

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file;
  if (url === '/index.json' || url.startsWith('/c/')) file = path.join(CHUNKS, path.normalize(url));
  else file = path.join(ROOT, url === '/' ? 'index.html' : path.normalize(url));
  if (!file.startsWith(ROOT) && !file.startsWith(CHUNKS)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404).end(); return; }
    const cache = url.startsWith('/c/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': cache }).end(body);
  });
}).listen(Number(process.env.PORT) || 8765, '127.0.0.1');
