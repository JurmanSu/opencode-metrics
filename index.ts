import { Plugin } from "@opencode/plugin"

/**
 * 服务端部分：本插件只在桌面端展示用量，服务端不做任何处理
 */
export default Plugin.define({
  id: "metrics",
  async setup() {},
})
