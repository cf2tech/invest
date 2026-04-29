import type {
  AccountDashboardItem,
  ApiAccount,
  BondRow,
  BreakdownItem,
  DashboardPayload,
  MoneyAmount,
  PortfolioPayload,
  PortfolioPosition,
  PositionRow,
  SummaryPayload
} from "../types/domain";
import type {
  TInvestAccount,
  TInvestBond,
  TInvestBondCoupon,
  TInvestInstrument,
  TInvestLastPrice,
  TInvestPortfolioPosition,
  TInvestPortfolioResponse
} from "../types/tinvest";
import { addMoneyAmounts, moneyToAmount, multiplyMoney, percent, quotationToAmount, quotationToNumber } from "./money";
import { TInvestClient } from "./tinvestClient";

const INSTRUMENT_CACHE_TTL_MS = 10 * 60 * 1000;
const COUPON_CACHE_TTL_MS = 60 * 60 * 1000;
const RESPONSE_CACHE_TTL_MS = 15 * 1000;
const RESPONSE_CACHE_MAX_STALE_MS = 5 * 60 * 1000;

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

export class PortfolioService {
  private readonly instrumentCache = new Map<string, CacheEntry<TInvestInstrument>>();
  private readonly bondCache = new Map<string, CacheEntry<TInvestBond>>();
  private readonly couponCache = new Map<string, CacheEntry<TInvestBondCoupon[]>>();
  private readonly summaryCache = new Map<string, CacheEntry<SummaryPayload>>();
  private readonly positionRowsCache = new Map<string, CacheEntry<PositionRow[]>>();

  constructor(private readonly client: TInvestClient) {}

  async getAccounts(): Promise<ApiAccount[]> {
    const response = await this.client.getAccounts();
    return (response.accounts ?? [])
      .filter((account): account is TInvestAccount & { id: string } => Boolean(account.id))
      .map((account) => ({
        id: account.id,
        name: account.name || account.id,
        type: account.type,
        status: account.status,
        openedDate: account.openedDate,
        closedDate: account.closedDate
      }));
  }

  async getPortfolio(accountId: string): Promise<PortfolioPayload> {
    const portfolio = await this.client.getPortfolio(accountId);
    const positions = (portfolio.positions ?? []).map((position) => normalizePosition(position));
    const totalAmountPortfolio = resolveTotalPortfolioAmount(portfolio);
    const expectedYield = moneyToAmount(portfolio.expectedYield);

    return {
      accountId,
      totalAmountPortfolio,
      expectedYield,
      expectedYieldPercent: percent(expectedYield.value, totalAmountPortfolio.value),
      positions,
      fetchedAt: new Date().toISOString()
    };
  }

  async getPositions(accountId: string, accountName = accountId): Promise<PositionRow[]> {
    const cacheKey = `${accountId}:${accountName}`;
    const cached = this.getCached(this.positionRowsCache, cacheKey);

    if (cached) {
      return cached;
    }

    try {
      const positions = await this.loadPositions(accountId, accountName);
      this.positionRowsCache.set(cacheKey, {
        value: positions,
        expiresAt: Date.now() + RESPONSE_CACHE_TTL_MS
      });
      return positions;
    } catch (error) {
      const stale = this.getStaleCached(this.positionRowsCache, cacheKey, RESPONSE_CACHE_MAX_STALE_MS);
      if (stale) {
        return stale;
      }
      throw error;
    }
  }

  async getBonds(accountId: string): Promise<BondRow[]> {
    const positions = await this.getPositions(accountId);

    return positions.filter((position) => isBondType(position.instrumentType)).map((position) => ({
      name: position.name,
      ticker: position.ticker,
      figi: position.figi,
      uid: position.uid || position.instrumentUid || position.positionUid,
      quantity: position.quantity,
      quantityLots: position.quantityLots,
      averagePrice: position.averagePrice,
      currentPrice: position.currentPrice,
      currentValue: position.currentValue,
      expectedYield: position.expectedYield,
      expectedYieldPercent: position.expectedYieldPercent,
      accruedInterest: position.accruedInterest,
      maturityDate: position.maturityDate,
      nominal: position.nominal,
      couponInfo: position.couponInfo,
      upcomingCoupons: position.upcomingCoupons,
      nextCouponDate: position.nextCouponDate,
      nextCouponAmount: position.nextCouponAmount,
      couponIncomeNext12m: position.couponIncomeNext12m,
      couponYieldNext12mPercent: position.couponYieldNext12mPercent,
      bondIncomeNow: position.bondIncomeNow,
      bondIncomeNext12m: position.bondIncomeNext12m,
      bondIncomeNext12mPercent: position.bondIncomeNext12mPercent
    }));
  }

