import { defineStore } from 'pinia'
import type { Dict } from '../types'
import { getDefaultDict } from '../types'

/** 同步状态机：在线 / 离线 / 后端不可达 / 同步中 / 存在待选边冲突 */
export type SyncState = 'idle' | 'online' | 'offline' | 'unavailable' | 'syncing' | 'conflict'

export interface RuntimeState {
  disableEventListener: boolean
  modalList: Array<{ id: string | number; close: Function }>
  editDict: Dict
  showDictModal: boolean
  excludeRoutes: any[]
  routeData: any
  isNew: boolean
  isError: boolean
  globalLoading: boolean
  /** 同步状态机：在线 / 离线 / 后端不可达 / 同步中 / 存在待选边冲突 */
  syncState: SyncState
  /** 待提交的操作数量 */
  pendingOps: number
  /** 本端设备标识（审计 / LWW 平局打破） */
  deviceId: string
  /** 最近一次「弹窗选边」的结果，用于界面提示 */
  lastConflictChoice: '' | 'local' | 'server'
  /** 其它端更新了练习会话缓存，需要重新拉取 */
  sessionStale: boolean
}

export const useRuntimeStore = defineStore('runtime', {
  state: (): RuntimeState => {
    return {
      routeData: null,
      disableEventListener: false,
      modalList: [],
      editDict: getDefaultDict(),
      showDictModal: false,
      excludeRoutes: [],
      isNew: false,
      isError: false,
      globalLoading: false,
      syncState: 'idle',
      pendingOps: 0,
      deviceId: '',
      lastConflictChoice: '',
      sessionStale: false,
    }
  },
  getters: {
    isOffline: state => state.syncState === 'offline' || state.syncState === 'unavailable',
    pendingCount: state => state.pendingOps,
  },
  actions: {
    updateExcludeRoutes(val: any) {
      // console.log('val', val)
      if (val.type === 'add') {
        if (!this.excludeRoutes.find(v => v === val.value)) {
          this.excludeRoutes.push(val.value)
        }
      } else {
        let resIndex = this.excludeRoutes.findIndex(v => v === val.value)
        if (resIndex !== -1) {
          this.excludeRoutes.splice(resIndex, 1)
        }
      }
      // console.log('store.excludeRoutes', this.excludeRoutes)
    },
  },
})
