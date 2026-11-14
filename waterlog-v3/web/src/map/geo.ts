/**
 * 坐标系换算：WGS84 ↔ GCJ-02（火星坐标）。
 *
 * ## 为什么必须有这个文件
 *
 * 站点的经纬度是 GPS 原始坐标（WGS84），高德/腾讯的瓦片是 GCJ-02。
 * 两者在国内偏移 **100~600 米** —— 直接把 WGS84 的经纬度画到高德底图上，
 * 标出来的位置是隔壁小区，不是那个下穿隧道。
 *
 * 这不是精度问题，是「对错」问题：地图上标错位置比不标更糟。
 *
 * ## 算法来源
 *
 * 国测局公开的偏移算法（俗称「火星坐标」），业界通用实现。
 * 它不是一个精确的投影变换，是把 WGS84 做一次非线性扰动得到 GCJ-02，
 * 官方没有公开逆变换，所以 `gcjToWgs` 用迭代逼近。
 *
 * 误差：正向 < 1m，反向迭代三次后 < 0.1m。对「标个点」足够。
 */

const PI = Math.PI
const A = 6378245.0 // 克拉索夫斯基椭球长半轴
const EE = 0.00669342162296594323 // 偏心率平方

/** 国内才偏。境外（含港澳台部分区域）不做扰动，否则会把坐标推到海里。 */
function outOfChina(lon: number, lat: number): boolean {
  return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271
}

function transformLat(x: number, y: number): number {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0
  return ret
}

function transformLon(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0
  return ret
}

/** WGS84 → GCJ-02。画到高德瓦片之前必须过这一步。 */
export function wgs84ToGcj02(lon: number, lat: number): [number, number] {
  if (outOfChina(lon, lat)) return [lon, lat]
  const dLat = transformLat(lon - 105.0, lat - 35.0)
  const dLon = transformLon(lon - 105.0, lat - 35.0)
  const radLat = (lat / 180.0) * PI
  let magic = Math.sin(radLat)
  magic = 1 - EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  const outLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI)
  const outLon = (dLon * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI)
  return [lon + outLon, lat + outLat]
}

/** GCJ-02 → WGS84，迭代逼近（官方未公开逆变换）。 */
export function gcj02ToWgs84(lon: number, lat: number): [number, number] {
  if (outOfChina(lon, lat)) return [lon, lat]
  let wgsLon = lon
  let wgsLat = lat
  for (let i = 0; i < 3; i += 1) {
    const [gLon, gLat] = wgs84ToGcj02(wgsLon, wgsLat)
    wgsLon += lon - gLon
    wgsLat += lat - gLat
  }
  return [wgsLon, wgsLat]
}

/** 两点球面距离（米）。用于「最近站点」「距离当前中心多远」这类判断。 */
export function haversine(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const R = 6371008.8
  const dLat = ((lat2 - lat1) * PI) / 180
  const dLon = ((lon2 - lon1) * PI) / 180
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * PI) / 180) * Math.cos((lat2 * PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
