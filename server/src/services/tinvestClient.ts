import fetch, { type Response } from "node-fetch";
import https from "node:https";
import { MissingTokenError, TInvestApiError } from "../errors";
import type {
  TInvestAccountsResponse,
  TInvestBondByResponse,
  TInvestBondCouponsResponse,
  TInvestInstrumentByResponse,
  TInvestLastPricesResponse,
  TInvestPortfolioResponse,
  TInvestPositionsResponse
} from "../types/tinvest";

type RequestBody = Record<string, unknown>;

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 2;

const endpoints = {
  getAccounts: "tinkoff.public.invest.api.contract.v1.UsersService/GetAccounts",
  getPortfolio: "tinkoff.public.invest.api.contract.v1.OperationsService/GetPortfolio",
  getPositions: "tinkoff.public.invest.api.contract.v1.OperationsService/GetPositions",
  bondBy: "tinkoff.public.invest.api.contract.v1.InstrumentsService/BondBy",
  getBondCoupons: "tinkoff.public.invest.api.contract.v1.InstrumentsService/GetBondCoupons",
  instrumentBy: "tinkoff.public.invest.api.contract.v1.InstrumentsService/GetInstrumentBy",
  getLastPrices: "tinkoff.public.invest.api.contract.v1.MarketDataService/GetLastPrices"
} as const;

export class TInvestClient {
  private readonly insecureAgent?: https.Agent;

  constructor(
    private readonly token: string,
    private readonly baseUrl: string,
    allowInsecureTls = false,
    private readonly requestTimeoutMs = 15_000
  ) {
    this.insecureAgent = allowInsecureTls ? new https.Agent({ rejectUnauthorized: false }) : undefined;
  }

  getAccounts(): Promise<TInvestAccountsResponse> {
    return this.request(endpoints.getAccounts, {});
  }

  getPortfolio(accountId: string): Promise<TInvestPortfolioResponse> {
    return this.request(endpoints.getPortfolio, { accountId });
  }

  getPositions(accountId: string): Promise<TInvestPositionsResponse> {
    return this.request(endpoints.getPositions, { accountId });
  }

  bondByUid(uid: string): Promise<TInvestBondByResponse> {
    return this.request(endpoints.bondBy, {
      idType: "INSTRUMENT_ID_TYPE_UID",
      id: uid
    });
  }

  bondByFigi(figi: string): Promise<TInvestBondByResponse> {
    return this.request(endpoints.bondBy, {
      idType: "INSTRUMENT_ID_TYPE_FIGI",
      id: figi
    });
  }

  getBondCoupons(instrumentId: string, from: string, to: string): Promise<TInvestBondCouponsResponse> {
    return this.request(endpoints.getBondCoupons, {
      instrumentId,
      from,
      to
    });
  }

  instrumentByUid(uid: string): Promise<TInvestInstrumentByResponse> {
    return this.request(endpoints.instrumentBy, {
      idType: "INSTRUMENT_ID_TYPE_UID",
      id: uid
    });
  }

  instrumentByFigi(figi: string): Promise<TInvestInstrumentByResponse> {
    return this.request(endpoints.instrumentBy, {
      idType: "INSTRUMENT_ID_TYPE_FIGI",
      id: figi
    });
  }

  async getLastPrices(instrumentIds: string[], figis: string[]): Promise<TInvestLastPricesResponse> {
    const uniqueInstrumentIds = [...new Set(instrumentIds.filter(Boolean))];
    const uniqueFigis = [...new Set(figis.filter(Boolean))];

    if (uniqueInstrumentIds.length > 0) {
      try {
        return await this.request(endpoints.getLastPrices, {
          instrumentId: uniqueInstrumentIds
        });
      } catch (error) {
        if (uniqueFigis.length === 0) {
          throw error;
        }
      }
    }

    if (uniqueFigis.length === 0) {
      return { lastPrices: [] };
    }

    return this.request(endpoints.getLastPrices, {
      figi: uniqueFigis
    });
  }

  private async request<T>(endpoint: string, body: RequestBody): Promise<T> {
    if (!this.token) {
      throw new MissingTokenError();
    }

    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.requestOnce<T>(endpoint, body);
      } catch (error) {
        lastError = error;

        if (!isRetryableError(error) || attempt === MAX_ATTEMPTS) {
          throw error;
        }

        await delay(250 * attempt);
      }
    }

    throw lastError;
  }

  private async requestOnce<T>(endpoint: string, body: RequestBody): Promise<T> {
    const url = `${this.baseUrl}/${endpoint}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json"
        },
        agent: this.insecureAgent,
        signal: controller.signal,
        body: JSON.stringify(body)
      });
    } catch (error) {
      const isAbort = error instanceof Error && error.name === "AbortError";
      throw new TInvestApiError(
        isAbort ? 504 : 502,
        isAbort
          ? "T-Invest API не ответил вовремя. Backend остановил запрос по таймауту."
          : "T-Invest API недоступен или сеть не отвечает. Проверьте подключение и попробуйте еще раз.",
        error instanceof Error ? error.message : error
      );
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const details = await safeReadError(response);
      const message =
        response.status === 401 || response.status === 403
          ? "T-Invest API отклонил токен. Проверьте TINVEST_TOKEN и права read-only."
          : "T-Invest API вернул ошибку. Проверьте параметры запроса и доступность сервиса.";

      throw new TInvestApiError(response.status, message, details);
    }

    return (await response.json()) as T;
  }
}

function isRetryableError(error: unknown): boolean {
  return error instanceof TInvestApiError && RETRYABLE_STATUSES.has(error.status);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function safeReadError(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 1000);
  }
}
