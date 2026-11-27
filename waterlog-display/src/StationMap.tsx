import { useEffect, useMemo, useState } from 'react'
import { CircleMarker, MapContainer, TileLayer, Tooltip, useMap } from 'react-leaflet'
import { latLngBounds } from 'leaflet'
import type { Station } from './types'
import { LEVEL_COLORS } from './types'
import { wgs84ToGcj02 } from './geo'

function depthColor(station: Station) {
  const d = station.actual
  if (d >= station.thresholds.red) return LEVEL_COLORS.red
  if (d >= station.thresholds.orange) return LEVEL_COLORS.orange
  if (d >= station.thresholds.yellow) return LEVEL_COLORS.yellow
  if (d >= station.thresholds.blue) return LEVEL_COLORS.blue
  return LEVEL_COLORS.none
}

function SizeAndBounds({ positions }: { positions: [number, number][] }) {
  const map = useMap()
  useEffect(() => {
    const host = map.getContainer()
    let frame = 0
    const size = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (!host.clientWidth || !host.clientHeight) return
        map.invalidateSize({ animate: false })
        if (positions.length) map.fitBounds(latLngBounds(positions), { paddingTopLeft: [70, 38], paddingBottomRight: [110, 38], maxZoom: 13, animate: false })
      })
    }
    const observer = new ResizeObserver(size)
    observer.observe(host)
    document.addEventListener('visibilitychange', size)
    window.addEventListener('resize', size)
    size()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      document.removeEventListener('visibilitychange', size)
      window.removeEventListener('resize', size)
    }
  }, [map, positions])
  return null
}

export function StationMap({ stations, selectedId, onSelect }: { stations: Station[]; selectedId?: string; onSelect?: (id: string) => void }) {
  const [tileError, setTileError] = useState(false)
  const sites = useMemo(() => stations.filter(s => Number.isFinite(s.lon) && Number.isFinite(s.lat) && Math.abs(s.lat) <= 85 && Math.abs(s.lon) <= 180).map(station => {
    const [lon, lat] = wgs84ToGcj02(station.lon, station.lat)
    return { station, position: [lat, lon] as [number, number] }
  }), [stations])
  const positions = useMemo(() => sites.map(s => s.position), [sites])
  return <div className="station-map" style={{ position: 'relative', width: '100%', height: '100%', minHeight: 240, overflow: 'hidden', background: '#edf3f5' }} aria-label="积水站点分布交互地图">
    <style>{`.station-map .leaflet-container{font-family:inherit;background:#edf3f5}.station-map .station-label{border:1px solid #d5e0e8;border-radius:3px;box-shadow:0 2px 5px #18354b12;background:#fff;color:#18354b;font-size:10px;line-height:1.4;padding:3px 6px;font-weight:600;white-space:nowrap}.station-map .station-label:before{display:none}.station-map .station-label.selected{border-color:#18354b;border-width:2px;box-shadow:0 2px 12px #18354b44}.station-map .leaflet-control-attribution{font-size:8px;background:#ffffffd9;color:#526b7c}`}</style>
    <MapContainer center={positions[0] ?? [39.9, 116.4]} zoom={10} style={{ width: '100%', height: '100%', minHeight: 240 }} zoomControl={false} attributionControl={true} dragging={false} scrollWheelZoom={false} doubleClickZoom={false} touchZoom={false} boxZoom={false} keyboard={false}>
      <TileLayer url="https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}" subdomains={['1', '2', '3', '4']} attribution="&copy; 高德地图" eventHandlers={{ tileerror: () => setTileError(true) }} />
      <SizeAndBounds positions={positions} />
      {sites.map(({ station, position }, index) => {
        const selected = station.id === selectedId
        const radius = (5 + Math.min(10, Math.sqrt(Math.max(0, Number.isFinite(station.actual) ? station.actual : 0)) * 10)) * (selected ? 1.35 : 1)
        return <CircleMarker key={station.id} center={position} radius={radius}
          pathOptions={{ color: selected ? '#18354b' : '#fff', weight: selected ? 3 : 2, fillColor: depthColor(station), fillOpacity: 0.95, opacity: 1 }}
          eventHandlers={{ click: () => onSelect?.(station.id) }}>
          <Tooltip permanent direction={index % 2 ? 'left' : 'right'} offset={[index % 2 ? -8 : 8, 0]} opacity={1} className={`station-label${selected ? ' selected' : ''}`}>{station.name} · {Number.isFinite(station.actual) ? station.actual.toFixed(2) : '—'} m</Tooltip>
        </CircleMarker>
      })}
    </MapContainer>
    {tileError && <div role="status" style={{ position: 'absolute', zIndex: 1000, top: 10, left: 10, background: '#fff', color: '#715329', border: '1px solid #e1cfaa', padding: '6px 10px', fontSize: 11, pointerEvents: 'none' }}>底图暂不可用</div>}
    {!sites.length && <div style={{ position: 'absolute', zIndex: 1000, inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none', color: '#526b7c', fontSize: 13 }}>暂无站点坐标</div>}
  </div>
}