  async getSummary(accountId: string): Promise<SummaryPayload> {
    const cached = this.getCached(this.summaryCache, accountId);

    if (cached) {
      return cached;
    }

    try {
      const portfolio = await this.client.getPortfolio(accountId);
      const totalAmountPortfolio = resolveTotalPortfolioAmount(portfolio);
      const expectedYield = moneyToAmount(portfolio.expectedYield);
      const positions = portfolio.positions ?? [];
      const bondsCount = positions.filter((position) => isBondType(position.instrumentType)).length;
      const summary = {
        accountId,
        totalAmountPortfolio,
        positionsCount: positions.length,
        bondsCount,
        expectedYield,
        expectedYieldPercent: percent(expectedYield.value, totalAmountPortfolio.value),
        breakdownByType: buildBreakdownFromPortfolioTotals(portfolio, totalAmountPortfolio),
        fetchedAt: new Date().toISOString()
      };

      this.summaryCache.set(accountId, {
        value: summary,
        expiresAt: Date.now() + RESPONSE_CACHE_TTL_MS
      });

      return summary;
    } catch (error) {
      const stale = this.getStaleCached(this.summaryCache, accountId, RESPONSE_CACHE_MAX_STALE_MS);
      if (stale) {
        return stale;
      }
      throw error;
    }
  }

  async getDashboard(): Promise<DashboardPayload> {
    const accounts = await this.getAccounts();
    const loadedAccounts: Array<AccountDashboardItem & { positions: PositionRow[] }> = [];

    for (const account of accounts) {
      try {
        const [summaryResult, positionsResult] = await Promise.allSettled([
          this.getSummary(account.id),
          this.getPositions(account.id, account.name)
        ]);

        loadedAccounts.push({
          account,
          summary: summaryResult.status === "fulfilled" ? summaryResult.value : fallbackSummary(account.id),
          positions: positionsResult.status === "fulfilled" ? positionsResult.value : []
        });
      } catch {
        loadedAccounts.push({
          account,
          summary: fallbackSummary(account.id),
          positions: []
        });
      }
    }

    const accountItems = loadedAccounts.filter((item) => {
      return (item.summary.totalAmountPortfolio.value ?? 0) > 0 || item.summary.positionsCount > 0 || item.positions.length > 0;
    });

    const positions = accountItems.flatMap((item) => item.positions);
    const accountDashboardItems = accountItems.map(({ account, summary }) => ({ account, summary }));
    const totalAmountPortfolio = addMoneyAmounts(accountDashboardItems.map((item) => item.summary.totalAmountPortfolio));
    const expectedYield = addMoneyAmounts(accountDashboardItems.map((item) => item.summary.expectedYield), totalAmountPortfolio.currency);
    const positionsCount = positions.length;
    const bondsCount = positions.filter((position) => isBondType(position.instrumentType)).length;

    return {
      accounts: accountDashboardItems,
      positions,
      totalAmountPortfolio,
      expectedYield,
      expectedYieldPercent: percent(expectedYield.value, totalAmountPortfolio.value),
      positionsCount,
      bondsCount,
      breakdownByType: mergeBreakdowns(accountDashboardItems.flatMap((item) => item.summary.breakdownByType), totalAmountPortfolio),
      fetchedAt: new Date().toISOString()
    };
  }

  private async loadInstruments(positions: TInvestPortfolioPosition[]): Promise<TInvestInstrument[]> {
    const loaded = await Promise.allSettled(
      positions.map((position) => this.resolveInstrument(position))
    );

    return loaded
      .filter((result): result is PromiseFulfilledResult<TInvestInstrument | undefined> => result.status === "fulfilled")
      .map((result) => result.value)
      .filter((instrument): instrument is TInvestInstrument => Boolean(instrument));
  }

