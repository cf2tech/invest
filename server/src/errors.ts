export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class MissingTokenError extends AppError {
  constructor() {
    super(
      503,
      "TINVEST_TOKEN_MISSING",
      "TINVEST_TOKEN не задан. Создайте .env из .env.example и вставьте read-only токен T-Invest API."
    );
  }
}

export class TInvestApiError extends AppError {
  constructor(status: number, message: string, details?: unknown) {
    super(status, "TINVEST_API_ERROR", message, details);
  }
}
