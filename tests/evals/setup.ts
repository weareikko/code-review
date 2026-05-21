// Loaded by vitest as a setupFile so that process.env is populated from .env
// inside each worker process before any eval module is evaluated.
// describeEval() calls skipIf() at module-load time, so the API key must be
// present before the test file is imported.
import { config } from 'dotenv';

config();
