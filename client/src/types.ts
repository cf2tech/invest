export interface ApiAccount {
  id: string;
  name: string;
  type?: string;
  status?: string;
  openedDate?: string;
}

export interface MoneyAmount {
  value: number | null;
  currency?: string;
}

export interface SummaryPayload {
  accountId: string;
  totalAmountPortfolio: MoneyAmount;
  positionsCount: number;
  bondsCount: number;
  expectedYield: MoneyAmount;
  expectedYieldPercent: number | null;
  breakdownByType: BreakdownItem[];
  fetchedAt: string;
}

export interface PositionRow {
  accountId: string;
  accountName: string;
  name: string;
  ticker?: string;
  figi?: string;
  uid?: string;
  instrumentUid?: string;
  positionUid?: string;
  instrumentType?: string;
  typeLabel: string;
  quantity: number | null;
  quantityLots: number | null;
  blocked: boolean;
  blockedLots: number | null;
  averagePrice: MoneyAmount;
  currentPrice: MoneyAmount;
  currentValue: MoneyAmount;
  expectedYield: MoneyAmount;
  expectedYieldPercent: number | null;
  accruedInterest: MoneyAmount;
  portfolioSharePercent: number | null;
  maturityDate?: string;
  nominal: MoneyAmount;
  couponInfo?: string;
  upcomingCoupons?: BondCouponPayment[];
  nextCouponDate?: string;
  nextCouponAmount: MoneyAmount;
  couponIncomeNext12m: MoneyAmount;
  couponYieldNext12mPercent: number | null;
  bondIncomeNow: MoneyAmount;
  bondIncomeNext12m: MoneyAmount;
  bondIncomeNext12mPercent: number | null;
}

export interface BondCouponPayment {
  date?: string;
  amountPerBond: MoneyAmount;
  totalAmount: MoneyAmount;
  couponNumber?: number;
  couponPeriod?: number;
}

export interface BondRow {
  name: string;
  ticker?: string;
  figi?: string;
  uid?: string;
  quantity: number | null;
  quantityLots: number | null;
  averagePrice: MoneyAmount;
  currentPrice: MoneyAmount;
  currentValue: MoneyAmount;
  expectedYield: MoneyAmount;
  expectedYieldPercent: number | null;
  accruedInterest: MoneyAmount;
  maturityDate?: string;
  nominal: MoneyAmount;
  couponFrequency?: number | null;
  couponInfo?: string;
  lastPriceTime?: string;
  upcomingCoupons?: BondCouponPayment[];
  nextCouponDate?: string;
  nextCouponAmount: MoneyAmount;
  couponIncomeNext12m: MoneyAmount;
  couponYieldNext12mPercent: number | null;
  bondIncomeNow: MoneyAmount;
  bondIncomeNext12m: MoneyAmount;
  bondIncomeNext12mPercent: number | null;
}

export interface BreakdownItem {
  key: string;
  label: string;
  count: number;
  value: MoneyAmount;
  percent: number | null;
}

export interface AccountDashboardItem {
  account: ApiAccount;
  summary: SummaryPayload;
}

export interface DashboardPayload {
  accounts: AccountDashboardItem[];
  positions: PositionRow[];
  totalAmountPortfolio: MoneyAmount;
  expectedYield: MoneyAmount;
  expectedYieldPercent: number | null;
  positionsCount: number;
  bondsCount: number;
  breakdownByType: BreakdownItem[];
  fetchedAt: string;
}
