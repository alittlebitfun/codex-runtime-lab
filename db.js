const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'codex_lab',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
});

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) DEFAULT 'New Session',
  model VARCHAR(100) DEFAULT 'gpt-5.3-codex-spark',
  sandbox_dir TEXT,
  thread_id VARCHAR(100),
  status VARCHAR(20) DEFAULT 'active',
  pinned BOOLEAN DEFAULT false,
  sort_order INTEGER DEFAULT 0,
  collection_id UUID REFERENCES session_collections(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS session_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_collections_user ON session_collections(user_id, sort_order);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS uploaded_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  original_name VARCHAR(512) NOT NULL,
  stored_path TEXT NOT NULL,
  mime_type VARCHAR(100),
  size_bytes INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_files_session ON uploaded_files(session_id);
`;

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(SCHEMA);
    // Migration: add thread_id column if missing
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name = 'sessions' AND column_name = 'thread_id') THEN
          ALTER TABLE sessions ADD COLUMN thread_id VARCHAR(100);
        END IF;
      END $$;
    `);
    // Migration: add pinned column
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name = 'sessions' AND column_name = 'pinned') THEN
          ALTER TABLE sessions ADD COLUMN pinned BOOLEAN DEFAULT false;
        END IF;
      END $$;
    `);
    // Migration: add sort_order column
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name = 'sessions' AND column_name = 'sort_order') THEN
          ALTER TABLE sessions ADD COLUMN sort_order INTEGER DEFAULT 0;
        END IF;
      END $$;
    `);
    // Migration: add collection_id column
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name = 'sessions' AND column_name = 'collection_id') THEN
          ALTER TABLE sessions ADD COLUMN collection_id UUID REFERENCES session_collections(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);
    // Backfill sort_order for existing sessions
    await client.query(`
      UPDATE sessions SET sort_order = sub.rn
      FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY updated_at DESC) as rn
        FROM sessions WHERE sort_order = 0
      ) sub
      WHERE sessions.id = sub.id AND sessions.sort_order = 0
    `);
    // Create composite sort index after columns exist
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sessions_sort ON sessions(user_id, pinned DESC, sort_order ASC, updated_at DESC)`);
    console.log('[db] Schema initialized');
  } finally {
    client.release();
  }
}

module.exports = { pool, initDb };
