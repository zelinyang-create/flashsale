export type AllocationFaultPoint =
  | "after_movement_writer_shared_lock"
  | "after_movement_ledger_exclusive_lock"
  | "after_provision_campaign_lock"
  | "during_expiry_release"
  | "after_first_capacity_movement_append"
  | "after_domain_transition_before_outbox"
  | "after_outbox_append_before_commit"

export interface AllocationFaultInjector {
  hit(
    name: AllocationFaultPoint,
    attemptId: string
  ): void | Promise<void>
}
