export type TInvestMoneyValue = {
  currency?: string;
  units?: string | number;
  nano?: number;
};

export type TInvestQuotation = {
  units?: string | number;
  nano?: number;
};

export type TInvestPortfolioPosition = {
  figi?: string;
  instrumentType?: string;
  quantity?: TInvestQuotation;
  quantityLots?: TInvestQuotation;
  averagePositionPrice?: TInvestMoneyValue;
  averagePositionPriceFifo?: TInvestMoneyValue;
  currentPrice?: TInvestMoneyValue | TInvestQuotation;
  expectedYield?: TInvestMoneyValue;
  currentNkd?: TInvestMoneyValue;
  instrumentUid?: string;
  positionUid?: string;
  ticker?: string;
  classCode?: string;
  blocked?: boolean;
  blockedLots?: TInvestQuotation;
};

export type TInvestPortfolioResponse = {
  totalAmountPortfolio?: TInvestMoneyValue;
  totalAmountShares?: TInvestMoneyValue;
  totalAmountBonds?: TInvestMoneyValue;
  totalAmountEtf?: TInvestMoneyValue;
  totalAmountCurrencies?: TInvestMoneyValue;
  totalAmountFutures?: TInvestMoneyValue;
  totalAmountOptions?: TInvestMoneyValue;
  expectedYield?: TInvestMoneyValue;
  positions?: TInvestPortfolioPosition[];
};

export type TInvestAccount = {
  id?: string;
  name?: string;
  type?: string;
  status?: string;
  openedDate?: string;
  closedDate?: string;
};

export type TInvestAccountsResponse = {
  accounts?: TInvestAccount[];
};

export type TInvestPositionsResponse = {
  securities?: Array<{
    figi?: string;
    instrumentType?: string;
    balance?: string | number;
    blocked?: string | number;
    instrumentUid?: string;
    positionUid?: string;
  }>;
};

export type TInvestBond = {
  figi?: string;
  ticker?: string;
  classCode?: string;
  isin?: string;
  lot?: number;
  currency?: string;
  name?: string;
  uid?: string;
  positionUid?: string;
  maturityDate?: string;
  nominal?: TInvestMoneyValue;
  couponQuantityPerYear?: number;
  couponFrequency?: number;
  couponDate?: string;
};

export type TInvestBondByResponse = {
  instrument?: TInvestBond;
};

export type TInvestBondCoupon = {
  figi?: string;
  couponDate?: string;
  couponNumber?: number;
  fixDate?: string;
  payOneBond?: TInvestMoneyValue;
  couponType?: string;
  couponStartDate?: string;
  couponEndDate?: string;
  couponPeriod?: number;
};

export type TInvestBondCouponsResponse = {
  events?: TInvestBondCoupon[];
  coupons?: TInvestBondCoupon[];
};

export type TInvestInstrument = {
  figi?: string;
  ticker?: string;
  classCode?: string;
  isin?: string;
  lot?: number;
  currency?: string;
  name?: string;
  instrumentType?: string;
  uid?: string;
  positionUid?: string;
};

export type TInvestInstrumentByResponse = {
  instrument?: TInvestInstrument;
};

export type TInvestLastPrice = {
  figi?: string;
  instrumentUid?: string;
  price?: TInvestQuotation;
  time?: string;
};

export type TInvestLastPricesResponse = {
  lastPrices?: TInvestLastPrice[];
};
