const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const initSqlJs = require('sql.js');

const PERSIST_RETRY_DELAYS_MS = [20, 50, 100, 200, 400];
const RETRYABLE_FS_ERROR_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const READ_ONLY_SQL_COMMANDS = new Set(['', 'SELECT', 'EXPLAIN']);
const ROW_MODIFYING_SQL_COMMANDS = new Set(['UPDATE', 'DELETE', 'INSERT', 'REPLACE']);
const DEFAULT_CHAT_MODEL = 'gpt-5.5';

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
        project_prompt TEXT NOT NULL DEFAULT '',
        agent_cli_provider TEXT NOT NULL DEFAULT 'codex',
        agent_cli_command TEXT NOT NULL DEFAULT '',
        codex_reasoning_effort TEXT,
        plan_generation_strategy TEXT NOT NULL DEFAULT 'external-cli-markdown',
        plan_generation_provider TEXT,
        plan_generation_command TEXT NOT NULL DEFAULT '',
        plan_generation_model TEXT NOT NULL DEFAULT '',
        plan_generation_codex_reasoning_effort TEXT,
        plan_generation_claude_base_url TEXT NOT NULL DEFAULT '',
        plan_generation_claude_auth_token TEXT NOT NULL DEFAULT '',
        plan_generation_claude_model TEXT NOT NULL DEFAULT '',
        plan_execution_strategy TEXT NOT NULL DEFAULT 'external-cli',
        plan_execution_provider TEXT,
        plan_execution_command TEXT NOT NULL DEFAULT '',
        plan_execution_model TEXT NOT NULL DEFAULT '',
        plan_execution_codex_reasoning_effort TEXT,
        plan_execution_claude_base_url TEXT NOT NULL DEFAULT '',
        plan_execution_claude_auth_token TEXT NOT NULL DEFAULT '',
        plan_execution_claude_model TEXT NOT NULL DEFAULT '',
        last_issue_hash TEXT,
        last_error TEXT,
        env_vars TEXT NOT NULL DEFAULT '',
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
        plan_generation_strategy TEXT,
        plan_generation_provider TEXT,
        plan_generation_command TEXT NOT NULL DEFAULT '',
        plan_generation_model TEXT NOT NULL DEFAULT '',
        plan_generation_codex_reasoning_effort TEXT,
        plan_generation_claude_base_url TEXT NOT NULL DEFAULT '',
        plan_generation_claude_auth_token TEXT NOT NULL DEFAULT '',
        plan_generation_claude_model TEXT NOT NULL DEFAULT '',
        generate_fail_count INTEGER DEFAULT 0,
        last_generate_fail_at TEXT,
        last_generate_error TEXT,
        last_generate_log_file TEXT,
        last_generate_agent_cli_provider TEXT,
        last_generate_codex_reasoning_effort TEXT,
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
        plan_generation_strategy TEXT,
        plan_generation_provider TEXT,
        plan_generation_command TEXT NOT NULL DEFAULT '',
        plan_generation_model TEXT NOT NULL DEFAULT '',
        plan_generation_codex_reasoning_effort TEXT,
        plan_generation_claude_base_url TEXT NOT NULL DEFAULT '',
        plan_generation_claude_auth_token TEXT NOT NULL DEFAULT '',
        plan_generation_claude_model TEXT NOT NULL DEFAULT '',
        agent_cli_session_id TEXT,
        generate_fail_count INTEGER DEFAULT 0,
        last_generate_fail_at TEXT,
        last_generate_error TEXT,
        last_generate_log_file TEXT,
        last_generate_agent_cli_provider TEXT,
        last_generate_codex_reasoning_effort TEXT,
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
        plan_generation_strategy TEXT NOT NULL DEFAULT 'external-cli-markdown',
        plan_generation_provider TEXT,
        plan_generation_command TEXT NOT NULL DEFAULT '',
        plan_generation_model TEXT NOT NULL DEFAULT '',
        plan_generation_codex_reasoning_effort TEXT,
        plan_generation_claude_base_url TEXT NOT NULL DEFAULT '',
        plan_generation_claude_auth_token TEXT NOT NULL DEFAULT '',
        plan_generation_claude_model TEXT NOT NULL DEFAULT '',
        plan_generation_duration_ms INTEGER NOT NULL DEFAULT 0,
        plan_execution_strategy TEXT NOT NULL DEFAULT 'external-cli',
        plan_execution_provider TEXT,
        plan_execution_command TEXT NOT NULL DEFAULT '',
        plan_execution_model TEXT NOT NULL DEFAULT '',
        plan_execution_codex_reasoning_effort TEXT,
        plan_execution_claude_base_url TEXT NOT NULL DEFAULT '',
        plan_execution_claude_auth_token TEXT NOT NULL DEFAULT '',
        plan_execution_claude_model TEXT NOT NULL DEFAULT '',
        agent_cli_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        accepted_at TEXT
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
        agent_cli_session_id TEXT,
        codex_session_id TEXT,
        updated_at TEXT NOT NULL,
        accepted_at TEXT,
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

      CREATE TABLE IF NOT EXISTS scripts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        name TEXT NOT NULL,
        path TEXT NOT NULL DEFAULT '',
        runtime TEXT NOT NULL DEFAULT 'node',
        body TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        trigger_mode TEXT NOT NULL DEFAULT 'manual',
        hook_stage TEXT,
        schedule_cron TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        work_dir TEXT NOT NULL DEFAULT '',
        timeout_seconds INTEGER NOT NULL DEFAULT 60,
        fail_aborts INTEGER NOT NULL DEFAULT 0,
        context_inject TEXT NOT NULL DEFAULT 'none',
        sort_order INTEGER NOT NULL DEFAULT 0,
        last_status TEXT,
        last_exit_code INTEGER,
        last_duration_ms INTEGER,
        last_log TEXT,
        last_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_scripts_project
      ON scripts (project_id);

      CREATE INDEX IF NOT EXISTS idx_scripts_project_hook_stage
      ON scripts (project_id, hook_stage);

      CREATE TABLE IF NOT EXISTS executors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        label TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'shell',
        command TEXT NOT NULL,
        args_json TEXT NOT NULL DEFAULT '[]',
        actions_json TEXT,
        options_json TEXT NOT NULL DEFAULT '{}',
        group_kind TEXT,
        group_is_default INTEGER NOT NULL DEFAULT 0,
        presentation_json TEXT NOT NULL DEFAULT '{}',
        problem_matcher_json TEXT,
        depends_on_json TEXT NOT NULL DEFAULT '[]',
        depends_order TEXT NOT NULL DEFAULT 'parallel',
        enabled INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        last_status TEXT,
        last_exit_code INTEGER,
        last_duration_ms INTEGER,
        last_log TEXT,
        last_run_at TEXT,
        plugin_state_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_executors_project_sort
      ON executors (project_id, sort_order, id);

      CREATE INDEX IF NOT EXISTS idx_executors_project_label
      ON executors (project_id, label);

      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls TEXT,
        tool_result TEXT,
        status TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chat_messages_project
      ON chat_messages (project_id, created_at);

      CREATE TABLE IF NOT EXISTS ai_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        name TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'openai',
        base_url TEXT NOT NULL DEFAULT '',
        api_key TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        temperature TEXT NOT NULL DEFAULT '0.3',
        thinking_depth TEXT,
        thinking_budget_tokens INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ai_configs_project
      ON ai_configs (project_id);

      CREATE TABLE IF NOT EXISTS claude_cli_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL DEFAULT '',
        auth_token TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_claude_cli_configs_project
      ON claude_cli_configs (project_id);

      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        title TEXT NOT NULL DEFAULT '',
        ai_config_id INTEGER,
        pinned_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_conversations_project
      ON conversations (project_id);

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
    this.ensureColumn('requirements', 'plan_generation_strategy', 'TEXT');
    this.ensureColumn('requirements', 'plan_generation_provider', 'TEXT');
    this.ensureColumn('requirements', 'plan_generation_command', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('requirements', 'plan_generation_model', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('requirements', 'plan_generation_codex_reasoning_effort', 'TEXT');
    this.ensureColumn('requirements', 'plan_generation_claude_base_url', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('requirements', 'plan_generation_claude_auth_token', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('requirements', 'plan_generation_claude_model', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('requirements', 'plan_generation_claude_config_id', "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn('requirements', 'generate_fail_count', 'INTEGER DEFAULT 0');
    this.ensureColumn('requirements', 'last_generate_fail_at', 'TEXT');
    this.ensureColumn('requirements', 'last_generate_error', 'TEXT');
    this.ensureColumn('requirements', 'last_generate_log_file', 'TEXT');
    this.ensureColumn('requirements', 'last_generate_agent_cli_provider', 'TEXT');
    this.ensureColumn('requirements', 'last_generate_codex_reasoning_effort', 'TEXT');
    this.ensureColumn('feedback', 'project_id', 'INTEGER');
    this.ensureColumn('feedback', 'linked_plan_id', 'INTEGER');
    this.ensureColumn('feedback', 'agent_cli_provider', 'TEXT');
    this.ensureColumn('feedback', 'agent_cli_command', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('feedback', 'codex_reasoning_effort', 'TEXT');
    this.ensureColumn('feedback', 'plan_generation_strategy', 'TEXT');
    this.ensureColumn('feedback', 'plan_generation_provider', 'TEXT');
    this.ensureColumn('feedback', 'plan_generation_command', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('feedback', 'plan_generation_model', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('feedback', 'plan_generation_codex_reasoning_effort', 'TEXT');
    this.ensureColumn('feedback', 'plan_generation_claude_base_url', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('feedback', 'plan_generation_claude_auth_token', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('feedback', 'plan_generation_claude_model', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('feedback', 'plan_generation_claude_config_id', "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn('feedback', 'agent_cli_session_id', 'TEXT');
    this.ensureColumn('feedback', 'generate_fail_count', 'INTEGER DEFAULT 0');
    this.ensureColumn('feedback', 'last_generate_fail_at', 'TEXT');
    this.ensureColumn('feedback', 'last_generate_error', 'TEXT');
    this.ensureColumn('feedback', 'last_generate_log_file', 'TEXT');
    this.ensureColumn('feedback', 'last_generate_agent_cli_provider', 'TEXT');
    this.ensureColumn('feedback', 'last_generate_codex_reasoning_effort', 'TEXT');
    this.ensureColumn('attachments', 'project_id', 'INTEGER');
    this.ensureColumn('plans', 'project_id', 'INTEGER');
    this.ensureColumn('plans', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('plans', 'agent_cli_provider', 'TEXT');
    this.ensureColumn('plans', 'agent_cli_command', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('plans', 'codex_reasoning_effort', 'TEXT');
    this.ensureColumn('plans', 'plan_generation_strategy', "TEXT NOT NULL DEFAULT 'external-cli-markdown'");
    this.ensureColumn('plans', 'plan_generation_provider', 'TEXT');
    this.ensureColumn('plans', 'plan_generation_command', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('plans', 'plan_generation_model', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('plans', 'plan_generation_codex_reasoning_effort', 'TEXT');
    this.ensureColumn('plans', 'plan_generation_claude_base_url', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('plans', 'plan_generation_claude_auth_token', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('plans', 'plan_generation_claude_model', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('plans', 'plan_generation_claude_config_id', "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn('plans', 'plan_generation_duration_ms', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('plans', 'plan_execution_strategy', "TEXT NOT NULL DEFAULT 'external-cli'");
    this.ensureColumn('plans', 'plan_execution_provider', 'TEXT');
    this.ensureColumn('plans', 'plan_execution_command', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('plans', 'plan_execution_model', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('plans', 'plan_execution_codex_reasoning_effort', 'TEXT');
    this.ensureColumn('plans', 'plan_execution_claude_base_url', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('plans', 'plan_execution_claude_auth_token', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('plans', 'plan_execution_claude_model', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('plans', 'plan_execution_claude_config_id', "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn('plans', 'agent_cli_session_id', 'TEXT');
    this.ensureColumn('plans', 'accepted_at', 'TEXT');
    this.ensureIntakePlanLinksTable();
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_plans_project_sort
      ON plans (project_id, sort_order, created_at, id)
    `);
    this.ensureColumn('plan_tasks', 'scope', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('plan_tasks', 'started_at', 'TEXT');
    this.ensureColumn('plan_tasks', 'finished_at', 'TEXT');
    this.ensureColumn('plan_tasks', 'duration_ms', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('plan_tasks', 'agent_cli_session_id', 'TEXT');
    this.ensureColumn('plan_tasks', 'codex_session_id', 'TEXT');
    this.ensureColumn('plan_tasks', 'accepted_at', 'TEXT');
    this.ensureColumn('events', 'project_id', 'INTEGER');
    this.ensureColumn('scripts', 'source_type', "TEXT NOT NULL DEFAULT 'inline'");
    this.ensureColumn('scripts', 'schedule_cron', 'TEXT');
    this.ensureColumn('executors', 'project_id', 'INTEGER NOT NULL DEFAULT 1');
    this.ensureColumn('executors', 'label', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('executors', 'type', "TEXT NOT NULL DEFAULT 'shell'");
    this.ensureColumn('executors', 'command', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('executors', 'args_json', "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn('executors', 'options_json', "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn('executors', 'group_kind', 'TEXT');
    this.ensureColumn('executors', 'group_is_default', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('executors', 'presentation_json', "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn('executors', 'problem_matcher_json', 'TEXT');
    this.ensureColumn('executors', 'depends_on_json', "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn('executors', 'depends_order', "TEXT NOT NULL DEFAULT 'parallel'");
    this.ensureColumn('executors', 'enabled', 'INTEGER NOT NULL DEFAULT 1');
    this.ensureColumn('executors', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('executors', 'last_status', 'TEXT');
    this.ensureColumn('executors', 'last_exit_code', 'INTEGER');
    this.ensureColumn('executors', 'last_duration_ms', 'INTEGER');
    this.ensureColumn('executors', 'last_log', 'TEXT');
    this.ensureColumn('executors', 'last_run_at', 'TEXT');
    this.ensureColumn('executors', 'actions_json', 'TEXT');
    this.ensureColumn('executors', 'plugin_state_json', 'TEXT');
    this.ensureColumn('executors', 'created_at', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('executors', 'updated_at', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('project_states', 'agent_cli_provider', "TEXT NOT NULL DEFAULT 'codex'");
    this.ensureColumn('project_states', 'project_prompt', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('project_states', 'agent_cli_command', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('project_states', 'codex_reasoning_effort', 'TEXT');
    this.ensureColumn('project_states', 'plan_generation_strategy', "TEXT NOT NULL DEFAULT 'external-cli-markdown'");
    this.ensureColumn('project_states', 'plan_generation_provider', 'TEXT');
    this.ensureColumn('project_states', 'plan_generation_command', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('project_states', 'plan_generation_model', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('project_states', 'plan_generation_codex_reasoning_effort', 'TEXT');
    this.ensureColumn('project_states', 'plan_generation_claude_base_url', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('project_states', 'plan_generation_claude_auth_token', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('project_states', 'plan_generation_claude_model', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('project_states', 'plan_generation_claude_config_id', "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn('project_states', 'plan_execution_strategy', "TEXT NOT NULL DEFAULT 'external-cli'");
    this.ensureColumn('project_states', 'plan_execution_provider', 'TEXT');
    this.ensureColumn('project_states', 'plan_execution_command', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('project_states', 'plan_execution_model', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('project_states', 'plan_execution_codex_reasoning_effort', 'TEXT');
    this.ensureColumn('project_states', 'plan_execution_claude_base_url', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('project_states', 'plan_execution_claude_auth_token', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('project_states', 'plan_execution_claude_model', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('project_states', 'plan_execution_claude_config_id', "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn('project_states', 'env_vars', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('chat_messages', 'project_id', 'INTEGER');
    this.ensureColumn('chat_messages', 'conversation_id', 'INTEGER');
    this.ensureColumn('ai_configs', 'project_id', 'INTEGER');
    this.ensureColumn('ai_configs', 'thinking_depth', 'TEXT');
    this.ensureColumn('ai_configs', 'thinking_budget_tokens', 'INTEGER');
    this.ensureColumn('conversations', 'project_id', 'INTEGER');
    this.ensureColumn('conversations', 'ai_config_id', 'INTEGER');
    this.ensureColumn('conversations', 'pinned_at', 'TEXT');
    this.ensureColumn('conversations', 'codex_session_id', 'TEXT');
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation
      ON chat_messages (conversation_id, created_at)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_conversations_project_pinned_updated
      ON conversations (project_id, pinned_at, updated_at, id)
    `);

    const defaultProjectId = this.ensureDefaultProject();
    this.ensureDefaultSettings();
    this.migrateScanFilesTable(defaultProjectId);
    this.assignLegacyRows(defaultProjectId);
    this.backfillIntakePlanLinks();
    this.backfillPlanSortOrders();
    this.ensureProjectState(defaultProjectId);
    this.migrateAiConfigsToGlobal();
    this.migrateChatToAiConfigs(defaultProjectId);
    this.migrateChatMessagesToConversation(defaultProjectId);
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

  ensureIntakePlanLinksTable() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS intake_plan_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        intake_type TEXT NOT NULL CHECK (intake_type IN ('requirement', 'feedback')),
        intake_id INTEGER NOT NULL,
        plan_id INTEGER NOT NULL,
        phase_index INTEGER NOT NULL DEFAULT 1,
        phase_title TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, intake_type, intake_id, plan_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_intake_plan_links_intake_phase
      ON intake_plan_links (project_id, intake_type, intake_id, phase_index);

      CREATE INDEX IF NOT EXISTS idx_intake_plan_links_intake
      ON intake_plan_links (project_id, intake_type, intake_id, phase_index, plan_id);

      CREATE INDEX IF NOT EXISTS idx_intake_plan_links_plan
      ON intake_plan_links (project_id, plan_id, intake_type, intake_id);
    `);
  }

  backfillIntakePlanLinks() {
    const now = nowIso();
    for (const [table, intakeType] of [
      ['requirements', 'requirement'],
      ['feedback', 'feedback'],
    ]) {
      this.db.run(
        `INSERT OR IGNORE INTO intake_plan_links
         (project_id, intake_type, intake_id, plan_id, phase_index, phase_title, created_at, updated_at)
         SELECT ${table}.project_id, ?, ${table}.id, ${table}.linked_plan_id, 1, '', ?, ?
           FROM ${table}
           JOIN plans
             ON plans.id = ${table}.linked_plan_id
            AND plans.project_id = ${table}.project_id
          WHERE ${table}.project_id IS NOT NULL
            AND ${table}.linked_plan_id IS NOT NULL
            AND CAST(${table}.linked_plan_id AS INTEGER) > 0`,
        [intakeType, now, now],
      );
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
      // 更新检查（需求 #24）：默认开启、6 小时间隔；lastCheckedAt/dismissedVersion 初始为空。
      'update.autoCheck': 'true',
      'update.intervalMinutes': '360',
      'update.lastCheckedAt': '',
      'update.dismissedVersion': '',
      'update.installerAssetAvailable': 'false',
      'update.installerAssetStatus': '',
      'update.installerAssetReason': '',
      'update.installerAssetName': '',
      'update.installerAssetDownloadUrl': '',
      'update.installerAssetSize': '',
      'update.installerAssetPlatform': '',
      'update.installerAssetArch': '',
      'update.installerAssetKind': '',
      'update.downloadPhase': 'idle',
      'update.downloadProgress': '0',
      'update.downloadError': '',
      'update.downloadReason': '',
      'update.downloadStartedAt': '',
      'update.downloadCompletedAt': '',
      'update.downloadBytesReceived': '0',
      'update.downloadTotalBytes': '0',
      'update.downloadAssetKey': '',
      'update.downloadVersion': '',
      'update.localInstallerPath': '',
      // 对话模块（需求 #26）：LLM 接口默认配置
      'chat.provider': 'openai',
      'chat.baseUrl': 'https://api.openai.com',
      'chat.apiKey': '',
      'chat.model': DEFAULT_CHAT_MODEL,
      'chat.temperature': '0.3',
      'terminal.defaultProfile': 'default',
      'terminal.initialCwd': '',
      'terminal.fontSize': '13',
      'terminal.scrollbackLimit': '10000',
      'terminal.retainOnExit': 'true',
      'terminal.confirmBeforeKill': 'true',
    };
    for (const [key, value] of Object.entries(defaults)) {
      this.db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [key, value]);
    }
  }

  migrateAiConfigsToGlobal() {
    // 将所有项目级 ai_configs 提升为全局（project_id = NULL）。
    this.db.run('UPDATE ai_configs SET project_id = NULL WHERE project_id IS NOT NULL');

    // 按完整配置身份去重：每组保留最小 id，将其余行的 conversations.ai_config_id
    // 重映射到保留行并刷新 updated_at，最后删除重复行。
    const rows = this.all(
      `SELECT id, name, provider, base_url, api_key, model, temperature,
              thinking_depth, thinking_budget_tokens
         FROM ai_configs`,
    );

    const groups = new Map();
    for (const row of rows) {
      const key = JSON.stringify([
        row.name ?? '',
        row.provider ?? '',
        row.base_url ?? '',
        row.api_key ?? '',
        row.model ?? '',
        row.temperature ?? '',
        row.thinking_depth ?? '',
        row.thinking_budget_tokens ?? '',
      ]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }

    const now = nowIso();
    const duplicateIds = [];
    for (const groupRows of groups.values()) {
      if (groupRows.length <= 1) continue;
      groupRows.sort((a, b) => Number(a.id) - Number(b.id));
      const keepId = groupRows[0].id;
      const removeIds = groupRows.slice(1).map((row) => Number(row.id));
      const placeholders = removeIds.map(() => '?').join(', ');
      this.db.run(
        `UPDATE conversations
           SET ai_config_id = ?, updated_at = ?
         WHERE ai_config_id IN (${placeholders})`,
        [keepId, now, ...removeIds],
      );
      duplicateIds.push(...removeIds);
    }

    if (duplicateIds.length > 0) {
      const placeholders = duplicateIds.map(() => '?').join(', ');
      this.db.run(`DELETE FROM ai_configs WHERE id IN (${placeholders})`, duplicateIds);
    }
  }

  migrateChatToAiConfigs(/* defaultProjectId */) {
    // AI 配置已提升为全局：当全局（project_id IS NULL）已存在任意配置时跳过；
    // 否则只创建一条全局「默认配置」，不再按项目循环创建。
    const existing = this.get('SELECT id FROM ai_configs WHERE project_id IS NULL LIMIT 1');
    if (existing) return;

    const provider = this.getSetting('chat.provider') || 'openai';
    const baseUrl = this.getSetting('chat.baseUrl') || '';
    const apiKey = this.getSetting('chat.apiKey') || '';
    const model = this.getSetting('chat.model') || DEFAULT_CHAT_MODEL;
    const temperature = this.getSetting('chat.temperature') || '0.3';

    const now = nowIso();
    this.db.run(
      `INSERT INTO ai_configs (project_id, name, provider, base_url, api_key, model, temperature, created_at, updated_at)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['默认配置', provider, baseUrl, apiKey, model, temperature, now, now],
    );
  }

  migrateChatMessagesToConversation(defaultProjectId) {
    const fallbackProjectId = Number(defaultProjectId || 1);
    this.db.run('UPDATE conversations SET project_id = ? WHERE project_id IS NULL', [fallbackProjectId]);
    this.db.run(
      `UPDATE chat_messages
          SET project_id = COALESCE(
            (SELECT conversations.project_id
               FROM conversations
              WHERE conversations.id = chat_messages.conversation_id),
            ?
          )
        WHERE project_id IS NULL`,
      [fallbackProjectId],
    );
    this.db.run(
      `UPDATE chat_messages
          SET project_id = (
            SELECT conversations.project_id
              FROM conversations
             WHERE conversations.id = chat_messages.conversation_id
          )
        WHERE conversation_id IS NOT NULL
          AND EXISTS (
            SELECT 1
              FROM conversations
             WHERE conversations.id = chat_messages.conversation_id
          )
          AND project_id != (
            SELECT conversations.project_id
              FROM conversations
             WHERE conversations.id = chat_messages.conversation_id
          )`,
    );

    const projects = this.all('SELECT id FROM projects');
    for (const project of projects) {
      const messageCount = this.get(
        'SELECT COUNT(*) AS cnt FROM chat_messages WHERE project_id = ? AND conversation_id IS NULL',
        [project.id],
      );
      if (!messageCount || messageCount.cnt === 0) continue;

      let conversation = this.get(
        'SELECT id FROM conversations WHERE project_id = ? AND title = ?',
        [project.id, '默认对话'],
      );

      if (!conversation) {
        const now = nowIso();
        const convId = this.insert(
          'INSERT INTO conversations (project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
          [project.id, '默认对话', now, now],
        );
        conversation = { id: convId };
      }

      this.db.run(
        'UPDATE chat_messages SET conversation_id = ? WHERE project_id = ? AND conversation_id IS NULL',
        [conversation.id, project.id],
      );
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
    if (this.shouldPersistAfterStatement(sql)) this.persist();
  }

  runBatch(statements = []) {
    const validStatements = Array.isArray(statements)
      ? statements.filter((statement) => String(statement?.sql || '').trim())
      : [];
    if (validStatements.length === 0) return;
    let changed = false;
    this.db.run('BEGIN TRANSACTION');
    try {
      for (const statement of validStatements) {
        this.db.run(statement.sql, statement.params || []);
        if (this.shouldPersistAfterStatement(statement.sql)) changed = true;
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
    if (changed) this.persist();
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
    if (this.shouldPersistAfterStatement(sql)) this.persist();
    return id;
  }

  shouldPersistAfterStatement(sql) {
    const command = firstSqlCommand(sql);
    if (READ_ONLY_SQL_COMMANDS.has(command)) return false;
    if (ROW_MODIFYING_SQL_COMMANDS.has(command) && typeof this.db.getRowsModified === 'function') {
      return this.db.getRowsModified() > 0;
    }
    return true;
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

function firstSqlCommand(sql) {
  return String(sql || '').trim().split(/\s+/, 1)[0].toUpperCase();
}

module.exports = { AppDatabase, nowIso };
