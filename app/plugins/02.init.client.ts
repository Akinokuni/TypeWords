//@ts-ignore
import VueVirtualScroller from 'vue-virtual-scroller'
import { ENV } from '@/core/config/env.ts'

export default defineNuxtPlugin(async nuxtApp => {
  if (
    !location.href.includes('localhost') &&
    !location.href.includes('192.168') &&
    !location.href.includes('172.16') &&
    !location.href.includes('10.0')
  ) {
    ;(function () {
      var t = document.createElement('script')
      t.src = ENV.LIBS_URL + 't.js?t=' + Date.now()
      document.head.appendChild(t)
    })()
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      void navigator.serviceWorker
        .getRegistrations()
        .then(registrations => Promise.all(registrations.map(registration => registration.unregister())))
        .then(() => {
          if (typeof caches === 'undefined') return
          return caches.keys().then(keys => Promise.all(keys.map(key => caches.delete(key))))
        })
        .then(() => {
          console.log('ServiceWorker cleanup done')
        })
        .catch(error => {
          console.log('ServiceWorker cleanup failed: ', error)
        })
    })
  }

  console.json = function (v: any, space = 0) {
    const json = JSON.stringify(
      v,
      (key, value) => {
        if (Array.isArray(value) && key !== 'nameList') {
          return `__ARRAY__${JSON.stringify(value)}`
        }
        return value
      },
      space
    )
      .replace(/"__ARRAY__(\[.*?\])"/g, (_, arr) => arr)
      // 专门处理 nameList，将其压缩成一行
      .replace(/"nameList": \[\s*([^\]]+)\s*\]/g, (match, content) => {
        // 移除数组内部的换行和多余空格，但保留字符串间的空格
        const compressed = content.replace(/\s*\n\s*/g, ' ').trim()
        return `"nameList": [${compressed}]`
      })

    console.log(json)
    return json
  }
  console.parse = function (v: any) {
    console.log(JSON.parse(v))
  }

  nuxtApp.vueApp.use(VueVirtualScroller)
})
