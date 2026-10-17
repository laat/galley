// One live-update connection shared by every galley tab.
//
// Browsers allow six HTTP/1.1 connections per host. A long-lived EventSource per tab
// used them up, after which new pages queued forever. This SharedWorker holds the only
// stream and forwards each event to all tabs, which filter for their own pull request.
'use strict';

const ports = new Set();
let source = null;
let lost = false;

function broadcast(message) {
  for (const port of ports) port.postMessage(message);
}

function connect() {
  source = new EventSource('/events');
  // Every message the server sends ({ type, event }) goes to the tabs as it is, so a new kind
  // of message needs no new worker.
  source.addEventListener('message', (e) => broadcast(JSON.parse(e.data)));
  source.addEventListener('open', () => {
    // Events sent while the server was away are gone; let the tabs catch up.
    if (lost) broadcast({ type: 'reconnected' });
    lost = false;
  });
  source.addEventListener('error', () => {
    lost = true;
  });
}

self.addEventListener('connect', (e) => {
  const port = e.ports[0];
  ports.add(port);
  port.addEventListener('message', (m) => {
    if (m.data === 'bye') ports.delete(port);
  });
  port.start();
  if (!source) connect();
});
