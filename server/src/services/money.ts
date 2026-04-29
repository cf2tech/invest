import type { MoneyAmount } from "../types/domain";
import type { TInvestMoneyValue, TInvestQuotation } from "../types/tinvest";

export function quotationToNumber(value?: TInvestQuotation | null): number | null {
  if (!value) {
    return null;
  }

  const units = Number(value.units ?? 0);
  const nano = Number(value.nano ?? 0);
  const result = units + nano / 1_000_000_000;

  return Number.isFinite(result) ? result : null;
}

export function moneyToAmount(value?: TInvestMoneyValue | null): MoneyAmount {
  return {
    value: quotationToNumber(value),
    currency: value?.currency
  };
}

export function quotationToAmount(value?: TInvestQuotation | null, currency?: string): MoneyAmount {
  return {
    value: quotationToNumber(value),
    currency
  };
}

export function addMoneyAmounts(amounts: MoneyAmount[], fallbackCurrency = "rub"): MoneyAmount {
  const values = amounts
    .map((amount) => amount.value)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  if (values.length === 0) {
    return { value: null, currency: fallbackCurrency };
  }

  const currency = amounts.find((amount) => amount.currency)?.currency ?? fallbackCurrency;
  return {
    value: values.reduce((sum, value) => sum + value, 0),
    currency
  };
}

export function percent(part: number | null, base: number | null): number | null {
  if (part === null || base === null || base === 0) {
    return null;
  }

  const result = (part / Math.abs(base)) * 100;
  return Number.isFinite(result) ? result : null;
}

export function multiplyMoney(amount: MoneyAmount, multiplier: number | null): MoneyAmount {
  if (amount.value === null || multiplier === null) {
    return { value: null, currency: amount.currency };
  }

  return {
    value: amount.value * multiplier,
    currency: amount.currency
  };
}
