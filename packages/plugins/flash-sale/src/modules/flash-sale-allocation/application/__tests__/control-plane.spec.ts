import {
  AllocationFenceDisposition,
  AllocationPolicyState,
  CapacityState,
} from "../../../../types"
import {
  AllocationCommandErrorCode,
  AllocationControlResult,
  AllocationControlStore,
  ProvisionAllocationCommand,
} from "../contracts"
import {
  createAllocationConfigurationHash,
  FenceAndCloseCampaignAllocationHandler,
  prepareFenceAndCloseCommand,
  ProvisionAllocationHandler,
  prepareProvisionCommand,
  prepareTransitionCommand,
} from "../control-plane"

const snapshot = {
  campaign_id: "campaign-1",
  rules_version: 3,
  starts_at: "2030-01-01T00:00:00.000Z",
  ends_at: "2030-01-01T01:00:00.000Z",
  hold_ttl_seconds: 300,
  per_subject_limit: 2,
  items: [
    { campaign_item_id: "item-b", quota: 20 },
    { campaign_item_id: "item-a", quota: 10 },
  ],
} as const

const command = (): ProvisionAllocationCommand => {
  const normalized = { ...snapshot, items: [...snapshot.items].reverse() }
  return {
    ...snapshot,
    configuration_hash: createAllocationConfigurationHash(normalized),
  }
}

const result: AllocationControlResult = {
  replayed: false,
  policy: {
    id: "fsapol-1",
    ...snapshot,
    configuration_hash: createAllocationConfigurationHash({
      ...snapshot,
      items: [...snapshot.items].reverse(),
    }),
    state: AllocationPolicyState.PREPARED,
    starts_at: new Date(snapshot.starts_at),
    ends_at: new Date(snapshot.ends_at),
    version: 1,
    created_at: new Date(snapshot.starts_at),
    updated_at: new Date(snapshot.starts_at),
    deleted_at: null,
  },
  capacities: [
    {
      id: "fscap-1",
      allocation_policy_id: "fsapol-1",
      campaign_item_id: "item-a",
      shard_no: 0,
      state: CapacityState.PREPARED,
      granted_quantity: 10,
      held_quantity: 0,
      consumed_quantity: 0,
      rules_version: 3,
      version: 1,
      created_at: new Date(snapshot.starts_at),
      updated_at: new Date(snapshot.starts_at),
      deleted_at: null,
    },
  ],
}

