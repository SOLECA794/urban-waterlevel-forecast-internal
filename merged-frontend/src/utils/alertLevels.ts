// 预警等级 key → 中文展示名
// 优先匹配动态配置（GET /alert-levels 的 levelKey→name），回退内置预设，最后原样返回
const PRESET_LEVEL_NAMES: Record<string, string> = {
  blue: '蓝色预警',
  yellow: '黄色预警',
  orange: '橙色预警',
  red: '红色预警',
  purple: '紫色预警',
}

export function levelKeyName(
  levelKey: string | null | undefined,
  levels?: { levelKey: string; name: string }[],
): string {
  if (!levelKey) return ''
  const hit = levels?.find((l) => l.levelKey === levelKey)
  return hit?.name ?? PRESET_LEVEL_NAMES[levelKey] ?? levelKey
}
