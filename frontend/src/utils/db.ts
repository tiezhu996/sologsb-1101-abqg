import Dexie, { type Table, type Transaction } from 'dexie'
import type { Hall } from '@/types/hall'
import type { Element } from '@/types/element'
import { compareLayersByLevel, type PaintLayer } from '@/types/layer'
import type { Decay } from '@/types/decay'
import type { RepairStep } from '@/types/repair'

/** 本地结构版本号：新增/修改表结构时必须递增，并补充 upgrade 迁移 */
export const DB_VERSION = 3

/** 本地存储键名（localStorage 侧的少量元数据） */
export const LS_KEYS = {
  dbVersion: 'gbmuralarch:db-version',
  lastBackupAt: 'gbmuralarch:last-backup-at',
  uiPrefs: 'gbmuralarch:ui-prefs'
} as const

export interface UiPrefs {
  lastHallId: string | null
  repairSort: 'manual' | 'severity'
}

export const DEFAULT_UI_PREFS: UiPrefs = {
  lastHallId: null,
  repairSort: 'manual'
}

/** 备份文件结构，供 export.ts / BackupView 使用 */
export interface BackupPayload {
  app: 'gbmuralarch'
  dbVersion: number
  exportedAt: string
  halls: Hall[]
  elements: Element[]
  layers: PaintLayer[]
  decays: Decay[]
  repairSteps: RepairStep[]
}

/**
 * 层位编号连续化的核心逻辑（v3 迁移与备份导入共用）：
 * 每个构件的层位按由外至内重排为 1..N 连续编号，断号收紧、重号按稳定次序顺移；
 * 病害按 layerId 挂接，重排只改 level，病害仍留在原层。顺带校正构件 layerCount。
 */
async function normalizeLayerLevelsCore(
  layerTable: Table<PaintLayer, string>,
  elementTable: Table<Element, string>
): Promise<void> {
  const allLayers = await layerTable.toArray()
  const byElement = new Map<string, PaintLayer[]>()
  allLayers.forEach((layer) => {
    const list = byElement.get(layer.elementId)
    if (list) list.push(layer)
    else byElement.set(layer.elementId, [layer])
  })

  const writes: Promise<unknown>[] = []
  byElement.forEach((group) => {
    group.sort(compareLayersByLevel).forEach((layer, index) => {
      const target = index + 1
      if (layer.level !== target) writes.push(layerTable.update(layer.id, { level: target }))
    })
  })

  const elements = await elementTable.toArray()
  elements.forEach((element) => {
    const count = byElement.get(element.id)?.length ?? 0
    if (element.layerCount !== count) writes.push(elementTable.update(element.id, { layerCount: count }))
  })

  await Promise.all(writes)
}

/** 把全部构件的层位编号收紧为连续（导入旧备份后调用；打开旧档案由 v3 迁移自动完成） */
export async function normalizeAllLayerLevels(): Promise<void> {
  await db.transaction('rw', [db.layers, db.elements], () => normalizeLayerLevelsCore(db.layers, db.elements))
}

export class MuralArchDatabase extends Dexie {
  halls!: Table<Hall, string>
  elements!: Table<Element, string>
  layers!: Table<PaintLayer, string>
  decays!: Table<Decay, string>
  repairSteps!: Table<RepairStep, string>

  constructor() {
    super('gbmuralarch')
    this.version(1).stores({
      halls: 'id, name, era, structureType, roofType, updatedAt',
      elements: 'id, hallId, position, status, updatedAt',
      layers: 'id, elementId, level, patternName, pigment',
      decays: 'id, layerId, type, severity, repaired, updatedAt',
      repairSteps: 'id, decayId, seq, state, updatedAt'
    })
    // v2：病害表补充 repairedAt 索引，工序表补充 name 索引
    this.version(2)
      .stores({
        halls: 'id, name, era, structureType, roofType, updatedAt',
        elements: 'id, hallId, position, status, updatedAt',
        layers: 'id, elementId, level, patternName, pigment',
        decays: 'id, layerId, type, severity, repaired, repairedAt, updatedAt',
        repairSteps: 'id, decayId, seq, name, state, updatedAt'
      })
      .upgrade(async (tx) => {
        // 迁移：历史数据 repaired 为 true 但缺少 repairedAt，用 updatedAt 回填
        await tx
          .table<Decay>('decays')
          .toCollection()
          .modify((decay) => {
            if (decay.repaired && !decay.repairedAt) {
              decay.repairedAt = decay.updatedAt ?? Date.now()
            }
            if (typeof decay.repaired !== 'boolean') {
              decay.repaired = false
            }
          })
      })
    // v3：层位编号改由系统维护——旧档案的断号 / 重号按由外至内重排为连续编号，构件层数同步校正
    this.version(DB_VERSION)
      .stores({
        halls: 'id, name, era, structureType, roofType, updatedAt',
        elements: 'id, hallId, position, status, updatedAt',
        layers: 'id, elementId, level, patternName, pigment',
        decays: 'id, layerId, type, severity, repaired, repairedAt, updatedAt',
        repairSteps: 'id, decayId, seq, name, state, updatedAt'
      })
      .upgrade((tx: Transaction) =>
        normalizeLayerLevelsCore(tx.table<PaintLayer, string>('layers'), tx.table<Element, string>('elements'))
      )
  }
}

export const db = new MuralArchDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 清空全部业务表，供「清空本地数据」与导入前的覆盖使用 */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.halls, db.elements, db.layers, db.decays, db.repairSteps],
    async () => {
      await Promise.all([
        db.halls.clear(),
        db.elements.clear(),
        db.layers.clear(),
        db.decays.clear(),
        db.repairSteps.clear()
      ])
    }
  )
}

/** 读取 localStorage 中的 UI 偏好 */
export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs)
    if (!raw) return { ...DEFAULT_UI_PREFS }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      lastHallId: typeof parsed.lastHallId === 'string' ? parsed.lastHallId : null,
      repairSort: parsed.repairSort === 'severity' ? 'severity' : 'manual'
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

/** 写入 localStorage 中的 UI 偏好 */
export function writeUiPrefs(prefs: UiPrefs): void {
  localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs))
}

/** 记录数据库结构版本到 localStorage，便于备份页比对 */
export function stampDbVersion(): void {
  localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
}

export function readStampedDbVersion(): number {
  const raw = localStorage.getItem(LS_KEYS.dbVersion)
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
}

export function stampBackupTime(iso: string): void {
  localStorage.setItem(LS_KEYS.lastBackupAt, iso)
}

export function readLastBackupAt(): string | null {
  return localStorage.getItem(LS_KEYS.lastBackupAt)
}
