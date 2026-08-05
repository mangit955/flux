import {
  Decimal,
  ZERO,
  money,
  toDecimalString,
  type InsuranceFund,
  type InsuranceFundUsage,
  type Money,
} from "../../risk/src/index";
import type { DurableLiquidationStatus, LedgerEntryWrite, LiquidationWrite } from "../../db/src/index";
import type {
  LiquidationAccount,
  LiquidationSettlementState,
  LiquidationStore,
  OpenLiquidation,
} from "./liquidation-store";
import type { RuntimeStore } from "./store";
import type { RuntimeOrder } from "./types";

/** Matches the seeded fund in `prisma/seed.sql`, so local mode behaves like a fresh deployment. */
const DEFAULT_INSURANCE_FUND = "1000000";

const WORKING_ORDER_STATUSES: ReadonlySet<RuntimeOrder["status"]> = new Set([
  "PENDING",
  "OPEN",
  "PARTIALLY_FILLED",
]);

/**
 * The in-memory twin of `PrismaLiquidationStore`, over `RuntimeStore`.
 *
 * Balances move through `store.settleBalance` — the same method the in-memory persistence worker
 * settles fills with — so the negative-balance semantics stay identical to production.
 */
export class InMemoryLiquidationStore implements LiquidationStore {
  readonly liquidations = new Map<string, LiquidationWrite>();
  readonly ledger: LedgerEntryWrite[] = [];
  private readonly funds = new Map<string, Money>();

  constructor(private readonly store: RuntimeStore) {}

  async accountsWithOpenPositions(markets: string[]): Promise<LiquidationAccount[]> {
    const scanned = new Set(markets);
    const byUser = new Map<string, LiquidationAccount>();

    for (const position of this.store.positions.values()) {
      if (position.quantity.isZero() || !scanned.has(position.marketId)) {
        continue;
      }

      const market = this.store.markets.get(position.marketId);

      if (!market) {
        continue;
      }

      const existing = byUser.get(position.userId);

      if (existing) {
        existing.positions.push(position);
        continue;
      }

      byUser.set(position.userId, {
        userId: position.userId,
        collateralAsset: market.quoteAsset,
        walletBalance: this.store.storedBalance(position.userId, market.quoteAsset).total,
        positions: [position],
        openOrders: this.openOrdersFor(position.userId, scanned),
      });
    }

    return [...byUser.values()];
  }

  async workingOrders(
    userId: string,
    marketId: string,
  ): Promise<{ liquidation: string[]; other: string[] }> {
    const liquidation: string[] = [];
    const other: string[] = [];

    for (const order of this.store.orders.values()) {
      if (
        order.userId !== userId ||
        order.marketId !== marketId ||
        !WORKING_ORDER_STATUSES.has(order.status)
      ) {
        continue;
      }

      (order.reduceOnly ? liquidation : other).push(order.id);
    }

    return { liquidation, other };
  }

  async recordLiquidation(write: LiquidationWrite): Promise<void> {
    this.liquidations.set(write.id, write);
  }

  async findOpenLiquidations(): Promise<OpenLiquidation[]> {
    const open: OpenLiquidation[] = [];

    for (const liquidation of this.liquidations.values()) {
      if (liquidation.status !== "LIQUIDATING") {
        continue;
      }

      const market = this.store.markets.get(liquidation.marketId);

      if (!market) {
        continue;
      }

      open.push({
        id: liquidation.id,
        userId: liquidation.userId,
        marketId: liquidation.marketId,
        asset: market.quoteAsset,
      });
    }

    return open;
  }

  async settlementState(
    userId: string,
    marketId: string,
    asset: string,
  ): Promise<LiquidationSettlementState> {
    const balance = this.store.storedBalance(userId, asset);

    return {
      positionQuantity: this.store.getPosition(userId, marketId)?.quantity ?? ZERO,
      total: balance.total,
      locked: balance.locked,
    };
  }

  async readInsuranceFund(asset: string): Promise<InsuranceFund> {
    return { asset, balance: this.fundBalance(asset) };
  }

  async applyInsuranceFundUsage(input: {
    userId: string;
    asset: string;
    usage: InsuranceFundUsage;
    referenceId: string;
    now: Date;
  }): Promise<{ applied: Money; balanceAfter: Money }> {
    const available = this.fundBalance(input.asset);
    const applied = Decimal.min(available, input.usage.used);

    if (!applied.gt(ZERO)) {
      return {
        applied: ZERO,
        balanceAfter: this.store.storedBalance(input.userId, input.asset).total,
      };
    }

    this.funds.set(input.asset, available.sub(applied));
    this.store.settleBalance(input.userId, input.asset, applied);

    const balanceAfter = this.store.storedBalance(input.userId, input.asset).total;

    this.ledger.push({
      id: `${input.referenceId}:insurance-fund`,
      userId: null,
      asset: input.asset,
      type: "INSURANCE_FUND_TRANSFER",
      amount: toWrite(applied.neg()),
      balanceAfter: toWrite(available.sub(applied)),
      referenceId: input.referenceId,
      createdAt: input.now,
    });
    this.ledger.push({
      id: `${input.referenceId}:liquidation-loss`,
      userId: input.userId,
      asset: input.asset,
      type: "LIQUIDATION_LOSS",
      amount: toWrite(applied),
      balanceAfter: toWrite(balanceAfter),
      referenceId: input.referenceId,
      createdAt: input.now,
    });

    return { applied, balanceAfter };
  }

  async updateLiquidationSettlement(input: {
    id: string;
    status: DurableLiquidationStatus;
    insuranceFundUsed: Money;
    adlUsed: Money;
    updatedAt: Date;
  }): Promise<void> {
    const existing = this.liquidations.get(input.id);

    if (!existing) {
      return;
    }

    this.liquidations.set(input.id, {
      ...existing,
      status: input.status,
      insuranceFundUsed: toWrite(input.insuranceFundUsed),
      adlUsed: toWrite(input.adlUsed),
      updatedAt: input.updatedAt,
    });
  }

  /** Test and demo seam: local mode has no admin endpoint for funding the insurance fund. */
  setInsuranceFund(asset: string, balance: Money): void {
    this.funds.set(asset, balance);
  }

  private fundBalance(asset: string): Money {
    return this.funds.get(asset) ?? money(DEFAULT_INSURANCE_FUND);
  }

  private openOrdersFor(userId: string, markets: Set<string>) {
    const openOrders = [];

    for (const order of this.store.orders.values()) {
      const market = this.store.markets.get(order.marketId);

      if (
        order.userId !== userId ||
        !markets.has(order.marketId) ||
        !WORKING_ORDER_STATUSES.has(order.status) ||
        !market
      ) {
        continue;
      }

      openOrders.push({
        marketId: order.marketId,
        side: order.side,
        price: money(order.price ?? 0),
        quantity: money(order.remainingQuantity),
        reduceOnly: order.reduceOnly,
        estimatedFeeRate: money(market.takerFeeRate),
        leverage: order.leverage,
      });
    }

    return openOrders;
  }
}

/** One canonical representation, the same one the Prisma writes use. */
function toWrite(value: Money): string {
  return toDecimalString(value);
}
