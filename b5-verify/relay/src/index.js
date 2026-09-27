import { loadConfig } from './config.js';
import { createDeviceRelay } from './device-relay.js';
import { createRelayServer } from './server.js';
import { createSupabaseCommandBus } from './supabase-command-bus.js';

const config = loadConfig(process.env);
const deviceRelay = createDeviceRelay(config);
const commandBus = createSupabaseCommandBus({ config, deviceRelay });
const server = createRelayServer(config, deviceRelay, commandBus);

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
