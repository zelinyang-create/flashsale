import {
  CheckoutCommandError,
  CheckoutCommandErrorCode,
  prepareAuthorizeCommand,
  prepareCancelExecutionCommand,
  prepareClaimLeaseCommand,
  prepareCompleteExecutionCommand,
  prepareExecutionCommand,
  prepareFindExecutionForCartCommand,
  prepareReadAuthorizationCommand,
  prepareReadExecutionReplayCommand,
  prepareRecordCommerceDefinitiveFailureCommand,
  prepareRecordCommerceSucceededCommand,
  prepareRecordCommerceUnknownCommand,
} from ".."

const prepare = () => ({
  attempt_id: "attempt-1",
  campaign_id: "campaign-1",
  subject_id: "customer-1",
  cart_id: "cart-1",
  command_id: "b".repeat(64),
  request_hash: "a".repeat(64),
  rules_version: 1,
  items: [
    { campaign_item_id: "item-b", variant_id: "variant-b", quantity: 2 },
    { campaign_item_id: "item-a", variant_id: "variant-a", quantity: 1 },
  ],
})

describe("checkout command validation", () => {
  it("canonicalizes trusted snapshot items", () => {
    expect(prepareExecutionCommand(prepare()).items).toEqual([
      { campaign_item_id: "item-a", variant_id: "variant-a", quantity: 1 },
      { campaign_item_id: "item-b", variant_id: "variant-b", quantity: 2 },
    ])
  })

  it.each([
    [{ ...prepare(), extra: true }],
    [Object.assign(Object.create({}), prepare())],
    [{ ...prepare(), request_hash: "A".repeat(64) }],
    [{ ...prepare(), items: [] }],
    [
      {
        ...prepare(),
        items: [
          { campaign_item_id: "one", variant_id: "same", quantity: 1 },
          { campaign_item_id: "two", variant_id: "same", quantity: 1 },
        ],
      },
    ],
  ])("rejects malformed prepare input", (command) => {
    expect(() => prepareExecutionCommand(command as never)).toThrow(
      CheckoutCommandError
    )
  })

  it("rejects accessor properties at the exact command boundary", () => {
    const command = prepare()
    Object.defineProperty(command, "cart_id", {
      enumerable: true,
      get: () => "cart-accessor",
    })
    expect(() => prepareExecutionCommand(command)).toThrow(
      expect.objectContaining({
        code: CheckoutCommandErrorCode.INVALID_COMMAND,
      })
    )
  })

  it("requires command_id to be a server-derived lowercase SHA-256 digest", () => {
    expect(() =>
      prepareExecutionCommand({ ...prepare(), command_id: "raw-client-key" })
    ).toThrow(
      expect.objectContaining({
        code: CheckoutCommandErrorCode.INVALID_COMMAND,
      })
    )
  })

  it("enforces exact lease, fence, read, and find commands", () => {
    expect(
      prepareClaimLeaseCommand({
        execution_id: "execution-1",
        worker_id: "worker-1",
        lease_seconds: 30,
      })
    ).toEqual({
      execution_id: "execution-1",
      worker_id: "worker-1",
      lease_seconds: 30,
    })
    expect(() =>
      prepareClaimLeaseCommand({
        execution_id: "execution-1",
        worker_id: "worker-1",
        lease_seconds: 121,
      })
    ).toThrow(CheckoutCommandError)
    expect(
      prepareAuthorizeCommand({
        execution_id: "execution-1",
        worker_id: "worker-1",
        lease_epoch: 1,
      })
    ).toBeDefined()
    expect(prepareFindExecutionForCartCommand({ cart_id: "cart-1" })).toEqual({
      cart_id: "cart-1",
    })
    expect(
      prepareReadAuthorizationCommand({
        cart_id: "cart-1",
        subject_id: "subject-1",
        campaign_id: "campaign-1",
        commerce_transaction_id: "transaction-1",
        rules_version: 1,
        items: [{ variant_id: "variant-1", quantity: 1 }],
      })
    ).toBeDefined()
    expect(() =>
      prepareReadAuthorizationCommand({
        cart_id: "cart-1",
        subject_id: "subject-1",
        campaign_id: "campaign-1",
        rules_version: 1,
        items: [{ variant_id: "variant-1", quantity: 1 }],
      } as never)
    ).toThrow(
      expect.objectContaining({
        code: CheckoutCommandErrorCode.INVALID_COMMAND,
      })
    )
  })

  it("enforces exact result, terminal, and replay commands", () => {
    const fence = {
      execution_id: "execution-1",
      expected_version: 3,
      worker_id: "worker-1",
      lease_epoch: 1,
      commerce_transaction_id: "transaction-1",
    }
    expect(
      prepareRecordCommerceSucceededCommand({ ...fence, order_id: "order-1" })
    ).toBeDefined()
    expect(
      prepareRecordCommerceDefinitiveFailureCommand({
        ...fence,
        error_code: "PAYMENT_DECLINED",
      })
    ).toBeDefined()
    expect(
      prepareRecordCommerceUnknownCommand({
        ...fence,
        error_code: "PAYMENT_TIMEOUT",
        reconcile_after_seconds: 30,
      })
    ).toBeDefined()
    expect(
      prepareCompleteExecutionCommand({
        execution_id: "execution-1",
        expected_version: 4,
        commerce_transaction_id: "transaction-1",
        order_id: "order-1",
      })
    ).toBeDefined()
    expect(
      prepareCancelExecutionCommand({
        execution_id: "execution-1",
        expected_version: 4,
        commerce_transaction_id: "transaction-1",
      })
    ).toBeDefined()
    expect(
      prepareReadExecutionReplayCommand({
        command_id: "b".repeat(64),
        cart_id: "cart-1",
        subject_id: "subject-1",
        request_hash: "a".repeat(64),
      })
    ).toBeDefined()
    expect(() =>
      prepareRecordCommerceSucceededCommand({
        ...fence,
        order_id: "order-1",
        extra: true,
      } as never)
    ).toThrow(
      expect.objectContaining({
        code: CheckoutCommandErrorCode.INVALID_COMMAND,
      })
    )
    expect(() =>
      prepareReadExecutionReplayCommand({
        command_id: "raw-key",
        cart_id: "cart-1",
        subject_id: "subject-1",
        request_hash: "a".repeat(64),
      })
    ).toThrow(CheckoutCommandError)
  })
})
