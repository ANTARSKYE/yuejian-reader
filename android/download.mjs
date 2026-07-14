import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const [url, destination] = process.argv.slice(2);
if (!url || !destination) process.exit(2);

function download(address, redirects = 0) {
  if (redirects > 8) throw new Error('Too many redirects');
  const client = address.startsWith('https:') ? https : http;
  client.get(address, { headers: { 'User-Agent': 'Yuejian-Android-Builder/1.0' } }, response => {
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
      response.resume();
      return download(new URL(response.headers.location, address).href, redirects + 1);
    }
    if (response.statusCode !== 200) throw new Error(`HTTP ${response.statusCode}`);
    const stream = fs.createWriteStream(destination);
    response.pipe(stream);
    stream.on('finish', () => stream.close());
    stream.on('error', error => { fs.rmSync(destination, { force: true }); throw error; });
  }).on('error', error => { console.error(error); process.exit(1); });
}
download(url);
