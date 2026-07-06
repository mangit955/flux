// ─── API Types (mirroring packages/runtime/src/types.ts) ─────────────────────

export interface ApiBalance {
  userId: string;
  asset: string;
  total: number;
  locked: number;
}

export interface ApiOrder {
  id: string;
  userId: string;
  marketId: string;
  side: "BUY" | "SELL" | "buy" | "sell";
  type: "MARKET" | "LIMIT" | "market" | "limit";
  quantity: number;
  remainingQuantity: number;
  price?: number;
  timeInForce: "GTC" | "IOC";
  reduceOnly: boolean;
  postOnly: boolean;
  status:
    | "PENDING"
    | "OPEN"
    | "PARTIALLY_FILLED"
    | "FILLED"
    | "CANCELLED"
    | "REJECTED"
    | "EXPIRED";
  rejectionReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ApiFill {
  id: string;
  tradeId: string;
  orderId: string;
  userId: string;
  marketId: string;
  side: "BUY" | "SELL";
  liquidityRole: "MAKER" | "TAKER";
  price: number;
  quantity: number;
  notional: number;
  fee: number;
  realizedPnl: number;
  createdAt: number;
}

/** Shape returned by GET /positions (from packages/risk's Position type) */
export interface ApiPosition {
  userId: string;
  marketId: string;
  side: "LONG" | "SHORT";
  quantity: number;
  entryPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  margin: number;
  leverage: number;
  liquidationPrice: number;
  markPrice: number;
  // Some runtimes may add extra fields
  [key: string]: unknown;
}

export interface ApiMarket {
  id: string;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: "ACTIVE" | "PAUSED";
  maxLeverage: number;
  [key: string]: unknown;
}

export interface SubmitOrderPayload {
  marketId: string;
  side: "buy" | "sell";
  type: "limit" | "market";
  quantity: number | string;
  price?: number | string;
  leverage?: number | string;
  timeInForce?: "GTC" | "IOC";
  reduceOnly?: boolean;
  postOnly?: boolean;
}

// ─── Client ──────────────────────────────────────────────────────────────────

// Get API URL with better fallback handling
function getApiUrl(): string {
  if (typeof window !== 'undefined') {
    // Browser environment
    const url = process.env.NEXT_PUBLIC_API_URL;
    if (!url) {
      console.warn('[API] NEXT_PUBLIC_API_URL not set, using default: http://localhost:3000');
      return "http://localhost:3000";
    }
    console.log('[API] Using API URL:', url);
    return url;
  }
  // Server environment
  return process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";
}

const BASE_URL = getApiUrl();

export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ApiError";
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  token?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  console.log(`[API] ${options.method || 'GET'} ${BASE_URL}${path}`);
  
  try {
    const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
    
    console.log(`[API] Response status: ${res.status} ${res.statusText}`);
    
    const data = (await res.json()) as T & { error?: { code: string; message: string } };

    if (!res.ok) {
      const err = (data as { error?: { code: string; message: string } }).error;
      const errorCode = err?.code ?? "UNKNOWN";
      const errorMessage = err?.message ?? `HTTP ${res.status}`;
      
      console.error(`[API] Error: ${errorCode} - ${errorMessage}`);
      
      throw new ApiError(errorCode, res.status, errorMessage);
    }

    console.log(`[API] Success:`, data);
    return data;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    
    // Network or parsing error
    console.error(`[API] Network/Parse error:`, error);
    throw new ApiError(
      "NETWORK_ERROR",
      0,
      error instanceof Error ? error.message : "Network request failed"
    );
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export async function apiRegister(
  email: string,
  password: string,
): Promise<{ userId: string }> {
  return request("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function apiLogin(
  email: string,
  password: string,
): Promise<{ token: string; userId: string }> {
  return request("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function apiGuestLogin(): Promise<{ token: string; userId: string }> {
  return request("/auth/guest", {
    method: "POST",
  });
}

// ─── Markets ─────────────────────────────────────────────────────────────────

export async function apiListMarkets(): Promise<ApiMarket[]> {
  return request("/markets");
}

// ─── OrderBook ───────────────────────────────────────────────────────────────

export async function apiGetOrderBook(
  marketId: string,
  depth?: number,
): Promise<{
  market: string;
  sequence: number;
  bids: Array<{ priceTicks: number; totalQtyLots: number }>;
  asks: Array<{ priceTicks: number; totalQtyLots: number }>;
}> {
  const params = depth ? `?depth=${depth}` : "";
  return request(`/markets/${marketId}/orderbook${params}`);
}

// ─── Utility Functions ──────────────────────────────────────────────────────

/** Convert backend orderbook to frontend OrderBookData format */
export function convertOrderBookToFrontend(
  backendBook: {
    bids: Array<{ priceTicks: number; totalQtyLots: number }>;
    asks: Array<{ priceTicks: number; totalQtyLots: number }>;
  }
): {
  asks: { price: number; size: number; total: number }[];
  bids: { price: number; size: number; total: number }[];
  spread: number;
  spreadPercentage: number;
  midPrice: number;
} {
  // Convert and add running totals
  let bidTotal = 0;
  const bids = backendBook.bids.map(entry => {
    bidTotal += entry.totalQtyLots;
    return {
      price: entry.priceTicks,
      size: entry.totalQtyLots,
      total: bidTotal,
    };
  });

  let askTotal = 0;
  const asks = backendBook.asks.map(entry => {
    askTotal += entry.totalQtyLots;
    return {
      price: entry.priceTicks,
      size: entry.totalQtyLots,
      total: askTotal,
    };
  });

  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 0;
  const spread = bestAsk - bestBid;
  const midPrice = (bestBid + bestAsk) / 2;
  const spreadPercentage = midPrice > 0 ? (spread / midPrice) * 100 : 0;

  return {
    asks,
    bids,
    spread,
    spreadPercentage,
    midPrice,
  };
}

// ─── Balances ────────────────────────────────────────────────────────────────

export async function apiGetBalances(token: string): Promise<ApiBalance[]> {
  return request("/balances", {}, token);
}

// ─── Positions ───────────────────────────────────────────────────────────────

export async function apiGetPositions(token: string): Promise<ApiPosition[]> {
  return request("/positions", {}, token);
}

// ─── Orders ──────────────────────────────────────────────────────────────────

export async function apiGetOrders(token: string): Promise<ApiOrder[]> {
  return request("/orders", {}, token);
}

export async function apiSubmitOrder(
  token: string,
  payload: SubmitOrderPayload,
): Promise<ApiOrder> {
  return request(
    "/orders",
    { method: "POST", body: JSON.stringify(payload) },
    token,
  );
}

export async function apiCancelOrder(
  token: string,
  orderId: string,
): Promise<{ orderId: string; status: string }> {
  return request(`/orders/${orderId}`, { method: "DELETE" }, token);
}

// ─── Fills ───────────────────────────────────────────────────────────────────

export async function apiGetFills(token: string): Promise<ApiFill[]> {
  return request("/fills", {}, token);
}

// ─── Deposits (utility) ───────────────────────────────────────────────────────

export async function apiDeposit(
  token: string,
  asset: string,
  amount: number,
): Promise<ApiBalance> {
  return request(
    "/deposits",
    { method: "POST", body: JSON.stringify({ asset, amount }) },
    token,
  );
}

export async function apiWithdraw(
  token: string,
  asset: string,
  amount: number,
): Promise<ApiBalance> {
  return request(
    "/withdrawals",
    { method: "POST", body: JSON.stringify({ asset, amount }) },
    token,
  );
}
