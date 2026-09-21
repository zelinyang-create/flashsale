import { ChildProcessWithoutNullStreams, spawn } from "child_process"
import * as path from "path"
import * as readline from "readline"
import { MultiprocessOperation, MultiprocessResult } from "./protocol"
import { AllocationFaultPoint } from "../../persistence"
import {
  MULTIPROCESS_PROTOCOL_PREFIX,
  WorkerRequest,
  WorkerResponse,
} from "./protocol"

type PendingRequest = {
  resolve: (results: readonly MultiprocessResult[]) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
  expectedFailpoint?: AllocationFaultPoint
  failpointReached?: boolean
  reachResolve?: () => void
  reachReject?: (error: Error) => void
}

export type PendingCrashExecution = Readonly<{
  result: Promise<readonly MultiprocessResult[]>
}>

export type WorkerTerminationObservation = Readonly<{
  kill_issued: true
  exited_after_kill: true
}>

export type WorkerCrashOptions = Readonly<{
  initialKill?: () => boolean
}>

const READY_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 120_000
const EXIT_TIMEOUT_MS = 10_000
const FAILED_CRASH_CLEANUP_TIMEOUT_MS = 1_000
let fleetSequence = 0

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
  private intentionalExit = false
  private closePromise?: Promise<void>

  constructor(
    databaseUrl: string,
    schema: string,
    readonly applicationName: string
  ) {
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
        FLASH_SALE_MP_APPLICATION_NAME: applicationName,
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
      if ((!this.intentionalExit && code !== 0) || this.pending.size > 0) {
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

  async executeUntilFailpoint(
    operation: MultiprocessOperation,
    failpoint: AllocationFaultPoint
  ): Promise<PendingCrashExecution> {
    let reachResolve!: () => void
    let reachReject!: (error: Error) => void
    const reached = new Promise<void>((resolve, reject) => {
      reachResolve = resolve
      reachReject = reject
    })
    const result = this.request(
      {
        id: ++this.sequence,
        kind: "execute_until_failpoint",
        operation,
        failpoint,
      },
      { expectedFailpoint: failpoint, reachResolve, reachReject }
    )
    // The process exit rejects this promise. Attach a handler immediately so
    // a real TerminateProcess cannot create a transient unhandled rejection.
    void result.catch(() => undefined)
    await reached
    return { result }
  }

  async close() {
    this.closePromise ??= this.closeOnce()
    await this.closePromise
  }

  private async closeOnce() {
    if (
      this.child.exitCode !== null ||
      this.child.signalCode !== null ||
      this.failed
    ) {
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

  async crash(
    options: WorkerCrashOptions = {}
  ): Promise<WorkerTerminationObservation> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      throw new Error("Cannot crash an allocation worker that already exited")
    }
    const pending = [...this.pending.values()]
    if (
      pending.length > 0 &&
      (pending.length !== 1 ||
        pending[0].expectedFailpoint === undefined ||
        pending[0].failpointReached !== true)
    ) {
      throw new Error(
        "Crash with pending work requires exactly one request suspended at its failpoint"
      )
    }
    this.intentionalExit = true
    const killIssued = options.initialKill?.() ?? this.child.kill()
    if (!killIssued) {
      return await this.cleanupFailedCrash(
        new Error("Allocation worker kill request was not issued")
      )
    }
    try {
      await this.waitForExit(
        EXIT_TIMEOUT_MS,
        `Allocation worker did not exit within ${EXIT_TIMEOUT_MS}ms after kill`
      )
    } catch (error) {
      return await this.cleanupFailedCrash(
        error instanceof Error ? error : new Error(String(error))
      )
    }
    return { kill_issued: true, exited_after_kill: true }
  }

  private async waitForExit(timeoutMs: number, message: string) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
      void this.exitPromise.then(() => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }

  private async cleanupFailedCrash(error: Error): Promise<never> {
    // Preserve the primary termination error while synchronously marking the
    // worker failed and rejecting every request/reach promise and timer.
    this.fail(error)
    this.child.stdin.destroy()
    this.child.stdout.destroy()
    this.child.stderr.destroy()
    if (this.child.exitCode === null && this.child.signalCode === null) {
      try {
        this.child.kill()
      } catch {
        // Best effort only: the original crash error remains authoritative.
      }
    }
    try {
      await this.waitForExit(
        FAILED_CRASH_CLEANUP_TIMEOUT_MS,
        "Allocation worker failed-crash cleanup timed out"
      )
    } catch {
      // Do not replace the original error or retain an event-loop handle.
      this.child.unref()
    }
    throw error
  }

  private request(
    request: WorkerRequest,
    failpoint?: Pick<
      PendingRequest,
      "expectedFailpoint" | "reachResolve" | "reachReject"
    >
  ) {
    return new Promise<readonly MultiprocessResult[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(request.id)
        const error = new Error(
          `Allocation worker request ${request.id} (${request.kind}) timed out after ${REQUEST_TIMEOUT_MS}ms. ${this.stderr}`.trim()
        )
        reject(error)
        failpoint?.reachReject?.(error)
        this.fail(error)
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(request.id, { resolve, reject, timeout, ...failpoint })
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
    if (response.kind === "failpoint_reached") {
      if (
        pending.expectedFailpoint !== response.failpoint ||
        pending.failpointReached
      ) {
        this.fail(
          new Error(`Unexpected failpoint response for request ${response.id}`)
        )
        return
      }
      pending.failpointReached = true
      pending.reachResolve?.()
      return
    }
    if (pending.expectedFailpoint && !pending.failpointReached) {
      this.fail(
        new Error(`Request ${response.id} completed before its failpoint`)
      )
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
      request.reachReject?.(error)
    }
    this.pending.clear()
    if (this.child.exitCode === null && this.child.signalCode === null) {
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
    const fleetId = `${process.pid}-${Date.now()}-${++fleetSequence}`
    const workers = Array.from(
      { length: size },
      (_, index) =>
        new AllocationWorker(
          databaseUrl,
          schema,
          `flash-sale-mp-${fleetId}-${index}`
        )
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

  async executeOn(
    workerIndex: number,
    operations: readonly MultiprocessOperation[]
  ) {
    const worker = this.workers[workerIndex]
    if (!worker) throw new Error(`Allocation worker ${workerIndex} does not exist`)
    return await worker.execute(operations)
  }

  async crash(workerIndex: number, options: WorkerCrashOptions = {}) {
    const worker = this.workers[workerIndex]
    if (!worker) throw new Error(`Allocation worker ${workerIndex} does not exist`)
    return await worker.crash(options)
  }

  applicationName(workerIndex: number) {
    const worker = this.workers[workerIndex]
    if (!worker) throw new Error(`Allocation worker ${workerIndex} does not exist`)
    return worker.applicationName
  }

  async executeUntilFailpoint(
    workerIndex: number,
    operation: MultiprocessOperation,
    failpoint: AllocationFaultPoint
  ) {
    const worker = this.workers[workerIndex]
    if (!worker) throw new Error(`Allocation worker ${workerIndex} does not exist`)
    return await worker.executeUntilFailpoint(operation, failpoint)
  }

  async close() {
    await Promise.all(this.workers.map((worker) => worker.close()))
  }
}