  private async loadBondInstruments(positions: TInvestPortfolioPosition[]): Promise<TInvestBond[]> {
    const loaded = await Promise.allSettled(
      positions.map((position) => this.resolveBondInstrument(position))
    );

    return loaded
      .filter((result): result is PromiseFulfilledResult<TInvestBond | undefined> => result.status === "fulfilled")
      .map((result) => result.value)
      .filter((instrument): instrument is TInvestBond => Boolean(instrument));
  }

  private async loadBondCoupons(positions: TInvestPortfolioPosition[]): Promise<Array<{ position: TInvestPortfolioPosition; coupons: TInvestBondCoupon[] }>> {
    const from = new Date();
    from.setUTCHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setFullYear(to.getFullYear() + 1);

    const loaded = await Promise.allSettled(
      positions.map(async (position) => {
        const coupons = await this.resolveBondCoupons(position, from.toISOString(), to.toISOString());
        return {
          position,
          coupons
        };
      })
    );

    return loaded
      .filter((result): result is PromiseFulfilledResult<{ position: TInvestPortfolioPosition; coupons: TInvestBondCoupon[] }> => result.status === "fulfilled")
      .map((result) => result.value);
  }

  private async resolveInstrument(position: TInvestPortfolioPosition): Promise<TInvestInstrument | undefined> {
    if (position.instrumentUid) {
      const byUid = await this.cachedInstrument(`uid:${position.instrumentUid}`, async () => {
        try {
          return (await this.client.instrumentByUid(position.instrumentUid as string)).instrument;
        } catch {
          return undefined;
        }
      });

      if (byUid) {
        return byUid;
      }
    }

    if (position.figi) {
      return this.cachedInstrument(`figi:${position.figi}`, async () => {
        try {
          return (await this.client.instrumentByFigi(position.figi as string)).instrument;
        } catch {
          return undefined;
        }
      });
    }

    return undefined;
  }

  private async resolveBondInstrument(position: TInvestPortfolioPosition): Promise<TInvestBond | undefined> {
    if (position.instrumentUid) {
      const byUid = await this.cachedBond(`uid:${position.instrumentUid}`, async () => {
        try {
          return (await this.client.bondByUid(position.instrumentUid as string)).instrument;
        } catch {
          return undefined;
        }
      });

      if (byUid) {
        return byUid;
      }
    }

    if (position.figi) {
      return this.cachedBond(`figi:${position.figi}`, async () => {
        try {
          return (await this.client.bondByFigi(position.figi as string)).instrument;
        } catch {
          return undefined;
        }
      });
    }

    return undefined;
  }

  private async resolveBondCoupons(position: TInvestPortfolioPosition, from: string, to: string): Promise<TInvestBondCoupon[]> {
    const ids = buildBondCouponIds(position);

    for (const instrumentId of ids) {
      const cached = this.getCached(this.couponCache, couponCacheKey(instrumentId, from, to));
      if (cached && cached.length > 0) {
        return cached;
      }

      if (cached) {
        continue;
      }

      try {
        const response = await this.client.getBondCoupons(instrumentId, from, to);
        const coupons = response.events ?? response.coupons ?? [];

        // Cache successful empty responses too: coupon schedules do not need 10-second polling.
        this.couponCache.set(couponCacheKey(instrumentId, from, to), {
          value: coupons,
          expiresAt: Date.now() + COUPON_CACHE_TTL_MS
        });

        if (coupons.length > 0) {
          return coupons;
        }
      } catch {
        // Try the next accepted identifier: UID, FIGI, then ticker_classCode.
      }
    }

    return [];
  }

  private async cachedInstrument(key: string, loader: () => Promise<TInvestInstrument | undefined>): Promise<TInvestInstrument | undefined> {
    const cached = this.getCached(this.instrumentCache, key);
    if (cached) {
      return cached;
    }

    const value = await loader();
    if (value) {
      this.instrumentCache.set(key, {
        value,
        expiresAt: Date.now() + INSTRUMENT_CACHE_TTL_MS
      });
    }

    return value;
  }

