import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import App from '@/App.vue'
import router from '@/router'
import { stampDbVersion } from '@/utils/db'
import { reconcileLayerLevels } from '@/utils/reconcileLayers'
import '@/styles/main.css'

const app = createApp(App)

Object.entries(ElementPlusIconsVue).forEach(([key, component]) => {
  app.component(key, component)
})

app.use(createPinia())
app.use(router)
app.use(ElementPlus, { locale: zhCn })

stampDbVersion()

// 打开档案时先整理层位：旧档案里的断号 / 重号收紧为由外至内的 1..n，再渲染页面
reconcileLayerLevels()
  .catch((err: unknown) => {
    // 整理失败不应阻断应用，页面侧的插入 / 作废逻辑本身也会保证编号连续
    console.warn('[gbmuralarch] 层位编号整理失败', err)
  })
  .finally(() => {
    app.mount('#app')
  })
