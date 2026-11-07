import { ComposerPill, Plugin, createKeyed } from "@opencode/plugin/gui"
import { lastAssistantWithUsage } from "@opencode/client/solid"
import { createSignal, onCleanup } from "solid-js"

/** 实时 TPS 的滚动窗口长度（毫秒） */
const WINDOW_MS = 1000
/** 两次界面刷新的最小间隔（毫秒），避免每个 delta 都触发重渲染 */
const THROTTLE_MS = 100
/** 单步结束后用于展示的采样保留时长（毫秒） */
const KEEP_MS = WINDOW_MS * 5

/** 一次流式增量采样 */
type Point = {
  /** 事件时间戳（毫秒），取自事件的 created 字段 */
  t: number
  /** 本次增量估算出的 token 数 */
  tokens: number
}

/** 单个会话的流式状态 */
type LiveState = {
  points: Point[]
}

/** 按 `${serverId}\n${sessionId}` 维护的流式状态 */
const states = new Map<string, LiveState>()

/** 全局版本号，用于驱动 pill 重算 */
const [tick, setTick] = createSignal(0)

/** 上次触发界面更新的时间 */
let lastBump = 0

/**
 * 估算一段增量文本的 token 数
 * 中日韩字符按 1 token 计，其余按 4 字符 1 token 计
 */
function estimate(text: string): number {
  let wide = 0
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) > 0x2e80) wide++
  }
  return wide + Math.ceil((text.length - wide) / 4)
}

/** 取或创建某个会话的流式状态 */
function stateOf(key: string): LiveState {
  const existing = states.get(key)
  if (existing) return existing
  const created: LiveState = { points: [] }
  states.set(key, created)
  return created
}

/** 记录一次增量，并按需触发界面刷新 */
function record(key: string, t: number, tokens: number) {
  const state = stateOf(key)
  state.points.push({ t, tokens })
  const cutoff = t - KEEP_MS
  while (state.points.length > 0 && state.points[0].t < cutoff) state.points.shift()
  if (t - lastBump >= THROTTLE_MS) {
    lastBump = t
    setTick(tick() + 1)
  }
}

/** 清空某个会话的采样，用于新的一步开始 */
function reset(key: string) {
  states.delete(key)
  setTick(tick() + 1)
}

/** 滚动窗口内的实时 TPS，样本不足时返回 undefined */
function liveRate(key: string): number | undefined {
  const state = states.get(key)
  if (!state || state.points.length < 2) return undefined
  const now = state.points[state.points.length - 1].t
  const from = now - WINDOW_MS
  const window = state.points.filter((point) => point.t >= from)
  if (window.length < 2) return undefined
  const span = (now - window[0].t) / 1000
  if (span < 0.2) return undefined
  const tokens = window.reduce((sum, point) => sum + point.tokens, 0)
  return tokens / span
}

/** 按比例格式化为整数百分比，保留 0~100 边界 */
function percent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 100)))
}

export default Plugin.define({
  setup(ctx) {
    // 1. 跟随当前会话切换订阅，流式增量只累加到所属会话
    createKeyed(
      () => {
        const session = ctx.sessions.current()
        return session ? `${session.server.id}\n${session.id}` : undefined
      },
      (key) => {
        const session = ctx.sessions.current()
        if (!session) return
        const data = session.server.data
        const sessionID = session.id

        // 2. 新的一步开始时清空上一轮的采样，避免数字串台
        onCleanup(
          data.on("session.step.started", (event) => {
            if (event.data.sessionID === sessionID) reset(key)
          }),
        )

        // 3. 文本、思考、工具参数都是模型输出，按增量累计
        const collect = (event: { data: { sessionID: string } }, text: string) => {
          if (event.data.sessionID !== sessionID) return
          record(key, Date.now(), estimate(text))
        }

        onCleanup(
          data.on("session.text.delta", (event) => collect(event, event.data.delta)),
        )
        onCleanup(
          data.on("session.reasoning.delta", (event) => collect(event, event.data.delta)),
        )
        onCleanup(
          data.on("session.tool.input.delta", (event) => collect(event, event.data.delta)),
        )

        // 4. 步结束或会话空闲时清空实时采样，改为展示精确值
        onCleanup(
          data.on("session.step.ended", (event) => {
            if (event.data.sessionID === sessionID) reset(key)
          }),
        )
        onCleanup(
          data.on("session.idle", (event) => {
            if (event.data.sessionID === sessionID) reset(key)
          }),
        )
      },
    )

    // 5. 把 tok/s、缓存命中率、上下文占用挂在输入框上方的 pill 行
    ctx.add(ComposerPill, {
      id: "usage",
      order: 10,
      show: (input) => {
        tick()
        const data = input.session.server.data
        const sessionID = input.session.id
        const key = `${input.session.server.id}\n${sessionID}`

        const info = data.session.get(sessionID)
        const step = lastAssistantWithUsage(
          data.session.message.list(sessionID),
          info?.revert?.messageID,
        )
        const tokens = step?.tokens
        if (!tokens) return undefined

        // 6. 提示词总量 = 未缓存输入 + 缓存读 + 缓存写，缓存命中率按缓存读占比计算
        const prompt = tokens.input + tokens.cache.read + tokens.cache.write
        const cacheHit = prompt > 0 ? tokens.cache.read / prompt : 0

        // 7. 上下文占用按当前填充上下文的那一步统计，上限取模型配置
        const used = prompt + tokens.output + tokens.reasoning
        const models = data.location.model.list(input.session.location)
        const ref = step?.model
        const model = models?.find(
          (item) =>
            item.id === ref?.id ||
            (item.providerID === ref?.providerID && item.modelID === ref?.id),
        )
        const limit = model?.limit.context

        // 8. 生成中的速度用滚动窗口，结束后改用该步的精确 tokens 和耗时
        const streaming = data.session.status(sessionID) === "running"
        const live = streaming ? liveRate(key) : undefined
        const elapsed = step.time.completed ?? step.time.streamed ?? step.time.created
        const settled =
          (tokens.output + tokens.reasoning) / (Math.max(1, elapsed - step.time.created) / 1000)
        const tps = live ?? (Number.isFinite(settled) ? settled : 0)

        const parts = [`${tps.toFixed(0)} tok/s`]
        if (prompt > 0) parts.push(`cache ${percent(cacheHit)}%`)
        if (limit) parts.push(`${percent(used / limit)}%`)

        return {
          label: parts.join(" · "),
          title: ref?.id,
          tone: limit && used / limit >= 0.85 ? "danger" : undefined,
          rows: [
            { id: "input", label: "输入(未缓存)", detail: String(tokens.input) },
            { id: "output", label: "输出", detail: String(tokens.output) },
            { id: "reasoning", label: "思考", detail: String(tokens.reasoning) },
            { id: "cacheRead", label: "缓存读", detail: String(tokens.cache.read) },
            { id: "cacheWrite", label: "缓存写", detail: String(tokens.cache.write) },
            {
              id: "context",
              label: "上下文",
              detail: limit ? `${used} / ${limit}` : String(used),
            },
          ],
        }
      },
    })
  },
})
