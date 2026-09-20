describe("completeCartWorkflow public hook registration", () => {
  afterEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
  })

  it("registers through the stable validate hook and forwards its transaction credential", async () => {
    const validate = jest.fn()
    const guard = jest.fn().mockResolvedValue(undefined)
    jest.isolateModules(() => {
      jest.doMock("@medusajs/medusa/core-flows", () => ({
        completeCartWorkflow: {
          hooks: {
            validate,
          },
        },
      }))
      jest.doMock("../../checkout-guard", () => ({
        validateFlashSaleCartCompletion: guard,
      }))
      jest.requireActual("../complete-cart-validate-flash-sale")
    })
    expect(validate).toHaveBeenCalledTimes(1)
    expect(validate).toHaveBeenCalledWith(expect.any(Function))
    const handler = validate.mock.calls[0][0]
    const data = { input: { id: "cart-1" }, cart: { id: "cart-1" } }
    const container = { resolve: jest.fn() }
    await handler(data, {
      container,
      transactionId: "commerce-transaction-1",
    })
    expect(guard).toHaveBeenCalledWith(
      data,
      container,
      "commerce-transaction-1"
    )
  })
})
