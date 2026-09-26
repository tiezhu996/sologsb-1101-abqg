/** 彩画层位：同一构件自外而内的彩画叠压层 */
export type PatternName = '旋子' | '和玺' | '苏式'
export type Pigment = '石青' | '石绿' | '朱砂' | '土黄'

/** 补录层位时的插入方位：外侧更靠近表面，里侧更靠近地仗 */
export type LayerSide = 'outer' | 'inner'

export interface PaintLayer {
  id: string
  elementId: string
  /** 由外至内序号，1 为最外层；由系统维护为 1..N 连续编号，补录/作废时自动顺移收紧 */
  level: number
  patternName: PatternName
  pigment: Pigment
  /** 层位厚度（毫米） */
  thicknessMm: number
  createdAt: number
  updatedAt: number
}

export const PATTERN_NAMES: PatternName[] = ['旋子', '和玺', '苏式']
export const PIGMENTS: Pigment[] = ['石青', '石绿', '朱砂', '土黄']

/**
 * 由外至内的稳定排序：先按层号，断号 / 重号的旧档案再按创建时间与 id 兜底，
 * 保证重排编号前每一层的先后次序是确定的。
 */
export function compareLayersByLevel(a: PaintLayer, b: PaintLayer): number {
  return a.level - b.level || (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id)
}
