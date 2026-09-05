import type { DatabaseSync } from 'node:sqlite'

import type { DatabaseSchema, DatabaseSchemaStatement } from './weave-database.js'

/**
 * 数据库结构版本号（写入 PRAGMA user_version）。
 * 与配置/frontmatter 的 schema_version "1"（TDD 5.2）对应；
 * 各库在基础版本之上可独立升版（如 core.db v2 起统一注册 team_bindings）。
 */
export const DEFAULT_SCHEMA_VERSION = 1

/** core.db 结构版本：v2 起统一注册 team_bindings（TDD 2.6.8，原由 TeamManager 自建）。 */
export const CORE_SCHEMA_VERSION = 2

/** tasks.db 结构版本：v3 起任务携带 write_scopes（写域提醒）+ revision/attempt_token（乐观并发）。 */
export const TASKS_SCHEMA_VERSION = 3

/** TDD 2.1.4 任务表 DDL */
export const TASKS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    dag_id TEXT NOT NULL DEFAULT '',  -- 所属 DAG（HI-3；与 dags.dag_id 一致；DEFAULT '' 兼容早期编写器）
    session_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    version TEXT NOT NULL,
    description TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT '',   -- DAG 模板阶段名（HI-4，阶段→角色绑定用）
    dependencies TEXT DEFAULT '[]',
    write_scopes TEXT DEFAULT '[]',   -- 写域前缀 JSON 数组（advisory：重叠仅告警不阻断）
    revision INTEGER NOT NULL DEFAULT 0,  -- 乐观并发版本号：治理/attempt 写回每次 +1（迟到写按 expectedRevision 拒绝）
    attempt_token TEXT,               -- attempt 句柄：claim(RUNNING) 签发 UUID；重派/取消/恢复作废（NULL）
    assigned_agent TEXT,
    executor TEXT,
    status TEXT NOT NULL,
    revision_count INTEGER DEFAULT 0,
    max_revisions INTEGER DEFAULT 5,
    feedback_timeout_seconds INTEGER DEFAULT 1800,
    feedback_expires_at TEXT,
    skip_override INTEGER DEFAULT 0,
    skip_reason TEXT,
    fail_count INTEGER DEFAULT 0,
    result TEXT,
    error_type TEXT,
    created_at TEXT,
    updated_at TEXT
)`

/**
 * v2→v3 存量库补列：CREATE TABLE IF NOT EXISTS 对旧表是 no-op，必须条件 ALTER。
 * 谓词查 PRAGMA table_info，列不存在才执行（全新库由建表 DDL 直接带列，跳过）。
 * 注意：migrate 以 user_version>=schema.version 短路——在 0174ebd（v3 仅 write_scopes）
 * 已迁移过的存量库上，本批补列不会随版本门重跑；该形态仅存在于开发期数据库
 * （可重建），生产行随本 v3 组合 DDL 一次到位。
 */
export const TASKS_V3_ADD_WRITE_SCOPES: DatabaseSchemaStatement = {
  sql: "ALTER TABLE tasks ADD COLUMN write_scopes TEXT NOT NULL DEFAULT '[]'",
  when: (db: DatabaseSync): boolean => {
    return !taskColumns(db).includes('write_scopes')
  },
}

/** v3 乐观并发补列（与 write_scopes 同版本 v3，t8 协调）：存量 v2 库升级时随迁移补齐。 */
export const TASKS_V3_ADD_REVISION: DatabaseSchemaStatement = {
  sql: 'ALTER TABLE tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0',
  when: (db: DatabaseSync): boolean => {
    return !taskColumns(db).includes('revision')
  },
}

export const TASKS_V3_ADD_ATTEMPT_TOKEN: DatabaseSchemaStatement = {
  sql: 'ALTER TABLE tasks ADD COLUMN attempt_token TEXT',
  when: (db: DatabaseSync): boolean => {
    return !taskColumns(db).includes('attempt_token')
  },
}

function taskColumns(db: DatabaseSync): string[] {
  return (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((column) => column.name)
}

/** TDD 2.6.6 dags 表（HI-3） */
export const DAGS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS dags (
    dag_id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    version TEXT NOT NULL,
    difficulty TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'created',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)`

/** TDD 2.6.7 edges 表（HI-3）：dag_id + from/to 复合主键 */
export const EDGES_TABLE_DDL = `CREATE TABLE IF NOT EXISTS edges (
    dag_id TEXT NOT NULL,
    from_task_id TEXT NOT NULL,
    to_task_id TEXT NOT NULL,
    PRIMARY KEY (dag_id, from_task_id, to_task_id)
)`

