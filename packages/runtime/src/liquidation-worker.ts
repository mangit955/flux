import { toLiquidationWrite, type DurableLiquidationStatus } from "../../db/src/index";
import {
  ZERO,
  createLiquidationTriggers,
  toNumber,
  useInsuranceFund,
  type LiquidationTrigger,
  type MarketRiskConfig,
  type Money,
} from "../../risk/src/index";
import type {
  LiquidationOrderSubmitter,
  LiquidationStore,
  MarkPriceSource,
  OpenLiquidation,
} from "./liquidation-store";
import { toRiskConfig, type RuntimeMarket } from "./types";

export interface LiquidationWorkerOptions {
  store: LiquidationStore;
  submitter: LiquidationOrderSubmitter;
  markPrices: MarkPriceSource;
  markets: () => RuntimeMarket[] | Promise<RuntimeMarket[]>;
  clock?: () => number;
  /** Price buffer on the forced-close limit order. Defaults to the risk package's 0.5%. */
  slippageBufferRate?: Money;
  /**
   * Minimum gap between forced-close attempts on the same position. An IOC order that finds no
   * liquidity expires immediately, so without this the scan would resubmit on every tick and fill
   * the order table with expired orders while the book stays empty.
   */
  retryIntervalMs?: number;
}

const DEFAULT_RETRY_INTERVAL_MS = 1_000;

/**
 * Closes positions that have fallen below maintenance margin, then settles what the close left
 * behind.
 *
 * The scan and the settlement are separate passes on purpose. A forced close is asynchronous — it
 * goes through the same command stream, matching engine and persistence worker as a user order —
 * so the money it moves is not visible until a later cycle. Pass A only decides *what* to close;
 * pass B looks at liquidations whose position has since gone flat and resolves any shortfall
 * against the insurance fund.
 *
 * All of the actual risk arithmetic lives in `packages/risk`: this class assembles inputs and
 * writes results back through `LiquidationStore`.
 */
export class LiquidationWorker {
  private readonly lastAttemptAt = new Map<string, number>();

  constructor(private readonly options: LiquidationWorkerOptions) {}

  /** Returns the number of liquidation actions taken — orders submitted, cancels, settlements. */
  async processOnce(): Promise<number> {
    const markets = await this.options.markets();

    return (
      (await this.scanForViolations(markets)) +
      (await this.settleOpenLiquidations(markets))
    );
  }

  private async scanForViolations(markets: RuntimeMarket[]): Promise<number> {
    const marketIds = markets.map((market) => market.marketId);

    if (marketIds.length === 0) {
      return 0;
    }

    const markPrices = await this.options.markPrices.markPrices(marketIds);

    if (markPrices.length === 0) {
      return 0;
    }

    // Only scan markets that have a fresh mark price. A missing price is not "no risk": pricing a
    // position at zero would liquidate every account holding it, so those markets are skipped.
    const priced = new Set(markPrices.map((markPrice) => markPrice.marketId));
    const riskConfigs = markets
      .filter((market) => priced.has(market.marketId))
      .map(toRiskConfig);
    const accounts = await this.options.store.accountsWithOpenPositions([...priced]);
    let actions = 0;

    for (const account of accounts) {
      // Both lists are narrowed to priced markets: `calculateMarginSummary` throws on a position
      // or open order whose market it was not given, and an unpriced market is one it never gets.
      const positions = account.positions.filter((position) =>
        priced.has(position.marketId),
      );
      const openOrders = account.openOrders.filter((order) =>
        priced.has(order.marketId),
      );

      if (positions.length === 0) {
        continue;
      }

      const triggers = createLiquidationTriggers({
        eventId: `liq-${account.userId}-${this.now()}`,
        account: { ...account, positions, openOrders },
        markets: riskConfigs,
        markPrices,
        createdAt: this.now(),
        slippageBufferRate: this.options.slippageBufferRate,
      });

      for (const trigger of triggers) {
        const position = positions.find(
          (candidate) => candidate.marketId === trigger.marketId,
        );

        actions += await this.actOnTrigger(
          trigger,
          marketRiskFor(riskConfigs, trigger.marketId),
          position?.leverage,
        );
      }
    }

    return actions;
  }

