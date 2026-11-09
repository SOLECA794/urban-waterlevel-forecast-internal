import { useId } from 'react'
import { LEVEL_LABEL } from '../../domain'
import type { MapPoint } from '../../view/useMapPoints'
import { MAP_H as H, MAP_W as W } from '../../view/useMapPoints'
import { T } from '../../utils/tokens'

/**
 * 抽象底图 + 站点气泡。
 *
 * 为什么不用 MapLibre：离线环境拿不到瓦片，底图一片空白反而比抽象示意图更难读；
 * 站点只有 10 个，抽象示意图 + 等级着色完全够表达「哪个片区在告警」。
 * 底图元素（绿地、河流、主干道）不对应真实地理，作用是给气泡一个城市参照，
 * 让读者能区分「相邻两个站点」和「隔了一条河的两个站点」。
 */

function Basemap({ gid }: { gid: string }) {
  return (
    <g>
      <defs>
        <linearGradient id={`${gid}-bg`} x1="0" y1="0" x2="0.7" y2="1">
          <stop offset="0%" stopColor="#fbfdff" />
          <stop offset="100%" stopColor="#eef5fb" />
        </linearGradient>
      </defs>
      <rect x={0} y={0} width={W} height={H} fill={`url(#${gid}-bg)`} rx={8} />

      <rect x={110} y={318} width={168} height={104} rx={12} fill={T.mapPark} opacity={0.85} />
      <rect x={700} y={48} width={150} height={96} rx={12} fill={T.mapPark} opacity={0.75} />
      <rect x={760} y={330} width={120} height={92} rx={12} fill={T.mapPark} opacity={0.6} />

      {[0, 1, 2].map((i) => (
        <ellipse
          key={`c${i}`}
          cx={500}
          cy={250}
          rx={170 + i * 78}
          ry={95 + i * 42}
          fill="none"
          stroke={T.mapGrid}
          strokeWidth={1}
          strokeDasharray="5 7"
        />
      ))}

      <path d="M -20 402 C 240 382, 520 434, 1020 392" fill="none" stroke={T.mapRoad} strokeWidth={11} strokeLinecap="round" opacity={0.95} />
      <path
        d="M -20 402 C 240 382, 520 434, 1020 392"
        fill="none"
        stroke="#ffffff"
        strokeWidth={2.5}
        strokeDasharray="14 12"
        opacity={0.9}
      />
      <path d="M 566 -20 C 576 150, 522 320, 566 540" fill="none" stroke={T.mapRoad} strokeWidth={8} strokeLinecap="round" opacity={0.9} />

      {/* 河流：外宽内窄两层，读起来像水面而不是一根线 */}
      <path
        d="M -20 138 C 180 118, 300 208, 470 198 S 780 296, 1020 328"
        fill="none"
        stroke={T.mapRiver}
        strokeWidth={36}
        strokeLinecap="round"
        opacity={0.55}
      />
      <path
        d="M -20 138 C 180 118, 300 208, 470 198 S 780 296, 1020 328"
        fill="none"
        stroke={T.mapWater}
        strokeWidth={13}
        strokeLinecap="round"
        opacity={0.5}
      />
      <text x={860} y={352} fontSize={11} fill="#7fa8c9" fontStyle="italic">
        南湖排水渠 →
      </text>
    </g>
  )
}

export interface MapCanvasProps {
  points: readonly MapPoint[]
  hovered: string | null
  onHover: (siteId: string | null) => void
  onPick: (siteId: string) => void
}

export function MapCanvas({ points, hovered, onHover, onPick }: MapCanvasProps) {
  const gid = useId().replace(/:/g, '')

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full mt-2" style={{ maxHeight: 470 }}>
      <Basemap gid={gid} />

      {/* 参考网格：只留很淡的线，够定位又不抢气泡 */}
      {Array.from({ length: 9 }).map((_, i) => (
        <line key={`h${i}`} x1={0} x2={W} y1={(H / 8) * i} y2={(H / 8) * i} stroke={T.mapGrid} strokeWidth={0.6} opacity={0.5} />
      ))}
      {Array.from({ length: 13 }).map((_, i) => (
        <line key={`v${i}`} y1={0} y2={H} x1={(W / 12) * i} x2={(W / 12) * i} stroke={T.mapGrid} strokeWidth={0.6} opacity={0.5} />
      ))}

      {points.map((p) => {
        const color = T.level[p.level]
        const isHover = hovered === p.siteId
        return (
          <g
            key={p.siteId}
            onMouseEnter={() => onHover(p.siteId)}
            onMouseLeave={() => onHover(null)}
            onClick={() => onPick(p.siteId)}
            style={{ cursor: 'pointer' }}
          >
            {/* 光晕：有预警才发，且只用两圈，多了显廉价 */}
            {p.isAlarm && <circle cx={p.x} cy={p.y} r={p.radius + 14} fill={color} opacity={isHover ? 0.16 : 0.09} />}
            <circle cx={p.x} cy={p.y} r={p.radius} fill={color} opacity={isHover ? 0.95 : 0.82} />
            <circle cx={p.x} cy={p.y} r={p.radius} fill="none" stroke="#fff" strokeWidth={2} />
            <circle cx={p.x} cy={p.y} r={p.radius + 4} fill="none" stroke={color} strokeWidth={1} opacity={0.35} />
            <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize={11} fontWeight={700} fill="#fff">
              {p.siteId}
            </text>
            <text
              x={p.x}
              y={p.y + p.radius + 16}
              textAnchor="middle"
              fontSize={11}
              fill={T.text2}
              style={{ paintOrder: 'stroke', stroke: '#fff', strokeWidth: 3 }}
            >
              {p.name}
            </text>
            {p.isAlarm && (
              <text
                x={p.x}
                y={p.y - p.radius - 8}
                textAnchor="middle"
                fontSize={11}
                fontWeight={700}
                fill={T.levelInk[p.level]}
                style={{ paintOrder: 'stroke', stroke: '#fff', strokeWidth: 3 }}
              >
                {p.depth.toFixed(2)}m
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

export const MAP_LEGEND = [
  { color: T.level.red, label: LEVEL_LABEL.red, square: true },
  { color: T.level.orange, label: LEVEL_LABEL.orange, square: true },
  { color: T.level.yellow, label: LEVEL_LABEL.yellow, square: true },
  { color: T.level.blue, label: LEVEL_LABEL.blue, square: true },
  { color: T.level.none, label: '无预警', square: true },
]
