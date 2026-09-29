import { IS_DEV } from '../config/env'
import { APP_VERSION } from '../config/env'
import { debounce } from '../utils'
import { useBaseStore, useRuntimeStore, useSettingStore } from '../stores'
import { ensureHashGuardBeforeInit } from './useDataSyncPersistence'
import { usePracticeServerBackup } from './usePracticeServerBackup'
import { useOpsSync } from './useOpsSync'
import { checkDrift, markBaseline } from '../utils/opsBridge'
import { onUnmounted } from 'vue'

let unsub: (() => void) | null = null
let unsub2: (() => void) | null = null

/**
 * 应用初始化与同步接线。
 *
 * - 写入统一走 `useOpsSync().dispatch(...)`；此处的 `$subscribe` 只负责
 *   开发期漏改探针与设置项 diff。
 * - 接入 `online` / `offline` 事件与 SSE 通道，恢复连接时先拉增量再推送本地积压。
 * - 后端不可达时使用本机影子副本启动并进入离线模式，不写入默认值。
 */
export function useInit() {
  const store = useBaseStore()
  const settingStore = useSettingStore()
  const runtimeStore = useRuntimeStore()
  const opsSync = useOpsSync()
  const practiceBackup = usePracticeServerBackup()
  let cleanupPracticeBackup: (() => void) | null = null
  let unsubscribeSse: (() => void) | null = null
  let initializing = false // 标记是否正在初始化
  let focus = true

  const onvisibilitychange = async () => {
    focus = !document.hidden
    if (!focus) {
      // 切走：把待提交操作与练习缓存尽量送出（pagehide 还会再试一次带有 keepalive 的通道）
      void opsSync.flushAll()
      void practiceBackup.flushToServer()
      return
    }
    // 回到前台：先拉增量（拿到其他端期间的写入），再推送本地积压
    await opsSync.pullAll()
    await opsSync.flushAll()
  }

  const ononline = async () => {
    // 恢复网络：顺序很关键 —— 先拉后推，避免用旧状态压掉服务端新数据
    await opsSync.pullAll()
    await opsSync.flushAll()
    void practiceBackup.flushToServer()
  }

  const onoffline = () => {
    runtimeStore.syncState = 'offline'
  }

  onUnmounted(() => {
    document.removeEventListener('visibilitychange', onvisibilitychange)
    window.removeEventListener('online', ononline)
    window.removeEventListener('offline', onoffline)
    unsubscribeSse?.()
    cleanupPracticeBackup?.()
  })

  //init 有可能重复执行，因为从老网站导了数据之后需要 init
  async function init() {
    if (initializing) return
    initializing = true
    console.time('init')

    //先清理副作用，避免重复监听
    unsub?.()
    unsub2?.()
    cleanupPracticeBackup?.()
    unsubscribeSse?.()
    document.removeEventListener('visibilitychange', onvisibilitychange)
    window.removeEventListener('online', ononline)
    window.removeEventListener('offline', onoffline)

    await ensureHashGuardBeforeInit()

    // 读取 dict/setting：失败时降级为离线（绝不用默认状态覆盖服务端）
    await store.init()
    await settingStore.init()

    // 接入操作同步：先把离线期间积压的操作推上去，再拉取他人期间的写入
    await opsSync.init()
    markBaseline('dict')
    markBaseline('setting')
    unsubscribeSse = opsSync.subscribe()

    settingStore.load = true
    store.load = true
    console.timeEnd('init')
    initializing = false // 初始化完成

    //启动练习缓存双备份：静止 / 离开页面 / 定时上传到服务器
    cleanupPracticeBackup = practiceBackup.start()

    document.addEventListener('visibilitychange', onvisibilitychange)
    window.addEventListener('online', ononline)
    window.addEventListener('offline', onoffline)

    /**
     * 开发期漏改探针：dict 的写入必须走 opsSync.dispatch。
     * 若指纹漂移却没有任何 dispatch，说明还有直接改 store 的调用点，需要迁移。
     * 生产环境不做任何额外计算。
     */
    unsub = store.$subscribe(
      debounce(() => {
        if (!IS_DEV) return
        if (runtimeStore.globalLoading) return
        if (checkDrift('dict')) {
          console.warn(
            '[sync] 检测到未经 dispatch 的 dict 写入：请改用 opsSync.dispatch()/dispatchOps()，否则该改动不会同步到服务端'
          )
        }
      }, 1500)
    )

    /**
     * 设置项：diff 出变化字段后提交 `setting.patch`，只提交发生变化的字段而不是整份设置。
     */
    unsub2 = settingStore.$subscribe(
      debounce(async () => {
        if (runtimeStore.globalLoading) return
        await opsSync.flushSettingPatch()
      }, 500)
    )

    runtimeStore.isNew = APP_VERSION.version > Number(settingStore.webAppVersion)
    runtimeStore.isError = runtimeStore.syncState === 'unavailable'
    window.umami?.track('host', { host: window.location.host })
  }

  return init
}
