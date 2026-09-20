import type { ConfigModule } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import {
  ALLOCATION_OUTBOX_EVENT_NAMES,
  compareUtf16CodeUnits,
} from "../../shared"
import type { AllocationOutboxDispatcherConfig } from "./contracts"

export class AllocationOutboxDispatcherConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AllocationOutboxDispatcherConfigError"
  }
}

export type DisabledAllocationOutboxDispatcherConfig = Readonly<{
  enabled: false
}>

const REDIS_PROVIDER_ALLOWLIST = new Set([
  "@medusajs/event-bus-redis",
  "@medusajs/medusa/event-bus-redis",
])

const SUBSCRIBER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number
) {
  const raw = env[name]
  if (raw === undefined || raw === "") return fallback
  if (!/^[0-9]+$/.test(raw)) throw invalid(name)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw invalid(name)
  }
  return value
}

function invalid(name: string): AllocationOutboxDispatcherConfigError {
  return new AllocationOutboxDispatcherConfigError(
    `${name} has an invalid allocation outbox dispatcher value`
  )
}

function parseSubscriberManifest(raw: string | undefined) {
  const name = "FLASH_SALE_OUTBOX_SUBSCRIBER_MANIFEST_JSON"
  if (!raw) throw invalid(name)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw invalid(name)
  }
  if (!Array.isArray(parsed)) {
    throw invalid(name)
  }
  const expected = new Set<string>(ALLOCATION_OUTBOX_EVENT_NAMES)
  const normalized: Record<string, readonly string[]> = {}
  for (const entry of parsed) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.getPrototypeOf(entry) !== Object.prototype ||
      JSON.stringify(Object.keys(entry).sort(compareUtf16CodeUnits)) !==
        JSON.stringify(["event_name", "subscriber_ids"])
    ) {
      throw invalid(name)
    }
    const typed = entry as {
      event_name?: unknown
      subscriber_ids?: unknown
    }
    if (
      typeof typed.event_name !== "string" ||
      !expected.has(typed.event_name) ||
      normalized[typed.event_name] !== undefined ||
      !Array.isArray(typed.subscriber_ids) ||
      typed.subscriber_ids.length < 1 ||
      typed.subscriber_ids.length > 32
    ) {
      throw invalid(name)
    }
    const ids = typed.subscriber_ids
    if (
      ids.some(
        (id) => typeof id !== "string" || !SUBSCRIBER_ID.test(id)
      ) ||
      new Set(ids).size !== ids.length
    ) {
      throw invalid(name)
    }
    normalized[typed.event_name] = Object.freeze(
      [...ids].sort(compareUtf16CodeUnits)
    )
  }
  if (
    Object.keys(normalized).length !== expected.size ||
    ALLOCATION_OUTBOX_EVENT_NAMES.some(
      (eventName) => normalized[eventName] === undefined
    )
  ) {
    throw invalid(name)
  }
  return Object.freeze(normalized)
}

function redisDeclaration(configModule: ConfigModule) {
  const declaration = configModule.modules?.[Modules.EVENT_BUS] as unknown
  if (!declaration || typeof declaration !== "object") {
    throw new AllocationOutboxDispatcherConfigError(
      "Allocation outbox dispatch requires an explicit Redis EventBus module"
    )
  }
  const typed = declaration as {
    resolve?: unknown
    options?: Record<string, unknown>
  }
  if (
    typeof typed.resolve !== "string" ||
    !REDIS_PROVIDER_ALLOWLIST.has(typed.resolve)
  ) {
    throw new AllocationOutboxDispatcherConfigError(
      "Allocation outbox dispatch refuses non-Redis EventBus providers"
    )
  }
  return typed
}

export function parseAllocationOutboxDispatcherConfig(
  env: NodeJS.ProcessEnv,
  configModule: ConfigModule
):
  | AllocationOutboxDispatcherConfig
  | DisabledAllocationOutboxDispatcherConfig {
  const enabled = env.FLASH_SALE_OUTBOX_DISPATCH_ENABLED
  if (enabled === undefined || enabled === "" || enabled === "false") {
    return Object.freeze({ enabled: false })
  }
  if (enabled !== "true") throw invalid("FLASH_SALE_OUTBOX_DISPATCH_ENABLED")
  if (
    configModule.projectConfig.workerMode !== "worker" &&
    configModule.projectConfig.workerMode !== "shared"
  ) {
    throw new AllocationOutboxDispatcherConfigError(
      "Allocation outbox dispatch requires worker or shared mode"
    )
  }
  redisDeclaration(configModule)
  const leaseSeconds = integer(
    env,
    "FLASH_SALE_OUTBOX_LEASE_SECONDS",
    30,
    2,
    3_600
  )
  const markTimeout = integer(
    env,
    "FLASH_SALE_OUTBOX_MARK_TIMEOUT_MS",
    2_000,
    100,
    10_000
  )
  const safetyMargin = integer(
    env,
    "FLASH_SALE_OUTBOX_SAFETY_MARGIN_MS",
    2_000,
    100,
    10_000
  )
  if (markTimeout + safetyMargin >= leaseSeconds * 1_000) {
    throw new AllocationOutboxDispatcherConfigError(
      "Allocation outbox lease must exceed mark and safety budgets"
    )
  }
  return Object.freeze({
    enabled: true,
    concurrency: integer(
      env,
      "FLASH_SALE_OUTBOX_CONCURRENCY",
      8,
      1,
      32
    ),
    lease_seconds: leaseSeconds,
    max_attempts: integer(
      env,
      "FLASH_SALE_OUTBOX_MAX_ATTEMPTS",
      10,
      1,
      100
    ),
    retry_after_seconds: integer(
      env,
      "FLASH_SALE_OUTBOX_RETRY_AFTER_SECONDS",
      5,
      1,
      86_400
    ),
    mark_timeout_ms: markTimeout,
    safety_margin_ms: safetyMargin,
    subscriber_manifest: parseSubscriberManifest(
      env.FLASH_SALE_OUTBOX_SUBSCRIBER_MANIFEST_JSON
    ),
  })
}
