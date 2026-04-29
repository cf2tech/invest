import type { ApiAccount, BondRow, DashboardPayload, PositionRow, SummaryPayload } from "./types";

interface ApiErrorPayload {
  code?: string;
  message?: string;
}

export async function fetchAccounts(): Promise<ApiAccount[]> {
  return request<ApiAccount[]>("/api/accounts");
}

export async function fetchSummary(accountId: string): Promise<SummaryPayload> {
  return request<SummaryPayload>(`/api/summary?accountId=${encodeURIComponent(accountId)}`);
}

export async function fetchPositions(accountId: string): Promise<PositionRow[]> {
  return request<PositionRow[]>(`/api/positions?accountId=${encodeURIComponent(accountId)}`);
}

export async function fetchBonds(accountId: string): Promise<BondRow[]> {
  return request<BondRow[]>(`/api/bonds?accountId=${encodeURIComponent(accountId)}`);
}

export async function fetchDashboard(): Promise<DashboardPayload> {
  return request<DashboardPayload>("/api/dashboard");
}

async function request<T>(url: string): Promise<T> {
  const response = await fetch(url);

  if (!response.ok) {
    let payload: ApiErrorPayload | undefined;
    try {
      payload = (await response.json()) as ApiErrorPayload;
    } catch {
      payload = undefined;
    }

    throw new Error(payload?.message || "Backend вернул ошибку. Проверьте консоль сервера.");
  }

  return (await response.json()) as T;
}
