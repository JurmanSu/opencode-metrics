import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

export default defineConfig({
  // 产物直接输出到插件根目录，桌面端按根目录文件名加载 GUI 部分
  plugins: [gui({ outFile: "gui-experimental.cjs" })],
})
