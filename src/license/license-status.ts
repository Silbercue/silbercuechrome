/**
 * License status abstraction.
 * Story 9.1: Minimal interface — Story 9.2 will provide the real implementation.
 */
export interface LicenseStatus {
  /** Returns true when the user has an active Pro license */
  isPro(): boolean;
}

/**
 * Default implementation: always Free Tier.
 * Replaced by a real validator in Story 9.2.
 */
export class FreeTierLicenseStatus implements LicenseStatus {
  isPro(): boolean {
    return false;
  }
}
