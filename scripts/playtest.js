#!/usr/bin/env node
const { spawn } = require('child_process');
const http = require('http');

const PORT = 3001;

const server = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'inherit',
});

const ngrok = spawn('ngrok', ['http', String(PORT)], { stdio: 'ignore' });

function fetchUrl(retries = 20) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      http.get('http://localhost:4040/api/tunnels', (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try {
            const tunnels = JSON.parse(data).tunnels;
            const tunnel = tunnels.find(t => t.proto === 'https');
            if (tunnel) { resolve(tunnel.public_url); return; }
          } catch {}
          if (--retries > 0) setTimeout(attempt, 600);
          else reject(new Error('ngrok tunnel not found'));
        });
      }).on('error', () => {
        if (--retries > 0) setTimeout(attempt, 600);
        else reject(new Error('ngrok API not reachable'));
      });
    };
    setTimeout(attempt, 1000);
  });
}

fetchUrl()
  .then(url => {
    const line = '─'.repeat(url.length + 4);
    console.log(`\n\x1b[33m┌${line}┐\x1b[0m`);
    console.log(`\x1b[33m│  ${url}  │\x1b[0m`);
    console.log(`\x1b[33m└${line}┘\x1b[0m`);
    console.log('\x1b[2m  Send that URL to your friends\x1b[0m\n');
  })
  .catch(err => console.error('\x1b[31mCould not get ngrok URL:\x1b[0m', err.message));

function shutdown() {
  server.kill();
  ngrok.kill();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
