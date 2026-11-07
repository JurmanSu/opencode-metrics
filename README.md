# opencode-metrics

OpenCode Desktop 的用量胶囊（GUI 插件）：在输入框上方显示 **tok/s · 缓存命中率 · 上下文占用**。

```
51 tok/s · cache 65% · 3%
```

OpenCode 自带的 tok/s 只存在于终端 TUI（`session.tps`），桌面版没有任何内置吞吐指标，社区插件
[`opencode-tps-meter`](https://github.com/ChiR24/opencode-tps-meter) 也只有 TUI 部分。这个插件补上桌面版这一块。

## 显示内容

| 段 | 含义 | 数据来源 |
| --- | --- | --- |
| `51 tok/s` | 输出速度。流式中按 1 秒滚动窗口实时计算；一步结束后换成该步精确 tokens ÷ 耗时 | `session.text.delta` / `session.reasoning.delta` / `session.tool.input.delta` 增量估算，`session.step.ended` 的 `tokens` 校准 |
| `cache 65%` | 提示词缓存命中率 = `cache.read / (input + cache.read + cache.write)` | 当前填充上下文的那一步的 `tokens` |
| `3%` | 上下文占用 = `(input + cache.read + cache.write + output + reasoning) / limit.context` | `lastAssistantWithUsage` + 模型 `limit.context` |

点击胶囊展开明细：输入（未缓存）、输出、思考、缓存读、缓存写、上下文总量。上下文占用超过 85% 时图标变红。

## 安装

```bash
git clone <this-repo> ~/.config/opencode/plugins/metrics
cd ~/.config/opencode/plugins/metrics
npm install
npm run build
```

然后在全局配置 `~/.config/opencode/opencode.json` 中注册：

```json
{
  "plugins": ["file:///C:/Users/<you>/.config/opencode/plugins/metrics"]
}
```

重启 OpenCode Desktop。之后修改 `src/gui.tsx` 只要 `npm run build`，窗口会热重载。

## 开发

```bash
npm install
npm run build     # 输出 gui-experimental.cjs 到插件根目录
npm run typecheck # tsc --noEmit
```

## 目录结构

```
index.ts              服务端部分（空实现，仅用于让插件被识别）
src/gui.tsx           GUI 部分：ComposerPill 注册与用量计算
gui-experimental.cjs  构建产物，桌面端实际加载的文件
vite.config.ts        @opencode/plugin/gui/vite 预设
```

## 实现要点（踩坑记录）

1. **桌面端只认 `opencode.json`，不认 `cli.json`**。`cli.json` 是终端 TUI 的配置。
2. **本地插件目录不要写 `exports` 映射**。带着 `exports` 时服务端能加载服务端部分，但
   `GET /api/plugin/gui?id=<id>` 返回 404：
   `No active plugin with a ./gui-experimental bundle`。
   去掉 `exports`、改用根目录文件名约定（`index.ts` + `gui-experimental.cjs`）即可被发现。
3. **GUI 产物必须是预构建的 CommonJS**，由 `@opencode/plugin/gui/vite` 预设生成。
4. **缓存命中率要等第一步结束才出现**，流式过程中 provider 还没回报 usage，此时不显示而不是显示 0%。
5. **provider 不透传 `tokens.cache` 时**，`cache` 段会一直不出现。

## 限制

- GUI 插件 API 目前是 experimental（`./gui-experimental`），OpenCode 升级可能需要跟进适配。
- 实时 tok/s 是字符估算：中日韩字符按 1 token、其余按 4 字符 1 token，步结束后由 provider 的精确值替换。
- 子 agent 的会话里不显示胶囊，这是宿主行为。

## License

MIT
