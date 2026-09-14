import { loadConfig } from './config.js';
import { createDeviceRelay } from './device-relay.js';
import { createRelayServer } from './server.js';

const config = loadConfig(process.env);
const deviceRelay = createDeviceRelay(config);
const server = createRelayServer(config, deviceRelay);

server.listen(config.port, config.host, () => {
  console.log(`Ø Remote relay listening on ${config.host}:${config.port}`);
});
