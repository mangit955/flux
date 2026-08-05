import type { MatchingEngine } from "../../matching-engine/index";
import { money, type MarkPrice } from "../../risk/src/index";
import type { MarkPriceSource } from "./liquidation-store";
import type { RuntimeStore } from "./store";

/**
 * Mark prices for local mode, where there is no Binance feed.
 *
 * Last traded price first — it is the only figure both sides of the book have agreed on — falling
 * back to the mid of the current book. A market with neither is left unpriced rather than marked
 * at zero, which the liquidation worker treats as "skip", not "everyone is underwater".
 */
export class LocalMarkPriceSource implements MarkPriceSource {
  constructor(
    private readonly store: RuntimeStore,
    private readonly engine: MatchingEngine,
  ) {}

  async markPrices(markets: string[]): Promise<MarkPrice[]> {
    const prices: MarkPrice[] = [];

    for (const marketId of markets) {
      const price = this.store.getLastTradePrice(marketId) ?? this.bookMid(marketId);

      if (price) {
        prices.push({ marketId, price });
      }
    }

    return prices;
  }

  private bookMid(marketId: string): MarkPrice["price"] | undefined {
    const book = this.engine.getBookSnapshot(marketId, 1);
    const bid = book.bids[0]?.priceTicks;
    const ask = book.asks[0]?.priceTicks;

    if (bid == null || ask == null) {
      return undefined;
    }

    return money(bid).add(money(ask)).div(2);
  }
}
