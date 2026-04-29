import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import { config } from "./config";
import { AppError } from "./errors";
import { createApiRouter } from "./routes/api";

const app = express();

app.use(cors({ origin: true }));
app.use(express.json());

app.use(
  "/api",
  createApiRouter({
    token: config.tinvestToken,
    baseUrl: config.tinvestBaseUrl,
    allowInsecureTls: config.tinvestAllowInsecureTls,
    requestTimeoutMs: config.tinvestRequestTimeoutMs
  })
);

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof AppError) {
    response.status(error.status).json({
      ok: false,
      code: error.code,
      message: error.message,
      details: error.details
    });
    return;
  }

  console.error(error);
  response.status(500).json({
    ok: false,
    code: "INTERNAL_SERVER_ERROR",
    message: "Внутренняя ошибка backend. Подробности смотрите в консоли сервера."
  });
};

app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`T-Invest dashboard API listening on http://localhost:${config.port}`);
  if (!config.tinvestToken) {
    console.warn("TINVEST_TOKEN is missing. API endpoints will return a clear setup error.");
  }
});
