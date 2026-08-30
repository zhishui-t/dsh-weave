import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { WeaveDatabase } from './persistence/weave-database.js'

/**
 * P0-KBLD-009 知识目录/元数据模型 — 对应 TDD 2.2（知识模型）、AC-KNOW-001/002/003。
 *
 * 覆盖：
 * - 四层知识目录（project/role/instance/shared）+ 三目录隔离（_agent/_human/_views）；
 * - frontmatter 规范（schema_version="1" 强制 + 必填字段 + 枚举/取值范围校验）；
 * - knowledge_meta 元数据仓库（TDD 2.6.2 DDL 的现有列）；
 * - 生命周期状态机（candidate → active → deprecated | superseded；reject: candidate → deprecated），
 *   **未确认前不写 active**：写入路径只有两条——createCandidate（强制 candidate）与
 *   activate(id, { confirmed: true })（须显式人工确认）。
 */

// ===== 类型（TDD 2.2.1 / 2.2.3 / 2.2.4）=====

export type KnowledgeType = 'doc' | 'skill' | 'guide' | 'pitfall' | 'pattern' | 'other'
export type KnowledgeStatus = 'candidate' | 'active' | 'deprecated' | 'superseded'
export type KnowledgeLayer = 'project' | 'role' | 'instance' | 'shared'
export type Visibility = 'project_only' | 'role_only' | 'instance_only' | 'global'

/** TDD 2.2.2 知识条目 frontmatter（9 个字段全部必填）。 */
export interface KnowledgeFrontmatter {
  schema_version: '1'
  title: string
  type: KnowledgeType
  status: KnowledgeStatus
  confidence: number
  /** YYYY-MM-DD（TDD 2.2.2） */
  created: string
  freshness_score: number
  visibility: Visibility
  tags: string[]
}

/** TDD 2.2.3 知识元数据（superseded_by 为 TDD 接口可选字段；TDD 2.6.2 knowledge_meta 表无对应列，P0 不持久化该字段）。 */
export interface KnowledgeMeta {
  id: string
  path: string
  layer: KnowledgeLayer
  status: KnowledgeStatus
  confidence: number
  freshness_score: number
  last_confirmed: string | null
  model_version: string | null
  created: string
  updated: string
  superseded_by?: string
}

/** 归属（用于解析四层目录路径）。 */
export interface KnowledgeScope {
  projectId?: string
  version?: string
  roleId?: string
  instanceId?: string
}

/** 解析后的知识条目（文件内容 + frontmatter）。 */
export interface KnowledgeFile {
  /** 相对 knowledge 根目录的路径（正斜杠）。 */
  path: string
  frontmatter: KnowledgeFrontmatter
  body: string
}

// ===== 常量 =====

export const REQUIRED_SCHEMA_VERSION = '1'
export const INITIAL_CONFIDENCE = 0.1
export const INITIAL_FRESHNESS_SCORE = 1.0
export const AGENT_DIR = '_agent'
export const HUMAN_DIR = '_human'
export const VIEWS_DIR = '_views'

export const LAYER_VISIBILITY: Record<KnowledgeLayer, Visibility> = {
  project: 'project_only',
  role: 'role_only',
  instance: 'instance_only',
  shared: 'global',
}

const KNOWLEDGE_TYPES: readonly string[] = ['doc', 'skill', 'guide', 'pitfall', 'pattern', 'other']
const KNOWLEDGE_STATUSES: readonly string[] = ['candidate', 'active', 'deprecated', 'superseded']
const VISIBILITIES: readonly string[] = ['project_only', 'role_only', 'instance_only', 'global']