  private async cachedBond(key: string, loader: () => Promise<TInvestBond | undefined>): Promise<TInvestBond | undefined> {
    const cached = this.getCached(this.bondCache, key);
    if (cached) {
      return cached;
    }

    const value = await loader();
    if (value) {
      this.bondCache.set(key, {
        value,
        expiresAt: Date.now() + INSTRUMENT_CACHE_TTL_MS
      });
    }

    return value;
  }

  private getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
    const entry = cache.get(key);

    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= Date.now()) {
      cache.delete(key);
      return undefined;
    }

    return entry.value;
  }

  private async loadLastPrices(positions: TInvestPortfolioPosition[]): Promise<TInvestLastPrice[]> {
    const instrumentIds = positions
      .map((position) => position.instrumentUid || position.positionUid)
      .filter((value): value is string => Boolean(value));
    const figis = positions.map((position) => position.figi).filter((value): value is string => Boolean(value));

    if (instrumentIds.length === 0 && figis.length === 0) {
      return [];
    }

    try {
      const response = await this.client.getLastPrices(instrumentIds, figis);
      return response.lastPrices ?? [];
    } catch {
      return [];
    }
  }

  private async loadPositions(accountId: string, accountName: string): Promise<PositionRow[]> {
    const portfolio = await this.client.getPortfolio(accountId);
    const rawPositions = portfolio.positions ?? [];
    const totalAmountPortfolio = resolveTotalPortfolioAmount(portfolio);
    const instruments = await this.loadInstruments(rawPositions);
    const bondInstruments = await this.loadBondInstruments(rawPositions.filter(isBondPosition));
    const bondCoupons = await this.loadBondCoupons(rawPositions.filter(isBondPosition));
    const lastPrices = await this.loadLastPrices(rawPositions);

    return rawPositions
      .map((position) =>
        buildPositionRow({
          accountId,
          accountName,
          position,
          totalAmountPortfolio,
          instrument: findInstrument(position, instruments),
          bondInstrument: findBondInstrument(position, bondInstruments),
          coupons: findBondCoupons(position, bondCoupons),
          lastPrice: findLastPrice(position, lastPrices)
        })
      )
      .sort((left, right) => (right.currentValue.value ?? 0) - (left.currentValue.value ?? 0));
  }

  private getStaleCached<T>(cache: Map<string, CacheEntry<T>>, key: string, maxStaleMs: number): T | undefined {
    const entry = cache.get(key);

    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt + maxStaleMs <= Date.now()) {
      cache.delete(key);
      return undefined;
    }

    return entry.value;
  }
}

