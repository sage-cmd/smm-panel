import Decimal from "decimal.js";

/**
 * Configure Decimal precision for financial accuracy.
 * 20 digits of precision with standard Half-Up rounding for monetary calculations.
 */
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

export interface DripFeedBatchPlan {
  batchNumber: number;
  quantity: number;
  scheduledAt: Date;
}

/**
 * Calculates the total charge for a service order.
 * Formula: (quantity / 1000) * ratePer1000
 * Returned with 6 decimal places of precision.
 */
export function calculateOrderCharge(
  quantity: number,
  ratePer1000: Decimal | string | number,
): Decimal {
  const qty = new Decimal(quantity);
  const rate = new Decimal(ratePer1000.toString());

  const rawCharge = qty.dividedBy(1000).times(rate);
  return rawCharge.toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
}

/**
 * Formats a monetary Decimal for display.
 * Default 2 decimal places (e.g., "15.50" USD).
 */
export function formatMonetaryAmount(
  amount: Decimal | string | number,
  decimalPlaces: number = 2,
): string {
  const dec = new Decimal(amount.toString());
  return dec.toFixed(decimalPlaces);
}

/**
 * Distributes total quantity across multiple drip-feed runs with remainder allocation.
 * Remainder distribution strategy:
 *   base = floor(quantity / runs)
 *   remainder = quantity % runs
 *   The first `remainder` batches receive `base + 1`, and the remaining receive `base`.
 * This guarantees: sum(batch.quantity) === totalQuantity.
 */
export function distributeDripFeedBatches(
  totalQuantity: number,
  runs: number,
  intervalMinutes: number,
  startDate: Date = new Date(),
): DripFeedBatchPlan[] {
  if (runs <= 0) {
    throw new Error("Drip-feed runs must be greater than zero");
  }

  const baseQty = Math.floor(totalQuantity / runs);
  const remainder = totalQuantity % runs;

  const batches: DripFeedBatchPlan[] = [];

  for (let i = 1; i <= runs; i++) {
    const qty = i <= remainder ? baseQty + 1 : baseQty;
    // Batch 1 runs immediately (delay = 0), subsequent batches run at interval intervals
    const delayMinutes = (i - 1) * intervalMinutes;
    const scheduledAt = new Date(startDate.getTime() + delayMinutes * 60 * 1000);

    batches.push({
      batchNumber: i,
      quantity: qty,
      scheduledAt,
    });
  }

  return batches;
}
