import { CampaignState } from "../../../../types"
import {
  assertSnapshotTransitionCommand,
  assertVersionedTransitionCommand,
} from "../campaign-transition-command"

const snapshotCommand = () => ({
  campaign_id: "campaign_1",
  target_state: CampaignState.SCHEDULED,
  expected_version: 2,
  expected_rules_version: 2,
  expected_items: [{ campaign_item_id: "item_1", quota: 10, version: 1 }],
})

describe("campaign transition command boundaries", () => {
  it("accepts exact snapshot and versioned commands", () => {
    expect(() =>
      assertSnapshotTransitionCommand(snapshotCommand())
    ).not.toThrow()
    expect(() =>
      assertVersionedTransitionCommand({
        campaign_id: "campaign_1",
        target_state: CampaignState.CANCELLED,
        expected_version: 2,
        expected_rules_version: 2,
      })
    ).not.toThrow()
  })

  it.each([
    { ...snapshotCommand(), extra: true },
    Object.assign(Object.create({ inherited: true }), snapshotCommand()),
    Object.defineProperty(snapshotCommand(), "campaign_id", {
      get: () => "campaign_1",
      enumerable: true,
    }),
    Object.assign(snapshotCommand(), { [Symbol("hidden")]: true }),
  ])("rejects non-exact snapshot command objects", (command) => {
    expect(() => assertSnapshotTransitionCommand(command)).toThrow()
  })

  it("rejects malformed or duplicate item snapshots", () => {
    expect(() =>
      assertSnapshotTransitionCommand({
        ...snapshotCommand(),
        expected_items: [],
      })
    ).toThrow("complete live campaign item set")
    expect(() =>
      assertSnapshotTransitionCommand({
        ...snapshotCommand(),
        expected_items: [
          { campaign_item_id: "item_1", quota: 10, version: 1 },
          { campaign_item_id: "item_1", quota: 20, version: 1 },
        ],
      })
    ).toThrow("unique campaign_item_id")
    expect(() =>
      assertSnapshotTransitionCommand({
        ...snapshotCommand(),
        expected_items: [
          {
            campaign_item_id: "item_1",
            quota: 10,
            version: 1,
            extra: true,
          },
        ],
      })
    ).toThrow("Snapshot item must contain exactly")
  })

  it("rejects invalid state and non-positive versions", () => {
    expect(() =>
      assertVersionedTransitionCommand({
        campaign_id: "campaign_1",
        target_state: "unknown",
        expected_version: 1,
        expected_rules_version: 1,
      })
    ).toThrow("target_state is invalid")
    expect(() =>
      assertVersionedTransitionCommand({
        campaign_id: "campaign_1",
        target_state: CampaignState.ENDED,
        expected_version: 0,
        expected_rules_version: 1,
      })
    ).toThrow("expected_version must be a positive integer")
  })
})
