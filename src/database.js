const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const initSqlJs = require('sql.js');

const PERSIST_RETRY_DELAYS_MS = [20, 50, 100, 200, 400];
const RETRYABLE_FS_ERROR_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

class AppDatabase {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  async init() {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file),
    });
    const bytes = this.readPersistedBytes();
    this.db = new SQL.Database(bytes);
    this.migrate();
    this.persist();
  }

  readPersistedBytes() {
    const candidates = [this.dbPath, `${this.dbPath}.mirror`, `${this.dbPath}.bak`];
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      const bytes = fs.readFileSync(candidate);
      if (candidate !== this.dbPath) {
        try {
          retryFileOperation(() => fs.copyFileSync(candidate, this.dbPath));
        } catch (error) {
          console.warn(`[database] restore failed for ${this.dbPath}:`, error);
        }
      }
      return bytes;
    }
    return undefined;
  }

  migrate() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        workspace_path TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_projects_updated
      ON projects (updated_at DESC);

      CREATE TABLE IF NOT EXISTS project_states (
        project_id INTEGER PRIMARY KEY,
        running INTEGER NOT NULL DEFAULT 0,
        phase TEXT NOT NULL DEFAULT 'idle',
        interval_seconds INTEGER NOT NULL DEFAULT 5,
        validation_command TEXT NOT NULL DEFAULT '',
        agent_cli_provider TEXT NOT NULL DEFAULT 'codex',
        agent_cli_command TEXT NOT NULL DEFAULT '',
        codex_reasoning_effort TEXT,
        last_issue_hash TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS requirements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        agent_cli_provider TEXT,
        agent_cli_command TEXT NOT NULL DEFAULT '',
        codex_reasoning_effort TEXT,
        source_path TEXT,
        source_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        requirement_id INTEGER,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        agent_cli_provider TEXT,
        agent_cli_command TEXT NOT NULL DEFAULT '',
        codex_reasoning_effort TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        owner_type TEXT NOT NULL,
        owner_id INTEGER NOT NULL,
        original_name TEXT NOT NULL,
        stored_path TEXT NOT NULL,
        mime_type TEXT,
        size INTEGER NOT NULL,
        hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_attachments_owner
      ON attachments (owner_type, owner_id);

      CREATE TABLE IF NOT EXISTS scan_files (
        project_id INTEGER NOT NULL DEFAULT 1,
        scan_type TEXT NOT NULL,
        file_path TEXT NOT NULL,
        hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        modified_at TEXT NOT NULL,
        scanned_at TEXT NOT NULL,
        PRIMARY KEY (project_id, scan_type, file_path)
      );

      CREATE TABLE IF NOT EXISTS plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        issue_hash TEXT NOT NULL,
        file_path TEXT NOT NULL,
        hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        sort_order INTEGER NOT NULL DEFAULT 0,
        total_tasks INTEGER NOT NULL DEFAULT 0,
        completed_tasks INTEGER NOT NULL DEFAULT 0,
        validation_passed INTEGER NOT NULL DEFAULT 0,
        agent_cli_provider TEXT,
        agent_cli_command TEXT NOT NULL DEFAULT '',
        codex_reasoning_effort TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS plan_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id INTEGER NOT NULL,
        task_key TEXT NOT NULL,
        title TEXT NOT NULL,
        raw_line TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        sort_order INTEGER NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        codex_session_id TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(plan_id, task_key)
      );

      CREATE INDEX IF NOT EXISTS idx_plan_tasks_plan_status_sort
      ON plan_tasks (plan_id, status, sort_order, id);

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        meta TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS loop_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        running INTEGER NOT NULL DEFAULT 0,
        phase TEXT NOT NULL DEFAULT 'idle',
        workspace_path TEXT NOT NULL DEFAULT '',
        interval_seconds INTEGER NOT NULL DEFAULT 5,
        validation_command TEXT NOT NULL DEFAULT '',
        last_issue_hash TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );

      INSERT OR IGNORE INTO loop_state (
        id, running, phase, workspace_path, interval_seconds, validation_command, updated_at
      ) VALUES (1, 0, 'idle', '', 5, '', datetime('now'));
    `);

    this.ensureColumn('requirements', 'project_id', 'INTEGER');
    this.ensureColumn('requirements', 'linked_plan_id', 'INTEGER');
    this.ensureColumn('requirements', 'agent_cli_provider', 'TEXT');
    this.ensureColumn('requirements', 'agent_cli_command', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('requirements', 'codex_reasoning_effort', 'TEXT');
    this.ensureColumn('feedback', 'project_id', 'INTEGER');
    this.ensureColumn('feedback', 'linked_plan_id', 'INTEGER');
    this.ensureColumn('feedback', 'agent_cli_provider', 'TEXT');
    this.ensureColumn('feedback', 'agent_cli_command', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('feedback', 'codex_reasoning_effort', 'TEXT');
    this.ensureColumn('attachments', 'project_id', 'INTEGER');
    this.ensureColumn('plans', 'project_id', 'INTEGER');
    this.ensureColumn('plans', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('plans', 'agent_cli_provider', 'TEXT');
    this.ensureColumn('plans', 'agent_cli_command', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('plans', 'codex_reasoning_effort', 'TEXT');
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_plans_project_sort
      ON plans (project_id, sort_order, created_at, id)
    `);
    this.ensureColumn('plan_tasks', 'scope', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('plan_tasks', 'started_at', 'TEXT');
    this.ensureColumn('plan_tasks', 'finished_at', 'TEXT');
    this.ensureColumn('plan_tasks', 'duration_ms', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('plan_tasks', 'codex_session_id', 'TEXT');
    this.ensureColumn('events', 'project_id', 'INTEGER');
    this.ensureColumn('project_states', 'agent_cli_provider', "TEXT NOT NULL DEFAULT 'codex'");
    this.ensureColumn('project_states', 'agent_cli_command', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('project_states', 'codex_reasoning_effort', 'TEXT');

    const defaultProjectId = this.ensureDefaultProject();
    this.ensureDefaultSettings();
    this.migrateScanFilesTable(defaultProjectId);
    this.assignLegacyRows(defaultProjectId);
    this.backfillPlanSortOrders();
    this.ensureProjectState(defaultProjectId);
  }

  ensureDefaultProject() {
    const existing = this.get('SELECT id FROM projects ORDER BY id ASC LIMIT 1');
    if (existing) return Number(existing.id);

    const legacyState = this.get('SELECT * FROM loop_state WHERE id = 1') || {};
    const now = nowIso();
    this.db.run(
      `INSERT INTO projects (name, workspace_path, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      ['默认项目', legacyState.workspace_path || '', '从旧版单项目数据自动迁移', now, now],
    );
    return Number(this.get('SELECT last_insert_rowid() AS id').id);
  }

  ensureProjectState(projectId) {
    const legacyState = this.get('SELECT * FROM loop_state WHERE id = 1') || {};
    this.db.run(
      `INSERT OR IGNORE INTO project_states
       (project_id, running, phase, interval_seconds, validation_command, last_issue_hash, last_error, updated_at)
       VALUES (?, 0, ?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        legacyState.phase || 'idle',
        Number(legacyState.interval_seconds || 5),
        legacyState.validation_command ?? '',
        legacyState.last_issue_hash || null,
        legacyState.last_error || null,
        legacyState.updated_at || nowIso(),
      ],
    );
  }

  assignLegacyRows(projectId) {
    for (const table of ['requirements', 'feedback', 'attachments', 'plans', 'events', 'scan_files']) {
      this.db.run(`UPDATE ${table} SET project_id = ? WHERE project_id IS NULL`, [projectId]);
    }
  }

  ensureColumn(table, column, definition) {
    const columns = this.all(`PRAGMA table_info(${table})`);
    if (!columns.some((item) => item.name === column)) {
      this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  ensureDefaultSettings() {
    const defaults = {
      'mcp.enabled': 'true',
      'mcp.transport': 'http',
      'mcp.host': '127.0.0.1',
      'mcp.port': '43847',
      'mcp.path': '/mcp',
      'mcp.authToken': generateSecretToken(),
    };
    for (const [key, value] of Object.entries(defaults)) {
      this.db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [key, value]);
    }
  }

  getSetting(key, fallback = null) {
    const row = this.get('SELECT value FROM settings WHERE key = ?', [key]);
    return row ? row.value : fallback;
  }

  setSetting(key, value) {
    this.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, String(value)]);
  }

  getSettings(prefix = '') {
    const rows = prefix
      ? this.all('SELECT key, value FROM settings WHERE key LIKE ? ORDER BY key ASC', [`${prefix}%`])
      : this.all('SELECT key, value FROM settings ORDER BY key ASC');
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  backfillPlanSortOrders() {
    const rows = this.all(
      `SELECT id, project_id, sort_order
       FROM plans
       ORDER BY COALESCE(project_id, 0) ASC, created_at ASC, id ASC`,
    );
    const byProject = new Map();
    for (const row of rows) {
      const key = String(row.project_id ?? 0);
      const plans = byProject.get(key) || [];
      plans.push(row);
      byProject.set(key, plans);
    }

    for (const plans of byProject.values()) {
      let nextOrder = plans.reduce((max, plan) => {
        const order = Number(plan.sort_order);
        return Number.isFinite(order) && order > max ? order : max;
      }, 0);
      for (const plan of plans) {
        const order = Number(plan.sort_order);
        if (Number.isFinite(order) && order > 0) continue;
        nextOrder += 1;
        this.db.run('UPDATE plans SET sort_order = ? WHERE id = ?', [nextOrder, plan.id]);
      }
    }
  }

  migrateScanFilesTable(defaultProjectId) {
    const table = this.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'scan_files'");
    if (String(table?.sql || '').includes('PRIMARY KEY (project_id, scan_type, file_path)')) return;

    const hasProjectId = this.all('PRAGMA table_info(scan_files)').some((item) => item.name === 'project_id');
    const fallbackProjectId = Number(defaultProjectId || 1);
    this.db.run('ALTER TABLE scan_files RENAME TO scan_files_legacy');
    this.db.run(`
      CREATE TABLE scan_files (
        project_id INTEGER NOT NULL DEFAULT ${fallbackProjectId},
        scan_type TEXT NOT NULL,
        file_path TEXT NOT NULL,
        hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        modified_at TEXT NOT NULL,
        scanned_at TEXT NOT NULL,
        PRIMARY KEY (project_id, scan_type, file_path)
      );
    `);

    if (hasProjectId) {
      this.db.run(`
        INSERT OR REPLACE INTO scan_files
        (project_id, scan_type, file_path, hash, size, modified_at, scanned_at)
        SELECT COALESCE(project_id, ${fallbackProjectId}), scan_type, file_path, hash, size, modified_at, scanned_at
        FROM scan_files_legacy;
      `);
    } else {
      this.db.run(`
        INSERT OR REPLACE INTO scan_files
        (project_id, scan_type, file_path, hash, size, modified_at, scanned_at)
        SELECT ${fallbackProjectId}, scan_type, file_path, hash, size, modified_at, scanned_at
        FROM scan_files_legacy;
      `);
    }

    this.db.run('DROP TABLE scan_files_legacy');
  }

  persist() {
    const data = Buffer.from(this.db.export());
    const tmp = `${this.dbPath}.${process.pid}.${Date.now()}.tmp`;
    const mirror = `${this.dbPath}.mirror`;
    try {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
      retryFileOperation(() => fs.writeFileSync(tmp, data));
      retryFileOperation(() => fs.writeFileSync(mirror, data));
      if (fs.existsSync(this.dbPath)) {
        try {
          retryFileOperation(() => fs.copyFileSync(this.dbPath, `${this.dbPath}.bak`));
        } catch (error) {
          console.warn(`[database] backup failed for ${this.dbPath}:`, error);
        }
      }
      if (process.platform === 'win32') {
        retryFileOperation(() => fs.copyFileSync(tmp, this.dbPath));
        tryUnlink(tmp);
      } else {
        retryFileOperation(() => fs.renameSync(tmp, this.dbPath));
      }
      this.lastPersistError = null;
    } catch (error) {
      this.lastPersistError = error;
      tryUnlink(tmp);
      console.error(`[database] persist failed for ${this.dbPath}:`, error);
    }
  }

  run(sql, params = []) {
    this.db.run(sql, params);
    this.persist();
  }

  runBatch(statements = []) {
    if (!Array.isArray(statements) || statements.length === 0) return;
    this.db.run('BEGIN TRANSACTION');
    try {
      for (const statement of statements) {
        if (!statement?.sql) continue;
        this.db.run(statement.sql, statement.params || []);
      }
      this.db.run('COMMIT');
    } catch (error) {
      try {
        this.db.run('ROLLBACK');
      } catch {
        // Keep the original database error as the failure reason.
      }
      throw error;
    }
    this.persist();
  }

  get(sql, params = []) {
    const rows = this.all(sql, params);
    return rows[0] || null;
  }

  all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  insert(sql, params = []) {
    this.db.run(sql, params);
    const id = this.get('SELECT last_insert_rowid() AS id').id;
    this.persist();
    return id;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function generateSecretToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function retryFileOperation(operation) {
  let lastError = null;
  for (let attempt = 0; attempt <= PERSIST_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_FS_ERROR_CODES.has(error?.code) || attempt >= PERSIST_RETRY_DELAYS_MS.length) {
        throw error;
      }
      sleepSync(PERSIST_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

function sleepSync(milliseconds) {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, milliseconds);
}

function tryUnlink(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Temporary files are best-effort cleanup only.
  }
}

module.exports = { AppDatabase, nowIso };
