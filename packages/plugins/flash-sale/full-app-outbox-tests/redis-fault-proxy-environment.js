/* eslint-env node, es2022 */
/* eslint-disable @medusajs/use-medusa-error-not-generic-error */

const NodeEnvironment = require("jest-environment-node").TestEnvironment
const net = require("node:net")

class RedisFaultProxyEnvironment extends NodeEnvironment {
  async setup() {
    await super.setup()
    const rawUpstream = process.env.FLASH_SALE_TEST_REDIS_URL
    if (!rawUpstream) {
      throw new Error(
        "FLASH_SALE_TEST_REDIS_URL must point to an explicit Redis test instance"
      )
    }
    this.originalRedisUrl = rawUpstream
    this.upstream = new URL(rawUpstream)
    this.available = true
    this.sockets = new Set()
    this.cleanWindow = false
    this.unexpected = []
    this.proxy = net.createServer((downstream) => {
      this.sockets.add(downstream)
      if (!this.available) {
        downstream.destroy()
        this.sockets.delete(downstream)
        return
      }
      const upstream = net.createConnection({
        host: this.upstream.hostname,
        port: Number(this.upstream.port || 6379),
      })
      this.sockets.add(upstream)
      downstream.pipe(upstream).pipe(downstream)
      const cleanup = () => {
        downstream.destroy()
        upstream.destroy()
        this.sockets.delete(downstream)
        this.sockets.delete(upstream)
      }
      downstream.once("error", cleanup)
      upstream.once("error", cleanup)
      downstream.once("close", cleanup)
      upstream.once("close", cleanup)
    })
    await new Promise((resolve, reject) => {
      this.proxy.once("error", reject)
      this.proxy.listen(0, "127.0.0.1", resolve)
    })
    const address = this.proxy.address()
    if (!address || typeof address === "string") {
      throw new Error("Redis fault proxy did not receive a TCP port")
    }
    const proxied = new URL(rawUpstream)
    proxied.hostname = "127.0.0.1"
    proxied.port = String(address.port)
    process.env.FLASH_SALE_TEST_REDIS_URL = proxied.toString()
    this.global.process.env.FLASH_SALE_TEST_REDIS_URL = proxied.toString()

    this.onUnhandledRejection = (reason) => this.capture(reason)
    this.onUncaughtException = (error) => this.capture(error)
    process.on("unhandledRejection", this.onUnhandledRejection)
    process.on("uncaughtExceptionMonitor", this.onUncaughtException)
    this.originalConsoleError = this.global.console.error
    this.global.console.error = (...args) => {
      if (this.cleanWindow) {
        for (const value of args) this.capture(value)
      }
      this.originalConsoleError(...args)
    }

    this.global.__flashSaleRedisFaultProxy = Object.freeze({
      upstreamUrl: rawUpstream,
      proxyUrl: proxied.toString(),
      setAvailable: (available) => {
        this.available = available
        if (!available) {
          for (const socket of this.sockets) socket.destroy()
          this.sockets.clear()
        }
      },
      beginCleanWindow: () => {
        if (!this.cleanWindow) this.unexpected = []
        this.cleanWindow = true
      },
    })
  }

  capture(error) {
    if (!this.cleanWindow) return
    const message = error instanceof Error ? error.stack || error.message : String(error)
    if (/command timed out|ECONNABORTED|Transaction auto-.*could not be found/i.test(message)) {
      this.unexpected.push(message)
    }
  }

  async teardown() {
    this.available = true
    process.removeListener("unhandledRejection", this.onUnhandledRejection)
    process.removeListener("uncaughtExceptionMonitor", this.onUncaughtException)
    this.global.console.error = this.originalConsoleError
    await new Promise((resolve) => {
      this.proxy.close(resolve)
      setTimeout(() => {
        for (const socket of this.sockets) socket.destroy()
        this.sockets.clear()
      }, 1_000).unref()
    })
    process.env.FLASH_SALE_TEST_REDIS_URL = this.originalRedisUrl
    this.global.process.env.FLASH_SALE_TEST_REDIS_URL = this.originalRedisUrl
    const unexpected = [...this.unexpected]
    await super.teardown()
    if (unexpected.length > 0) {
      throw new Error(
        `Redis fixture observed unexpected post-recovery errors:\n${unexpected.join("\n")}`
      )
    }
  }
}

module.exports = RedisFaultProxyEnvironment
