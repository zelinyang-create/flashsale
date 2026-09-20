import type { ConfigModule } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { ALLOCATION_OUTBOX_EVENT_NAMES } from "../../../shared"
import {
  AllocationOutboxDispatcherConfigError,
  parseAllocationOutboxDispatcherConfig,
} from "../config"

function manifest(
  entries: unknown[] = ALLOCATION_OUTBOX_EVENT_NAMES.map((eventName) => ({
    event_name: eventName,
    subscriber_ids: ["allocation-consumer-v1"],
  }))
) {
  return JSON.stringify(entries)
}

function config(
  resolve = "@medusajs/medusa/event-bus-redis",
  workerMode: "shared" | "worker" | "server" = "shared"
) {
  return {
    projectConfig: { workerMode },
    modules: {
      [Modules.EVENT_BUS]: {
        resolve,
        options: {},
      },
    },
  } as unknown as ConfigModule
}

const enabled = {
  FLASH_SALE_OUTBOX_DISPATCH_ENABLED: "true",
  FLASH_SALE_OUTBOX_SUBSCRIBER_MANIFEST_JSON: manifest(),
  FLASH_SALE_OUTBOX_CONCURRENCY: "4",
  FLASH_SALE_OUTBOX_LEASE_SECONDS: "3",
  FLASH_SALE_OUTBOX_MARK_TIMEOUT_MS: "200",
  FLASH_SALE_OUTBOX_SAFETY_MARGIN_MS: "200",
}

describe("allocation outbox dispatcher config", () => {
  it("is disabled by default without requiring an EventBus", () => {
    expect(
      parseAllocationOutboxDispatcherConfig(
        {},
        { projectConfig: {} } as ConfigModule
      )
    ).toEqual({ enabled: false })
  })

  it("accepts an explicit complete Redis configuration", () => {
    expect(
      parseAllocationOutboxDispatcherConfig(enabled, config())
    ).toMatchObject({
      enabled: true,
      concurrency: 4,
      lease_seconds: 3,
      subscriber_manifest: expect.objectContaining({
        [ALLOCATION_OUTBOX_EVENT_NAMES[0]]: ["allocation-consumer-v1"],
      }),
    })
  })

  it.each([
    ["Local provider", enabled, config("@medusajs/medusa/event-bus-local")],
    ["unknown provider", enabled, config("custom-event-bus")],
    ["server mode", enabled, config(undefined, "server")],
    [
      "missing manifest",
      {
        ...enabled,
        FLASH_SALE_OUTBOX_SUBSCRIBER_MANIFEST_JSON: undefined,
      },
      config(),
    ],
    [
      "incomplete manifest",
      {
        ...enabled,
        FLASH_SALE_OUTBOX_SUBSCRIBER_MANIFEST_JSON: manifest(
          ALLOCATION_OUTBOX_EVENT_NAMES.slice(1).map((eventName) => ({
            event_name: eventName,
            subscriber_ids: ["allocation-consumer-v1"],
          }))
        ),
      },
      config(),
    ],
    [
      "legacy destination remapping object",
      {
        ...enabled,
        FLASH_SALE_OUTBOX_SUBSCRIBER_MANIFEST_JSON: JSON.stringify(
          Object.fromEntries(
            ALLOCATION_OUTBOX_EVENT_NAMES.map((eventName) => [
              eventName,
              eventName,
            ])
          )
        ),
      },
      config(),
    ],
    [
      "duplicate event entry",
      {
        ...enabled,
        FLASH_SALE_OUTBOX_SUBSCRIBER_MANIFEST_JSON: manifest([
          ...ALLOCATION_OUTBOX_EVENT_NAMES.map((eventName) => ({
            event_name: eventName,
            subscriber_ids: ["allocation-consumer-v1"],
          })),
          {
            event_name: ALLOCATION_OUTBOX_EVENT_NAMES[0],
            subscriber_ids: ["other-consumer-v1"],
          },
        ]),
      },
      config(),
    ],
    [
      "unknown event entry",
      {
        ...enabled,
        FLASH_SALE_OUTBOX_SUBSCRIBER_MANIFEST_JSON: manifest([
          ...ALLOCATION_OUTBOX_EVENT_NAMES.slice(1).map((eventName) => ({
            event_name: eventName,
            subscriber_ids: ["allocation-consumer-v1"],
          })),
          {
            event_name: "flash_sale.quota.misdirected.v1",
            subscriber_ids: ["allocation-consumer-v1"],
          },
        ]),
      },
      config(),
    ],
    [
      "duplicate subscriber id",
      {
        ...enabled,
        FLASH_SALE_OUTBOX_SUBSCRIBER_MANIFEST_JSON: manifest(
          ALLOCATION_OUTBOX_EVENT_NAMES.map((eventName, index) => ({
            event_name: eventName,
            subscriber_ids:
              index === 0
                ? ["allocation-consumer-v1", "allocation-consumer-v1"]
                : ["allocation-consumer-v1"],
          }))
        ),
      },
      config(),
    ],
    [
      "unsafe lease budget",
      {
        ...enabled,
        FLASH_SALE_OUTBOX_LEASE_SECONDS: "2",
        FLASH_SALE_OUTBOX_MARK_TIMEOUT_MS: "500",
        FLASH_SALE_OUTBOX_SAFETY_MARGIN_MS: "1600",
      },
      config(),
    ],
  ])("rejects %s before dispatch", (_name, env, moduleConfig) => {
    expect(() =>
      parseAllocationOutboxDispatcherConfig(
        env as NodeJS.ProcessEnv,
        moduleConfig as ConfigModule
      )
    ).toThrow(AllocationOutboxDispatcherConfigError)
  })
})
