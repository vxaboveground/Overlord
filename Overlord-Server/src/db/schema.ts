import { db } from "./connection";


db.run(`
  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    hwid TEXT,
    role TEXT,
    ip TEXT,
    host TEXT,
    os TEXT,
    arch TEXT,
    version TEXT,
    user TEXT,
    nickname TEXT,
    custom_tag TEXT,
    custom_tag_note TEXT,
    monitors INTEGER,
    country TEXT,
    last_seen INTEGER,
    online INTEGER,
    ping_ms INTEGER,
    bookmarked INTEGER NOT NULL DEFAULT 0,
    build_tag TEXT,
    built_by_user_id INTEGER
  );
`);
try {
  db.run(`ALTER TABLE clients ADD COLUMN role TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN hwid TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN ip TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN nickname TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN custom_tag TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN custom_tag_note TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN bookmarked INTEGER NOT NULL DEFAULT 0`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN build_tag TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN built_by_user_id INTEGER`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN enrollment_status TEXT NOT NULL DEFAULT 'pending'`);
} catch {}
try {
  db.run(`UPDATE clients SET enrollment_status='pending' WHERE enrollment_status IS NULL`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN public_key TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN key_fingerprint TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN enrolled_at INTEGER`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN enrolled_by TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN cpu TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN gpu TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN ram TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN battery_percent INTEGER`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN battery_charging INTEGER`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`);
} catch {}
db.run(
  `CREATE INDEX IF NOT EXISTS idx_clients_public_key ON clients(public_key);`,
);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_clients_key_fingerprint ON clients(key_fingerprint);`,
);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_clients_enrollment_status ON clients(enrollment_status);`,
);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_clients_online_last_seen ON clients(online, last_seen DESC);`,
);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_clients_enrollment_online_bookmark_id ON clients(enrollment_status, online DESC, bookmarked DESC, id ASC);`,
);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_clients_enrollment_online_last_seen ON clients(enrollment_status, online DESC, last_seen DESC, id ASC);`,
);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_clients_os_last_seen ON clients(os, last_seen DESC);`,
);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_clients_ping_ms ON clients(ping_ms);`,
);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_clients_built_by_user_id ON clients(built_by_user_id);`,
);
try {
  db.run(`ALTER TABLE clients ADD COLUMN disconnect_reason TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN disconnect_detail TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN elevation TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN permissions TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN notifications_muted INTEGER NOT NULL DEFAULT 0`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN deny_reason TEXT`);
} catch {}

db.run(`
  CREATE TABLE IF NOT EXISTS client_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    color TEXT NOT NULL DEFAULT '#3b82f6',
    created_at INTEGER NOT NULL
  );
`);

try {
  db.run(`ALTER TABLE clients ADD COLUMN group_id INTEGER REFERENCES client_groups(id) ON DELETE SET NULL`);
} catch {}
db.run(`CREATE INDEX IF NOT EXISTS idx_clients_group_id ON clients(group_id);`);

try {
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS client_search_fts USING fts5(
      id UNINDEXED,
      host,
      user,
      nickname,
      custom_tag,
      custom_tag_note,
      os,
      ip,
      hwid,
      country,
      version,
      build_tag,
      cpu,
      gpu,
      ram,
      tokenize = 'unicode61'
    );
  `);

  const counts = db
    .query<{ clients: number; indexed: number }>(
      `SELECT
         (SELECT COUNT(*) FROM clients) as clients,
         (SELECT COUNT(*) FROM client_search_fts) as indexed`,
    )
    .get() ?? { clients: 0, indexed: 0 };

  if (counts.clients !== counts.indexed) {
    db.run(`DELETE FROM client_search_fts`);
    db.run(`
      INSERT INTO client_search_fts(
        rowid, id, host, user, nickname, custom_tag, custom_tag_note,
        os, ip, hwid, country, version, build_tag, cpu, gpu, ram
      )
      SELECT
        rowid, id, host, user, nickname, custom_tag, custom_tag_note,
        os, ip, hwid, country, version, build_tag, cpu, gpu, ram
      FROM clients
    `);
  }

  db.run(`
    CREATE TRIGGER IF NOT EXISTS clients_search_ai AFTER INSERT ON clients BEGIN
      INSERT INTO client_search_fts(
        rowid, id, host, user, nickname, custom_tag, custom_tag_note,
        os, ip, hwid, country, version, build_tag, cpu, gpu, ram
      )
      VALUES (
        new.rowid, new.id, new.host, new.user, new.nickname, new.custom_tag, new.custom_tag_note,
        new.os, new.ip, new.hwid, new.country, new.version, new.build_tag, new.cpu, new.gpu, new.ram
      );
    END;
  `);
  db.run(`
    CREATE TRIGGER IF NOT EXISTS clients_search_ad AFTER DELETE ON clients BEGIN
      DELETE FROM client_search_fts WHERE rowid = old.rowid;
    END;
  `);
  db.run(`
    CREATE TRIGGER IF NOT EXISTS clients_search_au AFTER UPDATE ON clients BEGIN
      DELETE FROM client_search_fts WHERE rowid = old.rowid;
      INSERT INTO client_search_fts(
        rowid, id, host, user, nickname, custom_tag, custom_tag_note,
        os, ip, hwid, country, version, build_tag, cpu, gpu, ram
      )
      VALUES (
        new.rowid, new.id, new.host, new.user, new.nickname, new.custom_tag, new.custom_tag_note,
        new.os, new.ip, new.hwid, new.country, new.version, new.build_tag, new.cpu, new.gpu, new.ram
      );
    END;
  `);
} catch {}

