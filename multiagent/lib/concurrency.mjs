// multiagent/lib/concurrency.mjs
// 并发治理（Audit §6）：全局并发 limiter、main writer 容量 1 的 mutex、
// 观测并发度（observed_max_concurrency）与 main 写并发（main_write_max_concurrency）。
export class ConcurrencyViolation extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConcurrencyViolation'
  }
}

/** 容量上限并发 limiter：同时最多 limit 个 fn 运行，先到先得队列。 */
export function createLimiter(limit) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`limiter limit must be >= 1 (got ${limit})`)
  let active = 0
  const queue = []
  let waitingResolve = null

  const pump = () => {
    if (active >= limit || queue.length === 0) {
      if (queue.length === 0 && waitingResolve) {
        waitingResolve()
        waitingResolve = null
      }
      return
    }
    const { fn, resolve, reject } = queue.shift()
    active++
    Promise.resolve()
      .then(fn)
      .then(v => { active--; resolve(v); pump() }, e => { active--; reject(e); pump() })
  }

  return {
    get active() { return active },
    get available() { return limit - active },
    run(fn) {
      return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject })
        pump()
      })
    },
    /** 等待所有排队与运行中的任务结束（取消后等待 in-flight cleanup）。 */
    async drain() {
      while (active > 0 || queue.length > 0) {
        if (active === 0 && queue.length > 0) continue // pump 会推进
        await new Promise(r => { waitingResolve = r })
      }
    },
  }
}

/**
 * main writer mutex：容量恒为 1。enter() 返回释放函数；
 * 若已有 main writer 持有（同一时刻第二个 main 节点），抛 ConcurrencyViolation ——
 * 这是 validator 之外的 runtime assertion（Audit §3 不变量 1 / §6 资源规则）。
 */
export function createMainWriterTracker() {
  let held = false
  let maxConcurrent = 0
  return {
    get held() { return held },
    get maxConcurrent() { return maxConcurrent },
    enter(tag = 'main-writer') {
      if (held) {
        throw new ConcurrencyViolation(`parallel main writer attempted (${tag})`)
      }
      held = true
      maxConcurrent = Math.max(maxConcurrent, 1)
      let released = false
      return () => {
        if (released) return
        released = true
        held = false
      }
    },
  }
}

/**
 * 观测并发包装：统计任意时刻同时运行的节点数，返回 {track, observedMax}。
 * track(fn) 在 fn 运行期间 +1/-1。
 */
export function createConcurrencyObserver() {
  let current = 0
  let max = 0
  return {
    get current() { return current },
    get observedMax() { return max },
    async track(fn) {
      current++
      if (current > max) max = current
      try {
        return await fn()
      } finally {
        current--
      }
    },
  }
}