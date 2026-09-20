import { MedusaRedisAllocationEventTransport } from "../medusa-event-transport"

describe("Medusa Redis allocation event transport", () => {
  it("requires the exact subscriber manifest and ignores wildcard coverage", () => {
    const emit = jest.fn()
    const exact = new MedusaRedisAllocationEventTransport({
      emit,
      eventToSubscribersMap: new Map([
        ["destination.v1", [{ id: "consumer-1" }]],
      ]),
    })
    expect(() =>
      exact.assertReady({ "destination.v1": ["consumer-1"] })
    ).not.toThrow()
    expect(() =>
      exact.assertReady({ "destination.v1": ["wrong-consumer"] })
    ).toThrow("EVENT_BUS_SUBSCRIBER_MANIFEST_MISMATCH")
    expect(() =>
      exact.assertReady({ "missing.v1": ["consumer-1"] })
    ).toThrow(
      "EVENT_BUS_SUBSCRIBER_MANIFEST_MISMATCH"
    )

    const wildcard = new MedusaRedisAllocationEventTransport({
      emit,
      eventToSubscribersMap: new Map([["*", [{ id: "consumer-all" }]]]),
    })
    expect(() =>
      wildcard.assertReady({ "destination.v1": ["consumer-all"] })
    ).toThrow("EVENT_BUS_SUBSCRIBER_MANIFEST_MISMATCH")

    const unexpected = new MedusaRedisAllocationEventTransport({
      emit,
      eventToSubscribersMap: new Map([
        [
          "destination.v1",
          [{ id: "consumer-1" }, { id: "unrelated-consumer" }],
        ],
      ]),
    })
    expect(() =>
      unexpected.assertReady({ "destination.v1": ["consumer-1"] })
    ).toThrow("EVENT_BUS_SUBSCRIBER_MANIFEST_MISMATCH")
  })

  it("returns acceptance only after the public emit promise resolves", async () => {
    let accept!: () => void
    const emit = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve
        })
    )
    const transport = new MedusaRedisAllocationEventTransport({ emit })
    let completed = false
    const publish = transport
      .publish({ event_name: "destination.v1" } as never)
      .then(() => (completed = true))
    await Promise.resolve()
    expect(completed).toBe(false)
    accept()
    await publish
    expect(completed).toBe(true)
  })
})
