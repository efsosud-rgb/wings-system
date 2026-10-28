// Fake SMTP server for the E2E run: accepts any login, delivers nothing, and writes each
// message to <dir>/<n>.eml so the flows can read invite and reset links.
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';

export function startSmtpSink(dir, port) {
  let count = 0;
  const server = createServer((socket) => {
    let buffer = '';
    let mode = 'cmd'; // cmd | data | auth-login-user | auth-login-pass | auth-plain
    let message = [];
    const say = (line) => socket.write(`${line}\r\n`);
    say('220 sink.e2e.invalid ESMTP');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let at;
      while ((at = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (mode === 'data') {
          if (line === '.') {
            count += 1;
            writeFileSync(`${dir}/${String(count).padStart(3, '0')}.eml`, message.join('\n'));
            message = [];
            mode = 'cmd';
            say('250 OK queued');
          } else message.push(line.startsWith('..') ? line.slice(1) : line);
          continue;
        }
        if (mode === 'auth-login-user') {
          mode = 'auth-login-pass';
          say('334 UGFzc3dvcmQ6');
          continue;
        }
        if (mode === 'auth-login-pass' || mode === 'auth-plain') {
          mode = 'cmd';
          say('235 OK');
          continue;
        }
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO') {
          say('250-sink.e2e.invalid');
          say('250-AUTH PLAIN LOGIN');
          say('250 8BITMIME');
        } else if (verb === 'HELO') say('250 sink.e2e.invalid');
        else if (verb === 'AUTH') {
          const [, kind, initial] = line.split(' ');
          if (kind?.toUpperCase() === 'LOGIN') {
            mode = 'auth-login-user';
            say('334 VXNlcm5hbWU6');
          } else if (initial) say('235 OK');
          else {
            mode = 'auth-plain';
            say('334 ');
          }
        } else if (verb === 'DATA') {
          mode = 'data';
          say('354 End with <CRLF>.<CRLF>');
        } else if (verb === 'QUIT') {
          say('221 Bye');
          socket.end();
        } else say('250 OK');
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
