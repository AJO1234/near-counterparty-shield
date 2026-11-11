// Entry point for `npm start` and process managers (pm2 wraps the script, so
// server.js cannot rely on detecting that it is the main module).
import { startServer } from './server.js';

startServer();
