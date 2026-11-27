// Station coordinates are WGS84; Amap tiles use GCJ-02.
const A = 6378245
const EE = 0.00669342162296594323
export function wgs84ToGcj02(lon: number, lat: number): [number, number] {
  if (lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271) return [lon, lat]
  const x = lon - 105, y = lat - 35, p = Math.PI
  let dLat = -100 + 2*x + 3*y + 0.2*y*y + 0.1*x*y + 0.2*Math.sqrt(Math.abs(x))
  dLat += (20*Math.sin(6*x*p) + 20*Math.sin(2*x*p))*2/3
  dLat += (20*Math.sin(y*p) + 40*Math.sin(y*p/3))*2/3
  dLat += (160*Math.sin(y*p/12) + 320*Math.sin(y*p/30))*2/3
  let dLon = 300 + x + 2*y + 0.1*x*x + 0.1*x*y + 0.1*Math.sqrt(Math.abs(x))
  dLon += (20*Math.sin(6*x*p) + 20*Math.sin(2*x*p))*2/3
  dLon += (20*Math.sin(x*p) + 40*Math.sin(x*p/3))*2/3
  dLon += (150*Math.sin(x*p/12) + 300*Math.sin(x*p/30))*2/3
  const rad = lat*p/180, magic = 1 - EE*Math.sin(rad)**2, root = Math.sqrt(magic)
  return [lon + dLon*180/(A/root*Math.cos(rad)*p), lat + dLat*180/((A*(1-EE)/(magic*root))*p)]
}
