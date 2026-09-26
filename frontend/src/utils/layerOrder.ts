import type { PaintLayer } from '@/types/layer'

/** 补录层位时，新层相对参照层的位置：outside=外侧（更靠表层、序号更小），inside=内侧（更靠里、序号更大） */
export type LayerAnchorSide = 'outside' | 'inside'

/** 补录层位的定位：放在哪一层（layerId）的外侧或内侧 */
export interface LayerAnchor {
  layerId: string
  side: LayerAnchorSide
}

type OrderableLayer = Pick<PaintLayer, 'id' | 'level' | 'createdAt'>

/**
 * 由外至内稳定排序。
 * 正常数据 level 已连续；旧档案出现重号时，以登记时间早者在外，
 * 仍相同则以 id 字典序兜底，保证任何数据下落点都确定。
 */
export function sortLayersOuterToInner<T extends OrderableLayer>(layers: readonly T[]): T[] {
  return [...layers].sort((a, b) => {
    if (a.level !== b.level) return a.level - b.level
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/**
 * 把一组同构件层位收紧为由外至内的 1..n，返回需要改号的层位副本（level 已更新）。
 * 层位身份（id）不变——病害经 layerId 挂接，重排后仍留在原物理层上。
 * 已连续时返回空数组，便于调用方跳过写库（幂等）。
 */
export function compactLayerLevels<T extends PaintLayer>(layers: readonly T[], stamp: number): T[] {
  const updates: T[] = []
  sortLayersOuterToInner(layers).forEach((layer, index) => {
    const level = index + 1
    if (layer.level !== level) {
      updates.push({ ...layer, level, updatedAt: stamp })
    }
  })
  return updates
}

/** 层号是否已按由外至内排成 1..n 的连续编号（无断号、无重号） */
export function isContiguousOuterToInner<T extends OrderableLayer>(layers: readonly T[]): boolean {
  return sortLayersOuterToInner(layers).every((layer, index) => layer.level === index + 1)
}

export interface InsertionPlan {
  /** 新层插入的 0 基位置（在已有层由外至内序列中的落点） */
  insertIndex: number
  /** 新层的层号（1 基） */
  newLevel: number
}

/**
 * 规划补录落点：插在参照层的外侧或内侧。
 * 构件尚无层位时新层即第 1 层；参照层缺失时退化为补在最内侧。
 */
export function planInsertion<T extends { id: string }>(
  orderedExisting: readonly T[],
  anchorId: string | null,
  side: LayerAnchorSide
): InsertionPlan {
  if (orderedExisting.length === 0) return { insertIndex: 0, newLevel: 1 }
  if (!anchorId) return { insertIndex: orderedExisting.length, newLevel: orderedExisting.length + 1 }
  const index = orderedExisting.findIndex((item) => item.id === anchorId)
  if (index < 0) return { insertIndex: orderedExisting.length, newLevel: orderedExisting.length + 1 }
  const insertIndex = side === 'outside' ? index : index + 1
  return { insertIndex, newLevel: insertIndex + 1 }
}