describe("allocation control-plane boundary", () => {
  it("derives one hash regardless of caller item order", () => {
    expect(createAllocationConfigurationHash(snapshot)).toBe(
      createAllocationConfigurationHash({
        ...snapshot,
        items: [...snapshot.items].reverse(),
      })
    )
  })

  it("derives one hash regardless of item property insertion order", () => {
    const campaignFirst = { campaign_item_id: "item-a", quota: 10 }
    const quotaFirst = { quota: 10, campaign_item_id: "item-a" }

    expect(
      createAllocationConfigurationHash({ ...snapshot, items: [campaignFirst] })
    ).toBe(
      createAllocationConfigurationHash({ ...snapshot, items: [quotaFirst] })
    )
  })

  it("normalizes reverse item input and verifies a server-derived hash", async () => {
    const provisionAllocation = jest.fn().mockResolvedValue(result)
    const store = {
      provisionAllocation,
      openAllocation: jest.fn(),
      closeAllocation: jest.fn(),
      fenceAndCloseCampaignAllocation: jest.fn(),
    } satisfies AllocationControlStore
    const handler = new ProvisionAllocationHandler(store)

    await handler.execute(command())

    expect(provisionAllocation).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          { campaign_item_id: "item-a", quota: 10 },
          { campaign_item_id: "item-b", quota: 20 },
        ],
      })
    )
  })

  it("rejects a caller-provided hash that does not describe the snapshot", () => {
    expect(() =>
      prepareProvisionCommand({
        ...command(),
        configuration_hash: "a".repeat(64),
      })
    ).toThrow(
      expect.objectContaining({
        code: AllocationCommandErrorCode.INVALID_COMMAND,
      })
    )
  })

  it.each(["2030-01-01", "2030-01-01T00:00:00Z", "not-a-date"])(
    "rejects non-canonical ISO timestamps",
    (startsAt) => {
      expect(() =>
        prepareProvisionCommand({ ...command(), starts_at: startsAt })
      ).toThrow(
        expect.objectContaining({
          code: AllocationCommandErrorCode.INVALID_COMMAND,
        })
      )
    }
  )

  it("rejects PostgreSQL integer overflow and year zero", () => {
    const invalidCommands = [
      { ...command(), rules_version: 2_147_483_648 },
      { ...command(), per_subject_limit: 2_147_483_648 },
      {
        ...command(),
        starts_at: "0000-01-01T00:00:00.000Z",
        ends_at: "0001-01-01T00:00:00.000Z",
      },
    ]

    for (const candidate of invalidCommands) {
      expect(() => prepareProvisionCommand(candidate)).toThrow(
        expect.objectContaining({
          code: AllocationCommandErrorCode.INVALID_COMMAND,
        })
      )
    }
  })

  it("rejects symbol, unknown, and non-enumerable fields", () => {
    const candidates = [
      Object.assign(command(), { unknown: true }),
      Object.assign(command(), { [Symbol("secret")]: true }),
      Object.defineProperty(command(), "secret", {
        value: true,
        enumerable: false,
      }),
    ]
    for (const candidate of candidates) {
      expect(() => prepareProvisionCommand(candidate)).toThrow(
        expect.objectContaining({
          code: AllocationCommandErrorCode.INVALID_COMMAND,
        })
      )
    }
  })

  it("rejects custom prototypes and getters on provision commands", () => {
    const customPrototype = Object.assign(
      Object.create({ inherited: true }),
      command()
    )
    const getter = Object.defineProperty({ ...command() }, "campaign_id", {
      get: () => "campaign-1",
      enumerable: true,
    })

    for (const candidate of [customPrototype, getter]) {
      expect(() => prepareProvisionCommand(candidate)).toThrow(
        expect.objectContaining({
          code: AllocationCommandErrorCode.INVALID_COMMAND,
        })
      )
    }
  })

  it("rejects symbol, unknown, and non-enumerable nested item fields", () => {
    const item = { campaign_item_id: "item-a", quota: 1 }
    const candidates = [
      { ...item, unknown: true },
      Object.assign({ ...item }, { [Symbol("secret")]: true }),
      Object.defineProperty({ ...item }, "secret", {
        value: true,
        enumerable: false,
      }),
    ]
    for (const candidate of candidates) {
      const base = command()
      expect(() =>
        prepareProvisionCommand({
          ...base,
          items: [candidate],
        })
      ).toThrow(
        expect.objectContaining({
          code: AllocationCommandErrorCode.INVALID_COMMAND,
        })
      )
    }
  })

  it("rejects custom prototypes and getters on provision items", () => {
    const item = { campaign_item_id: "item-a", quota: 1 }
    const customPrototype = Object.assign(
      Object.create({ inherited: true }),
      item
    )
    const getter = Object.defineProperty({ ...item }, "quota", {
      get: () => 1,
      enumerable: true,
    })

    for (const candidate of [customPrototype, getter]) {
      expect(() =>
        prepareProvisionCommand({ ...command(), items: [candidate] })
      ).toThrow(
        expect.objectContaining({
          code: AllocationCommandErrorCode.INVALID_COMMAND,
        })
      )
    }
  })

  it("rejects custom prototypes, getters, and integer overflow on transitions", () => {
    const transition = {
      policy_id: "fsapol-1",
      expected_rules_version: 1,
      expected_version: 1,
    }
    const candidates = [
      Object.assign(Object.create({ inherited: true }), transition),
      Object.defineProperty({ ...transition }, "policy_id", {
        get: () => "fsapol-1",
        enumerable: true,
      }),
      { ...transition, expected_rules_version: 2_147_483_648 },
      { ...transition, expected_version: 2_147_483_648 },
    ]

    for (const candidate of candidates) {
      expect(() =>
        prepareTransitionCommand(candidate, "openAllocation")
      ).toThrow(
        expect.objectContaining({
          code: AllocationCommandErrorCode.INVALID_COMMAND,
        })
      )
    }
  })

  it("rejects duplicate items and unsafe quotas before persistence", () => {
    const duplicate = {
      ...command(),
      items: [
        { campaign_item_id: "item-a", quota: 1 },
        { campaign_item_id: "item-a", quota: 2 },
      ],
    }
    expect(() => prepareProvisionCommand(duplicate)).toThrow(
      expect.objectContaining({
        code: AllocationCommandErrorCode.INVALID_COMMAND,
      })
    )

    const unsafe = {
      ...command(),
      items: [
        { campaign_item_id: "item-a", quota: Number.MAX_SAFE_INTEGER + 1 },
      ],
    }
    expect(() => prepareProvisionCommand(unsafe)).toThrow(
      expect.objectContaining({
        code: AllocationCommandErrorCode.INVALID_COMMAND,
      })
    )
  })

  it("validates and forwards an exact campaign fence command", async () => {
    const fenceAndCloseCampaignAllocation = jest.fn().mockResolvedValue({})
    const store = {
      provisionAllocation: jest.fn(),
      openAllocation: jest.fn(),
      closeAllocation: jest.fn(),
      fenceAndCloseCampaignAllocation,
    } satisfies AllocationControlStore
    const handler = new FenceAndCloseCampaignAllocationHandler(store)
    const fence = {
      campaign_id: "campaign-fence",
      disposition: AllocationFenceDisposition.CANCELLED,
      campaign_version: 4,
      rules_version: 3,
    }

    await handler.execute(fence)

    expect(fenceAndCloseCampaignAllocation).toHaveBeenCalledWith(fence)
  })

  it("rejects invalid, extra, hidden, and overflowing fence fields", () => {
    const fence = {
      campaign_id: "campaign-fence",
      disposition: AllocationFenceDisposition.ENDED,
      campaign_version: 4,
      rules_version: 3,
    }
    const candidates = [
      { ...fence, disposition: "draft" },
      { ...fence, campaign_version: 2_147_483_648 },
      { ...fence, rules_version: 0 },
      { ...fence, unknown: true },
      Object.assign({ ...fence }, { [Symbol("secret")]: true }),
      Object.defineProperty({ ...fence }, "secret", {
        value: true,
        enumerable: false,
      }),
    ]

    for (const candidate of candidates) {
      expect(() => prepareFenceAndCloseCommand(candidate as never)).toThrow(
        expect.objectContaining({
          code: AllocationCommandErrorCode.INVALID_COMMAND,
        })
      )
    }
  })
})
