import { logger } from "../logger";
import { db } from "./connection";

function addColumnIfMissing(table: string, definition: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  } catch (err: any) {
    if (!err?.message?.includes("duplicate column name")) throw err;
  }
}

type Migration = { id: string; run: () => void };

function runMigrations(migrations: ReadonlyArray<Migration>): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);

  const appliedRows = db
    .prepare("SELECT id FROM schema_migrations")
    .all() as Array<{ id: string }>;
  const applied = new Set(appliedRows.map((r) => r.id));
  const markApplied = db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)",
  );

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    try {
      migration.run();
      markApplied.run(migration.id, Date.now());
      logger.info(`[migration] Applied ${migration.id}`);
    } catch (err) {
      logger.error(`[migration] Failed: ${migration.id}`, err);
      throw err;
    }
  }
}

export function initializeUserSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'operator', 'viewer')),
      created_at INTEGER NOT NULL,
      last_login INTEGER,
      onboarding_completed_at INTEGER,
      created_by TEXT,
      must_change_password INTEGER DEFAULT 0,
      client_scope TEXT NOT NULL DEFAULT 'none' CHECK(client_scope IN ('none', 'allowlist', 'denylist', 'all'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_client_access_rules (
      user_id INTEGER NOT NULL,
      client_id TEXT NOT NULL,
      access TEXT NOT NULL CHECK(access IN ('allow', 'deny')),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, client_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_user_client_access_rules_user ON user_client_access_rules(user_id)`,
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_feature_permissions (
      user_id INTEGER NOT NULL,
      feature TEXT NOT NULL,
      allowed INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, feature),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_plugin_access_rules (
      user_id INTEGER NOT NULL,
      plugin_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, plugin_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_user_plugin_access_rules_user ON user_plugin_access_rules(user_id)`,
  );


  const userMigrations: Migration[] = [
    {
      id: "001_users_must_change_password",
      run: () => addColumnIfMissing("users", `must_change_password INTEGER DEFAULT 0`),
    },
    {
      id: "002_users_client_scope",
      run: () => {
        addColumnIfMissing(
          "users",
          `client_scope TEXT NOT NULL DEFAULT 'none' CHECK(client_scope IN ('none', 'allowlist', 'denylist', 'all'))`,
        );
        db.exec(`UPDATE users SET client_scope='all' WHERE role='admin'`);
      },
    },
    {
      id: "003_users_can_build",
      run: () => {
        addColumnIfMissing("users", `can_build INTEGER NOT NULL DEFAULT 0`);
        db.exec(`UPDATE users SET can_build=1 WHERE role='admin' OR role='operator'`);
      },
    },
    {
      id: "004_users_telegram_chat_id",
      run: () => addColumnIfMissing("users", `telegram_chat_id TEXT DEFAULT NULL`),
    },
    {
      id: "005_users_notification_delivery",
      run: () => {
        addColumnIfMissing("users", `webhook_enabled INTEGER DEFAULT 0`);
        addColumnIfMissing("users", `webhook_url TEXT DEFAULT NULL`);
        addColumnIfMissing("users", `webhook_template TEXT DEFAULT NULL`);
        addColumnIfMissing("users", `telegram_enabled INTEGER DEFAULT 0`);
        addColumnIfMissing("users", `telegram_bot_token TEXT DEFAULT NULL`);
        addColumnIfMissing("users", `telegram_template TEXT DEFAULT NULL`);
      },
    },
    {
      id: "006_users_can_upload_files",
      run: () => {
        addColumnIfMissing("users", `can_upload_files INTEGER NOT NULL DEFAULT 0`);
        db.exec(`UPDATE users SET can_upload_files=1 WHERE role='admin'`);
      },
    },
    {
      id: "007_users_client_event_filters",
      run: () => {
        addColumnIfMissing("users", `client_event_webhook INTEGER DEFAULT 1`);
        addColumnIfMissing("users", `client_event_telegram INTEGER DEFAULT 1`);
        addColumnIfMissing("users", `client_event_push INTEGER DEFAULT 1`);
      },
    },
    {
      id: "008_users_chat_write",
      run: () => addColumnIfMissing("users", `chat_write INTEGER DEFAULT NULL`),
    },
    {
      id: "009_users_registered_via",
      run: () => addColumnIfMissing("users", `registered_via TEXT DEFAULT NULL`),
    },
    {
      id: "010_users_plugin_scope",
      run: () => {
        addColumnIfMissing(
          "users",
          `plugin_scope TEXT NOT NULL DEFAULT 'none' CHECK(plugin_scope IN ('none', 'allowlist', 'all'))`,
        );
        db.exec(`UPDATE users SET plugin_scope='all' WHERE role='admin'`);
      },
    },
    {
      id: "011_permission_groups",
      run: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS permission_groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            description TEXT,
            created_at INTEGER NOT NULL,
            created_by INTEGER,
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
          )
        `);
        db.exec(`
          CREATE TABLE IF NOT EXISTS permission_group_permissions (
            group_id INTEGER NOT NULL,
            permission TEXT NOT NULL,
            PRIMARY KEY (group_id, permission),
            FOREIGN KEY (group_id) REFERENCES permission_groups(id) ON DELETE CASCADE
          )
        `);
        db.exec(`
          CREATE TABLE IF NOT EXISTS user_permission_groups (
            user_id INTEGER NOT NULL,
            group_id INTEGER NOT NULL,
            PRIMARY KEY (user_id, group_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (group_id) REFERENCES permission_groups(id) ON DELETE CASCADE
          )
        `);
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_user_permission_groups_user ON user_permission_groups(user_id)`,
        );
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_permission_group_permissions_group ON permission_group_permissions(group_id)`,
        );
      },
    },
    {
      id: "012_user_extra_permissions",
      run: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS user_extra_permissions (
            user_id INTEGER NOT NULL,
            permission TEXT NOT NULL,
            PRIMARY KEY (user_id, permission),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          )
        `);
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_user_extra_permissions_user ON user_extra_permissions(user_id)`,
        );
      },
    },
    {
      id: "013_users_mfa",
      run: () => {
        addColumnIfMissing("users", `mfa_secret TEXT DEFAULT NULL`);
        addColumnIfMissing("users", `mfa_enabled INTEGER NOT NULL DEFAULT 0`);
        addColumnIfMissing("users", `mfa_enabled_at INTEGER DEFAULT NULL`);
      },
    },
    {
      id: "014_users_keylog_archive_enabled",
      run: () => addColumnIfMissing("users", `keylog_archive_enabled INTEGER NOT NULL DEFAULT 0`),
    },
    {
      id: "015_users_onboarding_completed_at",
      run: () => {
        addColumnIfMissing("users", `onboarding_completed_at INTEGER DEFAULT NULL`);
        // Accounts that have already signed in predate onboarding and should not
        // be prompted. Accounts with no login history remain eligible.
        db.exec(`
          UPDATE users
          SET onboarding_completed_at = COALESCE(last_login, created_at)
          WHERE onboarding_completed_at IS NULL AND last_login IS NOT NULL
        `);
      },
    },
  ];

  runMigrations(userMigrations);

  db.exec(`
    CREATE TABLE IF NOT EXISTS registration_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      label TEXT,
      created_by INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      used_by INTEGER,
      used_at INTEGER,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_registration_keys_key ON registration_keys("key")`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'denied')),
      reviewed_by INTEGER,
      reviewed_at INTEGER,
      key_used INTEGER,
      FOREIGN KEY (key_used) REFERENCES registration_keys(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_registrations_status ON pending_registrations(status)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_registrations_username_pending ON pending_registrations(username) WHERE status = 'pending'`);
}


