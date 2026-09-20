jest.mock("../../../../../../orchestration/flash-sale-checkout", () => ({
  createCanonicalFlashSaleCartAssembler: jest.fn(),
  createMedusaFlashSaleCheckoutOrchestrator: jest.fn(),
  hashFlashSaleIdempotencyKey: jest.fn(),
  mapFlashSaleCheckoutResult: jest.fn(),
  toPublicFlashSaleCheckoutError: jest.fn((error) => error),
}))

import {
  createCanonicalFlashSaleCartAssembler,
  createMedusaFlashSaleCheckoutOrchestrator,
  hashFlashSaleIdempotencyKey,
  mapFlashSaleCheckoutResult,
} from "../../../../../../orchestration/flash-sale-checkout"
import { POST } from "../route"

describe("POST /store/flash-sales/:campaign_id/checkout", () => {
  it("uses auth plus hashed header and treats URL campaign as an exact assertion", async () => {
    const assemble = jest.fn(async () => ({
      campaign_id: "campaign-derived",
      subject_id: "customer-authenticated",
      cart_id: "cart-body",
    }))
    const run = jest.fn(async () => ({
      status: "completed",
      order_id: "order-1",
    }))
    jest.mocked(hashFlashSaleIdempotencyKey).mockReturnValue("a".repeat(64))
    jest
      .mocked(createCanonicalFlashSaleCartAssembler)
      .mockReturnValue({ assemble } as never)
    jest
      .mocked(createMedusaFlashSaleCheckoutOrchestrator)
      .mockReturnValue({ run } as never)
    jest.mocked(mapFlashSaleCheckoutResult).mockReturnValue({
      status: 200,
      body: { status: "completed", order_id: "order-1" },
    })
    const status = jest.fn()
    const json = jest.fn()
    status.mockReturnValue({ json })
    const request = {
      auth_context: {
        actor_id: "customer-authenticated",
        actor_type: "customer",
      },
      headers: { "idempotency-key": "raw-key-never-forwarded" },
      params: { campaign_id: "campaign-derived" },
      validatedBody: { cart_id: "cart-body" },
      publishable_key_context: {
        key: { id: "publishable-key-1" },
        sales_channel_ids: ["sales-channel-1"],
      },
      scope: { resolve: jest.fn() },
    }

    await POST(request as never, { status } as never)

    expect(hashFlashSaleIdempotencyKey).toHaveBeenCalledWith(
      "raw-key-never-forwarded"
    )
    expect(assemble).toHaveBeenCalledWith({
      cart_id: "cart-body",
      authenticated_customer_id: "customer-authenticated",
      command_id: "a".repeat(64),
      expected_campaign_id: "campaign-derived",
      allowed_sales_channel_ids: ["sales-channel-1"],
    })
    expect(JSON.stringify(assemble.mock.calls)).not.toContain(
      "raw-key-never-forwarded"
    )
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ campaign_id: "campaign-derived" })
    )
    expect(status).toHaveBeenCalledWith(200)
    expect(json).toHaveBeenCalledWith({
      status: "completed",
      order_id: "order-1",
    })
  })
})