/** 生命周期状态机：FDD 4.6.3 + TDD 2.2.5（reject: candidate → deprecated）。 */
const ALLOWED_TRANSITIONS: Record<KnowledgeStatus, readonly KnowledgeStatus[]> = {
  candidate: ['active', 'deprecated'],
  active: ['deprecated', 'superseded'],
  deprecated: [],
  superseded: [],
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// ===== 路径 =====

const SEGMENT_FORBIDDEN = '/\\:*?"<>|'

/** 目录/文件名单段校验：非空、不含路径分隔符与 Windows 保留字符/控制字符。 */
export function assertSafeSegment(segment: string, label: string): void {
  if (typeof segment !== 'string' || segment.length === 0 || segment === '.' || segment === '..') {
    throw new Error(`${label} 不能为空或 . / .. : ${String(segment)}`)
  }
  for (const ch of segment) {
    if (ch.charCodeAt(0) < 32 || SEGMENT_FORBIDDEN.includes(ch)) {
      throw new Error(`${label} 含非法字符: ${segment}`)
    }
  }
}

/**
 * 解析某层知识在 knowledge 根目录下的相对目录（三目录隔离中的 `_agent` 区）。
 * 与 TDD 3.1.6 目标归属路径一致（统一正斜杠，跨平台稳定）：
 *   project → _agent/projects/{projectId}/{version}
 *   role    → _agent/roles/{roleId}
 *   instance→ _agent/instances/{instanceId}
 *   shared  → _agent/shared
 */
export function agentLayerDir(layer: KnowledgeLayer, scope: KnowledgeScope): string {
  switch (layer) {
    case 'project': {
      const projectId = scope.projectId ?? ''
      const version = scope.version ?? ''
      assertSafeSegment(projectId, 'project_id')
      assertSafeSegment(version, 'version')
      return ['_agent', 'projects', projectId, version].join('/')
    }
    case 'role': {
      const roleId = scope.roleId ?? ''
      assertSafeSegment(roleId, 'role_id')
      return ['_agent', 'roles', roleId].join('/')
    }
    case 'instance': {
      const instanceId = scope.instanceId ?? ''
      assertSafeSegment(instanceId, 'instance_id')
      return ['_agent', 'instances', instanceId].join('/')
    }
    case 'shared':
      return '_agent/shared'
  }
}

/** layer 与 visibility 的归属合法性（TDD 3.1.6 / AC-IMPORT-006）。 */
export function validateVisibility(layer: KnowledgeLayer, visibility: Visibility): string[] {
  const errors: string[] = []
  const expected = LAYER_VISIBILITY[layer]
  if (visibility !== expected) {
    errors.push(`visibility='${visibility}' 与 layer='${layer}' 不匹配，应为 '${expected}'`)
  }
  return errors
}

// ===== frontmatter（简化 YAML 子集：键 + 标量/内联数组，仅面向本模型的 9 字段）=====

/** 解析 Markdown 文件开头的 `---` frontmatter 块；无块时 frontmatter=null。 */
export function parseFrontmatter(text: string): { frontmatter: Record<string, unknown> | null; body: string } {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') {
    return { frontmatter: null, body: text }
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end === -1) {
    return { frontmatter: null, body: text }
  }
  const frontmatter: Record<string, unknown> = {}
  for (const line of lines.slice(1, end)) {
    if (line.trim() === '' || line.trim().startsWith('#')) {
      continue
    }
    const colon = line.indexOf(':')
    if (colon === -1) {
      continue
    }
    const key = line.slice(0, colon).trim()
    const raw = line.slice(colon + 1).trim()
    frontmatter[key] = parseScalar(raw)
  }
  return { frontmatter, body: lines.slice(end + 1).join('\n') }
}

function parseScalar(raw: string): unknown {
  const v = raw.trim()
  if (v === '' || v === '~' || v === 'null') {
    return null
  }
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1)
  }
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim()
    if (inner === '') {
      return []
    }
    return inner.split(',').map((item) => parseScalar(item))
  }
  if (/^-?\d+(\.\d+)?$/.test(v)) {
    return Number(v)
  }
  return v
}

/**
 * 校验 frontmatter（AC-KNOW-002）：9 个必填字段、枚举合法、数值范围、日期格式。
 * @returns ok=true 时 value 为规范化后的强类型 frontmatter。
 */
