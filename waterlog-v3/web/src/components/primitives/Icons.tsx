/** 图标集：内联 SVG，24 视口 + stroke=currentColor。
 *  不用图标字体/图片的理由：一是离线可用，二是 stroke 能跟着文字色走（深色侧栏里直接变白）。 */

export type IconName =
  | 'map'
  | 'layers'
  | 'bell'
  | 'gauge'
  | 'sliders'
  | 'cpu'
  | 'activity'
  | 'droplet'
  | 'rain'
  | 'arrowUp'
  | 'arrowDown'
  | 'minus'
  | 'check'
  | 'clock'
  | 'refresh'
  | 'external'
  | 'chevronRight'
  | 'sparkles'
  | 'shield'
  | 'database'
  | 'wifi'
  | 'zap'
  | 'target'
  | 'alertTriangle'
  | 'info'

const P: Record<IconName, React.ReactNode> = {
  map: (
    <>
      <path d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20V6.5Z" />
      <path d="M9 4v13.5M15 6.5V20" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 13 9 5 9-5" />
      <path d="m3 17 9 5 9-5" opacity=".45" />
    </>
  ),
  bell: (
    <>
      <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6Z" />
      <path d="M10.5 20a2 2 0 0 0 3 0" />
    </>
  ),
  gauge: (
    <>
      <path d="M4 18a8 8 0 1 1 16 0" />
      <path d="m12 14 4-4" />
      <circle cx="12" cy="15" r="1.6" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </>
  ),
  cpu: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
      <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
    </>
  ),
  activity: <path d="M3 12h3.5l2.5-7 4 14 2.5-7H21" />,
  droplet: <path d="M12 3.5c3.2 3.6 5.5 6.3 5.5 9.2A5.5 5.5 0 0 1 12 18.2a5.5 5.5 0 0 1-5.5-5.5c0-2.9 2.3-5.6 5.5-9.2Z" />,
  rain: (
    <>
      <path d="M7 15a4 4 0 0 1 .6-8 5.5 5.5 0 0 1 10.4 1.4A3.4 3.4 0 0 1 17.5 15H7Z" />
      <path d="M8.5 18.5 7.5 21M12.5 18.5 11.5 21M16.5 18.5 15.5 21" />
    </>
  ),
  arrowUp: <path d="M12 19V5m0 0-6 6m6-6 6 6" />,
  arrowDown: <path d="M12 5v14m0 0 6-6m-6 6-6-6" />,
  minus: <path d="M5 12h14" />,
  check: <path d="m5 13 4.5 4.5L19 7" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4v4h-4" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </>
  ),
  chevronRight: <path d="m9 5 7 7-7 7" />,
  sparkles: (
    <>
      <path d="M12 3.5 13.7 9l5.5 1.7-5.5 1.7L12 18l-1.7-5.6L4.8 10.7 10.3 9 12 3.5Z" />
      <path d="M18.5 15.5 19.3 18l2.5.8-2.5.8-.8 2.4" opacity=".55" />
    </>
  ),
  shield: <path d="M12 3.5 19 6v6c0 4.2-2.9 7.2-7 8.5-4.1-1.3-7-4.3-7-8.5V6l7-2.5Z" />,
  database: (
    <>
      <ellipse cx="12" cy="6.5" rx="7" ry="2.8" />
      <path d="M5 6.5v11c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8v-11" />
      <path d="M5 12c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8" />
    </>
  ),
  wifi: (
    <>
      <path d="M4 9.5a12 12 0 0 1 16 0" />
      <path d="M7 13a8 8 0 0 1 10 0" />
      <path d="M10 16.4a3.6 3.6 0 0 1 4 0" />
      <circle cx="12" cy="19.5" r=".9" fill="currentColor" stroke="none" />
    </>
  ),
  zap: <path d="M13 3 5 13.5h5.5L10 21l8-10.5h-5.5L13 3Z" />,
  target: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.6" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </>
  ),
  alertTriangle: (
    <>
      <path d="M12 4.5 21 20H3L12 4.5Z" />
      <path d="M12 10v4.5" />
      <circle cx="12" cy="17.2" r=".9" fill="currentColor" stroke="none" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5" />
      <circle cx="12" cy="7.8" r=".9" fill="currentColor" stroke="none" />
    </>
  ),
}

export function Icon({
  name,
  size = 16,
  className,
  strokeWidth = 1.75,
}: {
  name: IconName
  size?: number
  className?: string
  strokeWidth?: number
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {P[name]}
    </svg>
  )
}
