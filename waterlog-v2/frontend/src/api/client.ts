// API 客户端：统一 {code,message,data} 响应，前缀 /api/v1
export const API_BASE: string = import.meta.env.VITE_API_BASE_URL || '/api/v1'

export class ApiError extends Error {
  code: number
  status: number
  constructor(message: string, code: number, status: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

interface RespBody<T> {
  code: number
  message: string
  data: T
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let resp: Response
  try {
    resp = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
      ...init,
    })
  } catch {
    throw new ApiError('网络请求失败：无法连接后端服务', -1, 0)
  }
  let body: RespBody<T>
  try {
    body = await resp.json()
  } catch {
    throw new ApiError(`后端响应解析失败（HTTP ${resp.status}）`, -1, resp.status)
  }
  if (body.code !== 0) {
    throw new ApiError(body.message || `业务错误（code=${body.code}）`, body.code, resp.status)
  }
  return body.data
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: 'GET' }),
  post: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'POST', body: data === undefined ? undefined : JSON.stringify(data) }),
  put: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'PUT', body: data === undefined ? undefined : JSON.stringify(data) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}
