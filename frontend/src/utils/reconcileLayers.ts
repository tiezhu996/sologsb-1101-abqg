import { db } from '@/utils/db'
import type { Element } from '@/types/element'
import type { PaintLayer } from '@/types/layer'
import { compactLayerLevels } from '@/utils/layerOrder'

export interface ReconcileResult {
  /** 实际改号的层位数 */
  renumberedLayers: number
  /** 层数字段被修正的构件数 */
  fixedElements: number
}

/**
 * 整理全部构件的层位编号：每个构件的层位由外至内收紧为 1..n，
 * 并回写构件 layerCount。层位 id 不变，挂在层上的病害仍留在原层。
 *
 * 幂等：编号已连续、层数已正确时不写库。
 * - Dexie v3 升级时在迁移里做一次（旧档案断号/重号，升级即排好）；
 * - 应用启动时再跑一遍，兜住导入旧备份、手动改过 IndexedDB 等情况，
 *   满足「旧档案里的断号下次打开也排好」。
 */
export async function reconcileLayerLevels(): Promise<ReconcileResult> {
  const [allLayers, allElements] = await Promise.all([
    db.layers.toArray(),
    db.elements.toArray()
  ])

  const layersByElement = new Map<string, PaintLayer[]>()
  allLayers.forEach((layer) => {
    const list = layersByElement.get(layer.elementId)
    if (list) list.push(layer)
    else layersByElement.set(layer.elementId, [layer])
  })

  const now = Date.now()
  const layerUpdates: PaintLayer[] = []
  layersByElement.forEach((layers) => {
    layerUpdates.push(...compactLayerLevels(layers, now))
  })

  const elementUpdates: Element[] = allElements
    .filter((element) => element.layerCount !== (layersByElement.get(element.id)?.length ?? 0))
    .map((element) => ({
      ...element,
      layerCount: layersByElement.get(element.id)?.length ?? 0,
      updatedAt: now
    }))

  if (layerUpdates.length === 0 && elementUpdates.length === 0) {
    return { renumberedLayers: 0, fixedElements: 0 }
  }

  await db.transaction('rw', [db.layers, db.elements], async () => {
    if (layerUpdates.length > 0) await db.layers.bulkPut(layerUpdates)
    if (elementUpdates.length > 0) await db.elements.bulkPut(elementUpdates)
  })

  return {
    renumberedLayers: layerUpdates.length,
    fixedElements: elementUpdates.length
  }
}