function buildPositionRow(input: {
  accountId: string;
  accountName: string;
  position: TInvestPortfolioPosition;
  totalAmountPortfolio: MoneyAmount;
  instrument?: TInvestInstrument;
  bondInstrument?: TInvestBond;
  coupons?: TInvestBondCoupon[];
  lastPrice?: TInvestLastPrice;
}): PositionRow {
  const normalized = normalizePosition(input.position);
  const displayInstrument = input.bondInstrument ?? input.instrument;
  const instrumentType = normalized.instrumentType || input.instrument?.instrumentType;
  const isBond = isBondType(instrumentType);
  const quantity = normalized.quantity ?? normalized.quantityLots;
  const nominal = moneyToAmount(input.bondInstrument?.nominal);
  const priceFromMarket = quotationToAmount(
    input.lastPrice?.price,
    normalized.currentPrice.currency || input.instrument?.currency || input.bondInstrument?.currency
  );
  const currentPrice = normalized.currentPrice.value !== null ? normalized.currentPrice : priceFromMarket;
  const currentValue = resolveCurrentValue(currentPrice, quantity, nominal);
  const accruedInterest = isBond
    ? multiplyMoney(normalized.accruedInterest, quantity)
    : normalized.accruedInterest;
  const expectedYieldPercent = normalized.expectedYieldPercent ?? percent(normalized.expectedYield.value, currentValue.value);
  const { raw: _raw, ...normalizedForOutput } = normalized;
  const emptyMoney = { value: null, currency: currentValue.currency || nominal.currency || normalized.expectedYield.currency };
  const upcomingCoupons = isBond ? buildCouponPayments(input.coupons ?? [], quantity) : [];
  const couponIncomeNext12m = isBond
    ? addMoneyAmounts(upcomingCoupons.map((coupon) => coupon.totalAmount), currentValue.currency || nominal.currency)
    : emptyMoney;
  const nextCoupon = upcomingCoupons[0];
  const nextCouponAmount = nextCoupon?.totalAmount ?? { value: null, currency: couponIncomeNext12m.currency };
  const bondIncomeNow = isBond ? addMoneyAmounts([normalized.expectedYield, accruedInterest], currentValue.currency || nominal.currency) : emptyMoney;
  const bondIncomeNext12m = isBond ? addMoneyAmounts([bondIncomeNow, couponIncomeNext12m], currentValue.currency || nominal.currency) : emptyMoney;

  return {
    ...normalizedForOutput,
    accountId: input.accountId,
    accountName: input.accountName,
    name: displayInstrument?.name || input.position.ticker || input.position.figi || input.position.instrumentUid || "Инструмент",
    ticker: displayInstrument?.ticker || input.position.ticker,
    figi: displayInstrument?.figi || input.position.figi,
    uid: displayInstrument?.uid || input.position.instrumentUid || input.position.positionUid,
    instrumentType,
    typeLabel: labelInstrumentType(instrumentType),
    quantity,
    currentPrice,
    currentValue,
    expectedYieldPercent,
    accruedInterest,
    portfolioSharePercent: sameCurrency(currentValue, input.totalAmountPortfolio)
      ? percent(currentValue.value, input.totalAmountPortfolio.value)
      : null,
    maturityDate: input.bondInstrument?.maturityDate,
    nominal,
    couponInfo: buildCouponInfo(input.bondInstrument),
    upcomingCoupons,
    nextCouponDate: nextCoupon?.date,
    nextCouponAmount,
    couponIncomeNext12m,
    couponYieldNext12mPercent: sameCurrency(couponIncomeNext12m, currentValue)
      ? percent(couponIncomeNext12m.value, currentValue.value)
      : null,
    bondIncomeNow,
    bondIncomeNext12m,
    bondIncomeNext12mPercent: sameCurrency(bondIncomeNext12m, currentValue)
      ? percent(bondIncomeNext12m.value, currentValue.value)
      : null
  };
}

function normalizePosition(position: TInvestPortfolioPosition): PortfolioPosition {
  const quantity = quotationToNumber(position.quantity);
  const quantityLots = quotationToNumber(position.quantityLots);
  const averagePrice = moneyToAmount(position.averagePositionPrice ?? position.averagePositionPriceFifo);
  const currentPrice = "currency" in (position.currentPrice ?? {})
    ? moneyToAmount(position.currentPrice)
    : quotationToAmount(position.currentPrice);
  const expectedYield = moneyToAmount(position.expectedYield);
  const accruedInterest = moneyToAmount(position.currentNkd);
  const currentValue = currentPrice.value !== null
    ? multiplyMoney(currentPrice, quantity ?? quantityLots)
    : { value: null, currency: currentPrice.currency || averagePrice.currency };

  return {
    figi: position.figi,
    instrumentUid: position.instrumentUid,
    positionUid: position.positionUid,
    instrumentType: position.instrumentType,
    quantity,
    quantityLots,
    blocked: Boolean(position.blocked),
    blockedLots: quotationToNumber(position.blockedLots),
    averagePrice,
    currentPrice,
    currentValue,
    expectedYield,
    expectedYieldPercent: percent(expectedYield.value, currentValue.value),
    accruedInterest,
    raw: position
  };
}

function resolveTotalPortfolioAmount(portfolio: TInvestPortfolioResponse) {
  const explicitTotal = moneyToAmount(portfolio.totalAmountPortfolio);

  if (explicitTotal.value !== null) {
    return explicitTotal;
  }

  return addMoneyAmounts([
    moneyToAmount(portfolio.totalAmountShares),
    moneyToAmount(portfolio.totalAmountBonds),
    moneyToAmount(portfolio.totalAmountEtf),
    moneyToAmount(portfolio.totalAmountCurrencies),
    moneyToAmount(portfolio.totalAmountFutures),
    moneyToAmount(portfolio.totalAmountOptions)
  ]);
}

