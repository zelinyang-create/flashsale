import { ChildProcessWithoutNullStreams, spawn } from "child_process"
import * as path from "path"
import * as readline from "readline"
import { MultiprocessOperation, MultiprocessResult } from "./protocol"
import {
  MULTIPROCESS_PROTOCOL_PREFIX,
  WorkerRequest,
  WorkerResponse,
} from "./protocol"

type PendingRequest = {
  resolve: (results: readonly MultiprocessResult[]) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

const READY_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 120_000
const EXIT_TIMEOUT_MS = 10_000

class AllocationWorker {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, PendingRequest>()
  private readonly readyPromise: Promise<void>
  private readyResolve!: () => void
  private readyReject!: (error: Error) => void
  private readonly readyTimeout: NodeJS.Timeout
  private readonly exitPromise: Promise<void>
  private exitResolve!: () => void
  private sequence = 0
  private stderr = ""
  private failed = false

  constructor(databaseUrl: string, schema: string) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.exitPromise = new Promise<void>((resolve) => {
      this.exitResolve = resolve
    })
    this.readyTimeout = setTimeout(() => {
      this.fail(
        new Error(
          `Allocation worker did not become ready within ${READY_TIMEOUT_MS}ms. ${this.stderr}`.trim()
        )
      )
    }, READY_TIMEOUT_MS)
    const workerPath = path.resolve(__dirname, "worker.ts")
    const tsNodeRegister = require.resolve("ts-node/register/transpile-only")
    this.child = spawn(process.execPath, ["-r", tsNodeRegister, workerPath], {
      cwd: path.resolve(__dirname, "../../../../.."),
      env: {
        ...process.env,
        FLASH_SALE_MP_DATABASE_URL: databaseUrl,
        FLASH_SALE_MP_SCHEMA: schema,
        TS_NODE_PROJECT: path.resolve(
          __dirname,
          "../../../../../tsconfig.json"
        ),
        TS_NODE_TRANSPILE_ONLY: "true",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString()
    })
    readline
      .createInterface({ input: this.child.stdout })
      .on("line", (line) => this.receive(line))
    this.child.once("error", (error) => this.fail(error))
    this.child.once("exit", (code) => {
      this.exitResolve()
      if (code !== 0 || this.pending.size > 0) {
        this.fail(
          new Error(
            `Allocation worker exited with code ${code}. ${this.stderr}`.trim()
          )
        )
      }
    })
  }

  async ready() {
    return await this.readyPromise
  }

  async execute(operations: readonly MultiprocessOperation[]) {
    return await this.request({
      id: ++this.sequence,
      kind: "execute",
      operations,
    })
  }

  async close() {
    if (this.child.exitCode !== null || this.failed) {
      return
    }
    await this.request({ id: ++this.sequence, kind: "shutdown" })
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.child.kill()
        reject(
          new Error(
            `Allocation worker did not exit within ${EXIT_TIMEOUT_MS}ms after shutdown`
          )
        )
      }, EXIT_TIMEOUT_MS)
      void this.exitPromise.then(() => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }

  private request(request: WorkerRequest) {
    return new Promise<readonly MultiprocessResult[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(request.id)
        const error = new Error(
          `Allocation worker request ${request.id} (${request.kind}) timed out after ${REQUEST_TIMEOUT_MS}ms. ${this.stderr}`.trim()
        )
        reject(error)
        this.fail(error)
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(request.id, { resolve, reject, timeout })
      this.child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error) {
          this.fail(error)
        }
      })
    })
  }

  private receive(line: string) {
    if (!line.startsWith(MULTIPROCESS_PROTOCOL_PREFIX)) {
      return
    }
    let response: WorkerResponse
    try {
      response = JSON.parse(
        line.slice(MULTIPROCESS_PROTOCOL_PREFIX.length)
      ) as WorkerResponse
    } catch (error) {
      this.fail(
        new Error(
          `Allocation worker emitted invalid protocol JSON: ${String(error)}`
        )
      )
      return
    }
    if (response.kind === "ready") {
      clearTimeout(this.readyTimeout)
      this.readyResolve()
      return
    }
    if (response.kind === "fatal") {
      this.fail(new Error(response.message))
      return
    }
    const pending = this.pending.get(response.id)
    if (!pending) {
      this.fail(new Error(`Unexpected worker response ${response.id}`))
      return
    }
    this.pending.delete(response.id)
    clearTimeout(pending.timeout)
    pending.resolve(response.results)
  }

  private fail(error: Error) {
    if (this.failed) {
      return
    }
    this.failed = true
    clearTimeout(this.readyTimeout)
    this.readyReject(error)
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout)
      request.reject(error)
    }
    this.pending.clear()
    if (this.child.exitCode === null) {
      this.child.kill()
    }
  }
}

export class AllocationWorkerFleet {
  private constructor(private readonly workers: readonly AllocationWorker[]) {}

  static async create(databaseUrl: string, schema: string, size: number) {
    if (!Number.isInteger(size) || size < 2 || size > 4) {
      throw new Error("Multiprocess allocation tests require 2 to 4 workers")
    }
    const workers = Array.from(
      { length: size },
      () => new AllocationWorker(databaseUrl, schema)
    )
    try {
      await Promise.all(workers.map((worker) => worker.ready()))
    } catch (error) {
      await Promise.allSettled(workers.map((worker) => worker.close()))
      throw error
    }
    return new AllocationWorkerFleet(workers)
  }

  async execute(operations: readonly MultiprocessOperation[]) {
    const batches = this.workers.map(() => [] as MultiprocessOperation[])
    operations.forEach((operation, index) => {
      batches[index % batches.length].push(operation)
    })
    const grouped = await Promise.all(
      this.workers.map((worker, index) => worker.execute(batches[index]))
    )
    const positions = this.workers.map(() => 0)
    return operations.map((_, index) => {
      const workerIndex = index % this.workers.length
      return grouped[workerIndex][positions[workerIndex]++]
    })
  }

  async close() {
    await Promise.all(this.workers.map((worker) => worker.close()))
  }
}
