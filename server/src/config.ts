import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envCandidates = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(__dirname, "../../.env"),
  path.resolve(__dirname, "../../../.env")
];

const envPath = envCandidates.find((candidate) => fs.existsSync(candidate));

if (envPath) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

const DEFAULT_TINVEST_BASE_URL = "https://invest-public-api.tbank.ru/rest";
const DEFAULT_TINVEST_REQUEST_TIMEOUT_MS = 15_000;

export const config = {
  port: Number(process.env.PORT ?? 3001),
  tinvestToken: process.env.TINVEST_TOKEN?.trim() ?? "",
  tinvestBaseUrl: (process.env.TINVEST_BASE_URL ?? DEFAULT_TINVEST_BASE_URL).replace(/\/+$/, ""),
  tinvestAllowInsecureTls: process.env.TINVEST_ALLOW_INSECURE_TLS === "true",
  tinvestRequestTimeoutMs: readPositiveNumber(process.env.TINVEST_REQUEST_TIMEOUT_MS, DEFAULT_TINVEST_REQUEST_TIMEOUT_MS)
};

function readPositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
