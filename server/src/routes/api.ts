import { Router } from "express";
import { AppError } from "../errors";
import { PortfolioService } from "../services/portfolioService";
import { TInvestClient } from "../services/tinvestClient";

interface ApiRouterOptions {
  token: string;
  baseUrl: string;
  allowInsecureTls: boolean;
  requestTimeoutMs: number;
}

export function createApiRouter(options: ApiRouterOptions): Router {
  const router = Router();

  const service = new PortfolioService(new TInvestClient(options.token, options.baseUrl, options.allowInsecureTls, options.requestTimeoutMs));

  router.get("/health", (_request, response) => {
    response.json({
      ok: true,
      hasToken: Boolean(options.token),
      baseUrl: options.baseUrl,
      allowInsecureTls: options.allowInsecureTls,
      requestTimeoutMs: options.requestTimeoutMs
    });
  });

  router.get("/accounts", async (_request, response, next) => {
    try {
      response.json(await service.getAccounts());
    } catch (error) {
      next(error);
    }
  });

  router.get("/portfolio", async (request, response, next) => {
    try {
      const accountId = requireAccountId(request.query.accountId);
      response.json(await service.getPortfolio(accountId));
    } catch (error) {
      next(error);
    }
  });

  router.get("/positions", async (request, response, next) => {
    try {
      const accountId = requireAccountId(request.query.accountId);
      response.json(await service.getPositions(accountId));
    } catch (error) {
      next(error);
    }
  });

  router.get("/bonds", async (request, response, next) => {
    try {
      const accountId = requireAccountId(request.query.accountId);
      response.json(await service.getBonds(accountId));
    } catch (error) {
      next(error);
    }
  });

  router.get("/summary", async (request, response, next) => {
    try {
      const accountId = requireAccountId(request.query.accountId);
      response.json(await service.getSummary(accountId));
    } catch (error) {
      next(error);
    }
  });

  router.get("/dashboard", async (_request, response, next) => {
    try {
      response.json(await service.getDashboard());
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function requireAccountId(accountId: unknown): string {
  if (typeof accountId !== "string" || accountId.trim().length === 0) {
    throw new AppError(400, "ACCOUNT_ID_REQUIRED", "Передайте accountId в query string.");
  }

  return accountId.trim();
}
