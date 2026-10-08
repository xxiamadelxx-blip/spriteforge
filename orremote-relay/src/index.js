import { loadConfig } from './config.js';
import { createDeviceRelay } from './device-relay.js';
import { createRelayServer } from './server.js';
import { createSupabaseCommandBus } from './supabase-command-bus.js';

const config = loadConfig(process.env);
const deviceRelay = createDeviceRelay(config);
const commandBus = createSupabaseCommandBus({ config, deviceRelay });
const server = createRelayServer(config, deviceRelay, commandBus);

// A persisted grant-denial journal must hydrate before the public listener
// accepts even read-only OAuth requests. An outage fails startup closed.
await server.initializeOAuthRevocations();
commandBus.start();

server.listen(config.port, config.host, () => {
  console.log(`Ø Remote relay listening on ${config.host}:${config.port}`);
});

function shutdown() {
  commandBus.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