db.run(`
  CREATE TABLE IF NOT EXISTS banned_ips (
    ip TEXT PRIMARY KEY,
    reason TEXT,
    created_at INTEGER NOT NULL
  );
`);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_banned_ips_created_at ON banned_ips(created_at DESC);`,
);

db.run(`
  CREATE TABLE IF NOT EXISTS revoked_tokens (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
`);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON revoked_tokens(expires_at);`,
);

db.run(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT,
    created_at INTEGER NOT NULL,
    last_activity INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);`);
db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);`);
db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);`);

db.run(`
  CREATE TABLE IF NOT EXISTS builds (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    start_time INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    files TEXT NOT NULL,
    build_tag TEXT,
    built_by_user_id INTEGER
  );
`);

try { db.run(`ALTER TABLE builds ADD COLUMN build_tag TEXT`); } catch {}
try { db.run(`ALTER TABLE builds ADD COLUMN built_by_user_id INTEGER`); } catch {}
try { db.run(`ALTER TABLE builds ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0`); } catch {}
db.run(`CREATE INDEX IF NOT EXISTS idx_builds_build_tag ON builds(build_tag);`);

db.run(`
  CREATE TABLE IF NOT EXISTS build_claims (
    build_id TEXT NOT NULL,
    key_fingerprint TEXT NOT NULL,
    claimed_at INTEGER NOT NULL,
    PRIMARY KEY (build_id, key_fingerprint)
  );
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_build_claims_build ON build_claims(build_id);`);

db.run(`
  CREATE TABLE IF NOT EXISTS build_profiles (
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    profile_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, name)
  );
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_build_profiles_user_updated ON build_profiles(user_id, updated_at DESC);`);

db.run(`
  CREATE TABLE IF NOT EXISTS saved_scripts (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    script_type TEXT NOT NULL DEFAULT 'powershell',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_saved_scripts_user ON saved_scripts(user_id, updated_at DESC);`);


db.run(`
  CREATE TABLE IF NOT EXISTS notification_screenshots (
    id TEXT PRIMARY KEY,
    notification_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    format TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    bytes BLOB NOT NULL
  );
`);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_notification_screenshots_notification_id ON notification_screenshots(notification_id);`,
);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_notification_screenshots_ts ON notification_screenshots(ts DESC);`,
);

db.run(`
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    host TEXT,
    user TEXT,
    os TEXT,
    title TEXT NOT NULL,
    process TEXT,
    process_path TEXT,
    pid INTEGER,
    keyword TEXT,
    category TEXT NOT NULL DEFAULT 'active_window',
    ts INTEGER NOT NULL,
    screenshot_id TEXT
  );
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_notifications_ts ON notifications(ts DESC);`);
db.run(`CREATE INDEX IF NOT EXISTS idx_notifications_client_id ON notifications(client_id);`);

db.run(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);`,
);
db.run(
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_push_subscriptions_endpoint ON push_subscriptions(endpoint);`,
);

db.run(`
  CREATE TABLE IF NOT EXISTS auto_scripts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    trigger TEXT NOT NULL,
    script TEXT NOT NULL,
    script_type TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_auto_scripts_trigger ON auto_scripts(trigger, enabled);`,
);
try {
  db.run(`ALTER TABLE auto_scripts ADD COLUMN os_filter TEXT NOT NULL DEFAULT '[]'`);
} catch { /* column already exists */ }

db.run(`
  CREATE TABLE IF NOT EXISTS auto_script_runs (
    script_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (script_id, client_id)
  );
`);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_auto_script_runs_ts ON auto_script_runs(ts DESC);`,
);

db.run(`
  CREATE TABLE IF NOT EXISTS auto_deploys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    trigger TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    file_os TEXT NOT NULL,
    args TEXT NOT NULL DEFAULT '',
    hide_window INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL,
    os_filter TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_auto_deploys_trigger ON auto_deploys(trigger, enabled);`,
);

db.run(`
  CREATE TABLE IF NOT EXISTS auto_deploy_runs (
    deploy_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (deploy_id, client_id)
  );
`);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_auto_deploy_runs_ts ON auto_deploy_runs(ts DESC);`,
);

db.run(`
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    user_role TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at DESC);`,
);

db.run(`
  CREATE TABLE IF NOT EXISTS shared_files (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    size INTEGER NOT NULL,
    mime_type TEXT NOT NULL,
    uploaded_by INTEGER NOT NULL,
    uploaded_by_username TEXT NOT NULL,
    password_hash TEXT,
    max_downloads INTEGER,
    download_count INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    description TEXT
  );
`);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_shared_files_created_at ON shared_files(created_at DESC);`,
);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_shared_files_uploaded_by ON shared_files(uploaded_by);`,
);

