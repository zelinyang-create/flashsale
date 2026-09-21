import { defineConfig, Modules } from "@medusajs/framework/utils"
import path from "node:path"

const databaseHost = process.env.DB_HOST ?? "localhost"
const databasePort = process.env.DB_PORT ?? "5432"
const databaseUsername = process.env.DB_USERNAME ?? "postgres"
const databasePassword = process.env.DB_PASSWORD ?? "postgres"
const databaseCredentials = `${encodeURIComponent(databaseUsername)}${
  databasePassword ? `:${encodeURIComponent(databasePassword)}` : ""
}`

const systemTaxProvider = {
  resolve: {
    services: [require("@medusajs/tax/dist/providers/system").default],
  },
  id: "system",
}

const systemPaymentProvider = {
  resolve: {
    services: [require("@medusajs/payment/dist/providers/system").default],
  },
  id: "default",
}

module.exports = defineConfig({
  admin: { disable: true },
  projectConfig: {
    databaseUrl: `postgres://${databaseCredentials}@${databaseHost}:${databasePort}/medusa-flash-sale-full-app`,
    http: {
      jwtSecret: "test",
      cookieSecret: "test",
      authCors: "http://localhost",
      storeCors: "http://localhost",
      adminCors: "http://localhost",
    },
  },
  plugins: [
    {
      resolve: path.resolve(__dirname, ".."),
      options: {},
    },
  ],
  modules: [
    {
      key: Modules.AUTH,
      resolve: "@medusajs/auth",
      options: {
        providers: [{ id: "emailpass", resolve: "@medusajs/auth-emailpass" }],
      },
    },
    {
      key: Modules.CACHE,
      resolve: "@medusajs/cache-inmemory",
      options: { ttl: 0 },
    },
    { key: Modules.LOCKING, resolve: "@medusajs/locking" },
    { key: Modules.STOCK_LOCATION, resolve: "@medusajs/stock-location" },
    { key: Modules.INVENTORY, resolve: "@medusajs/inventory" },
    { key: Modules.PRODUCT, resolve: "@medusajs/product" },
    { key: Modules.PRICING, resolve: "@medusajs/pricing" },
    { key: Modules.PROMOTION, resolve: "@medusajs/promotion" },
    { key: Modules.REGION, resolve: "@medusajs/region" },
    { key: Modules.CUSTOMER, resolve: "@medusajs/customer" },
    { key: Modules.SALES_CHANNEL, resolve: "@medusajs/sales-channel" },
    { key: Modules.CART, resolve: "@medusajs/cart" },
    {
      key: Modules.WORKFLOW_ENGINE,
      resolve: "@medusajs/workflow-engine-inmemory",
    },
    { key: Modules.API_KEY, resolve: "@medusajs/api-key" },
    { key: Modules.STORE, resolve: "@medusajs/store" },
    {
      key: Modules.TAX,
      resolve: "@medusajs/tax",
      options: { providers: [systemTaxProvider] },
    },
    { key: Modules.CURRENCY, resolve: "@medusajs/currency" },
    { key: Modules.ORDER, resolve: "@medusajs/order" },
    {
      key: Modules.PAYMENT,
      resolve: "@medusajs/payment",
      options: { providers: [systemPaymentProvider] },
    },
    {
      key: Modules.FULFILLMENT,
      resolve: "@medusajs/fulfillment",
      options: {
        providers: [{ resolve: "@medusajs/fulfillment-manual", id: "manual" }],
      },
    },
    {
      key: Modules.NOTIFICATION,
      resolve: "@medusajs/notification",
      options: {
        providers: [
          {
            resolve: "@medusajs/notification-local",
            id: "local",
            options: { name: "Local", channels: ["log", "email"] },
          },
        ],
      },
    },
  ],
})
