import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import { MedusaError } from "@medusajs/framework/utils"
import path from "path"
import {
  CampaignState,
  CreateFlashSaleCampaignItemInput,
  FlashSalePluginModule,
} from "../../../types"
import Campaign from "../models/campaign"
import CampaignItem from "../models/campaign-item"
import FlashSaleCampaignModuleService from "../service"

jest.setTimeout(60000)

type CampaignInput = {
  name: string
  starts_at?: Date
  ends_at?: Date
}

const makeCampaign = (
  overrides: Partial<CampaignInput> = {}
): CampaignInput => ({
  name: "Back-to-school flash sale",
  starts_at: new Date("2030-08-01T00:00:00.000Z"),
  ends_at: new Date("2030-08-02T00:00:00.000Z"),
  ...overrides,
})

moduleIntegrationTestRunner<FlashSaleCampaignModuleService>({
  moduleName: FlashSalePluginModule.CAMPAIGN,
  resolve: path.resolve(__dirname, ".."),
  cwd: path.resolve(__dirname, "../../../.."),
  moduleModels: [Campaign, CampaignItem],
  pathToMigrations: path.resolve(__dirname, "../migrations"),
  testSuite: ({ service }) => {
    describe("Flash sale campaign module", () => {
      it("creates campaigns in draft with version 1", async () => {
        const campaign = await service.createCampaigns(makeCampaign())

        expect(campaign).toEqual(
          expect.objectContaining({
            state: CampaignState.DRAFT,
            version: 1,
          })
        )
      })

      it("does not allow generated create/update methods to bypass lifecycle fields", async () => {
        await expect(
          service.createCampaigns({
            ...makeCampaign(),
            state: CampaignState.ACTIVE,
          } as unknown as CampaignInput)
        ).rejects.toThrow("Campaigns must be created in the draft state")

        const campaign = await service.createCampaigns(makeCampaign())

        await expect(
          service.updateCampaigns({
            id: campaign.id,
            state: CampaignState.SCHEDULED,
          } as unknown as { id: string })
        ).rejects.toThrow("state cannot be changed through updateCampaigns")

        await expect(
          service.updateCampaigns({
            id: campaign.id,
            version: 2,
          } as unknown as { id: string })
        ).rejects.toThrow("version cannot be changed through updateCampaigns")
      })

      it("transitions through the lifecycle and increments version", async () => {
        const campaign = await service.createCampaigns(makeCampaign())

        const scheduled = await service.transitionCampaignState(
          campaign.id,
          CampaignState.SCHEDULED
        )

        expect(scheduled).toEqual(
          expect.objectContaining({
            state: CampaignState.SCHEDULED,
            version: 2,
          })
        )
      })

      it("versions draft configuration changes and freezes them after scheduling", async () => {
        const campaign = await service.createCampaigns(makeCampaign())

        const updated = await service.updateCampaigns({
          id: campaign.id,
          per_subject_limit: 2,
        })

        expect(updated).toEqual(
          expect.objectContaining({
            per_subject_limit: 2,
            version: 2,
            rules_version: 2,
          })
        )

        await service.transitionCampaignState(
          campaign.id,
          CampaignState.SCHEDULED
        )
        await expect(
          service.updateCampaigns({
            id: campaign.id,
            per_subject_limit: 3,
          })
        ).rejects.toThrow("must be in draft state")
      })

      it("requires a campaign window before scheduling", async () => {
        const campaign = await service.createCampaigns(
          makeCampaign({ starts_at: undefined, ends_at: undefined })
        )

        await expect(
          service.transitionCampaignState(campaign.id, CampaignState.SCHEDULED)
        ).rejects.toThrow("starts_at and ends_at are required")
      })

      it("serializes conflicting transitions using the current locked state", async () => {
        const campaign = await service.createCampaigns(makeCampaign())

        const outcomes = await Promise.allSettled([
          service.transitionCampaignState(campaign.id, CampaignState.SCHEDULED),
          service.transitionCampaignState(campaign.id, CampaignState.CANCELLED),
        ])

        const fulfilled = outcomes.filter(
          (outcome) => outcome.status === "fulfilled"
        )

        // Both legal serial orders are acceptable: cancellation can either win
        // first (making scheduling invalid), or follow a successful scheduling.
        expect(fulfilled.length).toBeGreaterThanOrEqual(1)
        expect(fulfilled.length).toBeLessThanOrEqual(2)

        const current = await service.retrieveCampaign(campaign.id)
        expect(current.state).toBe(CampaignState.CANCELLED)
        expect(current.version).toBe(1 + fulfilled.length)
      })

      it("atomically transitions only when the complete item snapshot still matches", async () => {
        const campaign = await service.createCampaigns(makeCampaign())
        const items = await service.createCampaignItems([
          {
            campaign_id: campaign.id,
            variant_id: "snapshot-a",
            quota: 10,
          },
          {
            campaign_id: campaign.id,
            variant_id: "snapshot-b",
            quota: 20,
          },
        ])
        const versionedCampaign = await service.retrieveCampaign(campaign.id)
        const command = {
          campaign_id: campaign.id,
          target_state: CampaignState.SCHEDULED,
          expected_version: versionedCampaign.version,
          expected_rules_version: versionedCampaign.rules_version,
          expected_items: items.map((item) => ({
            campaign_item_id: item.id,
            quota: item.quota,
            version: item.version,
          })),
        }

        const [first, replay] = await Promise.all([
          service.transitionCampaignStateFromSnapshot(command),
          service.transitionCampaignStateFromSnapshot(command),
        ])

        expect(first.state).toBe(CampaignState.SCHEDULED)
        expect(replay.state).toBe(CampaignState.SCHEDULED)
        expect(first.version).toBe(versionedCampaign.version + 1)
        expect(replay.version).toBe(versionedCampaign.version + 1)

        await expect(
          service.transitionCampaignStateFromSnapshot({
            ...command,
            expected_version: versionedCampaign.version - 1,
          })
        ).rejects.toMatchObject({ type: MedusaError.Types.CONFLICT })
      })

      it("rejects incomplete or changed item snapshots without changing campaign state", async () => {
        const campaign = await service.createCampaigns(makeCampaign())
        const items = await service.createCampaignItems([
          {
            campaign_id: campaign.id,
            variant_id: "snapshot-complete-a",
            quota: 10,
          },
          {
            campaign_id: campaign.id,
            variant_id: "snapshot-complete-b",
            quota: 20,
          },
        ])
        const current = await service.retrieveCampaign(campaign.id)
        const base = {
          campaign_id: campaign.id,
          target_state: CampaignState.SCHEDULED,
          expected_version: current.version,
          expected_rules_version: current.rules_version,
          expected_items: items.map((item) => ({
            campaign_item_id: item.id,
            quota: item.quota,
            version: item.version,
          })),
        }

        await expect(
          service.transitionCampaignStateFromSnapshot({
            ...base,
            expected_items: base.expected_items.slice(0, 1),
          })
        ).rejects.toMatchObject({ type: MedusaError.Types.CONFLICT })
        await expect(
          service.transitionCampaignStateFromSnapshot({
            ...base,
            expected_items: base.expected_items.map((item, index) =>
              index === 0 ? { ...item, quota: item.quota + 1 } : item
            ),
          })
        ).rejects.toMatchObject({ type: MedusaError.Types.CONFLICT })

        const after = await service.retrieveCampaign(campaign.id)
        expect(after).toEqual(
          expect.objectContaining({
            state: CampaignState.DRAFT,
            version: current.version,
            rules_version: current.rules_version,
          })
        )
      })

      it("serializes snapshot transitions against item-set mutations", async () => {
        const campaign = await service.createCampaigns(makeCampaign())
        const item = await service.createCampaignItems({
          campaign_id: campaign.id,
          variant_id: "snapshot-race-original",
          quota: 10,
        })
        const current = await service.retrieveCampaign(campaign.id)
        const outcomes = await Promise.allSettled([
          service.transitionCampaignStateFromSnapshot({
            campaign_id: campaign.id,
            target_state: CampaignState.SCHEDULED,
            expected_version: current.version,
            expected_rules_version: current.rules_version,
            expected_items: [
              {
                campaign_item_id: item.id,
                quota: item.quota,
                version: item.version,
              },
            ],
          }),
          service.createCampaignItems({
            campaign_id: campaign.id,
            variant_id: "snapshot-race-new",
            quota: 5,
          }),
        ])

        expect(
          outcomes.filter((outcome) => outcome.status === "fulfilled")
        ).toHaveLength(1)
        const after = await service.retrieveCampaign(campaign.id)
        const afterItems = await service.listCampaignItems({
          campaign_id: campaign.id,
        })
        if (after.state === CampaignState.SCHEDULED) {
          expect(afterItems).toHaveLength(1)
        } else {
          expect(after.state).toBe(CampaignState.DRAFT)
          expect(afterItems).toHaveLength(2)
        }
      })

      it("uses version and rules CAS for terminal transitions and strict replay", async () => {
        const campaign = await service.createCampaigns(makeCampaign())
        const command = {
          campaign_id: campaign.id,
          target_state: CampaignState.CANCELLED,
          expected_version: campaign.version,
          expected_rules_version: campaign.rules_version,
        }

        const cancelled = await service.transitionCampaignStateWithVersion(
          command
        )
        const replay = await service.transitionCampaignStateWithVersion(command)
        expect(cancelled.version).toBe(campaign.version + 1)
        expect(replay.version).toBe(cancelled.version)

        await expect(
          service.transitionCampaignStateWithVersion({
            ...command,
            expected_version: campaign.version + 2,
          })
        ).rejects.toMatchObject({ type: MedusaError.Types.CONFLICT })
        await expect(
          service.transitionCampaignStateWithVersion({
            ...command,
            expected_rules_version: campaign.rules_version + 1,
          })
        ).rejects.toMatchObject({ type: MedusaError.Types.CONFLICT })
      })

      it("enforces separate unique constraints for default and location-scoped campaign items", async () => {
        const campaign = await service.createCampaigns(makeCampaign())

        await service.createCampaignItems({
          campaign_id: campaign.id,
          variant_id: "variant-default",
          quota: 10,
        } satisfies CreateFlashSaleCampaignItemInput)

        try {
          await service.createCampaignItems({
            campaign_id: campaign.id,
            variant_id: "variant-default",
            quota: 10,
          } satisfies CreateFlashSaleCampaignItemInput)
          throw new Error("Expected duplicate item creation to fail")
        } catch (error) {
          // This expectation also documents the API-level error contract.
          expect(error).toMatchObject({ type: MedusaError.Types.CONFLICT })
        }

        await service.createCampaignItems({
          campaign_id: campaign.id,
          variant_id: "variant-location",
          location_id: "location-1",
          quota: 10,
        } satisfies CreateFlashSaleCampaignItemInput)

        await expect(
          service.createCampaignItems({
            campaign_id: campaign.id,
            variant_id: "variant-location",
            location_id: "location-1",
            quota: 10,
          } satisfies CreateFlashSaleCampaignItemInput)
        ).rejects.toMatchObject({ type: MedusaError.Types.CONFLICT })

        await service.createCampaignItems({
          campaign_id: campaign.id,
          variant_id: "variant-location",
          location_id: "location-2",
          quota: 10,
        } satisfies CreateFlashSaleCampaignItemInput)
      })

      it("rolls back the item set and parent version when a batch mutation fails", async () => {
        const campaign = await service.createCampaigns(makeCampaign())
        await service.createCampaignItems({
          campaign_id: campaign.id,
          variant_id: "rollback-existing",
          quota: 10,
        })
        const before = await service.retrieveCampaign(campaign.id)

        await expect(
          service.createCampaignItems([
            {
              campaign_id: campaign.id,
              variant_id: "rollback-new",
              quota: 5,
            },
            {
              campaign_id: campaign.id,
              variant_id: "rollback-existing",
              quota: 10,
            },
          ])
        ).rejects.toMatchObject({ type: MedusaError.Types.CONFLICT })

        const after = await service.retrieveCampaign(campaign.id)
        const items = await service.listCampaignItems({
          campaign_id: campaign.id,
        })
        expect(items.map((item) => item.variant_id)).toEqual([
          "rollback-existing",
        ])
        expect(after).toEqual(
          expect.objectContaining({
            version: before.version,
            rules_version: before.rules_version,
          })
        )
      })

      it("allows a campaign item key to be reused after soft deletion", async () => {
        const campaign = await service.createCampaigns(makeCampaign())
        const item = await service.createCampaignItems({
          campaign_id: campaign.id,
          variant_id: "variant-reusable",
          quota: 10,
        } satisfies CreateFlashSaleCampaignItemInput)

        await service.softDeleteCampaignItems(item.id)

        const recreated = await service.createCampaignItems({
          campaign_id: campaign.id,
          variant_id: "variant-reusable",
          quota: 10,
        } satisfies CreateFlashSaleCampaignItemInput)

        expect(recreated.id).not.toBe(item.id)
      })

      it("blocks hard deletion and restoration, and limits campaign deletion to safe states", async () => {
        const draft = await service.createCampaigns(makeCampaign())

        await expect(service.deleteCampaigns(draft.id)).rejects.toThrow(
          "Hard deletion of flash-sale campaigns is disabled"
        )
        await expect(service.restoreCampaigns(draft.id)).rejects.toThrow(
          "Campaign restoration is disabled"
        )

        await service.softDeleteCampaigns(draft.id)

        const active = await service.createCampaigns(makeCampaign())
        await service.transitionCampaignState(
          active.id,
          CampaignState.SCHEDULED
        )
        await service.transitionCampaignState(active.id, CampaignState.ACTIVE)

        await expect(service.softDeleteCampaigns(active.id)).rejects.toThrow(
          "cannot be deleted"
        )
      })

      it("keeps campaign-item identity immutable and updates quota through its locked command", async () => {
        const campaign = await service.createCampaigns(makeCampaign())
        const item = await service.createCampaignItems({
          campaign_id: campaign.id,
          variant_id: "variant-quota",
          quota: 10,
        } satisfies CreateFlashSaleCampaignItemInput)

        await expect(
          service.updateCampaignItems({
            id: item.id,
            quota: 20,
          } as unknown as { id: string })
        ).rejects.toThrow("quota cannot be changed through updateCampaignItems")

        await expect(
          service.updateCampaignItems({
            id: item.id,
            variant_id: "other-variant",
          } as unknown as { id: string })
        ).rejects.toThrow(
          "variant_id cannot be changed through updateCampaignItems"
        )

        const updated = await service.updateCampaignItemQuota({
          id: item.id,
          quota: 20,
        })
        expect(updated).toEqual(
          expect.objectContaining({ quota: 20, version: 2 })
        )

        await service.transitionCampaignState(
          campaign.id,
          CampaignState.SCHEDULED
        )
        await expect(
          service.updateCampaignItemQuota({ id: item.id, quota: 30 })
        ).rejects.toThrow("must be in draft state")
      })

      it("bumps parent rule versions once per item mutation transaction but not for metadata", async () => {
        const campaign = await service.createCampaigns(makeCampaign())
        const items = await service.createCampaignItems([
          {
            campaign_id: campaign.id,
            variant_id: "version-a",
            quota: 10,
          },
          {
            campaign_id: campaign.id,
            variant_id: "version-b",
            quota: 20,
          },
        ])
        const afterCreate = await service.retrieveCampaign(campaign.id)
        expect(afterCreate).toEqual(
          expect.objectContaining({ version: 2, rules_version: 2 })
        )

        await service.updateCampaignItemQuota({ id: items[0].id, quota: 11 })
        const afterQuota = await service.retrieveCampaign(campaign.id)
        expect(afterQuota).toEqual(
          expect.objectContaining({ version: 3, rules_version: 3 })
        )

        await service.updateCampaignItems({
          id: items[0].id,
          metadata: { note: "operational-only" },
        })
        await service.updateCampaigns({
          id: campaign.id,
          metadata: { note: "operational-only" },
        })
        const afterMetadata = await service.retrieveCampaign(campaign.id)
        expect(afterMetadata).toEqual(
          expect.objectContaining({ version: 3, rules_version: 3 })
        )

        await service.softDeleteCampaignItems(items.map((item) => item.id))
        const afterDelete = await service.retrieveCampaign(campaign.id)
        expect(afterDelete).toEqual(
          expect.objectContaining({ version: 4, rules_version: 4 })
        )
      })

      it("only soft-deletes campaign items while their campaign is a draft", async () => {
        const campaign = await service.createCampaigns(makeCampaign())
        const item = await service.createCampaignItems({
          campaign_id: campaign.id,
          variant_id: "variant-delete-boundary",
          quota: 10,
        } satisfies CreateFlashSaleCampaignItemInput)

        await expect(service.deleteCampaignItems(item.id)).rejects.toThrow(
          "Hard deletion of flash-sale campaign items is disabled"
        )
        await expect(service.restoreCampaignItems(item.id)).rejects.toThrow(
          "Campaign item restoration is disabled"
        )

        await service.transitionCampaignState(
          campaign.id,
          CampaignState.SCHEDULED
        )
        await expect(service.softDeleteCampaignItems(item.id)).rejects.toThrow(
          "must be in draft state"
        )
      })
    })
  },
})
