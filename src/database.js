const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');

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
    const bytes = fs.existsSync(this.dbPath) ? fs.readFileSync(this.dbPath) : undefined;
    this.db = new SQL.Database(bytes);
    this.migrate();
    this.persist();
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
    this.ensureColumn('plans', 'agent_cli_provider', 'TEXT');
    this.ensureColumn('plans', 'agent_cli_command', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('plans', 'codex_reasoning_effort', 'TEXT');
    this.ensureColumn('plan_tasks', 'scope', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('plan_tasks', 'started_at', 'TEXT');
    this.ensureColumn('plan_tasks', 'finished_at', 'TEXT');
    this.ensureColumn('plan_tasks', 'duration_ms', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('plan_tasks', 'codex_session_id', 'TEXT');
    this.ensureColumn('events', 'project_id', 'INTEGER');
    this.ensureColumn('project_states', 'agent_cli_provider', "TEXT NOT NULL DEFAULT 'codex'");
    this.ensureColumn('project_states', 'agent_cli_command', "TEXT NOT NULL DEFAULT ''");

    const defaultProjectId = this.ensureDefaultProject();
    this.migrateScanFilesTable(defaultProjectId);
    this.assignLegacyRows(defaultProjectId);
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
    const tmp = `${this.dbPath}.tmp`;
    const mirror = `${this.dbPath}.mirror`;
    fs.writeFileSync(tmp, data);
    fs.writeFileSync(mirror, data);
    if (fs.existsSync(this.dbPath)) {
      fs.copyFileSync(this.dbPath, `${this.dbPath}.bak`);
      fs.unlinkSync(this.dbPath);
    }
    fs.renameSync(tmp, this.dbPath);
  }

  run(sql, params = []) {
    this.db.run(sql, params);
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

module.exports = { AppDatabase, nowIso };