function fallbackSummary(accountId: string): SummaryPayload {
  return {
    accountId,
    totalAmountPortfolio: { value: 0, currency: "rub" },
    positionsCount: 0,
    bondsCount: 0,
    expectedYield: { value: 0, currency: "rub" },
    expectedYieldPercent: null,
    breakdownByType: [],
    fetchedAt: new Date().toISOString()
  };
}

function buildBreakdownFromPortfolioTotals(portfolio: TInvestPortfolioResponse, totalAmountPortfolio: MoneyAmount): BreakdownItem[] {
  const items: BreakdownItem[] = [
    {
      key: "share",
      label: "Акции",
      count: 0,
      value: moneyToAmount(portfolio.totalAmountShares),
      percent: null
    },
    {
      key: "bond",
      label: "Облигации",
      count: 0,
      value: moneyToAmount(portfolio.totalAmountBonds),
      percent: null
    },
    {
      key: "etf",
      label: "Фонды",
      count: 0,
      value: moneyToAmount(portfolio.totalAmountEtf),
      percent: null
    },
    {
      key: "currency",
      label: "Валюта",
      count: 0,
      value: moneyToAmount(portfolio.totalAmountCurrencies),
      percent: null
    },
    {
      key: "future",
      label: "Фьючерсы",
      count: 0,
      value: moneyToAmount(portfolio.totalAmountFutures),
      percent: null
    },
    {
      key: "option",
      label: "Опционы",
      count: 0,
      value: moneyToAmount(portfolio.totalAmountOptions),
      percent: null
    }
  ];

  return items
    .filter((item) => (item.value.value ?? 0) !== 0)
    .map((item) => ({
      ...item,
      value: {
        ...item.value,
        currency: item.value.currency || totalAmountPortfolio.currency
      },
      percent: percent(item.value.value, totalAmountPortfolio.value)
    }))
    .sort((left, right) => (right.value.value ?? 0) - (left.value.value ?? 0));
}

function mergeBreakdowns(items: BreakdownItem[], totalAmountPortfolio: MoneyAmount): BreakdownItem[] {
  const grouped = new Map<string, BreakdownItem>();

  for (const item of items) {
    const key = item.key;
    const existing = grouped.get(key);
    const value = item.value.value ?? 0;

    if (existing) {
      existing.count += item.count;
      existing.value = {
        value: (existing.value.value ?? 0) + value,
        currency: existing.value.currency || item.value.currency || totalAmountPortfolio.currency
      };
    } else {
      grouped.set(key, {
        key,
        label: item.label,
        count: item.count,
        value: {
          value,
          currency: item.value.currency || totalAmountPortfolio.currency
        },
        percent: null
      });
    }
  }

  return [...grouped.values()]
    .map((item) => ({
      ...item,
      percent: percent(item.value.value, totalAmountPortfolio.value)
    }))
    .sort((left, right) => (right.value.value ?? 0) - (left.value.value ?? 0));
}

function sameCurrency(left: MoneyAmount, right: MoneyAmount): boolean {
  if (!left.currency || !right.currency) {
    return true;
  }

  return left.currency.toLowerCase() === right.currency.toLowerCase();
}

function isBondPosition(position: TInvestPortfolioPosition): boolean {
  return isBondType(position.instrumentType);
}

function isBondType(instrumentType?: string): boolean {
  return normalizeInstrumentType(instrumentType) === "bond";
}

function normalizeInstrumentType(instrumentType?: string): string {
  const normalized = (instrumentType ?? "unknown").toLowerCase();

  if (normalized.includes("bond")) {
    return "bond";
  }

  if (normalized.includes("share") || normalized.includes("stock")) {
    return "share";
  }

  if (normalized.includes("etf") || normalized.includes("fund")) {
    return "etf";
  }

  if (normalized.includes("currency")) {
    return "currency";
  }

  if (normalized.includes("future")) {
    return "future";
  }

  if (normalized.includes("option")) {
    return "option";
  }

  return normalized;
}