/** TDD 2.5.2 导入任务表 DDL */
export const IMPORT_JOBS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS import_jobs (
    id TEXT PRIMARY KEY,
    original_filename TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'uploaded',
    anydoc_job_id TEXT,
    markdown_path TEXT,
    converted_title TEXT,
    converted_body TEXT,
    target_project_id TEXT,
    target_version TEXT,
    target_role_id TEXT,
    target_instance_id TEXT,
    visibility TEXT NOT NULL,
    candidate_id TEXT,
    error_message TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)`

/** TDD 2.6.1 保温期路由表 DDL */
export const FEEDBACK_ROUTES_TABLE_DDL = `CREATE TABLE IF NOT EXISTS feedback_routes (
    task_id TEXT PRIMARY KEY,
    executor_id TEXT NOT NULL,
    revision_count INTEGER DEFAULT 0,
    status TEXT,
    last_completed_at TEXT,
    closed_at TEXT,
    reopen_count INTEGER DEFAULT 0,
    user_feedback TEXT DEFAULT '[]',
    previous_result TEXT
)`

/** TDD 2.6.2 知识元数据表 DDL */
export const KNOWLEDGE_META_TABLE_DDL = `CREATE TABLE IF NOT EXISTS knowledge_meta (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    layer TEXT NOT NULL,
    status TEXT NOT NULL,
    confidence REAL DEFAULT 0.0,
    freshness_score REAL DEFAULT 1.0,
    last_confirmed TEXT,
    model_version TEXT,
    created TEXT NOT NULL,
    updated TEXT NOT NULL
)`

/** TDD 2.6.3 任务序号表 DDL */
export const TASK_SEQUENCES_TABLE_DDL = `CREATE TABLE IF NOT EXISTS task_sequences (
    project_id TEXT NOT NULL,
    version TEXT NOT NULL,
    next_n INTEGER DEFAULT 1,
    PRIMARY KEY (project_id, version)
)`

/**
 * TDD 2.6.4 熔断表 DDL。
 * state 值域：'BANNED' | 'COOLDOWN' | 'RETIRED'（永久退役：不冷却不过期，
 * 参照 dsh-agent-teams RETIRED_MEMBERS 语义；Ddl 结构不变——state 为自由 TEXT）。
 */
export const BANS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS bans (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    entity_key TEXT NOT NULL,
    reason TEXT,
    failed_count INTEGER DEFAULT 0,
    banned_at TEXT NOT NULL,
    expiry TEXT,
    cooldown_seconds INTEGER DEFAULT 0,
    state TEXT NOT NULL,
    resolved_at TEXT,
    UNIQUE(scope, entity_key)
)`

/** TDD 2.6.5 失败计数表 DDL */
export const FAILURE_COUNTERS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS failure_counters (
    entity_key TEXT PRIMARY KEY,
    count INTEGER DEFAULT 0,
    updated_at TEXT
)`

/** TDD 2.6.8 会话绑定表 DDL（ME-4；统一由 schemas.ts 管理，原 TeamManager 自建） */
export const TEAM_BINDINGS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS team_bindings (
    session_id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
)`

/** 全部核心表 DDL 索引：表名 → 建表语句（TDD 2.x）。 */
export const CORE_TABLE_DDL: Record<string, string> = {
  tasks: TASKS_TABLE_DDL,
  dags: DAGS_TABLE_DDL,
  edges: EDGES_TABLE_DDL,
  import_jobs: IMPORT_JOBS_TABLE_DDL,
  feedback_routes: FEEDBACK_ROUTES_TABLE_DDL,
  knowledge_meta: KNOWLEDGE_META_TABLE_DDL,
  task_sequences: TASK_SEQUENCES_TABLE_DDL,
  bans: BANS_TABLE_DDL,
  failure_counters: FAILURE_COUNTERS_TABLE_DDL,
  team_bindings: TEAM_BINDINGS_TABLE_DDL,
}

/**
 * 按 TDD 2.7 目录模型把核心表拆分到 5 个库文件：
 * tasks.db / core.db / feedback.db / knowledge_meta.db / imports.db
 */
export const DEFAULT_SCHEMAS: Record<
  'tasks' | 'core' | 'feedback' | 'knowledgeMeta' | 'imports',
  DatabaseSchema
> = {
  tasks: {
    version: TASKS_SCHEMA_VERSION,
    statements: [
      TASKS_TABLE_DDL,
      DAGS_TABLE_DDL,
      EDGES_TABLE_DDL,
      TASKS_V3_ADD_WRITE_SCOPES,
      TASKS_V3_ADD_REVISION,
      TASKS_V3_ADD_ATTEMPT_TOKEN,
    ],
  },
  core: {
    version: CORE_SCHEMA_VERSION,
    statements: [TASK_SEQUENCES_TABLE_DDL, BANS_TABLE_DDL, FAILURE_COUNTERS_TABLE_DDL, TEAM_BINDINGS_TABLE_DDL],
  },
  feedback: { version: DEFAULT_SCHEMA_VERSION, statements: [FEEDBACK_ROUTES_TABLE_DDL] },
  knowledgeMeta: { version: DEFAULT_SCHEMA_VERSION, statements: [KNOWLEDGE_META_TABLE_DDL] },
  imports: { version: DEFAULT_SCHEMA_VERSION, statements: [IMPORT_JOBS_TABLE_DDL] },
}