export function validateFrontmatter(raw: Record<string, unknown>): {
  ok: boolean
  errors: string[]
  value?: KnowledgeFrontmatter
} {
  const errors: string[] = []
  const errorsFor = (...messages: string[]): void => {
    errors.push(...messages)
  }

  if (raw.schema_version === undefined) {
    errorsFor("缺少必填字段 'schema_version'")
  } else if (raw.schema_version !== '1' && raw.schema_version !== 1) {
    errorsFor("'schema_version' 必须为字符串 \"1\"")
  }

  if (typeof raw.title !== 'string' || raw.title.trim() === '') {
    errorsFor("'title' 必填且为非空字符串")
  }
  if (typeof raw.type !== 'string' || !KNOWLEDGE_TYPES.includes(raw.type)) {
    errorsFor(`'type' 必填且为 KnowledgeType（${KNOWLEDGE_TYPES.join('/')}）`)
  }
  if (typeof raw.status !== 'string' || !KNOWLEDGE_STATUSES.includes(raw.status)) {
    errorsFor(`'status' 必填且为 KnowledgeStatus（${KNOWLEDGE_STATUSES.join('/')}）`)
  }
  if (typeof raw.confidence !== 'number' || raw.confidence < 0 || raw.confidence > 1) {
    errorsFor("'confidence' 必填且为 [0,1] 数值")
  }
  if (typeof raw.created !== 'string' || !DATE_RE.test(raw.created)) {
    errorsFor("'created' 必填且为 YYYY-MM-DD 日期")
  }
  if (typeof raw.freshness_score !== 'number' || raw.freshness_score < 0 || raw.freshness_score > 1) {
    errorsFor("'freshness_score' 必填且为 [0,1] 数值")
  }
  if (typeof raw.visibility !== 'string' || !VISIBILITIES.includes(raw.visibility)) {
    errorsFor(`'visibility' 必填且为 Visibility（${VISIBILITIES.join('/')}）`)
  }
  if (!Array.isArray(raw.tags) || !raw.tags.every((tag) => typeof tag === 'string')) {
    errorsFor("'tags' 必填且为 string[]")
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }
  return {
    ok: true,
    errors: [],
    value: {
      schema_version: '1',
      title: raw.title as string,
      type: raw.type as KnowledgeType,
      status: raw.status as KnowledgeStatus,
      confidence: raw.confidence as number,
      created: raw.created as string,
      freshness_score: raw.freshness_score as number,
      visibility: raw.visibility as Visibility,
      tags: raw.tags as string[],
    },
  }
}