function labelInstrumentType(instrumentType?: string): string {
  const normalized = normalizeInstrumentType(instrumentType);
  const labels: Record<string, string> = {
    bond: "Облигации",
    share: "Акции",
    etf: "Фонды",
    currency: "Валюта",
    future: "Фьючерсы",
    option: "Опционы",
    unknown: "Другое"
  };

  return labels[normalized] ?? "Другое";
}

function findInstrument(position: TInvestPortfolioPosition, instruments: TInvestInstrument[]): TInvestInstrument | undefined {
  return instruments.find((instrument) => {
    return Boolean(
      (position.instrumentUid && instrument.uid === position.instrumentUid) ||
        (position.positionUid && instrument.positionUid === position.positionUid) ||
        (position.figi && instrument.figi === position.figi)
    );
  });
}

function findBondInstrument(position: TInvestPortfolioPosition, instruments: TInvestBond[]): TInvestBond | undefined {
  return instruments.find((instrument) => {
    return Boolean(
      (position.instrumentUid && instrument.uid === position.instrumentUid) ||
        (position.positionUid && instrument.positionUid === position.positionUid) ||
        (position.figi && instrument.figi === position.figi)
    );
  });
}

function findBondCoupons(position: TInvestPortfolioPosition, coupons: Array<{ position: TInvestPortfolioPosition; coupons: TInvestBondCoupon[] }>): TInvestBondCoupon[] {
  return coupons.find((item) => {
    return Boolean(
      (position.instrumentUid && item.position.instrumentUid === position.instrumentUid) ||
        (position.positionUid && item.position.positionUid === position.positionUid) ||
        (position.figi && item.position.figi === position.figi)
    );
  })?.coupons ?? [];
}

function findLastPrice(position: TInvestPortfolioPosition, prices: TInvestLastPrice[]): TInvestLastPrice | undefined {
  return prices.find((price) => {
    return Boolean(
      (position.instrumentUid && price.instrumentUid === position.instrumentUid) ||
        (position.positionUid && price.instrumentUid === position.positionUid) ||
        (position.figi && price.figi === position.figi)
    );
  });
}

function buildBondCouponIds(position: TInvestPortfolioPosition): string[] {
  return [
    position.instrumentUid,
    position.figi,
    position.ticker && position.classCode ? `${position.ticker}_${position.classCode}` : undefined
  ]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index);
}

function couponCacheKey(instrumentId: string, from: string, to: string): string {
  return `${instrumentId}:${from.slice(0, 10)}:${to.slice(0, 10)}`;
}

function resolveCurrentValue(price: { value: number | null; currency?: string }, quantity: number | null, nominal: { value: number | null; currency?: string }) {
  if (price.value === null || quantity === null) {
    return { value: null, currency: price.currency || nominal.currency };
  }

  const nominalValue = nominal.value;
  const looksLikeBondPercent = nominalValue !== null && price.value > 0 && price.value <= 200 && !price.currency;

  return {
    value: looksLikeBondPercent ? (nominalValue * price.value * quantity) / 100 : price.value * quantity,
    currency: price.currency || nominal.currency
  };
}

function buildCouponPayments(coupons: TInvestBondCoupon[], quantity: number | null) {
  return coupons
    .filter((coupon) => coupon.couponDate)
    .sort((left, right) => new Date(left.couponDate ?? 0).getTime() - new Date(right.couponDate ?? 0).getTime())
    .map((coupon) => {
      const amountPerBond = moneyToAmount(coupon.payOneBond);
      return {
        date: coupon.couponDate,
        amountPerBond,
        totalAmount: multiplyMoney(amountPerBond, quantity),
        couponNumber: coupon.couponNumber,
        couponPeriod: coupon.couponPeriod
      };
    });
}

function buildCouponInfo(instrument?: TInvestBond): string | undefined {
  if (!instrument) {
    return undefined;
  }

  if (instrument.couponQuantityPerYear) {
    return `${instrument.couponQuantityPerYear} куп. в год`;
  }

  if (instrument.couponFrequency) {
    return `${instrument.couponFrequency} куп. в год`;
  }

  if (instrument.couponDate) {
    return `след. купон: ${instrument.couponDate}`;
  }

  return undefined;
}
