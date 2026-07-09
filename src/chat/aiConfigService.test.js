'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const initSqlJs = require('sql.js');
const { AppDatabase, nowIso } = require('../database');
const {
  createAiConfig,
  deleteAiConfig,
  getAiConfig,
  getLegacyChatConfig,
  listAiConfigs,
  resolveAiConfigForConversation,
  resolveAiConfigForPlanGeneration,
  updateAiConfig,
} = require('./aiConfigService');

describe('aiConfigService create regression', () => {
  it('creates OpenAI, DeepSeek, and Anthropic configs with normalized fields and masked API keys', async () => {
    const fixture = await createDatabaseFixture();
    try {
      const openai = createAiConfig(fixture.db, {
        projectId: fixture.projectId,
        name: '  OpenAI Primary  ',
        provider: 'openai',
        baseUrl: '  https://api.openai.com/v1  ',
        apiKey: 'sk-openai-123456',
        model: '  gpt-4o  ',
        temperature: '0.7',
        thinkingDepth: 'medium',
        thinkingBudgetTokens: 8000,
      });
      assert.equal(openai.name, 'OpenAI Primary');
      assert.equal(openai.provider, 'openai');
      assert.equal(openai.baseUrl, 'https://api.openai.com/v1');
      assert.equal(openai.model, 'gpt-4o');
      assert.equal(openai.temperature, '0.7');
      assert.equal(openai.thinkingDepth, 'medium');
      assert.equal(openai.thinkingBudgetTokens, null);
      assert.equal(openai.hasApiKey, true);
      assert.equal(openai.maskedKey, '····3456');
      assert.equal(Object.prototype.hasOwnProperty.call(openai, 'apiKey'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(openai, 'api_key'), false);

      const deepseek = createAiConfig(fixture.db, {
        projectId: fixture.projectId,
        name: 'DeepSeek Reasoner',
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-deepseek-abcdef',
        model: 'deepseek-reasoner',
        thinkingDepth: 'high',
        thinkingBudgetTokens: 4000,
      });
      assert.equal(deepseek.provider, 'deepseek');
      assert.equal(deepseek.thinkingDepth, 'high');
      assert.equal(deepseek.thinkingBudgetTokens, null);
      assert.equal(deepseek.maskedKey, '····cdef');

      const anthropic = createAiConfig(fixture.db, {
        projectId: fixture.projectId,
        name: 'Anthropic Sonnet',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-ant-987654',
        model: 'claude-sonnet-4-6',
        thinkingDepth: 'high',
        thinkingBudgetTokens: '5000',
      });
      assert.equal(anthropic.provider, 'anthropic');
      assert.equal(anthropic.thinkingDepth, null);
      assert.equal(anthropic.thinkingBudgetTokens, 5000);
      assert.equal(anthropic.maskedKey, '····7654');

      const raw = fixture.db.get('SELECT api_key, project_id FROM ai_configs WHERE id = ?', [openai.id]);
      assert.equal(raw.api_key, 'sk-openai-123456', '真实 API Key 应只保存在数据库内');
      assert.equal(raw.project_id, null, '新建 AI 配置应保存为全局配置');
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects empty names and normalizes invalid providers to openai', async () => {
    const fixture = await createDatabaseFixture();
    try {
      assert.throws(
        () => createAiConfig(fixture.db, { projectId: fixture.projectId, name: '   ' }),
        /配置名称不能为空/,
      );

      const config = createAiConfig(fixture.db, {
        projectId: fixture.projectId,
        name: 'Fallback Provider',
        provider: 'not-a-provider',
        apiKey: '',
      });
      assert.equal(config.provider, 'openai');
      assert.equal(config.hasApiKey, false);
      assert.equal(config.maskedKey, '');
    } finally {
      fixture.cleanup();
    }
  });

  it('creates Codex config with thinkingDepth passthrough, no baseUrl/apiKey requirement, and null thinkingBudgetTokens', async () => {
    const fixture = await createDatabaseFixture();
    try {
      const codex = createAiConfig(fixture.db, {
        projectId: fixture.projectId,
        name: 'Codex Default',
        provider: 'codex',
        apiKey: '',
        thinkingDepth: 'xhigh',
        thinkingBudgetTokens: 16000,
      });
      assert.equal(codex.provider, 'codex');
      assert.equal(codex.thinkingDepth, 'xhigh');
      // codex 无需 HTTP 凭证：不要求 apiKey，baseUrl 保持空串
      assert.equal(codex.hasApiKey, false);
      assert.equal(codex.maskedKey, '');
      assert.equal(codex.baseUrl, '');
      assert.equal(codex.model, '');
      // codex 不支持 thinkingBudgetTokens（仍仅限 anthropic）
      assert.equal(codex.thinkingBudgetTokens, null);

      // 无效 thinkingDepth 规范化为 null
      const codexInvalid = createAiConfig(fixture.db, {
        projectId: fixture.projectId,
        name: 'Codex Invalid Depth',
        provider: 'codex',
        thinkingDepth: 'ultra',
      });
      assert.equal(codexInvalid.thinkingDepth, null);

      // resolveAiConfigForConversation 对 codex 不要求 apiKey/baseUrl
      const resolved = resolveAiConfigForConversation(fixture.db, {
        project_id: fixture.projectId,
        ai_config_id: codex.id,
      });
      assert.equal(resolved.provider, 'codex');
      assert.equal(resolved.apiKey, '');
      assert.equal(resolved.baseUrl, '');
      assert.equal(resolved.thinkingDepth, 'xhigh');
      assert.equal(resolved.thinkingBudgetTokens, null);
    } finally {
      fixture.cleanup();
    }
  });

  it('preserves OpenAI xhigh thinking depth on create and update without exposing API keys', async () => {
    const fixture = await createDatabaseFixture();
    try {
      const created = createAiConfig(fixture.db, {
        projectId: fixture.projectId,
        name: 'OpenAI XHigh',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-openai-xhigh-9999',
        model: 'gpt-4.1',
        temperature: '0.4',
        thinkingDepth: 'xhigh',
        thinkingBudgetTokens: 12000,
      });

      assert.equal(created.provider, 'openai');
      assert.equal(created.thinkingDepth, 'xhigh');
      assert.equal(created.thinkingBudgetTokens, null);
      assert.equal(created.hasApiKey, true);
      assert.equal(created.maskedKey, '····9999');
      assert.equal(Object.prototype.hasOwnProperty.call(created, 'apiKey'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(created, 'api_key'), false);
      assert.equal(
        fixture.db.get('SELECT thinking_depth FROM ai_configs WHERE id = ?', [created.id]).thinking_depth,
        'xhigh',
      );

      const updated = updateAiConfig(fixture.db, created.id, {
        name: 'OpenAI XHigh Updated',
        thinkingDepth: 'xhigh',
        thinkingBudgetTokens: 16000,
      });
      assert.equal(updated.name, 'OpenAI XHigh Updated');
      assert.equal(updated.thinkingDepth, 'xhigh');
      assert.equal(updated.thinkingBudgetTokens, null);
      assert.equal(updated.maskedKey, '····9999');
      assert.equal(Object.prototype.hasOwnProperty.call(updated, 'apiKey'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(updated, 'api_key'), false);

      const raw = fixture.db.get(
        'SELECT api_key, thinking_depth, thinking_budget_tokens FROM ai_configs WHERE id = ?',
        [created.id],
      );
      assert.equal(raw.api_key, 'sk-openai-xhigh-9999');
      assert.equal(raw.thinking_depth, 'xhigh');
      assert.equal(raw.thinking_budget_tokens, null);
    } finally {
      fixture.cleanup();
    }
  });

  it('lists only global AI configs and ignores project-scoped legacy rows', async () => {
    const fixture = await createDatabaseFixture();
    try {
      const created = createAiConfig(fixture.db, {
        projectId: fixture.projectId,
        name: 'Global DeepSeek',
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-global-list-1234',
        model: 'deepseek-chat',
      });
      fixture.db.run(
        `INSERT INTO ai_configs
         (project_id, name, provider, base_url, api_key, model, temperature, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          999,
          'Legacy Project Only',
          'openai',
          'https://api.openai.com',
          'sk-project-only-9999',
          'gpt-4o',
          '0.3',
          nowIso(),
          nowIso(),
        ],
      );

      const currentProjectList = listAiConfigs(fixture.db, fixture.projectId);
      const otherProjectList = listAiConfigs(fixture.db, 999);

      assert.deepEqual(
        currentProjectList.map((config) => config.id),
        otherProjectList.map((config) => config.id),
        '全局 AI 配置列表不应按项目过滤',
      );
      assert.ok(currentProjectList.some((config) => config.id === created.id));
      assert.equal(currentProjectList.some((config) => config.name === 'Legacy Project Only'), false);
      assert.equal(currentProjectList.every((config) => config.projectId === null), true);
    } finally {
      fixture.cleanup();
    }
  });

  it('migrates legacy ai_configs tables before creating configs', async () => {
    const fixture = await createDatabaseFixture({ legacyAiConfigs: true });
    try {
      const columns = fixture.db.all('PRAGMA table_info(ai_configs)').map((column) => column.name);
      assert.ok(columns.includes('thinking_depth'), '旧 ai_configs 表应补齐 thinking_depth 列');
      assert.ok(columns.includes('thinking_budget_tokens'), '旧 ai_configs 表应补齐 thinking_budget_tokens 列');

      const migratedRows = fixture.db.all('SELECT id, project_id, name FROM ai_configs ORDER BY id ASC');
      assert.equal(migratedRows.every((row) => row.project_id === null), true, '旧项目级配置应提升为全局配置');
      assert.deepEqual(
        migratedRows.map((row) => row.name),
        ['Legacy Shared', 'Legacy DeepSeek'],
        '重复的旧项目级配置应去重并保留首条',
      );
      const remapped = fixture.db.get('SELECT ai_config_id FROM conversations WHERE title = ?', [
        'duplicate bound conversation',
      ]);
      assert.equal(remapped.ai_config_id, migratedRows[0].id, '重复配置删除前应先重映射对话绑定');

      const config = createAiConfig(fixture.db, {
        projectId: fixture.projectId,
        name: 'Migrated DeepSeek',
        provider: 'deepseek',
        model: 'deepseek-reasoner',
        thinkingDepth: 'high',
      });
      assert.equal(config.provider, 'deepseek');
      assert.equal(config.thinkingDepth, 'high');
    } finally {
      fixture.cleanup();
    }
  });

  it('keeps legacy chat config empty keys separate from global AI config resolution', async () => {
    const fixture = await createDatabaseFixture();
    try {
      fixture.db.setSetting('chat.apiKey', '');
      const first = fixture.db.get(
        'SELECT id FROM ai_configs WHERE project_id IS NULL ORDER BY id ASC LIMIT 1',
      );
      fixture.db.run(
        `UPDATE ai_configs
         SET name = ?, provider = ?, base_url = ?, api_key = ?, model = ?, temperature = ?, updated_at = ?
         WHERE id = ?`,
        [
          'Global Primary',
          'deepseek',
          'https://api.deepseek.com',
          'sk-global-primary-1234',
          'deepseek-chat',
          '0.2',
          nowIso(),
          first.id,
        ],
      );

      const legacy = getLegacyChatConfig(fixture.db);
      assert.equal(legacy.source, 'legacy-chat-settings');
      assert.equal(legacy.compatibilityOnly, true);
      assert.equal(legacy.hasApiKey, false);
      assert.equal(legacy.maskedKey, '');
      assert.equal(Object.prototype.hasOwnProperty.call(legacy, 'apiKey'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(legacy, 'api_key'), false);

      const resolved = resolveAiConfigForConversation(fixture.db, {
        project_id: fixture.projectId,
        ai_config_id: null,
      });
      assert.equal(resolved.id, first.id);
      assert.equal(resolved.provider, 'deepseek');
      assert.equal(resolved.apiKey, 'sk-global-primary-1234');
      assert.equal(resolved.model, 'deepseek-chat');
    } finally {
      fixture.cleanup();
    }
  });

  it('prefers the conversation-bound AI config over the global default', async () => {
    const fixture = await createDatabaseFixture();
    try {
      const first = fixture.db.get(
        'SELECT id FROM ai_configs WHERE project_id IS NULL ORDER BY id ASC LIMIT 1',
      );
      fixture.db.run(
        `UPDATE ai_configs
         SET name = ?, provider = ?, base_url = ?, api_key = ?, model = ?, temperature = ?, updated_at = ?
        WHERE id = ?`,
        [
          'Global Fallback',
          'openai',
          'https://api.openai.com',
          'sk-global-fallback-1111',
          'gpt-4o',
          '0.3',
          nowIso(),
          first.id,
        ],
      );
      const bound = createAiConfig(fixture.db, {
        projectId: fixture.projectId,
        name: 'Bound DeepSeek',
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-bound-deepseek-2222',
        model: 'deepseek-chat',
        temperature: '0.2',
      });

      const resolved = resolveAiConfigForConversation(fixture.db, {
        project_id: fixture.projectId,
        ai_config_id: bound.id,
      });

      assert.equal(resolved.id, bound.id);
      assert.equal(resolved.provider, 'deepseek');
      assert.equal(resolved.apiKey, 'sk-bound-deepseek-2222');
      assert.equal(resolved.model, 'deepseek-chat');
    } finally {
      fixture.cleanup();
    }
  });

  it('uses switched conversation-bound global AI config for availability and display name', async () => {
    const fixture = await createDatabaseFixture();
    try {
      fixture.db.setSetting('chat.provider', 'openai');
      fixture.db.setSetting('chat.apiKey', '');
      fixture.db.setSetting('chat.model', 'gpt-4o-mini');
      const first = fixture.db.get(
        'SELECT id FROM ai_configs WHERE project_id IS NULL ORDER BY id ASC LIMIT 1',
      );
      fixture.db.run(
        `UPDATE ai_configs
         SET name = ?, provider = ?, base_url = ?, api_key = ?, model = ?, temperature = ?, updated_at = ?
        WHERE id = ?`,
        [
          'Global Empty Default',
          'openai',
          'https://api.openai.com',
          '',
          'gpt-4o-mini',
          '0.3',
          nowIso(),
          first.id,
        ],
      );
      const switched = createAiConfig(fixture.db, {
        projectId: fixture.projectId,
        name: 'Global Bound Available',
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-switched-config-4444',
        model: 'deepseek-chat',
        temperature: '0.2',
      });
      const conversationId = fixture.db.insert(
        'INSERT INTO conversations (project_id, title, ai_config_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [fixture.projectId, 'Switching conversation', first.id, nowIso(), nowIso()],
      );
      fixture.db.run('UPDATE conversations SET ai_config_id = ?, updated_at = ? WHERE id = ?', [
        switched.id,
        nowIso(),
        conversationId,
      ]);

      const legacy = getLegacyChatConfig(fixture.db);
      assert.equal(legacy.compatibilityOnly, true);
      assert.equal(legacy.hasApiKey, false);

      const conversation = fixture.db.get('SELECT * FROM conversations WHERE id = ?', [conversationId]);
      const resolved = resolveAiConfigForConversation(fixture.db, conversation);
      assert.equal(resolved.id, switched.id);
      assert.equal(resolved.name, 'Global Bound Available');
      assert.equal(resolved.provider, 'deepseek');
      assert.equal(resolved.apiKey, 'sk-switched-config-4444');
      assert.equal(resolved.model, 'deepseek-chat');

      const summary = getAiConfig(fixture.db, switched.id);
      assert.equal(summary.name, 'Global Bound Available');
      assert.equal(summary.hasApiKey, true);
      assert.equal(summary.maskedKey, '····4444');
      assert.equal(Object.prototype.hasOwnProperty.call(summary, 'apiKey'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(summary, 'api_key'), false);
    } finally {
      fixture.cleanup();
    }
  });

  it('falls back to the first global AI config when the bound config is missing', async () => {
    const fixture = await createDatabaseFixture();
    try {
      const first = fixture.db.get(
        'SELECT id FROM ai_configs WHERE project_id IS NULL ORDER BY id ASC LIMIT 1',
      );
      fixture.db.run(
        `UPDATE ai_configs
         SET name = ?, provider = ?, base_url = ?, api_key = ?, model = ?, temperature = ?, updated_at = ?
        WHERE id = ?`,
        [
          'Global First',
          'anthropic',
          'https://api.anthropic.com',
          'sk-global-first-3333',
          'claude-sonnet-4-6',
          '0.4',
          nowIso(),
          first.id,
        ],
      );

      const resolved = resolveAiConfigForConversation(fixture.db, {
        project_id: fixture.projectId,
        ai_config_id: 999999,
      });

      assert.equal(resolved.id, first.id);
      assert.equal(resolved.provider, 'anthropic');
      assert.equal(resolved.apiKey, 'sk-global-first-3333');
      assert.equal(resolved.model, 'claude-sonnet-4-6');
    } finally {
      fixture.cleanup();
    }
  });

  it('falls back to built-in defaults when no global AI config exists', async () => {
    const fixture = await createDatabaseFixture();
    try {
      fixture.db.run('DELETE FROM ai_configs');

      const resolved = resolveAiConfigForConversation(fixture.db, {
        project_id: fixture.projectId,
        ai_config_id: 999999,
      });

      assert.equal(resolved.provider, 'openai');
      assert.equal(resolved.baseUrl, 'https://api.openai.com');
      assert.equal(resolved.apiKey, '');
      assert.equal(resolved.model, 'gpt-5.5');
      assert.equal(resolved.temperature, '0.3');

      const planResolved = resolveAiConfigForPlanGeneration(fixture.db);
      assert.equal(planResolved.provider, 'openai');
      assert.equal(planResolved.model, 'gpt-5.5');

      const explicitPlanModel = resolveAiConfigForPlanGeneration(fixture.db, {
        planGenerationModel: 'gpt-4o',
      });
      assert.equal(explicitPlanModel.model, 'gpt-4o');
    } finally {
      fixture.cleanup();
    }
  });

  it('initializes legacy chat defaults and global AI config with the new OpenAI default model', async () => {
    const fixture = await createDatabaseFixture();
    try {
      const legacy = getLegacyChatConfig(fixture.db);
      assert.equal(legacy.model, 'gpt-5.5');

      const row = fixture.db.get(
        'SELECT * FROM ai_configs WHERE project_id IS NULL ORDER BY id ASC LIMIT 1',
      );
      assert.equal(row.provider, 'openai');
      assert.equal(row.model, 'gpt-5.5');

      const resolved = resolveAiConfigForConversation(fixture.db, {
        project_id: fixture.projectId,
        ai_config_id: null,
      });
      assert.equal(resolved.model, 'gpt-5.5');

      const planResolved = resolveAiConfigForPlanGeneration(fixture.db);
      assert.equal(planResolved.model, 'gpt-5.5');
    } finally {
      fixture.cleanup();
    }
  });

  it('migrates legacy chat settings into the global default AI config', async () => {
    const fixture = await createDatabaseFixture({ legacyChatSettings: true });
    try {
      const row = fixture.db.get(
        'SELECT * FROM ai_configs WHERE project_id IS NULL ORDER BY id ASC LIMIT 1',
      );
      assert.equal(row.project_id, null);
      assert.equal(row.provider, 'anthropic');
      assert.equal(row.base_url, 'https://api.anthropic.com');
      assert.equal(row.api_key, 'sk-legacy-chat-9999');
      assert.equal(row.model, 'claude-sonnet-4-6');
      assert.equal(row.temperature, '0.4');

      const summary = getAiConfig(fixture.db, row.id);
      assert.equal(summary.hasApiKey, true);
      assert.equal(summary.maskedKey, '····9999');
      assert.equal(Object.prototype.hasOwnProperty.call(summary, 'apiKey'), false);
    } finally {
      fixture.cleanup();
    }
  });

  it('migrates legacy chat settings without explicit model to the new OpenAI default model', async () => {
    const fixture = await createDatabaseFixture({ legacyChatSettingsWithoutModel: true });
    try {
      const row = fixture.db.get(
        'SELECT * FROM ai_configs WHERE project_id IS NULL ORDER BY id ASC LIMIT 1',
      );
      assert.equal(row.provider, 'openai');
      assert.equal(row.base_url, 'https://api.openai.com');
      assert.equal(row.api_key, 'sk-legacy-openai-5555');
      assert.equal(row.model, 'gpt-5.5');

      const legacy = getLegacyChatConfig(fixture.db);
      assert.equal(legacy.model, 'gpt-5.5');
    } finally {
      fixture.cleanup();
    }
  });

  it('preserves existing API keys when update omits apiKey and clears all conversation bindings on delete', async () => {
    const fixture = await createDatabaseFixture();
    try {
      const fallback = fixture.db.get(
        'SELECT id FROM ai_configs WHERE project_id IS NULL ORDER BY id ASC LIMIT 1',
      );
      fixture.db.run(
        `UPDATE ai_configs
         SET name = ?, provider = ?, base_url = ?, api_key = ?, model = ?, temperature = ?, updated_at = ?
         WHERE id = ?`,
        [
          'Remaining Global',
          'anthropic',
          'https://api.anthropic.com',
          'sk-remaining-global-0000',
          'claude-sonnet-4-6',
          '0.4',
          nowIso(),
          fallback.id,
        ],
      );
      const config = createAiConfig(fixture.db, {
        projectId: fixture.projectId,
        name: 'Editable',
        provider: 'openai',
        apiKey: 'sk-keep-123456',
        model: 'gpt-4o',
      });

      const updated = updateAiConfig(fixture.db, config.id, {
        name: 'Editable Renamed',
        model: 'gpt-4.1',
      });
      assert.equal(updated.name, 'Editable Renamed');
      assert.equal(updated.maskedKey, '····3456');
      assert.equal(
        fixture.db.get('SELECT api_key FROM ai_configs WHERE id = ?', [config.id]).api_key,
        'sk-keep-123456',
        '编辑表单留空并省略 apiKey 时不应覆盖旧密钥',
      );

      const conversationId = fixture.db.insert(
        'INSERT INTO conversations (project_id, title, ai_config_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [fixture.projectId, 'Bound conversation', config.id, nowIso(), nowIso()],
      );
      const otherConversationId = fixture.db.insert(
        'INSERT INTO conversations (project_id, title, ai_config_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [fixture.projectId + 1, 'Other project bound conversation', config.id, nowIso(), nowIso()],
      );
      deleteAiConfig(fixture.db, config.id);
      assert.equal(getAiConfig(fixture.db, config.id), null);
      assert.equal(
        fixture.db.get('SELECT ai_config_id FROM conversations WHERE id = ?', [conversationId]).ai_config_id,
        null,
        '删除配置后关联对话应回退为未绑定配置',
      );
      assert.equal(
        fixture.db.get('SELECT ai_config_id FROM conversations WHERE id = ?', [otherConversationId]).ai_config_id,
        null,
        '全局配置删除后所有项目的关联对话都应清空绑定',
      );
      const resolved = resolveAiConfigForConversation(fixture.db, {
        project_id: fixture.projectId + 1,
        ai_config_id: null,
      });
      assert.equal(resolved.id, fallback.id);
      assert.equal(resolved.provider, 'anthropic');
      assert.equal(resolved.apiKey, 'sk-remaining-global-0000');
    } finally {
      fixture.cleanup();
    }
  });
});

async function createDatabaseFixture(options = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-ai-config-test-'));
  const dbPath = path.join(tempRoot, 'data', 'autoplan.sqlite');
  if (options.legacyAiConfigs) {
    await writeLegacyAiConfigDatabase(dbPath);
  } else if (options.legacyChatSettingsWithoutModel) {
    await writeLegacyOpenAiSettingsWithoutModelDatabase(dbPath);
  } else if (options.legacyChatSettings) {
    await writeLegacyChatSettingsDatabase(dbPath);
  }

  const db = new AppDatabase(dbPath);
  await db.init();
  const projectId = Number(db.get('SELECT id FROM projects ORDER BY id ASC LIMIT 1').id);
  return {
    db,
    projectId,
    cleanup() {
      try {
        db.db?.close?.();
      } catch {
        // sql.js close is best-effort in tests.
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

async function writeLegacyChatSettingsDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', file),
  });
  const db = new SQL.Database();
  db.run('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);');
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of [
    ['chat.provider', 'anthropic'],
    ['chat.baseUrl', 'https://api.anthropic.com'],
    ['chat.apiKey', 'sk-legacy-chat-9999'],
    ['chat.model', 'claude-sonnet-4-6'],
    ['chat.temperature', '0.4'],
  ]) {
    stmt.run([key, value]);
  }
  stmt.free();
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
}

async function writeLegacyOpenAiSettingsWithoutModelDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', file),
  });
  const db = new SQL.Database();
  db.run('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);');
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of [
    ['chat.provider', 'openai'],
    ['chat.baseUrl', 'https://api.openai.com'],
    ['chat.apiKey', 'sk-legacy-openai-5555'],
    ['chat.temperature', '0.3'],
  ]) {
    stmt.run([key, value]);
  }
  stmt.free();
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
}

async function writeLegacyAiConfigDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', file),
  });
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE ai_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      name TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'openai',
      base_url TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      temperature TEXT NOT NULL DEFAULT '0.3',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      title TEXT NOT NULL DEFAULT '',
      ai_config_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const now = '2026-01-01T00:00:00.000Z';
  const insertConfig = db.prepare(
    `INSERT INTO ai_configs
     (project_id, name, provider, base_url, api_key, model, temperature, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertConfig.run([
    1,
    'Legacy Shared',
    'openai',
    'https://api.openai.com',
    'sk-legacy-shared-1111',
    'gpt-4o',
    '0.3',
    now,
    now,
  ]);
  insertConfig.run([
    2,
    'Legacy Shared',
    'openai',
    'https://api.openai.com',
    'sk-legacy-shared-1111',
    'gpt-4o',
    '0.3',
    now,
    now,
  ]);
  insertConfig.run([
    2,
    'Legacy DeepSeek',
    'deepseek',
    'https://api.deepseek.com',
    'sk-legacy-deepseek-2222',
    'deepseek-chat',
    '0.2',
    now,
    now,
  ]);
  insertConfig.free();
  db.run(
    `INSERT INTO conversations (project_id, title, ai_config_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [2, 'duplicate bound conversation', 2, now, now],
  );
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
}