const QUOTE_TRIGGERS = ':#[]{},"\'\n\r'

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => formatScalar(item)).join(', ')}]`
  }
  if (typeof value === 'number') {
    return String(value)
  }
  const text = String(value)
  if (
    text === '' ||
    /^-?\d+(\.\d+)?$/.test(text) ||
    /^(true|false|null|~)$/.test(text) ||
    /^\s|\s$/.test(text) ||
    [...text].some((ch) => QUOTE_TRIGGERS.includes(ch))
  ) {
    return JSON.stringify(text)
  }
  return text
}

/** 序列化知识文件文本（frontmatter + 正文）。 */
export function serializeKnowledgeFile(frontmatter: KnowledgeFrontmatter, body: string): string {
  const lines: string[] = ['---']
  lines.push(`schema_version: ${formatScalar(frontmatter.schema_version)}`)
  lines.push(`title: ${formatScalar(frontmatter.title)}`)
  lines.push(`type: ${formatScalar(frontmatter.type)}`)
  lines.push(`status: ${formatScalar(frontmatter.status)}`)
  lines.push(`confidence: ${formatScalar(frontmatter.confidence)}`)
  lines.push(`created: ${formatScalar(frontmatter.created)}`)
  lines.push(`freshness_score: ${formatScalar(frontmatter.freshness_score)}`)
  lines.push(`visibility: ${formatScalar(frontmatter.visibility)}`)
  lines.push(`tags: ${formatScalar(frontmatter.tags)}`)
  lines.push('---')
  lines.push('')
  lines.push(body.replace(/\n+$/, ''))
  return `${lines.join('\n')}\n`
}

// ===== KnowledgeStore（文件 + knowledge_meta 元数据仓库）=====

export interface KnowledgeStoreOptions {
  /** knowledge 根目录（如 ~/.dsh/knowledge；测试传临时目录） */
  rootDir: string
  /** knowledge_meta.db 的 WeaveDatabase（P0-DB-004 交付） */
  metaDb: WeaveDatabase
}

interface KnowledgeMetaRow {
  id: string
  path: string
  layer: string
  status: string
  confidence: number
  freshness_score: number
  last_confirmed: string | null
  model_version: string | null
  created: string
  updated: string
}

export interface CreateCandidateInput {
  layer: KnowledgeLayer
  scope: KnowledgeScope
  filename: string
  /** 不含 status/schema_version/confidence/freshness_score/created（由 store 强制默认值） */
  frontmatter: Omit<
    KnowledgeFrontmatter,
    'schema_version' | 'status' | 'confidence' | 'freshness_score' | 'created'
  >
  body: string
  modelVersion?: string
}

/**
 * KnowledgeStore — 知识目录与元数据模型（AC-KNOW-001/002/003）。
 *
 * 规则：
 * 1. 只允许写 `_agent` 区（四层目录）；`_human` 人工编辑区与 `_views` 动态视图区
 *    仅保证存在，不提供自动写入（Agent 不覆盖人工内容）；
 * 2. createCandidate 强制 status='candidate'（即使入参声明 active），写入的 frontmatter
 *    必须通过校验（schema_version="1" 等 9 个必填字段）；
 * 3. candidate → active 必须显式确认（activate(id, { confirmed: true })），未确认不得写 active；
 * 4. 生命周期转移按 FDD 4.6.3 状态机校验（非法转移直接抛错）；
 * 5. 元数据变更经 metaDb 的单写者队列串行化。
 */
export class KnowledgeStore {
  readonly rootDir: string
  readonly #metaDb: WeaveDatabase
  #ready = false

  constructor(options: KnowledgeStoreOptions) {
    this.rootDir = resolve(options.rootDir)
    this.#metaDb = options.metaDb
    this.#ensureDirs()
  }

  /** 建立三目录隔离结构（含 _agent 四层子目录）。 */
  #ensureDirs(): void {
    for (const dir of [
      join(this.rootDir, AGENT_DIR, 'projects'),
      join(this.rootDir, AGENT_DIR, 'roles'),
      join(this.rootDir, AGENT_DIR, 'instances'),
      join(this.rootDir, AGENT_DIR, 'shared'),
      join(this.rootDir, HUMAN_DIR),
      join(this.rootDir, VIEWS_DIR),
    ]) {
      mkdirSync(dir, { recursive: true })
    }
  }

  agentRoot(): string {
    return join(this.rootDir, AGENT_DIR)
  }

  humanRoot(): string {
    return join(this.rootDir, HUMAN_DIR)
  }

  viewsRoot(): string {
    return join(this.rootDir, VIEWS_DIR)
  }

  /** 目标归属目录（_agent 区，绝对路径），并确保目录存在。 */
  resolveAgentDir(layer: KnowledgeLayer, scope: KnowledgeScope): string {
    const dir = join(this.rootDir, agentLayerDir(layer, scope))
    if (!this.#pathWithin(join(this.rootDir, AGENT_DIR), dir)) {
      throw new Error(`目标目录超出 _agent 区: ${dir}`)
    }
    mkdirSync(dir, { recursive: true })
    return dir
  }

  #pathWithin(base: string, target: string): boolean {
    const rel = relative(resolve(base), resolve(target))
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }

  /** 校验文件名（仅基名、.md 后缀），返回安全文件名。 */
  static safeKnowledgeFilename(filename: string): string {
    assertSafeSegment(filename, 'filename')
    if (!filename.endsWith('.md')) {
      throw new Error(`知识文件必须为 .md 后缀: ${filename}`)
    }
    return filename
  }

  /** 写入 candidate 知识卡片（未确认前不写 active）。返回元数据记录。 */
  async createCandidate(input: CreateCandidateInput): Promise<KnowledgeMeta> {
    await this.#ensureTable()

    // 覆盖/强制默认值：schema_version="1"、status=candidate、confidence=0.1、freshness=1.0、created=今天
    const frontmatter: KnowledgeFrontmatter = {
      schema_version: '1',
      title: input.frontmatter.title,
      type: input.frontmatter.type,
      status: 'candidate',
      confidence: INITIAL_CONFIDENCE,
      created: todayDate(),
      freshness_score: INITIAL_FRESHNESS_SCORE,
      visibility: input.frontmatter.visibility,
      tags: input.frontmatter.tags,
    }
    const visibilityErrors = validateVisibility(input.layer, frontmatter.visibility)
    if (visibilityErrors.length > 0) {
      throw new Error(visibilityErrors.join('；'))
    }
    const check = validateFrontmatter({ ...frontmatter })
    if (!check.ok || !check.value) {
      throw new Error(`frontmatter 校验失败: ${check.errors.join('；')}`)
    }

    const filename = KnowledgeStore.safeKnowledgeFilename(input.filename)
    const dir = this.resolveAgentDir(input.layer, input.scope)
    const absolute = join(dir, filename)
    const id = randomUUID()
    const now = new Date().toISOString()
    const body = input.body ?? ''
    writeFileSync(absolute, serializeKnowledgeFile(frontmatter, body), 'utf8')

    const row: KnowledgeMetaRow = {
      id,
      path: this.#relativePath(absolute),
      layer: input.layer,
      status: 'candidate',
      confidence: frontmatter.confidence,
      freshness_score: frontmatter.freshness_score,
      last_confirmed: null,
      model_version: input.modelVersion ?? null,
      created: now,
      updated: now,
    }
    await this.#upsertMeta(row)
    return this.#toMeta(row)
  }

  #relativePath(absolutePath: string): string {
    return relative(this.rootDir, absolutePath).split('\\').join('/')
  }

  /**
   * 激活：candidate → active。必须显式人工确认（confirmed: true），
   * 否则拒绝并抛错——保证"未确认前不写 active"。
   */
  async activate(id: string, options: { confirmed: boolean }): Promise<KnowledgeMeta> {
    if (options.confirmed !== true) {
      throw new Error(`激活 ${id} 需要显式确认（confirmed: true）；未确认前不写 active`)
    }
    return this.#transition(id, 'active', (now) => ({ last_confirmed: now }))
  }

  /** 驳回：candidate → deprecated（FDD 4.6.3 reject）。 */
  reject(id: string): Promise<KnowledgeMeta> {
    return this.#transition(id, 'deprecated', () => ({}))
  }

  /** 弃用：active → deprecated（FDD 4.6.3 / TDD 2.2.5）。 */
  deprecate(id: string): Promise<KnowledgeMeta> {
    return this.#transition(id, 'deprecated', () => ({}))
  }

  /**
   * 替代：active → superseded（FDD 4.6.3 supersede）。
   * superseded_by 在 TDD 2.6.2 的 knowledge_meta 表中无对应列，仅记录于返回对象；
   * 持久化关联留待 DDL 扩展（P1 F-23）。
   */
  async supersede(id: string, supersededBy: string): Promise<KnowledgeMeta> {
    const meta = await this.#transition(id, 'superseded', () => ({}))
    return { ...meta, superseded_by: supersededBy }
  }

  /** 状态转移公共实现：读取 → 状态机校验 → 更新文件 frontmatter + 元数据。 */
  async #transition(
    id: string,
    next: KnowledgeStatus,
    extra: (now: string) => Partial<Pick<KnowledgeMetaRow, 'last_confirmed'>>,
  ): Promise<KnowledgeMeta> {
    await this.#ensureTable()
    const current = await this.#getRow(id)
    if (!current) {
      throw new Error(`知识不存在: ${id}`)
    }
    const from = current.status as KnowledgeStatus
    if (!ALLOWED_TRANSITIONS[from]?.includes(next)) {
      throw new Error(`非法状态转移: ${from} → ${next}`)
    }

    const now = new Date().toISOString()
    const nextRow: KnowledgeMetaRow = {
      ...current,
      status: next,
      updated: now,
      ...extra(now),
    }

    // 同步文件 frontmatter（knowledge_meta 与卡片保持一致）
    const absolute = join(this.rootDir, current.path)
    if (!existsSync(absolute)) {
      throw new Error(`知识文件不存在: ${absolute}`)
    }
    const parsed = parseFrontmatter(readFileSync(absolute, 'utf8'))
    const validated = parsed.frontmatter ? validateFrontmatter(parsed.frontmatter) : null
    if (!validated?.ok || !validated.value) {
      throw new Error(`知识文件 frontmatter 非法: ${absolute}`)
    }
    const fileFm: KnowledgeFrontmatter = { ...validated.value, status: next }
    writeFileSync(absolute, serializeKnowledgeFile(fileFm, parsed.body), 'utf8')

    await this.#upsertMeta(nextRow)
    return this.#toMeta(nextRow)
  }

  /** 读取元数据；不存在返回 null。 */
  async getMeta(id: string): Promise<KnowledgeMeta | null> {
    await this.#ensureTable()
    const row = await this.#getRow(id)
    return row ? this.#toMeta(row) : null
  }

  /** 按层/状态过滤列出元数据。 */
  async listMeta(filter: { layer?: KnowledgeLayer; status?: KnowledgeStatus } = {}): Promise<KnowledgeMeta[]> {
    await this.#ensureTable()
    const clauses: string[] = []
    const params: string[] = []
    if (filter.layer) {
      clauses.push('layer = ?')
      params.push(filter.layer)
    }
    if (filter.status) {
      clauses.push('status = ?')
      params.push(filter.status)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = await this.#metaDb.run((raw) => {
      return raw
        .prepare(`SELECT id, path, layer, status, confidence, freshness_score, last_confirmed, model_version, created, updated FROM knowledge_meta ${where} ORDER BY updated DESC`)
        .all(...params) as unknown as KnowledgeMetaRow[]
    })
    return rows.map((row) => this.#toMeta(row))
  }

  /** 读取知识文件全文（frontmatter + 正文）。 */
  getKnowledgeFile(id: string): KnowledgeFile | null {
    const raw = this.#readFileSyncSafe(id)
    if (!raw) {
      return null
    }
    const parsed = parseFrontmatter(raw.text)
    const validated = parsed.frontmatter ? validateFrontmatter(parsed.frontmatter) : null
    if (!parsed.frontmatter || !validated?.ok || !validated.value) {
      throw new Error(`知识文件 frontmatter 非法: ${id}`)
    }
    return { path: raw.path, frontmatter: validated.value, body: parsed.body }
  }

  /** 读取原始文件文本（无 frontmatter 校验）；供测试/审计使用。 */
  readRaw(id: string): string | null {
    return this.#readFileSyncSafe(id)?.text ?? null
  }

  #readFileSyncSafe(id: string): { path: string; text: string } | null {
    const row = this.#getRowSync(id)
    if (!row) {
      return null
    }
    const absolute = join(this.rootDir, row.path)
    if (!existsSync(absolute)) {
      throw new Error(`知识文件不存在: ${absolute}`)
    }
    return { path: row.path, text: readFileSync(absolute, 'utf8') }
  }

  #getRowSync(id: string): KnowledgeMetaRow | null {
    const prepared = this.#metaDb.raw.prepare(
      'SELECT id, path, layer, status, confidence, freshness_score, last_confirmed, model_version, created, updated FROM knowledge_meta WHERE id = ?',
    )
    return (prepared.get(id) as KnowledgeMetaRow | undefined) ?? null
  }

  async #getRow(id: string): Promise<KnowledgeMetaRow | null> {
    return this.#metaDb.run((raw) => {
      const row = raw
        .prepare(
          'SELECT id, path, layer, status, confidence, freshness_score, last_confirmed, model_version, created, updated FROM knowledge_meta WHERE id = ?',
        )
        .get(id) as KnowledgeMetaRow | undefined
      return row ?? null
    })
  }

  async #upsertMeta(row: KnowledgeMetaRow): Promise<void> {
    await this.#metaDb.run((raw) => {
      raw
        .prepare(
          `INSERT INTO knowledge_meta (id, path, layer, status, confidence, freshness_score, last_confirmed, model_version, created, updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             path = excluded.path,
             layer = excluded.layer,
             status = excluded.status,
             confidence = excluded.confidence,
             freshness_score = excluded.freshness_score,
             last_confirmed = excluded.last_confirmed,
             model_version = excluded.model_version,
             updated = excluded.updated`,
        )
        .run(
          row.id,
          row.path,
          row.layer,
          row.status,
          row.confidence,
          row.freshness_score,
          row.last_confirmed,
          row.model_version,
          row.created,
          row.updated,
        )
    })
  }

  #toMeta(row: KnowledgeMetaRow): KnowledgeMeta {
    return {
      id: row.id,
      path: row.path,
      layer: row.layer as KnowledgeLayer,
      status: row.status as KnowledgeStatus,
      confidence: row.confidence,
      freshness_score: row.freshness_score,
      last_confirmed: row.last_confirmed,
      model_version: row.model_version,
      created: row.created,
      updated: row.updated,
    }
  }

  async #ensureTable(): Promise<void> {
    if (this.#ready) {
      return
    }
    await this.#metaDb.run((raw) => {
      raw.exec(
        `CREATE TABLE IF NOT EXISTS knowledge_meta (
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
        )`,
      )
    })
    this.#ready = true
  }
}

const todayDate = (): string => new Date().toISOString().slice(0, 10)
