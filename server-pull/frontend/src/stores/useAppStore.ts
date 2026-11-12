// 应用级状态：时间切片、选中的监测点、大屏模式等（纯 UI 状态，业务数据一律走 React Query）
import { create } from 'zustand'

export type TimeSlice = 'realtime' | number

interface AppState {
  selectedStationId: number | null
  setSelectedStation: (id: number | null) => void
  timeSlice: TimeSlice
  setTimeSlice: (t: TimeSlice) => void
  isDarkMode: boolean
  toggleDarkMode: () => void
  sidebarCollapsed: boolean
  toggleSidebar: () => void
}

export const useAppStore = create<AppState>((set) => ({
  selectedStationId: null,
  setSelectedStation: (id) => set({ selectedStationId: id }),
  timeSlice: 'realtime',
  setTimeSlice: (t) => set({ timeSlice: t }),
  isDarkMode: false,
  toggleDarkMode: () => set((s) => ({ isDarkMode: !s.isDarkMode })),
  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
}))
