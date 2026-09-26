/** 彩画层位：同一构件自外而内的彩画叠压层 */
export type PatternName = '旋子' | '和玺' | '苏式'
export type Pigment = '石青' | '石绿' | '朱砂' | '土黄'

export interface PaintLayer {
  id: string
  elementId: string
  /** 由外至内层号，1 为最外层；由系统强制维护为该构件内的连续 1..n，补录 / 作废时自动重排，不可手填 */
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
