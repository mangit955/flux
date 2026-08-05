import type { DurableLiquidationStatus, LiquidationWrite } from "../../db/src/index";
import type {
  InsuranceFund,
  InsuranceFundUsage,
  MarkPrice,
  Money,
  OpenOrderRisk,
  Position,
} from "../../risk/src/index";
import type { SubmitOrderInput } from "./exchange-runtime";
import type { RuntimeOrder } from "./types";

/**
 * The ports the liquidation worker runs on.
 *
 * Same shape as `PersistenceStore`: one narrow interface with an in-memory implementation for
 * local mode and tests, and a Prisma implementation for production. The worker itself performs no
 * money arithmetic — it feeds these into the pure functions in `packages/risk` and writes the
 * result back through the store.
 */

/** One account's state, in the exact form `calculateMarginSummary` needs. */
export interface LiquidationAccount {
  userId: string;
  collateralAsset: string;
  walletBalance: Money;
  positions: Position[];
  openOrders: OpenOrderRisk[];
}

/** A liquidation that has been triggered and whose forced close has not settled yet. */
export interface OpenLiquidation {
  id: string;
  userId: string;
  marketId: string;
  asset: string;
}

/** What the settlement pass needs to decide whether a liquidation is finished. */
export interface LiquidationSettlementState {
  positionQuantity: Money;
  total: Money;
  locked: Money;
}

export interface LiquidationStore {
  /** Every account holding a non-flat position in one of `markets`. */
  accountsWithOpenPositions(markets: string[]): Promise<LiquidationAccount[]>;
  /**
   * Order ids still working for this user and market, split by whether they are the liquidation's
   * own reduce-only orders. `other` has to be cancelled before a liquidation order is submitted:
   * the engine stops matching with `SELF_TRADE_PREVENTION` when the best opposite maker is the
   * same user (`matching-engine/src/orderbook.ts`), which would expire the liquidation order.
   */
  workingOrders(
    userId: string,
    marketId: string,
  ): Promise<{ liquidation: string[]; other: string[] }>;
  /** Upsert by id, so a rescan within the same millisecond cannot collide on `eventId`. */
  recordLiquidation(write: LiquidationWrite): Promise<void>;
  findOpenLiquidations(): Promise<OpenLiquidation[]>;
  settlementState(
    userId: string,
    marketId: string,
    asset: string,
  ): Promise<LiquidationSettlementState>;
  readInsuranceFund(asset: string): Promise<InsuranceFund>;
  /**
   * Debit the insurance fund and credit the user in one transaction, with a ledger entry on each
   * side. Returns what was actually applied: the fund is debited conditionally, so a concurrent
   * draw can leave less available than `usage.used` assumed.
   */
  applyInsuranceFundUsage(input: {
    userId: string;
    asset: string;
    usage: InsuranceFundUsage;
    referenceId: string;
    now: Date;
  }): Promise<{ applied: Money; balanceAfter: Money }>;
  updateLiquidationSettlement(input: {
    id: string;
    status: DurableLiquidationStatus;
    insuranceFundUsed: Money;
    adlUsed: Money;
    updatedAt: Date;
  }): Promise<void>;
}

/**
 * How the worker places its forced-close orders.
 *
 * Both `PrismaApiRuntime` and `ExchangeRuntime` satisfy this structurally, so a liquidation order
 * takes exactly the same path as a user order — including the reduce-only branches that lock no
 * collateral (`checkOrderMargin` returns ok for reduce-only; `submitOrder` then locks nothing and
 * records `lockedMargin: 0`).
 */
export interface LiquidationOrderSubmitter {
  submitOrder(input: SubmitOrderInput): Promise<RuntimeOrder>;
  cancelOrder(userId: string, marketId: string, orderId: string): Promise<void>;
}

/** Mark prices for the markets being scanned. Markets without a fresh price are skipped. */
export interface MarkPriceSource {
  markPrices(markets: string[]): Promise<MarkPrice[]>;
}
