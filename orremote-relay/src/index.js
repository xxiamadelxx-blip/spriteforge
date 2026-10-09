import { loadConfig } from './config.js';
import { createDeviceRelay } from './device-relay.js';
import { createRelayServer } from './server.js';
import { createSupabaseCommandBus } from './supabase-command-bus.js';

const config = loadConfig(process.env);
const deviceRelay = createDeviceRelay(config);
const commandBus = createSupabaseCommandBus({ config, deviceRelay });
const server = createRelayServer(config, deviceRelay, commandBus);

// Diagnostic only: log configuration presence, never API tokens or bus secrets.
// Bus command transport may be healthy while the optional CI consumer is disabled.
console.info('Ø Remote CI build consumer configuration', JSON.stringify({
  bus_enabled: Boolean(commandBus.enabled),
  codemagic_token_present: Boolean(config.codemagicApiToken),
  codemagic_app_configured: Boolean(config.codemagicAppId),
  codemagic_workflow_configured: Boolean(config.codemagicWorkflowId),
}));

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
