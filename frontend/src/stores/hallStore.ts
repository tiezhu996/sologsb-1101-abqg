import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { createId, db, readUiPrefs, writeUiPrefs } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  planInsertion,
  sortLayersOuterToInner,
  type LayerAnchor,
  type LayerAnchorSide
} from '@/utils/layerOrder'
import type { Element } from '@/types/element'
import type { Hall, HallStat } from '@/types/hall'
import type { PaintLayer } from '@/types/layer'
import type { Decay } from '@/types/decay'

export type { LayerAnchor, LayerAnchorSide }

/**
 * 殿宇 store：维护殿宇列表、当前选中殿宇，并派生出各殿宇的病害统计。
 */
export const useHallStore = defineStore('hall', () => {
  const hallsTable = useIdbTable<Hall>((database) => database.halls)
  const elementsTable = useIdbTable<Element>((database) => database.elements, { sortByUpdatedAt: false })
  const layersTable = useIdbTable<PaintLayer>((database) => database.layers, { sortByUpdatedAt: false })
  const decaysTable = useIdbTable<Decay>((database) => database.decays)

  const prefs = readUiPrefs()
  const currentHallId = ref<string | null>(prefs.lastHallId)
  const keyword = ref('')
  const eraFilter = ref<string[]>([])
  const structureFilter = ref<string[]>([])

  watch(currentHallId, (value) => {
    writeUiPrefs({ ...readUiPrefs(), lastHallId: value })
  })

  const halls = computed<Hall[]>(() => hallsTable.rows.value)
  const elements = computed<Element[]>(() => elementsTable.rows.value)
  const layers = computed<PaintLayer[]>(() => layersTable.rows.value)
  const decays = computed<Decay[]>(() => decaysTable.rows.value)
  const loading = computed(() => hallsTable.loading.value)

  /** 殿宇表是否已完成首次载入：直链场景用于区分「殿宇不存在」与「尚未读取」 */
  const hallsReady = computed(() => hallsTable.ready.value)

  const currentHall = computed<Hall | null>(
    () => halls.value.find((hall) => hall.id === currentHallId.value) ?? null
  )

  const eraOptions = computed<string[]>(() =>
    Array.from(new Set(halls.value.map((hall) => hall.era).filter((era) => era.length > 0))).sort()
  )

  /** 殿宇 id → 病害记录列表 */
  const decaysByHall = computed<Record<string, Decay[]>>(() => {
    const layerToElement = new Map<string, string>()
    layers.value.forEach((layer) => layerToElement.set(layer.id, layer.elementId))
    const elementToHall = new Map<string, string>()
    elements.value.forEach((element) => elementToHall.set(element.id, element.hallId))

    const grouped: Record<string, Decay[]> = {}
    decays.value.forEach((decay) => {
      const elementId = layerToElement.get(decay.layerId)
      const hallId = elementId ? elementToHall.get(elementId) : undefined
      if (!hallId) return
      if (!grouped[hallId]) grouped[hallId] = []
      grouped[hallId].push(decay)
    })
    return grouped
  })

  const stats = computed<HallStat[]>(() =>
    halls.value.map((hall) => {
      const list = decaysByHall.value[hall.id] ?? []
      const hallElements = elements.value.filter((element) => element.hallId === hall.id)
      const elementIds = new Set(hallElements.map((element) => element.id))
      const layerCount = layers.value.filter((layer) => elementIds.has(layer.elementId)).length
      const repaired = list.filter((decay) => decay.repaired).length
      return {
        hallId: hall.id,
        decayCount: list.length,
        unrepairedCount: list.length - repaired,
        elementCount: hallElements.length,
        layerCount,
        repairedPercent: list.length === 0 ? 0 : Math.round((repaired / list.length) * 100)
      }
    })
  )

  const statMap = computed<Record<string, HallStat>>(() => {
    const map: Record<string, HallStat> = {}
    stats.value.forEach((stat) => {
      map[stat.hallId] = stat
    })
    return map
  })

  /** 殿宇总览的筛选结果（关键字 + 年代 + 结构类型） */
  const filteredHalls = computed<Hall[]>(() =>
    halls.value.filter((hall) => {
      const kw = keyword.value.trim()
      if (kw.length > 0) {
        const haystack = `${hall.name}${hall.era}${hall.roofType}${hall.structureType}`
        if (!haystack.includes(kw)) return false
      }
      if (eraFilter.value.length > 0 && !eraFilter.value.includes(hall.era)) return false
      if (structureFilter.value.length > 0 && !structureFilter.value.includes(hall.structureType)) return false
      return true
    })
  )

  const totalDecay = computed(() => decays.value.length)
  const totalUnrepaired = computed(() => decays.value.filter((decay) => !decay.repaired).length)
  const totalArea = computed(() => decays.value.reduce((sum, decay) => sum + decay.areaCm2, 0))

  function setCurrentHall(id: string | null): void {
    currentHallId.value = id
  }

  async function createElement(
    payload: Omit<Element, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<Element> {
    return elementsTable.create(payload, 'elem')
  }

  async function updateElement(id: string, patch: Partial<Element>): Promise<void> {
    await elementsTable.update(id, patch)
  }

  /**
   * 补录层位：不允许自报层号，而是放在参照层（anchor.layerId）的外侧或内侧，
   * 插入后该构件层位由外至内重新排成连续 1..n；新层之后的层位依次顺移。
   * 层位身份（id）不变，挂在各层上的病害仍留在原物理层。
   * 构件尚无层位时 anchor 可为 null，新层即第 1 层。
   */
  async function insertLayer(
    payload: {
      elementId: string
      patternName: PaintLayer['patternName']
      pigment: PaintLayer['pigment']
      thicknessMm: number
      anchor?: LayerAnchor | null
    }
  ): Promise<PaintLayer> {
    const now = Date.now()
    const newId = createId('lay')
    let created: PaintLayer
    await db.transaction('rw', [db.layers, db.elements], async () => {
      const existing = sortLayersOuterToInner(
        await db.layers.where('elementId').equals(payload.elementId).toArray()
      )
      const anchor = payload.anchor ?? null
      const { insertIndex } = planInsertion(
        existing,
        anchor?.layerId ?? null,
        (anchor?.side ?? 'inside') as LayerAnchorSide
      )
      const orderedIds = existing.map((layer) => layer.id)
      orderedIds.splice(insertIndex, 0, newId)

      const newLevel = orderedIds.indexOf(newId) + 1
      created = {
        id: newId,
        elementId: payload.elementId,
        level: newLevel,
        patternName: payload.patternName,
        pigment: payload.pigment,
        thicknessMm: payload.thicknessMm,
        createdAt: now,
        updatedAt: now
      }

      // 仅改号落点之后的层位；其余层号不动
      const shifts: PaintLayer[] = []
      orderedIds.forEach((id, index) => {
        const targetLevel = index + 1
        const layer = existing.find((item) => item.id === id)
        if (layer && layer.level !== targetLevel) {
          shifts.push({ ...layer, level: targetLevel, updatedAt: now })
        }
      })

      if (shifts.length > 0) await db.layers.bulkPut(shifts)
      await db.layers.put(created)

      const element = await db.elements.get(payload.elementId)
      if (element) {
        const count = orderedIds.length
        if (element.layerCount !== count) {
          await db.elements.put({ ...element, layerCount: count, updatedAt: now })
        }
      }
    })
    return created!
  }

  /** 编辑层位只改做法 / 颜料 / 厚度；层号由补录与作废自动维护，不在这里挪动 */
  async function updateLayer(id: string, patch: Partial<PaintLayer>): Promise<void> {
    const { level: _level, ...rest } = patch
    void _level
    await layersTable.update(id, rest)
  }

  /**
   * 作废层位：连带删除挂在该层上的病害与工序（沿用原级联规则），
   * 同事务内把其余层位由外至内收紧为 1..n，层位 id 不变，病害仍留在原层。
   */
  async function removeLayer(id: string): Promise<void> {
    const layer = layers.value.find((item) => item.id === id)
    const decayIds = decays.value.filter((decay) => decay.layerId === id).map((decay) => decay.id)
    await db.transaction('rw', [db.layers, db.decays, db.repairSteps, db.elements], async () => {
      await db.repairSteps.where('decayId').anyOf(decayIds).delete()
      await db.decays.bulkDelete(decayIds)
      await db.layers.delete(id)

      if (layer) {
        const remaining = await db.layers.where('elementId').equals(layer.elementId).toArray()
        const now = Date.now()
        const updates: PaintLayer[] = []
        sortLayersOuterToInner(remaining).forEach((item, index) => {
          const level = index + 1
          if (item.level !== level) updates.push({ ...item, level, updatedAt: now })
        })
        if (updates.length > 0) await db.layers.bulkPut(updates)

        const element = await db.elements.get(layer.elementId)
        if (element && element.layerCount !== remaining.length) {
          await db.elements.put({ ...element, layerCount: remaining.length, updatedAt: now })
        }
      }
    })
  }

  /** 级联删除构件及其层位、病害、工序 */
  async function removeElement(id: string): Promise<void> {
    const layerIds = layersOfElement(id).map((layer) => layer.id)
    const decayIds = decays.value.filter((decay) => layerIds.includes(decay.layerId)).map((decay) => decay.id)
    await db.transaction(
      'rw',
      [db.elements, db.layers, db.decays, db.repairSteps],
      async () => {
        await db.repairSteps.where('decayId').anyOf(decayIds).delete()
        await db.decays.bulkDelete(decayIds)
        await db.layers.bulkDelete(layerIds)
        await db.elements.delete(id)
      }
    )
  }

  /** 层位数量变化后回写构件 layerCount，保证卡片回显一致 */
  async function syncLayerCount(elementId: string): Promise<void> {
    const count = layers.value.filter((layer) => layer.elementId === elementId).length
    const element = elements.value.find((item) => item.id === elementId)
    if (element && element.layerCount !== count) {
      await elementsTable.update(elementId, { layerCount: count } as Partial<Element>)
    }
  }

  function resetFilters(): void {
    keyword.value = ''
    eraFilter.value = []
    structureFilter.value = []
  }

  async function createHall(payload: Omit<Hall, 'id' | 'createdAt' | 'updatedAt'>): Promise<Hall> {
    const hall = await hallsTable.create(payload, 'hall')
    currentHallId.value = hall.id
    return hall
  }

  async function updateHall(id: string, patch: Partial<Hall>): Promise<void> {
    await hallsTable.update(id, patch)
  }

  /** 级联删除：殿宇 → 构件 → 层位 → 病害 → 工序 */
  async function removeHall(id: string): Promise<void> {
    const elementIds = elements.value.filter((element) => element.hallId === id).map((element) => element.id)
    const layerIds = layers.value
      .filter((layer) => elementIds.includes(layer.elementId))
      .map((layer) => layer.id)
    const decayIds = decays.value.filter((decay) => layerIds.includes(decay.layerId)).map((decay) => decay.id)
    await db.transaction(
      'rw',
      [db.halls, db.elements, db.layers, db.decays, db.repairSteps],
      async () => {
        await db.repairSteps.where('decayId').anyOf(decayIds).delete()
        await db.decays.bulkDelete(decayIds)
        await db.layers.bulkDelete(layerIds)
        await db.elements.bulkDelete(elementIds)
        await db.halls.delete(id)
      }
    )
    if (currentHallId.value === id) currentHallId.value = null
  }

  function elementById(id: string): Element | undefined {
    return elements.value.find((element) => element.id === id)
  }

  function hallById(id: string): Hall | undefined {
    return halls.value.find((hall) => hall.id === id)
  }

  function layersOfElement(elementId: string): PaintLayer[] {
    return layers.value
      .filter((layer) => layer.elementId === elementId)
      .sort((a, b) => a.level - b.level)
  }

  function decaysOfLayer(layerId: string): Decay[] {
    return decays.value.filter((decay) => decay.layerId === layerId)
  }

  function elementDecayCount(elementId: string): number {
    const layerIds = layersOfElement(elementId).map((layer) => layer.id)
    return decays.value.filter((decay) => layerIds.includes(decay.layerId)).length
  }

  return {
    halls,
    elements,
    layers,
    decays,
    loading,
    hallsReady,
    currentHallId,
    currentHall,
    keyword,
    eraFilter,
    structureFilter,
    eraOptions,
    stats,
    statMap,
    decaysByHall,
    filteredHalls,
    totalDecay,
    totalUnrepaired,
    totalArea,
    setCurrentHall,
    resetFilters,
    createHall,
    updateHall,
    removeHall,
    createElement,
    updateElement,
    removeElement,
    insertLayer,
    updateLayer,
    removeLayer,
    syncLayerCount,
    elementById,
    hallById,
    layersOfElement,
    decaysOfLayer,
    elementDecayCount
  }
})