  /**
   * Cancel first, close second.
   *
   * The user's own resting orders have to be out of the book before the forced close is submitted,
   * or the engine hits self-trade prevention and expires the liquidation order without filling.
   * The cancel is worth doing on its own account too: it releases the collateral those orders hold,
   * which occasionally lifts the account back above maintenance margin with no close at all.
   */
  private async actOnTrigger(
    trigger: LiquidationTrigger,
    market: MarketRiskConfig | undefined,
    positionLeverage: number | undefined,
  ): Promise<number> {
    if (!market || this.isCoolingDown(trigger.userId, trigger.marketId)) {
      return 0;
    }

    const working = await this.options.store.workingOrders(
      trigger.userId,
      trigger.marketId,
    );

    if (working.other.length > 0) {
      // Consumes the cooldown as well: the cancels are asynchronous, so without it the next tick
      // would re-cancel orders that are already on their way out.
      this.lastAttemptAt.set(attemptKey(trigger.userId, trigger.marketId), this.now());

      for (const orderId of working.other) {
        await this.options.submitter.cancelOrder(
          trigger.userId,
          trigger.marketId,
          orderId,
        );
      }

      console.warn(
        `[LIQUIDATION] cancelled ${working.other.length} working order(s) for ${trigger.userId} ` +
          `on ${trigger.marketId} before closing`,
      );
      return working.other.length;
    }

    if (working.liquidation.length > 0) {
      // A forced close is already in flight; re-submitting would double the size being closed.
      return 0;
    }

    const order = trigger.order;

    this.lastAttemptAt.set(attemptKey(trigger.userId, trigger.marketId), this.now());

    await this.options.submitter.submitOrder({
      userId: order.userId,
      marketId: order.marketId,
      side: order.side,
      type: "LIMIT",
      quantity: toNumber(order.quantity),
      price: toNumber(order.limitPrice),
      // IOC: an unfilled remainder expires rather than resting in the book, and the next scan
      // retries against whatever liquidity has appeared since.
      timeInForce: "IOC",
      reduceOnly: true,
      // Reduce-only reserves no margin, but `checkOrderMargin` validates the leverage bound before
      // it reaches that branch, so the value still has to be legal for the market.
      leverage: clampLeverage(positionLeverage, market.maxLeverage),
    });

    await this.options.store.recordLiquidation(
      toLiquidationWrite(trigger, {
        insuranceFundUsed: ZERO,
        adlUsed: ZERO,
        status: "LIQUIDATING",
      }),
    );

    console.warn(
      `[LIQUIDATION] closing ${trigger.userId} ${trigger.marketId}: ` +
        `equity ${trigger.accountEquity.toFixed()} <= maintenance ${trigger.maintenanceMargin.toFixed()}`,
    );

    return 1;
  }

  private async settleOpenLiquidations(markets: RuntimeMarket[]): Promise<number> {
    const open = await this.options.store.findOpenLiquidations();
    let settled = 0;

    for (const liquidation of open) {
      if (!markets.some((market) => market.marketId === liquidation.marketId)) {
        continue;
      }

      if (await this.settleOne(liquidation)) {
        settled += 1;
      }
    }

    return settled;
  }

  private async settleOne(liquidation: OpenLiquidation): Promise<boolean> {
    const state = await this.options.store.settlementState(
      liquidation.userId,
      liquidation.marketId,
      liquidation.asset,
    );

    if (!state.positionQuantity.isZero()) {
      // Still closing. The position is flat only once the fills have been persisted.
      return false;
    }

    const now = new Date(this.now());

    if (!state.total.isNegative()) {
      await this.options.store.updateLiquidationSettlement({
        id: liquidation.id,
        status: "CLOSED",
        insuranceFundUsed: ZERO,
        adlUsed: ZERO,
        updatedAt: now,
      });
      return true;
    }

    if (state.locked.gt(ZERO)) {
      // Crediting the deficit now would leave `locked > total`. The cancel pass drains `locked`,
      // so this resolves on a later cycle.
      return false;
    }

    const deficit = state.total.neg();
    const fund = await this.options.store.readInsuranceFund(liquidation.asset);
    const usage = useInsuranceFund(fund, deficit);
    const { applied } = await this.options.store.applyInsuranceFundUsage({
      userId: liquidation.userId,
      asset: liquidation.asset,
      usage,
      referenceId: liquidation.id,
      now,
    });
    const unresolved = deficit.sub(applied);
    const status: DurableLiquidationStatus = unresolved.isZero()
      ? "INSURANCE_FUND_USED"
      : "FAILED";

    await this.options.store.updateLiquidationSettlement({
      id: liquidation.id,
      status,
      insuranceFundUsed: applied,
      adlUsed: ZERO,
      updatedAt: now,
    });

    if (!unresolved.isZero()) {
      // ADL is the designed next resort and is not wired yet (TODO). Left as bad debt on the
      // user's balance rather than forgiven, so the shortfall stays visible in the books.
      console.error(
        `[LIQUIDATION] insurance fund could not cover ${liquidation.userId} ${liquidation.asset}: ` +
          `deficit ${deficit.toFixed()}, covered ${applied.toFixed()}, unresolved ${unresolved.toFixed()}`,
      );
    }

    return true;
  }

  private isCoolingDown(userId: string, marketId: string): boolean {
    const last = this.lastAttemptAt.get(attemptKey(userId, marketId));

    if (last == null) {
      return false;
    }

    const interval = this.options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;

    return this.now() - last < interval;
  }

  private now(): number {
    return this.options.clock?.() ?? Date.now();
  }
}

function attemptKey(userId: string, marketId: string): string {
  return `${userId}:${marketId}`;
}

function marketRiskFor(
  markets: MarketRiskConfig[],
  marketId: string,
): MarketRiskConfig | undefined {
  return markets.find((market) => market.marketId === marketId);
}

function clampLeverage(leverage: number | undefined, maxLeverage: number): number {
  if (leverage == null || !Number.isInteger(leverage) || leverage < 1) {
    return maxLeverage;
  }

  return Math.min(leverage, maxLeverage);
}
