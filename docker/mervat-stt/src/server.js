import { createServer } from 'node:http';
import { createHandler, loadConfig } from './app.js';

const cfg = loadConfig();
const server = createServer(createHandler(cfg)).listen(cfg.port, () => console.log(`mervat-stt-proxy listening on :${cfg.port}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
