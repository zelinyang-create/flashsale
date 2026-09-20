import {
  WorkflowData,
  WorkflowResponse,
  createWorkflow,
  transform,
} from "@medusajs/framework/workflows-sdk"

import { CampaignLifecycleWorkflowInput, LifecycleResult } from "./contracts"
import { provisionCampaignAllocationStep } from "./steps/provision-allocation"
import {
  readActivateCampaignSnapshotStep,
  readCancelableCampaignStep,
  readEndableCampaignStep,
  readScheduleCampaignSnapshotStep,
  validateCampaignLifecycleInputStep,
} from "./steps/shared"
import {
  fenceAndCloseAllocationForCancelStep,
  fenceAndCloseAllocationForEndStep,
  openCampaignAllocationStep,
} from "./steps/transition-allocation"
import {
  activateCampaignStateStep,
  cancelCampaignStateStep,
  endCampaignStateStep,
  scheduleCampaignStateStep,
} from "./steps/transition-campaign"

export const scheduleCampaignWorkflow = createWorkflow(
  "schedule-campaign",
  (input: WorkflowData<CampaignLifecycleWorkflowInput>) => {
    const validInput = validateCampaignLifecycleInputStep(input)
    const snapshot = readScheduleCampaignSnapshotStep(validInput)
    const policy = provisionCampaignAllocationStep(snapshot)
    const snapshotAfterProvision = transform(
      { snapshot, policy },
      ({ snapshot }) => snapshot
    )
    const campaign = scheduleCampaignStateStep(snapshotAfterProvision)
    const result = transform(
      { campaign, policy },
      ({ campaign, policy }): LifecycleResult => ({
        campaign,
        allocation_policy: policy,
        allocation_fence: null,
      })
    )
    return new WorkflowResponse(result)
  }
)

export const activateCampaignWorkflow = createWorkflow(
  "activate-campaign",
  (input: WorkflowData<CampaignLifecycleWorkflowInput>) => {
    const validInput = validateCampaignLifecycleInputStep(input)
    const snapshot = readActivateCampaignSnapshotStep(validInput)
    const provisioned = provisionCampaignAllocationStep(snapshot)
    const snapshotAfterProvision = transform(
      { snapshot, provisioned },
      ({ snapshot }) => snapshot
    )
    const campaign = activateCampaignStateStep(snapshotAfterProvision)
    const policyAfterCampaignActivation = transform(
      { provisioned, campaign },
      ({ provisioned }) => provisioned
    )
    const policy = openCampaignAllocationStep(policyAfterCampaignActivation)
    const result = transform(
      { campaign, policy },
      ({ campaign, policy }): LifecycleResult => ({
        campaign,
        allocation_policy: policy,
        allocation_fence: null,
      })
    )
    return new WorkflowResponse(result)
  }
)

export const cancelCampaignWorkflow = createWorkflow(
  "cancel-campaign",
  (input: WorkflowData<CampaignLifecycleWorkflowInput>) => {
    const validInput = validateCampaignLifecycleInputStep(input)
    const observed = readCancelableCampaignStep(validInput)
    const terminalAllocation = fenceAndCloseAllocationForCancelStep(observed)
    const campaignAfterClose = transform(
      { observed, terminalAllocation },
      ({ observed }) => observed
    )
    const campaign = cancelCampaignStateStep(campaignAfterClose)
    const result = transform(
      { campaign, terminalAllocation },
      ({ campaign, terminalAllocation }): LifecycleResult => ({
        campaign,
        allocation_policy: terminalAllocation.allocation_policy,
        allocation_fence: terminalAllocation.fence,
      })
    )
    return new WorkflowResponse(result)
  }
)

export const endCampaignWorkflow = createWorkflow(
  "end-campaign",
  (input: WorkflowData<CampaignLifecycleWorkflowInput>) => {
    const validInput = validateCampaignLifecycleInputStep(input)
    const observed = readEndableCampaignStep(validInput)
    const terminalAllocation = fenceAndCloseAllocationForEndStep(observed)
    const campaignAfterClose = transform(
      { observed, terminalAllocation },
      ({ observed }) => observed
    )
    const campaign = endCampaignStateStep(campaignAfterClose)
    const result = transform(
      { campaign, terminalAllocation },
      ({ campaign, terminalAllocation }): LifecycleResult => ({
        campaign,
        allocation_policy: terminalAllocation.allocation_policy,
        allocation_fence: terminalAllocation.fence,
      })
    )
    return new WorkflowResponse(result)
  }
)
