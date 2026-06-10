/**
 * Minimal PLC broker hub for local testing without chamber hardware.
 *
 * On the real rig the PLC device runs a Socket.IO server at :4000 that every
 * party connects to (the stack-control "brain" and the UI client). It acts as a
 * dumb relay: whatever one client emits is rebroadcast to the others. This script
 * reproduces only that relay role so stack-control (in demoMode) can drive the UI
 * end to end.
 *
 *   node tools/plc_hub.js            # listens on 0.0.0.0:4000
 *   node tools/plc_hub.js --port 4000
 */
const { Server } = require('socket.io');

const portArg = process.argv.indexOf('--port');
const PORT = portArg !== -1 ? Number(process.argv[portArg + 1]) : 4000;

const io = new Server(PORT, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  console.log(`[hub] connect ${socket.id} (clients: ${io.engine.clientsCount})`);

  // Relay every inbound event to all OTHER connected clients.
  socket.onAny((event, ...args) => {
    if (event !== 'sensorData') console.log(`[hub] relay '${event}' from ${socket.id}`);
    socket.broadcast.emit(event, ...args);
  });

  socket.on('disconnect', () => {
    console.log(`[hub] disconnect ${socket.id} (clients: ${io.engine.clientsCount})`);
  });
});

console.log(`[hub] PLC relay hub listening on :${PORT} — Ctrl+C to stop`);
