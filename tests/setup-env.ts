import os from 'node:os';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

const root = path.join(os.tmpdir(), `openverify-test-${process.pid}`);
mkdirSync(root, { recursive: true });

process.env.OPENVERIFY_DATA_DIR = root;
process.env.OPENVERIFY_DB_PATH = path.join(root, 'test.sqlite');
process.env.OPENVERIFY_UPLOAD_DIR = path.join(root, 'uploads');
process.env.OPENVERIFY_OUTPUT_DIR = path.join(root, 'output');
process.env.OPENVERIFY_DISPOSABLE_PATH = path.join(root, 'disposable-domains.txt');
process.env.OPENVERIFY_FREE_PROVIDERS_PATH = path.join(root, 'free-email-providers.txt');
process.env.OPENVERIFY_LOG_LEVEL = 'error';
process.env.OPENVERIFY_SMTP_ENABLED = 'false';
process.env.REACHER_ENABLED = 'false';
process.env.REACHER_API_URL = '';
process.env.OPENVERIFY_CACHE_TTL_SECONDS = '3600';
process.env.OPENVERIFY_TRANSPORT = 'http';
process.env.OPENVERIFY_HTTP_HOST = '127.0.0.1';
process.env.OPENVERIFY_HTTP_PORT = '8787';
