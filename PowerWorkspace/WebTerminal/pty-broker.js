'use strict';

// One lightweight node-pty broker is shared by every terminal pane. Keeping
// the protocol on stdout means the WPF process needs no local socket or port.
const readline = require('readline');
const pty = require('./node_modules/node-pty');

const sessions = new Map();

function send(message) {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch (_) { }
}

function stopSession(id) {
  const terminal = sessions.get(id);
  if (!terminal) return;
  sessions.delete(id);
  try { terminal.kill(); } catch (_) { }
}

function stopAll() {
  for (const id of [...sessions.keys()]) stopSession(id);
}

function startSession(message) {
  const id = String(message.id || '');
  if (!id || sessions.has(id)) {
    send({ type: 'error', id, message: 'Invalid or duplicate terminal session.' });
    return;
  }

  try {
    const terminal = pty.spawn(message.file, Array.isArray(message.args) ? message.args : [], {
      name: 'xterm-256color',
      cols: Math.max(2, Number(message.columns) || 80),
      rows: Math.max(1, Number(message.rows) || 30),
      cwd: message.cwd || process.cwd(),
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        TERM_PROGRAM: 'IHATECODING'
      },
      useConpty: true
    });

    sessions.set(id, terminal);
    terminal.onData(data => send({ type: 'output', id, data }));
    terminal.onExit(event => {
      sessions.delete(id);
      send({
        type: 'exit',
        id,
        exitCode: Number(event.exitCode) || 0,
        signal: Number(event.signal) || 0
      });
    });
    send({ type: 'started', id, pid: terminal.pid });
  } catch (error) {
    send({ type: 'error', id, message: error && error.message ? error.message : String(error) });
  }
}

function handle(message) {
  const id = String(message.id || '');
  const terminal = sessions.get(id);
  switch (message.type) {
    case 'start':
      startSession(message);
      break;
    case 'input':
      if (terminal && typeof message.data === 'string') terminal.write(message.data);
      break;
    case 'resize':
      if (terminal) {
        try {
          terminal.resize(
            Math.max(2, Number(message.columns) || 80),
            Math.max(1, Number(message.rows) || 30));
        } catch (_) { }
      }
      break;
    case 'kill':
      stopSession(id);
      break;
    case 'shutdown':
      stopAll();
      process.exit(0);
      break;
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  try { handle(JSON.parse(line)); }
  catch (error) { send({ type: 'error', id: '', message: `Invalid broker message: ${error.message}` }); }
});
input.on('close', () => {
  stopAll();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopAll();
  process.exit(0);
});
process.on('uncaughtException', error => {
  send({ type: 'fatal', message: error && error.stack ? error.stack : String(error) });
  stopAll();
  process.exit(1);
});

send({ type: 'broker-ready' });
