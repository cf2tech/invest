import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchDashboard } from "./api";
import type {
  AccountDashboardItem,
  BreakdownItem,
  DashboardPayload,
  MoneyAmount,
  PositionRow
} from "./types";

const ALL_ACCOUNTS = "all";
const ALL_TYPES = "all";
const POLLING_INTERVAL_MS = 10_000;
const ACCOUNT_ROTATION_INTERVAL_MS = 30_000;
const THEME_STORAGE_KEY = "t-invest-dashboard-theme";
const KIOSK_STORAGE_KEY = "t-invest-dashboard-kiosk";
const AUTO_ROTATE_STORAGE_KEY = "t-invest-dashboard-auto-rotate";
const SNAPSHOT_STORAGE_KEY = "t-invest-dashboard-session-snapshots";
const PASSIVE_TARGET_STORAGE_KEY = "t-invest-dashboard-passive-target";
const MAX_SNAPSHOTS = 240;

type PositionSignal = "all" | "negative" | "positive" | "blocked" | "zero" | "foreign";
type SortKey = "name" | "type" | "account" | "quantity" | "value" | "share" | "yield" | "yieldPercent";
type SortDirection = "asc" | "desc";
type Theme = "dark" | "light";
type MoneyEventKind = "coupon" | "maturity" | "amortization" | "dividend";

interface SortState {
  key: SortKey;
  direction: SortDirection;
}

interface PortfolioSnapshot {
  accountId: string;
  fetchedAt: string;
  value: number | null;
  currency?: string;
  expectedYield: number | null;
}

interface MoneyEvent {
  kind: MoneyEventKind;
  date?: string;
  title: string;
  amount: MoneyAmount;
  meta: string;
  source?: "api" | "derived" | "not_connected";
}

type WakeLockSentinel = EventTarget & {
  release: () => Promise<void>;
};

type WakeLockNavigator = Navigator & {
  wakeLock?: {
    request: (type: "screen") => Promise<WakeLockSentinel>;
  };
};

function App() {
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const sessionStartedAtRef = useRef(Date.now());
  const [selectedAccountId, setSelectedAccountId] = useState(() => getInitialAccountId());
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState(ALL_TYPES);
  const [signalFilter, setSignalFilter] = useState<PositionSignal>("all");
  const [sortState, setSortState] = useState<SortState>({ key: "value", direction: "desc" });
  const [theme, setTheme] = useState<Theme>(() => getInitialTheme());
  const [isKioskMode, setIsKioskMode] = useState(() => getInitialKioskMode());
  const [isAutoRotate, setIsAutoRotate] = useState(() => getInitialAutoRotate());
  const [snapshots, setSnapshots] = useState<PortfolioSnapshot[]>(() => getInitialSnapshots());
  const [passiveIncomeTarget, setPassiveIncomeTarget] = useState(() => getInitialStoredNumber(PASSIVE_TARGET_STORAGE_KEY, 0));
  const [scenarioAmount, setScenarioAmount] = useState(100_000);
  const [scenarioBondShare, setScenarioBondShare] = useState(70);
  const [scenarioPositionKey, setScenarioPositionKey] = useState("");
  const [scenarioQuantity, setScenarioQuantity] = useState(0);
  const [nextRefreshAt, setNextRefreshAt] = useState(() => Date.now() + POLLING_INTERVAL_MS);
  const [nextRotationAt, setNextRotationAt] = useState(() => Date.now() + ACCOUNT_ROTATION_INTERVAL_MS);
  const [now, setNow] = useState(() => Date.now());
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isWakeLockActive, setIsWakeLockActive] = useState(false);
  const [apiLatencyMs, setApiLatencyMs] = useState<number | null>(null);
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshDashboard = useCallback(async () => {
    const startedAt = performance.now();

    try {
      setIsRefreshing(true);
      const nextDashboard = await fetchDashboard();
      setApiLatencyMs(Math.round(performance.now() - startedAt));
      setLastSuccessAt(Date.now());
      setDashboard(nextDashboard);
      setSelectedAccountId((current) => resolveSelectedAccountId(current, nextDashboard.accounts));
      setError(null);
    } catch (refreshError) {
      setApiLatencyMs(Math.round(performance.now() - startedAt));
      setError(getErrorMessage(refreshError));
    } finally {
      setIsRefreshing(false);
      setNextRefreshAt(Date.now() + POLLING_INTERVAL_MS);
    }
  }, []);

  useEffect(() => {
    refreshDashboard();
  }, [refreshDashboard]);

  useEffect(() => {
    const timerId = window.setInterval(refreshDashboard, POLLING_INTERVAL_MS);
    return () => window.clearInterval(timerId);
  }, [refreshDashboard]);

  useEffect(() => {
    const timerId = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timerId);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }

      await document.documentElement.requestFullscreen();
    } catch {
      setError("Браузер не дал включить полноэкранный режим. Попробуйте нажать кнопку еще раз в активном окне.");
    }
  }, []);

  const toggleWakeLock = useCallback(async () => {
    if (wakeLockRef.current) {
      try {
        await wakeLockRef.current.release();
      } catch {
        // The browser may already have released the lock.
      }
      wakeLockRef.current = null;
      setIsWakeLockActive(false);
      return;
    }

    const api = (navigator as WakeLockNavigator).wakeLock;

    if (!api) {
      setError("Удержание экрана недоступно в этом браузере. Можно оставить монитор включенным через настройки macOS.");
      return;
    }

    try {
      const sentinel = await api.request("screen");
      wakeLockRef.current = sentinel;
      setIsWakeLockActive(true);
      sentinel.addEventListener("release", () => {
        wakeLockRef.current = null;
        setIsWakeLockActive(false);
      });
    } catch {
      setError("Не получилось удержать экран включенным. Браузер мог запретить эту возможность.");
    }
  }, []);

  const copyMonitorLink = useCallback(async () => {
    const url = new URL(window.location.href);
    url.searchParams.set("mode", "monitor");
    url.searchParams.set("auto", "1");

    try {
      await navigator.clipboard.writeText(url.toString());
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 1600);
    } catch {
      setError("Не получилось скопировать ссылку. Откройте экранный режим через адресную строку: ?mode=monitor&auto=1");
    }
  }, []);

  useEffect(() => {
    function handleFullscreenChange() {
      setIsFullscreen(Boolean(document.fullscreenElement));
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  useEffect(() => {
    return () => {
      wakeLockRef.current?.release().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem(KIOSK_STORAGE_KEY, isKioskMode ? "true" : "false");
  }, [isKioskMode]);

  useEffect(() => {
    window.localStorage.setItem(AUTO_ROTATE_STORAGE_KEY, isAutoRotate ? "true" : "false");
  }, [isAutoRotate]);

  useEffect(() => {
    function handleKeyboard(event: KeyboardEvent) {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) {
        return;
      }

      if (event.key.toLowerCase() === "k") {
        setIsKioskMode((current) => !current);
      }

      if (event.key.toLowerCase() === "a") {
        setIsAutoRotate((current) => !current);
      }

      if (event.key.toLowerCase() === "f") {
        toggleFullscreen();
      }

      if (event.key.toLowerCase() === "w") {
        toggleWakeLock();
      }

      if (event.key === "Escape") {
        setIsKioskMode(false);
      }
    }

    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  }, [toggleFullscreen, toggleWakeLock]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const selectedAccount = useMemo(
    () => dashboard?.accounts.find((item) => item.account.id === selectedAccountId),
    [dashboard?.accounts, selectedAccountId]
  );

  const selectedPositions = useMemo(() => {
    if (!dashboard) {
      return [];
    }

    if (selectedAccountId === ALL_ACCOUNTS) {
      return dashboard.positions;
    }

    return dashboard.positions.filter((position) => position.accountId === selectedAccountId);
  }, [dashboard, selectedAccountId]);

  const selectedSummary = useMemo(() => {
    if (!dashboard) {
      return null;
    }

    if (selectedAccountId === ALL_ACCOUNTS) {
      return {
        totalAmountPortfolio: dashboard.totalAmountPortfolio,
        expectedYield: dashboard.expectedYield,
        expectedYieldPercent: dashboard.expectedYieldPercent,
        positionsCount: dashboard.positionsCount,
        bondsCount: dashboard.bondsCount,
        fetchedAt: dashboard.fetchedAt
      };
    }

    if (!selectedAccount) {
      return null;
    }

    return {
      totalAmountPortfolio: selectedAccount.summary.totalAmountPortfolio,
      expectedYield: selectedAccount.summary.expectedYield,
      expectedYieldPercent: selectedAccount.summary.expectedYieldPercent,
      positionsCount: selectedAccount.summary.positionsCount,
      bondsCount: selectedAccount.summary.bondsCount,
      fetchedAt: selectedAccount.summary.fetchedAt
    };
  }, [dashboard, selectedAccount, selectedAccountId]);

  const selectedBreakdown = useMemo(() => {
    if (!dashboard || !selectedSummary) {
      return [];
    }

    if (selectedAccountId === ALL_ACCOUNTS) {
      return dashboard.breakdownByType;
    }

    return selectedAccount?.summary.breakdownByType ?? [];
  }, [dashboard, selectedAccount, selectedAccountId, selectedSummary]);

  const selectedBonds = useMemo(
    () => selectedPositions.filter((position) => isBondPosition(position)),
    [selectedPositions]
  );
  const nextBond = useMemo(
    () => [...selectedBonds].sort((left, right) => dateTime(left.maturityDate) - dateTime(right.maturityDate))[0],
    [selectedBonds]
  );

  const availableTypes = useMemo(() => {
    return [...new Set(selectedPositions.map((position) => position.typeLabel))].sort((left, right) =>
      left.localeCompare(right, "ru")
    );
  }, [selectedPositions]);

  const analytics = useMemo(() => buildAnalytics(selectedPositions, selectedSummary?.totalAmountPortfolio), [selectedPositions, selectedSummary]);
  const sessionTrend = useMemo(
    () => buildSessionTrend(snapshots.filter((snapshot) => snapshot.accountId === selectedAccountId)),
    [selectedAccountId, snapshots]
  );
  const apiStatus = useMemo(
    () => buildApiStatus({ now, lastSuccessAt, apiLatencyMs, isRefreshing, hasError: Boolean(error) }),
    [apiLatencyMs, error, isRefreshing, lastSuccessAt, now]
  );
  const accountPerformance = useMemo(() => buildAccountPerformance(dashboard), [dashboard]);

  const filteredPositions = useMemo(() => {
    return sortPositions(
      selectedPositions.filter((position) => matchesFilters(position, query, typeFilter, signalFilter)),
      sortState
    );
  }, [query, selectedPositions, signalFilter, sortState, typeFilter]);

  const activeAccountCount = useMemo(
    () => dashboard?.accounts.filter((item) => (item.summary.totalAmountPortfolio.value ?? 0) > 0).length ?? 0,
    [dashboard?.accounts]
  );
  const secondsToRefresh = Math.max(0, Math.ceil((nextRefreshAt - now) / 1_000));
  const sessionUptimeMs = now - sessionStartedAtRef.current;
  const rotationTargets = useMemo(() => buildRotationTargets(dashboard), [dashboard]);
  const secondsToRotation = isAutoRotate ? Math.max(0, Math.ceil((nextRotationAt - now) / 1_000)) : null;
  const nextRotationLabel = isAutoRotate ? getNextRotationLabel(rotationTargets, selectedAccountId) : null;

  useEffect(() => {
    if (!selectedSummary?.fetchedAt) {
      return;
    }

    const nextSnapshot: PortfolioSnapshot = {
      accountId: selectedAccountId,
      fetchedAt: selectedSummary.fetchedAt,
      value: selectedSummary.totalAmountPortfolio.value,
      currency: selectedSummary.totalAmountPortfolio.currency,
      expectedYield: selectedSummary.expectedYield.value
    };

    setSnapshots((current) => {
      const last = current[current.length - 1];

      if (last?.accountId === nextSnapshot.accountId && last.fetchedAt === nextSnapshot.fetchedAt) {
        return current;
      }

      return [...current, nextSnapshot].slice(-MAX_SNAPSHOTS);
    });
  }, [selectedAccountId, selectedSummary]);

  useEffect(() => {
    window.localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshots.slice(-MAX_SNAPSHOTS)));
  }, [snapshots]);

  useEffect(() => {
    window.localStorage.setItem(PASSIVE_TARGET_STORAGE_KEY, String(passiveIncomeTarget));
  }, [passiveIncomeTarget]);

  useEffect(() => {
    if (!dashboard || !isAutoRotate) {
      return undefined;
    }

    setNextRotationAt(Date.now() + ACCOUNT_ROTATION_INTERVAL_MS);

    const timerId = window.setInterval(() => {
      setSelectedAccountId((current) => {
        const currentIndex = Math.max(0, rotationTargets.findIndex((target) => target.id === current));
        const nextId = rotationTargets[(currentIndex + 1) % rotationTargets.length]?.id ?? ALL_ACCOUNTS;
        syncAccountIdToUrl(nextId);
        return nextId;
      });
      setNextRotationAt(Date.now() + ACCOUNT_ROTATION_INTERVAL_MS);
    }, ACCOUNT_ROTATION_INTERVAL_MS);

    return () => window.clearInterval(timerId);
  }, [dashboard, isAutoRotate, rotationTargets]);

  function handleSort(key: SortKey) {
    setSortState((current) => ({
      key,
      direction: current.key === key && current.direction === "desc" ? "asc" : "desc"
    }));
  }

  function handleAccountSelect(accountId: string) {
    setSelectedAccountId(accountId);
    syncAccountIdToUrl(accountId);
  }

  function handleResetSnapshots() {
    setSnapshots([]);
    window.localStorage.removeItem(SNAPSHOT_STORAGE_KEY);
  }

  const scenario = useMemo(
    () =>
      buildScenario({
        positions: selectedPositions,
        summary: selectedSummary,
        analytics,
        amountToInvest: scenarioAmount,
        bondSharePercent: scenarioBondShare,
        positionKey: scenarioPositionKey,
        quantityToBuy: scenarioQuantity
      }),
    [analytics, scenarioAmount, scenarioBondShare, scenarioPositionKey, scenarioQuantity, selectedPositions, selectedSummary]
  );

  return (
    <main className={isKioskMode ? "page kioskPage" : "page"}>
      {!isKioskMode && (
      <header className="topbar">
        <div>
          <p className="eyebrow">Локальный дашборд</p>
          <h1>T-Invest портфель</h1>
        </div>

        <div className="toolbar">
          <div className="accountPicker">
            <label htmlFor="account">Срез</label>
            <select
              id="account"
              value={selectedAccountId}
              disabled={!dashboard || dashboard.accounts.length === 0}
              onChange={(event) => handleAccountSelect(event.target.value)}
            >
              <option value={ALL_ACCOUNTS}>Все счета</option>
              {dashboard?.accounts.map((item) => (
                <option key={item.account.id} value={item.account.id}>
                  {item.account.name} ({shortAccountId(item.account.id)})
                </option>
              ))}
            </select>
          </div>
          <button className="ghostButton" disabled={isRefreshing} onClick={refreshDashboard}>
            {isRefreshing ? "Обновляю..." : "Обновить"}
          </button>
          <button className={isAutoRotate ? "ghostButton active" : "ghostButton"} onClick={() => setIsAutoRotate((current) => !current)}>
            {isAutoRotate ? "Авто счета: вкл" : "Авто счета"}
          </button>
          <button className="ghostButton" onClick={handleResetSnapshots}>
            Сброс сессии
          </button>
          <button className={copiedLink ? "ghostButton active" : "ghostButton"} onClick={copyMonitorLink}>
            {copiedLink ? "Скопировано" : "Ссылка на экран"}
          </button>
          <button className="ghostButton" onClick={() => setIsKioskMode(true)}>
            Экран
          </button>
          <button className={isFullscreen ? "ghostButton active" : "ghostButton"} onClick={toggleFullscreen}>
            {isFullscreen ? "Полный экран" : "Во весь экран"}
          </button>
          <button className={isWakeLockActive ? "ghostButton active" : "ghostButton"} onClick={toggleWakeLock}>
            {isWakeLockActive ? "Экран не гаснет" : "Не гасить экран"}
          </button>
          <button className="ghostButton" onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}>
            {theme === "dark" ? "Светлая тема" : "Темная тема"}
          </button>
        </div>
      </header>
      )}

      {error && <div className="notice error">{error}</div>}

      {!dashboard && !error && <LoadingDashboard />}

      {dashboard && (
        <>
          <MonitorBoard
            title={selectedAccountId === ALL_ACCOUNTS ? "Все счета" : selectedAccount?.account.name || "Счет"}
            subtitle={selectedAccountId === ALL_ACCOUNTS ? `${dashboard.accounts.length} счетов` : selectedAccount?.account.type || ""}
            summary={selectedSummary}
            activeAccountCount={activeAccountCount}
            breakdown={selectedBreakdown}
            accounts={dashboard.accounts}
            total={dashboard.totalAmountPortfolio}
            analytics={analytics}
            sessionTrend={sessionTrend}
            apiStatus={apiStatus}
            nextBond={nextBond}
            passiveIncomeTarget={passiveIncomeTarget}
            now={now}
            sessionUptimeMs={sessionUptimeMs}
            isRefreshing={isRefreshing}
            isAutoRotate={isAutoRotate}
            isKioskMode={isKioskMode}
            isFullscreen={isFullscreen}
            isWakeLockActive={isWakeLockActive}
            secondsToRefresh={secondsToRefresh}
            secondsToRotation={secondsToRotation}
            nextRotationLabel={nextRotationLabel}
            fetchedAt={selectedSummary?.fetchedAt || dashboard.fetchedAt}
          />

          {!isKioskMode && (
          <section className="detailDeck">
            <div className="detailIntro">
              <div>
                <p className="eyebrow">Подробности</p>
                <h2>Рабочая зона</h2>
              </div>
              <span>Для анализа с компьютера: фильтры, сортировка, экспорт и полные таблицы.</span>
            </div>

            <section className="summaryGrid" aria-label="Сводка портфеля">
              <SummaryCard label="Стоимость" value={formatMoney(selectedSummary?.totalAmountPortfolio)} />
              <SummaryCard label="Позиций" value={formatCount(selectedSummary?.positionsCount)} />
              <SummaryCard label="Счетов" value={formatCount(activeAccountCount)} />
              <SummaryCard
                label="Текущий результат"
                value={formatMoney(selectedSummary?.expectedYield)}
                accent={selectedSummary?.expectedYield.value ?? 0}
                suffix={formatPercent(selectedSummary?.expectedYieldPercent)}
              />
            </section>

            <section className="accountCards" aria-label="Быстрый выбор счета">
              <button
                className={selectedAccountId === ALL_ACCOUNTS ? "accountCard active" : "accountCard"}
                onClick={() => handleAccountSelect(ALL_ACCOUNTS)}
              >
                <span>Все счета</span>
                <strong>{formatMoney(dashboard.totalAmountPortfolio)}</strong>
                <small>{dashboard.positionsCount} позиций</small>
              </button>
              {dashboard.accounts.map((item) => (
                <button
                  className={selectedAccountId === item.account.id ? "accountCard active" : "accountCard"}
                  key={item.account.id}
                  onClick={() => handleAccountSelect(item.account.id)}
                >
                  <span>{item.account.name}</span>
                  <strong>{formatMoney(item.summary.totalAmountPortfolio)}</strong>
                  <small>{item.summary.positionsCount} позиций</small>
                </button>
              ))}
            </section>

            <section className="dashboardGrid">
              <div className="panel">
                <div className="sectionHeader">
                  <div>
                    <p className="eyebrow">Распределение</p>
                    <h2>По типам активов</h2>
                  </div>
                </div>
                <AllocationBar items={selectedBreakdown} />
                <BreakdownList items={selectedBreakdown} />
              </div>

              <div className="panel">
                <div className="sectionHeader">
                  <div>
                    <p className="eyebrow">Счета</p>
                    <h2>Где лежат деньги</h2>
                  </div>
                </div>
                <AccountBars accounts={dashboard.accounts} total={dashboard.totalAmountPortfolio} onSelect={handleAccountSelect} />
              </div>
            </section>

            <section className="insightGrid">
              <PositionHeatmapPanel positions={analytics.heatmapPositions} />
              <ConcentrationPanel concentration={analytics.concentration} />
              <SessionTrendPanel trend={sessionTrend} />
              <HealthPanel health={analytics.health} attention={analytics.attentionQueue} />
              <ApiStatusPanel status={apiStatus} />
              <AccountPerformancePanel accounts={accountPerformance} />
              <DiversificationPanel diversification={analytics.diversification} />
              <MoneyCalendarPanel calendar={analytics.moneyCalendar} />
              <CouponSalaryPanel income={analytics.passiveIncome} target={passiveIncomeTarget} onTargetChange={setPassiveIncomeTarget} />
              <HonestReturnPanel returns={analytics.honestReturn} />
              <MaturityLadderPanel ladder={analytics.maturityLadder} />
              <RiskScorePanel risk={analytics.riskModel} />
              <SmartInsightsPanel insights={analytics.smartInsights} />
              <AlertsPanel alerts={analytics.alerts} />
              <ScenarioCalculatorPanel
                scenario={scenario}
                positions={selectedPositions}
                amountToInvest={scenarioAmount}
                bondSharePercent={scenarioBondShare}
                positionKey={scenarioPositionKey}
                quantityToBuy={scenarioQuantity}
                onAmountChange={setScenarioAmount}
                onBondShareChange={setScenarioBondShare}
                onPositionChange={setScenarioPositionKey}
                onQuantityChange={setScenarioQuantity}
              />
              <CashflowForecastPanel forecast={analytics.bond.cashflowForecast} />
              <StructureHintsPanel hints={analytics.structureHints} />
              <TypePerformancePanel items={analytics.typePerformance} />
              <TopHoldingsPanel positions={analytics.topHoldings} />
              <WinnersLosersPanel winners={analytics.winners} losers={analytics.losers} />
              <CurrencyExposurePanel items={analytics.currencyExposure} />
              <RiskPanel items={analytics.riskItems} />
              <DataQualityPanel quality={analytics.dataQuality} />
              <IncomeMonthsPanel months={analytics.bond.couponMonths} />
              <TopCouponBondsPanel bonds={analytics.bond.topCouponBonds} />
            </section>

            <PositionsControls
              query={query}
              typeFilter={typeFilter}
              signalFilter={signalFilter}
              availableTypes={availableTypes}
              filteredCount={filteredPositions.length}
              totalCount={selectedPositions.length}
              onQueryChange={setQuery}
              onTypeChange={setTypeFilter}
              onSignalChange={setSignalFilter}
              onExport={() => exportPositionsToCsv(filteredPositions)}
            />

            <PositionsTable positions={filteredPositions} sortState={sortState} onSort={handleSort} />
            <BondsTable bonds={selectedBonds} />
            <BondTimeline bonds={selectedBonds} />
          </section>
          )}
        </>
      )}
    </main>
  );
}

function MonitorBoard(props: {
  title: string;
  subtitle: string;
  summary: {
    totalAmountPortfolio: MoneyAmount;
    expectedYield: MoneyAmount;
    expectedYieldPercent: number | null;
    positionsCount: number;
    bondsCount: number;
    fetchedAt: string;
  } | null;
  activeAccountCount: number;
  breakdown: BreakdownItem[];
  accounts: AccountDashboardItem[];
  total: MoneyAmount;
  analytics: ReturnType<typeof buildAnalytics>;
  sessionTrend: ReturnType<typeof buildSessionTrend>;
  apiStatus: ReturnType<typeof buildApiStatus>;
  nextBond?: PositionRow;
  passiveIncomeTarget: number;
  now: number;
  sessionUptimeMs: number;
  isRefreshing: boolean;
  isAutoRotate: boolean;
  isKioskMode: boolean;
  isFullscreen: boolean;
  isWakeLockActive: boolean;
  secondsToRefresh: number;
  secondsToRotation: number | null;
  nextRotationLabel: string | null;
  fetchedAt: string;
}) {
  const criticalItems = props.analytics.riskItems.filter((item) => item.level !== "ok");
  const strongestRisk = criticalItems[0];

  return (
    <section className="monitorBoard" aria-label="Главный экран портфеля">
      <div className="monitorHeader">
        <div>
          <p className="eyebrow">Экран портфеля</p>
          <h2>{props.title}</h2>
          <span>{props.subtitle} · {props.analytics.pulse}</span>
        </div>
        <div className="clockPanel">
          <strong>{formatClock(props.now)}</strong>
          <span>работает {formatDuration(props.sessionUptimeMs)}</span>
        </div>
        <div className={`monitorStatus ${props.isRefreshing ? "refreshing" : ""} ${props.apiStatus.tone}`}>
          <strong>{props.apiStatus.label}</strong>
          <span>{formatTime(props.fetchedAt)}</span>
          <small>{props.apiStatus.latencyLabel} · след. {props.secondsToRefresh}с</small>
          {props.secondsToRotation !== null && <small>счет {props.secondsToRotation}с: {props.nextRotationLabel}</small>}
        </div>
      </div>

      <InsightStrip items={props.analytics.insights} />

      <div className="monitorGrid">
        <div className="monitorHero panel">
          <span>Стоимость портфеля</span>
          <strong>{formatMoney(props.summary?.totalAmountPortfolio)}</strong>
          <SessionTrendMini trend={props.sessionTrend} />
          <div className="monitorResult">
            <span>Результат</span>
            <b className={amountClass(props.summary?.expectedYield.value)}>
              {formatMoney(props.summary?.expectedYield)}
            </b>
            <small className={amountClass(props.summary?.expectedYieldPercent)}>
              {formatPercent(props.summary?.expectedYieldPercent)}
            </small>
          </div>
        </div>

        <div className="monitorKpis">
          <MonitorKpi label="Счетов" value={formatCount(props.activeAccountCount)} />
          <MonitorKpi label="Позиций" value={formatCount(props.summary?.positionsCount)} />
          <MonitorKpi label="Риск" value={`${props.analytics.riskModel.score}/100`} tone={props.analytics.riskModel.tone === "bad" || props.analytics.riskModel.tone === "warn" ? "warn" : "ok"} />
          <MonitorKpi label="Купоны 90д" value={formatMoney(props.analytics.bond.cashflowForecast.next90d)} />
          <MonitorKpi label="Мес. доход" value={formatMoney(props.analytics.passiveIncome.monthlyRunRate)} />
        </div>

        <div className="panel monitorAllocation">
          <div className="sectionHeader compact">
            <div>
              <p className="eyebrow">Аллокация</p>
              <h2>Активы</h2>
            </div>
          </div>
          <AllocationBar items={props.breakdown} />
          <BreakdownList items={props.breakdown.slice(0, 4)} />
        </div>

        <div className="panel monitorAccounts">
          <div className="sectionHeader compact">
            <div>
              <p className="eyebrow">Счета</p>
              <h2>Вес</h2>
            </div>
          </div>
          <MonitorAccountBars accounts={props.accounts} total={props.total} />
        </div>

        <div className="panel monitorBondIncome">
          <div className="sectionHeader compact">
            <div>
              <p className="eyebrow">Облигации</p>
              <h2>Доход</h2>
            </div>
          </div>
          <BondIncomeSnapshot bond={props.analytics.bond} passive={props.analytics.passiveIncome} target={props.passiveIncomeTarget} />
        </div>

        <div className="panel monitorTop">
          <div className="sectionHeader compact">
            <div>
              <p className="eyebrow">Топ</p>
              <h2>Крупные позиции</h2>
            </div>
          </div>
          <CompactPositionList positions={props.analytics.topHoldings.slice(0, 5)} mode="value" />
        </div>

        <div className="panel monitorMoves">
          <div className="sectionHeader compact">
            <div>
              <p className="eyebrow">Карта</p>
              <h2>Позиции</h2>
            </div>
          </div>
          <PositionHeatmap positions={props.analytics.heatmapPositions.slice(0, 8)} />
        </div>

        <div className="panel monitorCoupons">
          <div className="sectionHeader compact">
            <div>
              <p className="eyebrow">Деньги</p>
              <h2>Календарь</h2>
            </div>
          </div>
          <MonitorCashflowMini calendar={props.analytics.moneyCalendar} />
        </div>

        <div className={strongestRisk ? `panel monitorAlert ${strongestRisk.level}` : "panel monitorAlert ok"}>
          <div>
            <p className="eyebrow">Контроль</p>
            <h2>{props.analytics.riskModel.label}</h2>
          </div>
          <strong>{props.analytics.riskModel.score}</strong>
          <MonitorRiskMini risk={props.analytics.riskModel} alerts={props.analytics.alerts} />
          <span>
            {buildScreenStatus(props.isKioskMode, props.isAutoRotate, props.isFullscreen, props.isWakeLockActive)}
          </span>
        </div>
      </div>
    </section>
  );
}

function LoadingDashboard() {
  return (
    <section className="monitorBoard loadingBoard" aria-label="Загрузка портфеля">
      <div className="monitorHeader">
        <div>
          <p className="eyebrow">Загрузка данных</p>
          <h2>Собираю портфель</h2>
          <span>Счета, позиции, купоны, погашения и risk score подтягиваются из T-Invest API.</span>
        </div>
        <div className="clockPanel loadingPanel">
          <strong>--:--</strong>
          <span>ожидание</span>
        </div>
        <div className="monitorStatus warn">
          <strong>Обновление</strong>
          <span>первый запрос</span>
          <small>обычно несколько секунд</small>
        </div>
      </div>

      <div className="insightStrip">
        {["Счета", "Позиции", "Купоны", "Риски", "События"].map((label) => (
          <div className="insightChip loadingPanel" key={label}>
            <span>{label}</span>
            <strong>загрузка...</strong>
          </div>
        ))}
      </div>

      <div className="monitorGrid">
        <div className="monitorHero panel loadingPanel">
          <span>Стоимость портфеля</span>
          <strong>считаю...</strong>
          <div className="loadingLines">
            <span />
            <span />
            <span />
          </div>
        </div>
        <div className="monitorKpis">
          {["Счетов", "Позиций", "Риск", "Купоны 90д", "Мес. доход"].map((label) => (
            <div className="monitorKpi loadingPanel" key={label}>
              <span>{label}</span>
              <strong>--</strong>
            </div>
          ))}
        </div>
        {[
          ["monitorAllocation", "Активы"],
          ["monitorAccounts", "Счета"],
          ["monitorBondIncome", "Доход"],
          ["monitorTop", "Крупные позиции"],
          ["monitorMoves", "Карта"],
          ["monitorCoupons", "Календарь"],
          ["monitorAlert", "Контроль"]
        ].map(([className, label]) => (
          <div className={`panel loadingPanel ${className}`} key={label}>
            <div className="sectionHeader compact">
              <div>
                <p className="eyebrow">Подготовка</p>
                <h2>{label}</h2>
              </div>
            </div>
            <div className="loadingLines">
              <span />
              <span />
              <span />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function InsightStrip(props: { items: Array<{ label: string; value: string; tone: "ok" | "warn" | "bad" | "good" }> }) {
  return (
    <div className="insightStrip" aria-label="Ключевые сигналы">
      {props.items.map((item) => (
        <div className={`insightChip ${item.tone}`} key={item.label}>
          <span>{item.label}</span>
          <strong>{item.value}</strong>
        </div>
      ))}
    </div>
  );
}

function BondIncomeSnapshot(props: { bond: ReturnType<typeof buildAnalytics>["bond"]; passive: ReturnType<typeof buildAnalytics>["passiveIncome"]; target: number }) {
  return (
    <div className="bondIncomeSnapshot">
      <div>
        <span>Стоимость</span>
        <strong>{formatMoney(props.bond.value)}</strong>
      </div>
      <div>
        <span>Сейчас</span>
        <strong className={amountClass(props.bond.incomeNow.value)}>{formatMoney(props.bond.incomeNow)}</strong>
      </div>
      <div>
        <span>Купоны 12м</span>
        <strong>{formatMoney(props.bond.couponsNext12m)}</strong>
      </div>
      <div>
        <span>Прогноз 12м</span>
        <strong className={amountClass(props.bond.incomeNext12m.value)}>
          {formatMoney(props.bond.incomeNext12m)} · {formatPercent(props.bond.incomeNext12mPercent)}
        </strong>
      </div>
      <div>
        <span>Run-rate / цель</span>
        <strong>
          {formatMoney(props.passive.monthlyRunRate)}
          {props.target > 0 ? ` · ${formatPercent(percentValue(props.passive.monthlyRunRate.value, props.target))}` : ""}
        </strong>
      </div>
    </div>
  );
}

function SessionTrendMini(props: { trend: ReturnType<typeof buildSessionTrend> }) {
  return (
    <div className="sessionTrendMini">
      <div>
        <span>Сессия</span>
        <strong className={amountClass(props.trend.deltaFromStart.value)}>{formatMoney(props.trend.deltaFromStart)}</strong>
      </div>
      <div>
        <span>Тик</span>
        <strong className={amountClass(props.trend.deltaFromPrevious.value)}>{formatMoney(props.trend.deltaFromPrevious)}</strong>
      </div>
      <SparkBars points={props.trend.points} />
    </div>
  );
}

function SparkBars(props: { points: number[] }) {
  if (props.points.length === 0) {
    return (
      <div className="sparkBars emptySpark" aria-label="Мини-график стоимости">
        <small>нет истории</small>
      </div>
    );
  }

  const min = Math.min(...props.points);
  const max = Math.max(...props.points);
  const range = max - min || 1;

  return (
    <div className="sparkBars" aria-label="Мини-график стоимости">
      {props.points.slice(-24).map((point, index) => (
        <span
          key={`${point}-${index}`}
          style={{ height: `${Math.max(12, ((point - min) / range) * 100)}%` }}
        />
      ))}
    </div>
  );
}

function EventPreview(props: { events: MoneyEvent[] }) {
  return (
    <div className="eventPreview">
      {props.events.slice(0, 4).map((event) => (
        <div className={`eventPreviewItem ${event.kind}`} key={`${event.kind}-${event.title}-${event.date}`}>
          <span>{formatDate(event.date)} · {eventKindLabel(event.kind)}</span>
          <strong>{formatMoney(event.amount)}</strong>
          <small>{event.title}</small>
        </div>
      ))}
      {props.events.length === 0 && <div className="emptyInline">Нет событий</div>}
    </div>
  );
}

function MonitorCashflowMini(props: { calendar: ReturnType<typeof buildAnalytics>["moneyCalendar"] }) {
  return (
    <div className="monitorCashflowMini">
      <div className="cashflowNow">
        <div>
          <span>30д</span>
          <strong>{formatMoney(props.calendar.forecast.next30d)}</strong>
        </div>
        <div>
          <span>90д</span>
          <strong>{formatMoney(props.calendar.forecast.next90d)}</strong>
        </div>
        <div>
          <span>365д</span>
          <strong>{formatMoney(props.calendar.forecast.next365d)}</strong>
        </div>
      </div>
      <div className="eventPreview compactEvents">
        {props.calendar.upcoming.slice(0, 3).map((event) => (
          <div className={`eventPreviewItem ${event.kind}`} key={`${event.kind}-${event.title}-${event.date}-monitor`}>
            <span>{formatDate(event.date)} · {eventKindLabel(event.kind)}</span>
            <strong>{formatMoney(event.amount)}</strong>
            <small>{event.title}</small>
          </div>
        ))}
        {props.calendar.upcoming.length === 0 && <div className="emptyInline">Нет событий</div>}
      </div>
    </div>
  );
}

function MonitorRiskMini(props: {
  risk: ReturnType<typeof buildAnalytics>["riskModel"];
  alerts: ReturnType<typeof buildAnalytics>["alerts"];
}) {
  const signals = props.alerts.length > 0 ? props.alerts : props.risk.warnings;

  return (
    <div className="monitorRiskMini">
      {signals.slice(0, 2).map((signal) => (
        <div className={`miniSignal ${signal.level}`} key={`${signal.title}-${signal.detail}`}>
          <b>{signal.title}</b>
          <small>{signal.detail}</small>
        </div>
      ))}
      {signals.length === 0 && (
        <div className="miniSignal ok">
          <b>Спокойно</b>
          <small>Критичных сигналов нет</small>
        </div>
      )}
    </div>
  );
}

function PositionHeatmap(props: { positions: PositionRow[] }) {
  return (
    <div className="positionHeatmap">
      {props.positions.map((position) => (
        <div
          className={`heatTile ${heatTone(position)}`}
          key={`${position.accountId}-${position.uid || position.figi || position.name}-heat`}
          style={{ gridColumn: `span ${heatSpan(position.portfolioSharePercent)}` }}
          title={`${position.name}: ${formatMoney(position.currentValue)} · ${formatPercent(position.expectedYieldPercent)}`}
        >
          <strong>{position.ticker || position.name}</strong>
          <span>{formatPercent(position.portfolioSharePercent)}</span>
          <small>{formatPercent(position.expectedYieldPercent)}</small>
        </div>
      ))}
      {props.positions.length === 0 && <div className="emptyInline">Нет карты позиций</div>}
    </div>
  );
}

function MonitorKpi(props: { label: string; value: string; tone?: "ok" | "warn" }) {
  return (
    <div className={props.tone === "warn" ? "monitorKpi warn" : "monitorKpi"}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function MonitorAccountBars(props: { accounts: AccountDashboardItem[]; total: MoneyAmount }) {
  return (
    <div className="monitorAccountBars">
      {props.accounts
        .filter((item) => (item.summary.totalAmountPortfolio.value ?? 0) > 0)
        .slice(0, 5)
        .map((item) => {
          const share = percentValue(item.summary.totalAmountPortfolio.value, props.total.value);
          return (
            <div className="monitorAccountRow" key={item.account.id}>
              <div>
                <strong>{item.account.name}</strong>
                <span>{formatPercent(share)}</span>
              </div>
              <div className="miniTrack">
                <div style={{ width: `${Math.max(share ?? 0, 1)}%` }} />
              </div>
            </div>
          );
        })}
    </div>
  );
}

function CompactPositionList(props: { positions: PositionRow[]; mode: "value" | "percent" }) {
  return (
    <div className="compactPositionList">
      {props.positions.map((position) => (
        <div className="compactPosition" key={`${position.accountId}-${position.uid || position.figi || position.name}-${props.mode}`}>
          <span>{position.ticker || position.name}</span>
          <strong className={props.mode === "percent" ? amountClass(position.expectedYieldPercent) : ""}>
            {props.mode === "value" ? formatMoney(position.currentValue) : formatPercent(position.expectedYieldPercent)}
          </strong>
        </div>
      ))}
      {props.positions.length === 0 && <div className="emptyInline">Нет данных</div>}
    </div>
  );
}

function SummaryCard(props: { label: string; value: string; suffix?: string; accent?: number }) {
  return (
    <article className="summaryCard">
      <span>{props.label}</span>
      <strong className={amountClass(props.accent)}>{props.value}</strong>
      {props.suffix && <small>{props.suffix}</small>}
    </article>
  );
}

function AllocationBar(props: { items: BreakdownItem[] }) {
  const visibleItems = props.items.filter((item) => (item.value.value ?? 0) > 0);

  if (visibleItems.length === 0) {
    return <div className="emptyChart">Нет стоимости для графика</div>;
  }

  return (
    <div className="allocationBar" aria-label="Распределение активов">
      {visibleItems.map((item, index) => (
        <div
          key={item.key}
          style={{
            width: `${Math.max(item.percent ?? 0, 1)}%`,
            background: chartColor(index)
          }}
          title={`${item.label}: ${formatPercent(item.percent)}`}
        />
      ))}
    </div>
  );
}

function BreakdownList(props: { items: BreakdownItem[] }) {
  return (
    <div className="breakdownList">
      {props.items.map((item, index) => (
        <div className="breakdownItem" key={item.key}>
          <span className="swatch" style={{ background: chartColor(index) }} />
          <strong>{item.label}</strong>
          <span>{formatMoney(item.value)}</span>
          <span>{formatPercent(item.percent)}</span>
        </div>
      ))}
      {props.items.length === 0 && <div className="emptyInline">Нет позиций</div>}
    </div>
  );
}

function AccountBars(props: { accounts: AccountDashboardItem[]; total: MoneyAmount; onSelect: (accountId: string) => void }) {
  return (
    <div className="accountBars">
      {props.accounts.map((item) => {
        const share = percentValue(item.summary.totalAmountPortfolio.value, props.total.value);
        return (
          <button className="accountBarRow" key={item.account.id} onClick={() => props.onSelect(item.account.id)}>
            <div>
              <strong>{item.account.name}</strong>
              <span>{formatMoney(item.summary.totalAmountPortfolio)}</span>
            </div>
            <div className="miniTrack">
              <div style={{ width: `${Math.max(share ?? 0, item.summary.totalAmountPortfolio.value ? 1 : 0)}%` }} />
            </div>
          </button>
        );
      })}
    </div>
  );
}

function TopHoldingsPanel(props: { positions: PositionRow[] }) {
  return (
    <div className="panel">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Топ</p>
          <h2>Крупные позиции</h2>
        </div>
      </div>
      <div className="rankList">
        {props.positions.map((position, index) => (
          <div className="rankItem" key={`${position.accountId}-${position.uid || position.figi || position.name}`}>
            <span>{index + 1}</span>
            <div>
              <strong>{position.name}</strong>
              <small>{position.typeLabel} · {position.accountName}</small>
            </div>
            <b>{formatMoney(position.currentValue)}</b>
          </div>
        ))}
        {props.positions.length === 0 && <div className="emptyInline">Нет позиций</div>}
      </div>
    </div>
  );
}

function PositionHeatmapPanel(props: { positions: PositionRow[] }) {
  return (
    <div className="panel widePanel">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Карта</p>
          <h2>Размер и результат позиций</h2>
        </div>
      </div>
      <PositionHeatmap positions={props.positions.slice(0, 14)} />
    </div>
  );
}

function ConcentrationPanel(props: { concentration: ReturnType<typeof buildAnalytics>["concentration"] }) {
  return (
    <div className="panel">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Баланс</p>
          <h2>Концентрация</h2>
        </div>
      </div>
      <div className="concentrationList">
        <div>
          <span>Крупнейшая</span>
          <strong>{props.concentration.largestName}</strong>
          <b>{formatPercent(props.concentration.largestShare)}</b>
        </div>
        <div>
          <span>Топ-5</span>
          <strong>{formatPercent(props.concentration.topFiveShare)}</strong>
          <b>{props.concentration.topFiveCount} поз.</b>
        </div>
        <div>
          <span>Валюта</span>
          <strong>{formatMoney(props.concentration.cashLikeValue)}</strong>
          <b>{formatPercent(props.concentration.cashLikeShare)}</b>
        </div>
      </div>
    </div>
  );
}

function SessionTrendPanel(props: { trend: ReturnType<typeof buildSessionTrend> }) {
  return (
    <div className="panel">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Сессия</p>
          <h2>Движение сессии</h2>
        </div>
        <span>{props.trend.points.length} точек</span>
      </div>
      <div className="trendPanelBody">
        <SparkBars points={props.trend.points} />
        <div className="concentrationList">
          <div>
            <span>С открытия</span>
            <strong className={amountClass(props.trend.deltaFromStart.value)}>{formatMoney(props.trend.deltaFromStart)}</strong>
            <b>{formatPercent(props.trend.deltaFromStartPercent)}</b>
          </div>
          <div>
            <span>Последний тик</span>
            <strong className={amountClass(props.trend.deltaFromPrevious.value)}>{formatMoney(props.trend.deltaFromPrevious)}</strong>
            <b>{formatTime(props.trend.lastFetchedAt)}</b>
          </div>
          <div>
            <span>Макс / мин</span>
            <strong>{formatMoney(props.trend.high)}</strong>
            <b>{formatMoney(props.trend.low)}</b>
          </div>
          <div>
            <span>От максимума</span>
            <strong className={amountClass(props.trend.drawdown.value)}>{formatMoney(props.trend.drawdown)}</strong>
            <b>{formatPercent(props.trend.drawdownPercent)}</b>
          </div>
        </div>
      </div>
    </div>
  );
}

function HealthPanel(props: { health: ReturnType<typeof buildAnalytics>["health"]; attention: ReturnType<typeof buildAnalytics>["attentionQueue"] }) {
  return (
    <div className="panel">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Контроль</p>
          <h2>Оценка здоровья</h2>
        </div>
        <span>{props.health.label}</span>
      </div>
      <div className={`healthGauge ${props.health.tone}`}>
        <strong>{props.health.score}</strong>
        <span>/100</span>
      </div>
      <div className="attentionList">
        {props.attention.slice(0, 4).map((item) => (
          <div className={`attentionItem ${item.level}`} key={item.title}>
            <strong>{item.title}</strong>
            <span>{item.detail}</span>
          </div>
        ))}
        {props.attention.length === 0 && <div className="emptyInline">Нет срочных сигналов</div>}
      </div>
    </div>
  );
}

function ApiStatusPanel(props: { status: ReturnType<typeof buildApiStatus> }) {
  return (
    <div className="panel">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Данные</p>
          <h2>Свежесть данных</h2>
        </div>
        <span>{props.status.label}</span>
      </div>
      <div className={`apiStatusCard ${props.status.tone}`}>
        <strong>{props.status.ageLabel}</strong>
        <span>{props.status.latencyLabel}</span>
      </div>
      <div className="concentrationList">
        <div>
          <span>Последний успех</span>
          <strong>{props.status.lastSuccessLabel}</strong>
          <b>{props.status.stale ? "устарели" : "свежие"}</b>
        </div>
        <div>
          <span>Опрос</span>
          <strong>10 сек</strong>
          <b>{props.status.isRefreshing ? "идет" : "ждет"}</b>
        </div>
      </div>
    </div>
  );
}

function AccountPerformancePanel(props: { accounts: ReturnType<typeof buildAccountPerformance> }) {
  return (
    <div className="panel">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Счета</p>
          <h2>Результат</h2>
        </div>
      </div>
      <div className="accountPerformanceList">
        {props.accounts.map((item) => (
          <div className="accountPerformanceItem" key={item.id}>
            <div>
              <strong>{item.name}</strong>
              <span>{formatMoney(item.value)}</span>
            </div>
            <b className={amountClass(item.expectedYield.value)}>
              {formatMoney(item.expectedYield)} · {formatPercent(item.expectedYieldPercent)}
            </b>
          </div>
        ))}
        {props.accounts.length === 0 && <div className="emptyInline">Нет активных счетов</div>}
      </div>
    </div>
  );
}

function DiversificationPanel(props: { diversification: ReturnType<typeof buildAnalytics>["diversification"] }) {
  return (
    <div className="panel">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Структура</p>
          <h2>Диверсификация</h2>
        </div>
        <span>{props.diversification.grade}</span>
      </div>
      <div className="metricGrid">
        <div>
          <span>Эфф. позиций</span>
          <strong>{props.diversification.effectivePositions.toFixed(1)}</strong>
        </div>
        <div>
          <span>HHI</span>
          <strong>{formatNumber(props.diversification.hhi)}</strong>
        </div>
        <div>
          <span>Топ-10</span>
          <strong>{formatPercent(props.diversification.topTenShare)}</strong>
        </div>
        <div>
          <span>Малые</span>
          <strong>{props.diversification.smallPositions}</strong>
        </div>
      </div>
    </div>
  );
}

function CashflowForecastPanel(props: { forecast: ReturnType<typeof buildAnalytics>["bond"]["cashflowForecast"] }) {
  return (
    <div className="panel">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Купоны</p>
          <h2>Купонный прогноз</h2>
        </div>
      </div>
      <div className="concentrationList">
        <div>
          <span>30 дней</span>
          <strong>{formatMoney(props.forecast.next30d)}</strong>
          <b>{props.forecast.payments30d} вып.</b>
        </div>
        <div>
          <span>90 дней</span>
          <strong>{formatMoney(props.forecast.next90d)}</strong>
          <b>{props.forecast.payments90d} вып.</b>
        </div>
        <div>
          <span>12 месяцев</span>
          <strong>{formatMoney(props.forecast.next365d)}</strong>
          <b>{formatMoney(props.forecast.monthlyAverage)}/мес</b>
        </div>
      </div>
    </div>
  );
}

function MoneyCalendarPanel(props: { calendar: ReturnType<typeof buildAnalytics>["moneyCalendar"] }) {
  return (
    <div className="panel widePanel">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Календарь денег</p>
          <h2>Ближайшие поступления</h2>
        </div>
        <span>{props.calendar.events.length} событий</span>
      </div>
      <div className="moneyCalendarGrid">
        <div className="metricGrid">
          <div>
            <span>30 дней</span>
            <strong>{formatMoney(props.calendar.forecast.next30d)}</strong>
          </div>
          <div>
            <span>90 дней</span>
            <strong>{formatMoney(props.calendar.forecast.next90d)}</strong>
          </div>
          <div>
            <span>365 дней</span>
            <strong>{formatMoney(props.calendar.forecast.next365d)}</strong>
          </div>
          <div>
            <span>Дивиденды/аморт.</span>
            <strong>{props.calendar.hasExtendedEvents ? "подключены" : "нет данных"}</strong>
          </div>
        </div>
        <div className="eventPreview">
          {props.calendar.upcoming.slice(0, 6).map((event) => (
            <div className={`eventPreviewItem ${event.kind}`} key={`${event.kind}-${event.title}-${event.date}-calendar`}>
              <span>{formatDate(event.date)} · {eventKindLabel(event.kind)}</span>
              <strong>{formatMoney(event.amount)}</strong>
              <small>{event.title}</small>
            </div>
          ))}
          {props.calendar.upcoming.length === 0 && <div className="emptyInline">Нет будущих поступлений</div>}
        </div>
      </div>
      <CashflowTimeline months={props.calendar.months} />
    </div>
  );
}

function CashflowTimeline(props: { months: Array<{ key: string; label: string; amount: MoneyAmount; percent: number | null; events: number }> }) {
  return (
    <div className="cashflowTimeline">
      {props.months.map((month) => (
        <div className="cashflowMonth" key={month.key}>
          <span>{month.label}</span>
          <div className="miniTrack">
            <div style={{ width: `${Math.max(month.percent ?? 0, month.amount.value ? 3 : 0)}%` }} />
          </div>
          <strong>{formatMoney(month.amount)}</strong>
          <small>{month.events} вып.</small>
        </div>
      ))}
      {props.months.length === 0 && <div className="emptyInline">Пока нечего рисовать на timeline</div>}
    </div>
  );
}

function CouponSalaryPanel(props: {
  income: ReturnType<typeof buildAnalytics>["passiveIncome"];
  target: number;
  onTargetChange: (value: number) => void;
}) {
  const targetProgress = props.target > 0 ? percentValue(props.income.monthlyRunRate.value, props.target) : null;

  return (
    <div className="panel">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Купонная зарплата</p>
          <h2>Пассивный доход</h2>
        </div>
      </div>
      <div className="metricGrid">
        <div>
          <span>В месяц</span>
          <strong>{formatMoney(props.income.monthlyRunRate)}</strong>
        </div>
        <div>
          <span>В год</span>
          <strong>{formatMoney(props.income.yearlyExpected)}</strong>
        </div>
        <div>
          <span>Ближайшая</span>
          <strong>{props.income.nextPayment ? formatMoney(props.income.nextPayment.amount) : dash()}</strong>
        </div>
        <div>
          <span>Прогресс цели</span>
          <strong>{formatPercent(targetProgress)}</strong>
        </div>
      </div>
      <label className="inlineInput">
        <span>Цель в месяц, ₽</span>
        <input
          min="0"
          type="number"
          value={props.target}
          onChange={(event) => props.onTargetChange(readInputNumber(event.currentTarget.value))}
        />
      </label>
      <div className="miniProgress">
        <div style={{ width: `${Math.min(100, Math.max(0, targetProgress ?? 0))}%` }} />
      </div>
    </div>
  );
}

function HonestReturnPanel(props: { returns: ReturnType<typeof buildAnalytics>["honestReturn"] }) {
  return (
    <div className="panel">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Честная доходность</p>
          <h2>Total return</h2>
        </div>
        <span>{props.returns.confidence}</span>
      </div>
      <div className="concentrationList">
        <div>
          <span>Total return</span>
          <strong className={amountClass(props.returns.totalReturn.value)}>{formatMoney(props.returns.totalReturn)}</strong>
          <b>{formatPercent(props.returns.totalReturnPercent)}</b>
        </div>
        <div>
          <span>Unrealized PnL</span>
          <strong className={amountClass(props.returns.unrealizedPnl.value)}>{formatMoney(props.returns.unrealizedPnl)}</strong>
          <b>по рынку</b>
        </div>
        <div>
          <span>Realized PnL</span>
          <strong>{formatMoney(props.returns.realizedPnl)}</strong>
          <b>нужна история</b>
        </div>
        <div>
          <span>НКД</span>
          <strong>{formatMoney(props.returns.accruedInterest)}</strong>
          <b>учтен отдельно</b>
        </div>
      </div>
      <div className="panelNote">{props.returns.note}</div>
    </div>
  );
}

function MaturityLadderPanel(props: { ladder: ReturnType<typeof buildAnalytics>["maturityLadder"] }) {
  return (
    <div className="panel widePanel">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Лестница погашений</p>
          <h2>Возврат капитала</h2>
        </div>
        <span>{props.ladder.emptyMonths12m} пустых мес.</span>
      </div>
      <div className="ladderGrid">
        {props.ladder.years.map((bucket) => (
          <div className={bucket.isConcentrated ? "ladderBucket warn" : "ladderBucket"} key={bucket.key}>
            <span>{bucket.label}</span>
            <strong>{formatMoney(bucket.amount)}</strong>
            <small>{bucket.count} бумаг · {formatPercent(bucket.share)}</small>
          </div>
        ))}
        {props.ladder.years.length === 0 && <div className="emptyInline">Нет дат погашения</div>}
      </div>
      <div className="durationGrid">
        {props.ladder.durationBuckets.map((bucket) => (
          <div key={bucket.key}>
            <span>{bucket.label}</span>
            <strong>{formatMoney(bucket.amount)}</strong>
            <small>{formatPercent(bucket.share)}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

function RiskScorePanel(props: { risk: ReturnType<typeof buildAnalytics>["riskModel"] }) {
  return (
    <div className="panel">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Risk score</p>
          <h2>Перекосы портфеля</h2>
        </div>
        <span>{props.risk.label}</span>
      </div>
      <div className={`healthGauge ${props.risk.tone}`}>
        <strong>{props.risk.score}</strong>
        <span>/100</span>
      </div>
      <div className="attentionList">
        {props.risk.warnings.slice(0, 4).map((warning) => (
          <div className={`attentionItem ${warning.level}`} key={warning.title}>
            <strong>{warning.title}</strong>
            <span>{warning.detail}</span>
          </div>
        ))}
        {props.risk.warnings.length === 0 && <div className="emptyInline">Критичных перекосов не видно</div>}
      </div>
    </div>
  );
}

function SmartInsightsPanel(props: { insights: ReturnType<typeof buildAnalytics>["smartInsights"] }) {
  return (
    <div className="panel">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Умные инсайты</p>
          <h2>Что важно сейчас</h2>
        </div>
      </div>
      <div className="attentionList">
        {props.insights.map((insight) => (
          <div className={`attentionItem ${insight.level}`} key={insight.title}>
            <strong>{insight.title}</strong>
            <span>{insight.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AlertsPanel(props: { alerts: ReturnType<typeof buildAnalytics>["alerts"] }) {
  return (
    <div className="panel">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Алерты</p>
          <h2>События и лимиты</h2>
        </div>
        <span>{props.alerts.length}</span>
      </div>
      <div className="attentionList">
        {props.alerts.slice(0, 5).map((alert) => (
          <div className={`attentionItem ${alert.level}`} key={`${alert.title}-${alert.detail}`}>
            <strong>{alert.title}</strong>
            <span>{alert.detail}</span>
          </div>
        ))}
        {props.alerts.length === 0 && <div className="emptyInline">Алертов нет</div>}
      </div>
      <div className="panelNote">UI-архитектура готова: следующим шагом эти события можно отправлять в Telegram или email.</div>
    </div>
  );
}

function ScenarioCalculatorPanel(props: {
  scenario: ReturnType<typeof buildScenario>;
  positions: PositionRow[];
  amountToInvest: number;
  bondSharePercent: number;
  positionKey: string;
  quantityToBuy: number;
  onAmountChange: (value: number) => void;
  onBondShareChange: (value: number) => void;
  onPositionChange: (value: string) => void;
  onQuantityChange: (value: number) => void;
}) {
  const selectablePositions = props.positions.filter((position) => (position.currentValue.value ?? 0) > 0 || (position.currentPrice.value ?? 0) > 0);

  return (
    <div className="panel widePanel">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Что будет, если</p>
          <h2>Сценарный калькулятор</h2>
        </div>
      </div>
      <div className="scenarioControls">
        <label className="inlineInput">
          <span>Довнести, ₽</span>
          <input min="0" type="number" value={props.amountToInvest} onChange={(event) => props.onAmountChange(readInputNumber(event.currentTarget.value))} />
        </label>
        <label className="inlineInput">
          <span>Доля в облигации, %</span>
          <input min="0" max="100" type="number" value={props.bondSharePercent} onChange={(event) => props.onBondShareChange(clamp(readInputNumber(event.currentTarget.value), 0, 100))} />
        </label>
        <label className="inlineInput">
          <span>Докупить бумагу</span>
          <select value={props.positionKey} onChange={(event) => props.onPositionChange(event.currentTarget.value)}>
            <option value="">Не выбрано</option>
            {selectablePositions.map((position) => (
              <option key={positionKey(position)} value={positionKey(position)}>
                {position.ticker || position.name}
              </option>
            ))}
          </select>
        </label>
        <label className="inlineInput">
          <span>Количество</span>
          <input min="0" type="number" value={props.quantityToBuy} onChange={(event) => props.onQuantityChange(readInputNumber(event.currentTarget.value))} />
        </label>
      </div>
      <div className="metricGrid scenarioResult">
        <div>
          <span>Новый портфель</span>
          <strong>{formatMoney(props.scenario.newPortfolioValue)}</strong>
        </div>
        <div>
          <span>Новый cashflow</span>
          <strong>{formatMoney(props.scenario.newAnnualCashflow)}</strong>
        </div>
        <div>
          <span>Месячный run-rate</span>
          <strong>{formatMoney(props.scenario.newMonthlyRunRate)}</strong>
        </div>
        <div>
          <span>Risk score</span>
          <strong>{props.scenario.newRiskScore}/100</strong>
        </div>
      </div>
      <div className="panelNote">{props.scenario.note}</div>
    </div>
  );
}

function StructureHintsPanel(props: { hints: ReturnType<typeof buildAnalytics>["structureHints"] }) {
  return (
    <div className="panel">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Подсказки</p>
          <h2>Структура</h2>
        </div>
      </div>
      <div className="attentionList">
        {props.hints.map((hint) => (
          <div className={`attentionItem ${hint.level}`} key={hint.title}>
            <strong>{hint.title}</strong>
            <span>{hint.detail}</span>
          </div>
        ))}
        {props.hints.length === 0 && <div className="emptyInline">Структура без явных перекосов</div>}
      </div>
    </div>
  );
}

function TypePerformancePanel(props: { items: ReturnType<typeof buildAnalytics>["typePerformance"] }) {
  return (
    <div className="panel">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Результат</p>
          <h2>По типам активов</h2>
        </div>
      </div>
      <div className="typePerformanceList">
        {props.items.map((item) => (
          <div className="typePerformanceItem" key={item.type}>
            <div>
              <strong>{item.type}</strong>
              <span>{formatMoney(item.value)}</span>
            </div>
            <b className={amountClass(item.expectedYield.value)}>{formatMoney(item.expectedYield)}</b>
          </div>
        ))}
        {props.items.length === 0 && <div className="emptyInline">Нет данных</div>}
      </div>
    </div>
  );
}

function WinnersLosersPanel(props: { winners: PositionRow[]; losers: PositionRow[] }) {
  return (
    <div className="panel">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Движение</p>
          <h2>Лидеры и просадки</h2>
        </div>
      </div>
      <div className="twoColumnList">
        <div>
          <strong className="miniTitle">Лучше</strong>
          {props.winners.map((position) => (
            <MiniPosition key={`${position.accountId}-${position.uid || position.name}-win`} position={position} />
          ))}
          {props.winners.length === 0 && <span className="emptyInline">Нет плюса</span>}
        </div>
        <div>
          <strong className="miniTitle">Хуже</strong>
          {props.losers.map((position) => (
            <MiniPosition key={`${position.accountId}-${position.uid || position.name}-loss`} position={position} />
          ))}
          {props.losers.length === 0 && <span className="emptyInline">Нет минуса</span>}
        </div>
      </div>
    </div>
  );
}

function MiniPosition(props: { position: PositionRow }) {
  return (
    <div className="miniPosition">
      <span>{props.position.ticker || props.position.name}</span>
      <b className={amountClass(props.position.expectedYieldPercent)}>{formatPercent(props.position.expectedYieldPercent)}</b>
    </div>
  );
}

function CurrencyExposurePanel(props: { items: Array<{ currency: string; count: number; value: number }> }) {
  return (
    <div className="panel">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Валюты</p>
          <h2>Валютная доля</h2>
        </div>
      </div>
      <div className="breakdownList">
        {props.items.map((item, index) => (
          <div className="breakdownItem" key={item.currency}>
            <span className="swatch" style={{ background: chartColor(index) }} />
            <strong>{item.currency}</strong>
            <span>{formatMoney({ value: item.value, currency: item.currency })}</span>
            <span>{item.count} поз.</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RiskPanel(props: { items: Array<{ title: string; value: string; level: "ok" | "warn" | "bad" }> }) {
  return (
    <div className="panel">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Контроль</p>
          <h2>Риски и качество</h2>
        </div>
      </div>
      <div className="riskGrid">
        {props.items.map((item) => (
          <div className={`riskItem ${item.level}`} key={item.title}>
            <span>{item.title}</span>
            <strong>{item.value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function DataQualityPanel(props: { quality: ReturnType<typeof buildAnalytics>["dataQuality"] }) {
  return (
    <div className="panel">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Данные</p>
          <h2>Качество API</h2>
        </div>
      </div>
      <div className="riskGrid">
        <div className={props.quality.missingPrices > 0 ? "riskItem warn" : "riskItem"}>
          <span>Без цены</span>
          <strong>{props.quality.missingPrices}</strong>
        </div>
        <div className={props.quality.zeroValues > 0 ? "riskItem warn" : "riskItem"}>
          <span>Нулевая стоимость</span>
          <strong>{props.quality.zeroValues}</strong>
        </div>
        <div className={props.quality.bondsWithoutCoupons > 0 ? "riskItem warn" : "riskItem"}>
          <span>Облигации без купонов</span>
          <strong>{props.quality.bondsWithoutCoupons}</strong>
        </div>
        <div className={props.quality.blocked > 0 ? "riskItem bad" : "riskItem"}>
          <span>Заблокировано</span>
          <strong>{props.quality.blocked}</strong>
        </div>
      </div>
    </div>
  );
}

function IncomeMonthsPanel(props: { months: Array<{ key: string; label: string; amount: MoneyAmount; percent: number | null }> }) {
  return (
    <div className="panel">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Купоны</p>
          <h2>12 месяцев</h2>
        </div>
      </div>
      <div className="monthBars">
        {props.months.map((month) => (
          <div className="monthBarRow" key={month.key}>
            <span>{month.label}</span>
            <div className="miniTrack">
              <div style={{ width: `${Math.max(month.percent ?? 0, month.amount.value ? 2 : 0)}%` }} />
            </div>
            <strong>{formatMoney(month.amount)}</strong>
          </div>
        ))}
        {props.months.length === 0 && <div className="emptyInline">Нет будущих купонов</div>}
      </div>
    </div>
  );
}

function TopCouponBondsPanel(props: { bonds: PositionRow[] }) {
  return (
    <div className="panel">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Облигации</p>
          <h2>Главные по купонам</h2>
        </div>
      </div>
      <div className="rankList">
        {props.bonds.map((bond, index) => (
          <div className="rankItem" key={`${bond.accountId}-${bond.uid || bond.figi || bond.name}-coupon-top`}>
            <span>{index + 1}</span>
            <div>
              <strong>{bond.ticker || bond.name}</strong>
              <small>{formatDate(bond.nextCouponDate)} · {bond.couponInfo || "купон"}</small>
            </div>
            <b>{formatMoney(bond.couponIncomeNext12m)}</b>
          </div>
        ))}
        {props.bonds.length === 0 && <div className="emptyInline">Нет купонных выплат</div>}
      </div>
    </div>
  );
}

function PositionsControls(props: {
  query: string;
  typeFilter: string;
  signalFilter: PositionSignal;
  availableTypes: string[];
  filteredCount: number;
  totalCount: number;
  onQueryChange: (value: string) => void;
  onTypeChange: (value: string) => void;
  onSignalChange: (value: PositionSignal) => void;
  onExport: () => void;
}) {
  return (
    <section className="controlsPanel">
      <div className="filterField">
        <label htmlFor="search">Поиск</label>
        <input
          id="search"
          value={props.query}
          placeholder="Тикер, название, счет, FIGI"
          onChange={(event) => props.onQueryChange(event.target.value)}
        />
      </div>
      <div className="filterField">
        <label htmlFor="typeFilter">Тип</label>
        <select id="typeFilter" value={props.typeFilter} onChange={(event) => props.onTypeChange(event.target.value)}>
          <option value={ALL_TYPES}>Все типы</option>
          {props.availableTypes.map((type) => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>
      </div>
      <div className="filterField">
        <label htmlFor="signalFilter">Сигнал</label>
        <select id="signalFilter" value={props.signalFilter} onChange={(event) => props.onSignalChange(event.target.value as PositionSignal)}>
          <option value="all">Все позиции</option>
          <option value="negative">Просадка</option>
          <option value="positive">Плюс</option>
          <option value="blocked">Заблокировано</option>
          <option value="zero">Нулевая цена</option>
          <option value="foreign">Не ₽</option>
        </select>
      </div>
      <button className="ghostButton" onClick={props.onExport} disabled={props.filteredCount === 0}>
        CSV
      </button>
      <div className="filterCount">{props.filteredCount} из {props.totalCount}</div>
    </section>
  );
}

function PositionsTable(props: { positions: PositionRow[]; sortState: SortState; onSort: (key: SortKey) => void }) {
  return (
    <section className="tableSection">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Позиции</p>
          <h2>Все инструменты</h2>
        </div>
        <span>{props.positions.length} строк</span>
      </div>

      <div className="tableWrap">
        <table>
          <thead>
            <tr>
              <SortHeader label="Инструмент" sortKey="name" state={props.sortState} onSort={props.onSort} />
              <SortHeader label="Тип" sortKey="type" state={props.sortState} onSort={props.onSort} />
              <SortHeader label="Счет" sortKey="account" state={props.sortState} onSort={props.onSort} />
              <SortHeader label="Кол-во" sortKey="quantity" state={props.sortState} onSort={props.onSort} />
              <th>Средняя цена</th>
              <th>Текущая цена</th>
              <SortHeader label="Стоимость" sortKey="value" state={props.sortState} onSort={props.onSort} />
              <SortHeader label="Доля" sortKey="share" state={props.sortState} onSort={props.onSort} />
              <SortHeader label="Доход" sortKey="yield" state={props.sortState} onSort={props.onSort} />
              <SortHeader label="Доход, %" sortKey="yieldPercent" state={props.sortState} onSort={props.onSort} />
            </tr>
          </thead>
          <tbody>
            {props.positions.map((position) => (
              <tr className={position.blocked ? "blockedRow" : ""} key={`${position.accountId}-${position.uid || position.figi || position.name}`}>
                <td>
                  <div className="instrumentName">{position.name}</div>
                  <div className="muted">{position.ticker || position.figi || position.uid || "без id"}{position.blocked ? " · заблокировано" : ""}</div>
                </td>
                <td><span className="typePill">{position.typeLabel}</span></td>
                <td>{position.accountName}</td>
                <td>{formatNumber(position.quantity)}</td>
                <td>{formatMoney(position.averagePrice)}</td>
                <td>{formatMoney(position.currentPrice)}</td>
                <td>{formatMoney(position.currentValue)}</td>
                <td>{formatPercent(position.portfolioSharePercent)}</td>
                <td className={amountClass(position.expectedYield.value)}>{formatMoney(position.expectedYield)}</td>
                <td className={amountClass(position.expectedYieldPercent)}>{formatPercent(position.expectedYieldPercent)}</td>
              </tr>
            ))}

            {props.positions.length === 0 && (
              <tr>
                <td colSpan={10} className="empty">
                  Под выбранные фильтры ничего не попало.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SortHeader(props: { label: string; sortKey: SortKey; state: SortState; onSort: (key: SortKey) => void }) {
  const isActive = props.state.key === props.sortKey;
  return (
    <th>
      <button className={isActive ? "sortButton active" : "sortButton"} onClick={() => props.onSort(props.sortKey)}>
        {props.label}
        {isActive ? <span>{props.state.direction === "desc" ? "↓" : "↑"}</span> : null}
      </button>
    </th>
  );
}

function BondsTable(props: { bonds: PositionRow[] }) {
  return (
    <section className="tableSection">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Облигации</p>
          <h2>Детали по долговым бумагам</h2>
        </div>
        <span>{props.bonds.length} строк</span>
      </div>

      <div className="tableWrap">
        <table className="bondsTable">
          <thead>
            <tr>
              <th>Название</th>
              <th>Тикер</th>
              <th>Кол-во</th>
              <th>Средняя</th>
              <th>Текущая</th>
              <th>Стоимость</th>
              <th>НКД</th>
              <th>Заработок</th>
              <th>Купоны 12м</th>
              <th>Купонная дох.</th>
              <th>Итого 12м</th>
              <th>След. купон</th>
              <th>Номинал</th>
              <th>Купон</th>
              <th>Погашение</th>
            </tr>
          </thead>
          <tbody>
            {props.bonds.map((bond) => (
              <tr key={`${bond.accountId}-${bond.uid || bond.figi || bond.name}`}>
                <td>
                  <div className="instrumentName">{bond.name}</div>
                  <div className="muted">{bond.accountName}</div>
                </td>
                <td>{bond.ticker || dash()}</td>
                <td>{formatNumber(bond.quantity)}</td>
                <td>{formatMoney(bond.averagePrice)}</td>
                <td>{formatMoney(bond.currentPrice)}</td>
                <td>{formatMoney(bond.currentValue)}</td>
                <td>{formatMoney(bond.accruedInterest)}</td>
                <td className={amountClass(bond.bondIncomeNow.value)}>{formatMoney(bond.bondIncomeNow)}</td>
                <td>{formatMoney(bond.couponIncomeNext12m)}</td>
                <td>{formatPercent(bond.couponYieldNext12mPercent)}</td>
                <td className={amountClass(bond.bondIncomeNext12m.value)}>
                  {formatMoney(bond.bondIncomeNext12m)} · {formatPercent(bond.bondIncomeNext12mPercent)}
                </td>
                <td>{bond.nextCouponDate ? `${formatDate(bond.nextCouponDate)} · ${formatMoney(bond.nextCouponAmount)}` : dash()}</td>
                <td>{formatMoney(bond.nominal)}</td>
                <td>{bond.couponInfo || dash()}</td>
                <td>{formatDate(bond.maturityDate)}</td>
              </tr>
            ))}

            {props.bonds.length === 0 && (
              <tr>
                <td colSpan={15} className="empty">
                  В выбранном срезе облигации не найдены.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function BondTimeline(props: { bonds: PositionRow[] }) {
  const sortedBonds = [...props.bonds].sort((left, right) => dateTime(left.maturityDate) - dateTime(right.maturityDate));

  return (
    <section className="tableSection">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">Календарь</p>
          <h2>Погашения облигаций</h2>
        </div>
      </div>
      <div className="timelinePanel">
        {sortedBonds.map((bond) => (
          <div className="timelineItem" key={`${bond.accountId}-${bond.uid || bond.figi || bond.name}-timeline`}>
            <span>{formatDate(bond.maturityDate)}</span>
            <strong>{bond.name}</strong>
            <small>{formatMoney(bond.currentValue)} · {bond.couponInfo || "купон не указан"}</small>
          </div>
        ))}
        {sortedBonds.length === 0 && <div className="emptyInline">Нет облигаций для календаря</div>}
      </div>
    </section>
  );
}

function buildAnalytics(positions: PositionRow[], total?: MoneyAmount | null) {
  const topHoldings = [...positions]
    .filter((position) => (position.currentValue.value ?? 0) > 0)
    .sort((left, right) => compareNullableNumbers(right.portfolioSharePercent, left.portfolioSharePercent) || compareMoneyValue(right, left))
    .slice(0, 5);
  const positionsByValue = [...positions]
    .filter((position) => (position.currentValue.value ?? 0) > 0)
    .sort((left, right) => (right.currentValue.value ?? 0) - (left.currentValue.value ?? 0));
  const heatmapPositions = positionsByValue.slice(0, 14);
  const diversification = buildDiversification(positionsByValue);

  const byYield = positions.filter((position) => position.expectedYieldPercent !== null);
  const winners = [...byYield].sort((left, right) => (right.expectedYieldPercent ?? 0) - (left.expectedYieldPercent ?? 0)).slice(0, 3);
  const losers = [...byYield].sort((left, right) => (left.expectedYieldPercent ?? 0) - (right.expectedYieldPercent ?? 0)).slice(0, 3);
  const currencyExposure = buildCurrencyExposure(positions);
  const blockedCount = positions.filter((position) => position.blocked).length;
  const zeroCount = positions.filter((position) => (position.currentValue.value ?? 0) === 0).length;
  const negativeCount = positions.filter((position) => (position.expectedYield.value ?? 0) < 0).length;
  const foreignCount = positions.filter((position) => normalizeCurrency(position.currentValue.currency) !== "RUB").length;
  const largestShare = Math.max(0, ...positions.map((position) => position.portfolioSharePercent ?? 0));
  const largestPosition = positionsByValue[0];
  const bestPosition = winners[0];
  const worstPosition = losers[0];
  const topFiveShare = positionsByValue.slice(0, 5).reduce((sum, position) => sum + (position.portfolioSharePercent ?? 0), 0);
  const cashLikePositions = positions.filter((position) => normalizePositionType(position.typeLabel) === "currency");
  const cashLikeValue = addMoney(cashLikePositions.map((position) => position.currentValue));
  const cashLikeShare = percentValue(cashLikeValue.value, total?.value ?? null);
  const typePerformance = buildTypePerformance(positions);
  const bonds = positions.filter(isBondPosition);
  const bondValue = addMoney(bonds.map((position) => position.currentValue));
  const bondIncomeNow = addMoney(bonds.map((position) => position.bondIncomeNow));
  const couponsNext12m = addMoney(bonds.map((position) => position.couponIncomeNext12m));
  const bondIncomeNext12m = addMoney(bonds.map((position) => position.bondIncomeNext12m));
  const missingPrices = positions.filter((position) => position.currentPrice.value === null).length;
  const bondsWithoutCoupons = bonds.filter((position) => (position.upcomingCoupons ?? []).length === 0).length;
  const upcomingCoupons = bonds
    .flatMap((bond) =>
      (bond.upcomingCoupons ?? []).map((coupon) => ({
        date: coupon.date,
        amount: coupon.totalAmount,
        bondName: bond.name
      }))
    )
    .sort((left, right) => dateTime(left.date) - dateTime(right.date));
  const couponEvents: MoneyEvent[] = upcomingCoupons.map((coupon) => ({
    kind: "coupon",
    date: coupon.date,
    title: coupon.bondName,
    amount: coupon.amount,
    meta: "купон",
    source: "api"
  }));
  const maturityEvents: MoneyEvent[] = bonds
    .filter((bond) => isFutureDate(bond.maturityDate))
    .map((bond) => ({
      kind: "maturity",
      date: bond.maturityDate,
      title: bond.ticker || bond.name,
      amount: estimateMaturityAmount(bond),
      meta: "погашение",
      source: "derived"
    }));
  const events = [...couponEvents, ...maturityEvents].sort((left, right) => dateTime(left.date) - dateTime(right.date));
  const couponsNext30d = addMoney(
    upcomingCoupons
      .filter((coupon) => isWithinDays(coupon.date, 30))
      .map((coupon) => coupon.amount)
  );
  const couponMonths = buildCouponMonths(upcomingCoupons);
  const cashflowForecast = buildCashflowForecast(upcomingCoupons);
  const moneyCalendar = buildMoneyCalendar(events);
  const maturityLadder = buildMaturityLadder(bonds);
  const honestReturn = buildHonestReturn(positions, bonds, total);
  const topCouponBonds = [...bonds]
    .filter((bond) => (bond.couponIncomeNext12m.value ?? 0) > 0)
    .sort((left, right) => (right.couponIncomeNext12m.value ?? 0) - (left.couponIncomeNext12m.value ?? 0))
    .slice(0, 5);
  const nextEvent = events[0];
  const health = buildHealthScore({
    largestShare,
    negativeCount,
    zeroCount,
    blockedCount,
    missingPrices,
    bondsWithoutCoupons,
    foreignCount,
    positionsCount: positions.length
  });
  const attentionQueue = buildAttentionQueue({
    largestPosition,
    largestShare,
    worstPosition,
    negativeCount,
    zeroCount,
    blockedCount,
    missingPrices,
    bondsWithoutCoupons,
    nextEvent,
    health
  });
  const structureHints = buildStructureHints({
    diversification,
    largestPosition,
    largestShare,
    topFiveShare,
    cashLikeShare,
    bondsShare: percentValue(bondValue.value, total?.value ?? null),
    couponsNext12m
  });
  const pulse = buildPulse({
    expectedYield: addMoney(positions.map((position) => position.expectedYield)),
    expectedYieldPercent: percentValue(
      addMoney(positions.map((position) => position.expectedYield)).value,
      total?.value ?? null
    ),
    health,
    nextEvent,
    cashflow90d: cashflowForecast.next90d
  });
  const passiveIncome = buildPassiveIncome(cashflowForecast, events);
  const riskModel = buildRiskModel({
    positions,
    positionsByValue,
    total,
    largestPosition,
    largestShare,
    currencyExposure,
    maturityLadder,
    blockedCount,
    zeroCount,
    missingPrices,
    foreignCount
  });
  const alerts = buildAlerts({
    events,
    largestPosition,
    largestShare,
    worstPosition,
    riskModel,
    total
  });
  const smartInsights = buildSmartInsights({
    largestPosition,
    largestShare,
    bestPosition,
    worstPosition,
    nextEvent,
    passiveIncome,
    moneyCalendar,
    maturityLadder,
    riskModel,
    sessionQualityIssues: missingPrices + zeroCount + bondsWithoutCoupons
  });
  const insights = [
    {
      label: "Крупнейшая",
      value: largestPosition
        ? `${largestPosition.ticker || largestPosition.name} · ${formatPercent(largestPosition.portfolioSharePercent)}`
        : dash(),
      tone: largestShare > 35 ? "bad" as const : largestShare > 20 ? "warn" as const : "ok" as const
    },
    {
      label: "Лучший",
      value: bestPosition ? `${bestPosition.ticker || bestPosition.name} · ${formatPercent(bestPosition.expectedYieldPercent)}` : dash(),
      tone: "good" as const
    },
    {
      label: "Худший",
      value: worstPosition ? `${worstPosition.ticker || worstPosition.name} · ${formatPercent(worstPosition.expectedYieldPercent)}` : dash(),
      tone: (worstPosition?.expectedYieldPercent ?? 0) < -10 ? "bad" as const : "warn" as const
    },
    {
      label: "След. событие",
      value: nextEvent ? `${formatDate(nextEvent.date)} · ${nextEvent.title}` : dash(),
      tone: "ok" as const
    },
    {
      label: "Данные",
      value: missingPrices + zeroCount + bondsWithoutCoupons > 0 ? `${missingPrices + zeroCount + bondsWithoutCoupons} вопросов` : "норма",
      tone: missingPrices + zeroCount + bondsWithoutCoupons > 0 ? "warn" as const : "good" as const
    }
  ];

  return {
    topHoldings,
    heatmapPositions,
    winners,
    losers,
    currencyExposure,
    events,
    moneyCalendar,
    insights,
    pulse,
    honestReturn,
    passiveIncome,
    maturityLadder,
    riskModel,
    smartInsights,
    alerts,
    health,
    attentionQueue,
    diversification,
    structureHints,
    typePerformance,
    concentration: {
      largestName: largestPosition?.ticker || largestPosition?.name || dash(),
      largestShare,
      topFiveShare,
      topFiveCount: Math.min(5, positionsByValue.length),
      cashLikeValue,
      cashLikeShare
    },
    dataQuality: {
      missingPrices,
      zeroValues: zeroCount,
      bondsWithoutCoupons,
      blocked: blockedCount
    },
    bond: {
      value: bondValue,
      incomeNow: bondIncomeNow,
      couponsNext12m,
      couponsNext30d,
      incomeNext12m: bondIncomeNext12m,
      couponYieldPercent: percentValue(couponsNext12m.value, bondValue.value),
      incomeNext12mPercent: percentValue(bondIncomeNext12m.value, bondValue.value),
      upcomingCoupons,
      couponMonths,
      cashflowForecast,
      topCouponBonds
    },
    riskItems: [
      {
        title: "Концентрация",
        value: largestShare ? formatPercent(largestShare) : dash(),
        level: largestShare > 35 ? "bad" as const : largestShare > 20 ? "warn" as const : "ok" as const
      },
      {
        title: "Просадки",
        value: String(negativeCount),
        level: negativeCount > Math.max(positions.length / 2, 3) ? "warn" as const : "ok" as const
      },
      {
        title: "Нулевая оценка",
        value: String(zeroCount),
        level: zeroCount > 0 ? "warn" as const : "ok" as const
      },
      {
        title: "Заблокировано",
        value: String(blockedCount),
        level: blockedCount > 0 ? "bad" as const : "ok" as const
      },
      {
        title: "Не ₽",
        value: String(foreignCount),
        level: foreignCount > 0 ? "warn" as const : "ok" as const
      },
      {
        title: "Итого",
        value: formatMoney(total),
        level: "ok" as const
      }
    ]
  };
}

function addMoney(amounts: MoneyAmount[]): MoneyAmount {
  const currency = amounts.find((amount) => amount.currency)?.currency ?? "rub";
  const values = amounts
    .map((amount) => amount.value)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  return {
    value: values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null,
    currency
  };
}

function buildCurrencyExposure(positions: PositionRow[]) {
  const grouped = new Map<string, { currency: string; count: number; value: number }>();

  for (const position of positions) {
    const currency = normalizeCurrency(position.currentValue.currency);
    const existing = grouped.get(currency);
    const value = position.currentValue.value ?? 0;

    if (existing) {
      existing.count += 1;
      existing.value += value;
    } else {
      grouped.set(currency, { currency, count: 1, value });
    }
  }

  return [...grouped.values()].sort((left, right) => right.value - left.value);
}

function buildTypePerformance(positions: PositionRow[]) {
  const grouped = new Map<string, { type: string; value: MoneyAmount[]; expectedYield: MoneyAmount[] }>();

  for (const position of positions) {
    const existing = grouped.get(position.typeLabel);

    if (existing) {
      existing.value.push(position.currentValue);
      existing.expectedYield.push(position.expectedYield);
    } else {
      grouped.set(position.typeLabel, {
        type: position.typeLabel,
        value: [position.currentValue],
        expectedYield: [position.expectedYield]
      });
    }
  }

  return [...grouped.values()]
    .map((item) => ({
      type: item.type,
      value: addMoney(item.value),
      expectedYield: addMoney(item.expectedYield)
    }))
    .sort((left, right) => Math.abs(right.expectedYield.value ?? 0) - Math.abs(left.expectedYield.value ?? 0));
}

function buildMoneyCalendar(events: MoneyEvent[]) {
  const futureEvents = events
    .filter((event) => isFutureDate(event.date))
    .sort((left, right) => dateTime(left.date) - dateTime(right.date));
  const months = buildEventMonths(futureEvents);
  const byKind = (["coupon", "maturity", "amortization", "dividend"] as MoneyEventKind[]).map((kind) => ({
    kind,
    label: eventKindLabel(kind),
    amount: addMoney(futureEvents.filter((event) => event.kind === kind).map((event) => event.amount)),
    count: futureEvents.filter((event) => event.kind === kind).length
  }));

  return {
    events: futureEvents,
    upcoming: futureEvents.slice(0, 10),
    months,
    byKind,
    hasExtendedEvents: futureEvents.some((event) => event.kind === "amortization" || event.kind === "dividend"),
    forecast: {
      next30d: addMoney(futureEvents.filter((event) => isWithinDays(event.date, 30)).map((event) => event.amount)),
      next90d: addMoney(futureEvents.filter((event) => isWithinDays(event.date, 90)).map((event) => event.amount)),
      next365d: addMoney(futureEvents.filter((event) => isWithinDays(event.date, 365)).map((event) => event.amount))
    }
  };
}

function buildEventMonths(events: MoneyEvent[]) {
  const grouped = new Map<string, { amounts: MoneyAmount[]; events: number }>();

  for (const event of events) {
    if (!event.date) {
      continue;
    }

    const key = event.date.slice(0, 7);
    const existing = grouped.get(key) ?? { amounts: [], events: 0 };
    existing.amounts.push(event.amount);
    existing.events += 1;
    grouped.set(key, existing);
  }

  const months = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 12)
    .map(([key, group]) => ({
      key,
      label: formatMonth(key),
      amount: addMoney(group.amounts),
      events: group.events,
      percent: null as number | null
    }));
  const maxValue = Math.max(0, ...months.map((month) => month.amount.value ?? 0));

  return months.map((month) => ({
    ...month,
    percent: percentValue(month.amount.value, maxValue)
  }));
}

function buildHonestReturn(positions: PositionRow[], bonds: PositionRow[], total?: MoneyAmount | null) {
  const unrealizedPnl = addMoney(positions.map((position) => position.expectedYield));
  const accruedInterest = addMoney(bonds.map((bond) => bond.accruedInterest));
  const totalReturn = addMoney([unrealizedPnl, accruedInterest]);
  const investedCapital = subtractMoney(total ?? { value: null, currency: totalReturn.currency }, unrealizedPnl);

  return {
    totalReturn,
    totalReturnPercent: percentValue(totalReturn.value, investedCapital.value),
    unrealizedPnl,
    realizedPnl: { value: null, currency: totalReturn.currency },
    accruedInterest,
    commissions: { value: null, currency: totalReturn.currency },
    confidence: "без истории операций",
    note: "Сейчас расчет использует текущие позиции, средние цены, broker expected yield и НКД. Полученные купоны, дивиденды, сделки и комиссии появятся после подключения истории операций."
  };
}

function buildPassiveIncome(cashflowForecast: ReturnType<typeof buildCashflowForecast>, events: MoneyEvent[]) {
  const nextPayment = events.find((event) => event.kind === "coupon" && isFutureDate(event.date));

  return {
    monthlyRunRate: cashflowForecast.monthlyAverage,
    yearlyExpected: cashflowForecast.next365d,
    nextPayment: nextPayment ? { date: nextPayment.date, amount: nextPayment.amount, title: nextPayment.title } : null
  };
}

function buildMaturityLadder(bonds: PositionRow[]) {
  const maturityItems = bonds
    .filter((bond) => isFutureDate(bond.maturityDate))
    .map((bond) => ({
      bond,
      date: bond.maturityDate as string,
      amount: estimateMaturityAmount(bond)
    }));
  const totalMaturity = addMoney(maturityItems.map((item) => item.amount));
  const years = groupMaturityByYear(maturityItems, totalMaturity);
  const durationBuckets = buildDurationBuckets(maturityItems, totalMaturity);
  const emptyMonths12m = countEmptyMaturityMonths(maturityItems, 12);
  const largestShare = Math.max(0, ...years.map((year) => year.share ?? 0));

  return {
    totalMaturity,
    years,
    durationBuckets,
    emptyMonths12m,
    largestShare,
    concentratedPeriod: years.find((year) => year.isConcentrated)
  };
}

function groupMaturityByYear(items: Array<{ date: string; amount: MoneyAmount }>, total: MoneyAmount) {
  const grouped = new Map<string, MoneyAmount[]>();

  for (const item of items) {
    const key = item.date.slice(0, 4);
    grouped.set(key, [...(grouped.get(key) ?? []), item.amount]);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 8)
    .map(([key, amounts]) => {
      const amount = addMoney(amounts);
      const share = percentValue(amount.value, total.value);
      return {
        key,
        label: key,
        amount,
        count: amounts.length,
        share,
        isConcentrated: (share ?? 0) >= 35
      };
    });
}

function buildDurationBuckets(items: Array<{ date: string; amount: MoneyAmount }>, total: MoneyAmount) {
  const buckets = [
    { key: "short", label: "до 1 года", amounts: [] as MoneyAmount[] },
    { key: "mid", label: "1-3 года", amounts: [] as MoneyAmount[] },
    { key: "long", label: "3+ года", amounts: [] as MoneyAmount[] }
  ];

  for (const item of items) {
    const years = (dateTime(item.date) - Date.now()) / (365 * 24 * 60 * 60 * 1000);
    const bucket = years <= 1 ? buckets[0] : years <= 3 ? buckets[1] : buckets[2];
    bucket.amounts.push(item.amount);
  }

  return buckets.map((bucket) => {
    const amount = addMoney(bucket.amounts);
    return {
      key: bucket.key,
      label: bucket.label,
      amount,
      share: percentValue(amount.value, total.value)
    };
  });
}

function countEmptyMaturityMonths(items: Array<{ date: string }>, monthsAhead: number): number {
  const occupied = new Set(items.map((item) => item.date.slice(0, 7)));
  let empty = 0;
  const cursor = new Date();
  cursor.setDate(1);

  for (let index = 0; index < monthsAhead; index += 1) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
    if (!occupied.has(key)) {
      empty += 1;
    }
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return empty;
}

function buildRiskModel(input: {
  positions: PositionRow[];
  positionsByValue: PositionRow[];
  total?: MoneyAmount | null;
  largestPosition?: PositionRow;
  largestShare: number;
  currencyExposure: Array<{ currency: string; count: number; value: number }>;
  maturityLadder: ReturnType<typeof buildMaturityLadder>;
  blockedCount: number;
  zeroCount: number;
  missingPrices: number;
  foreignCount: number;
}) {
  const warnings: Array<{ title: string; detail: string; level: "ok" | "warn" | "bad" }> = [];
  const maxCurrency = input.currencyExposure[0];
  const maxCurrencyShare = percentValue(maxCurrency?.value ?? null, input.total?.value ?? null) ?? 0;
  const typeShares = buildTypeShares(input.positions, input.total);
  const maxType = typeShares[0];

  if (input.largestPosition && input.largestShare > 25) {
    warnings.push({
      title: "Концентрация позиции",
      detail: `${input.largestPosition.ticker || input.largestPosition.name}: ${formatPercent(input.largestShare)}`,
      level: input.largestShare > 40 ? "bad" : "warn"
    });
  }

  if (maxCurrency && maxCurrencyShare > 80) {
    warnings.push({
      title: "Одна валюта",
      detail: `${maxCurrency.currency}: ${formatPercent(maxCurrencyShare)}`,
      level: maxCurrencyShare > 95 ? "bad" : "warn"
    });
  }

  if (maxType && (maxType.share ?? 0) > 70) {
    warnings.push({
      title: "Перекос по типу",
      detail: `${maxType.label}: ${formatPercent(maxType.share)}`,
      level: (maxType.share ?? 0) > 85 ? "bad" : "warn"
    });
  }

  if (input.maturityLadder.largestShare > 35) {
    warnings.push({
      title: "Плотное погашение",
      detail: `${input.maturityLadder.concentratedPeriod?.label}: ${formatPercent(input.maturityLadder.largestShare)} капитала облигаций`,
      level: input.maturityLadder.largestShare > 55 ? "bad" : "warn"
    });
  }

  if (input.blockedCount + input.zeroCount + input.missingPrices > 0) {
    warnings.push({
      title: "Качество данных",
      detail: `${input.blockedCount + input.zeroCount + input.missingPrices} позиций требуют проверки`,
      level: input.blockedCount > 0 ? "bad" : "warn"
    });
  }

  const score = clamp(
    Math.round(
      100 -
        concentrationPenalty(input.largestShare, 18, 38) -
        concentrationPenalty(maxCurrencyShare, 80, 96) -
        concentrationPenalty(maxType?.share ?? 0, 68, 86) -
        concentrationPenalty(input.maturityLadder.largestShare, 34, 56) -
        (input.blockedCount > 0 ? 16 : 0) -
        Math.min(15, (input.zeroCount + input.missingPrices) * 4) -
        (input.foreignCount > Math.max(2, input.positions.length / 3) ? 5 : 0)
    ),
    0,
    100
  );
  const tone = score >= 78 ? "good" as const : score >= 58 ? "warn" as const : "bad" as const;

  return {
    score,
    tone,
    label: score >= 78 ? "риск под контролем" : score >= 58 ? "есть перекосы" : "высокий риск",
    warnings,
    maxCurrencyShare,
    maxTypeShare: maxType?.share ?? null,
    largestPositionShare: input.largestShare
  };
}

function buildTypeShares(positions: PositionRow[], total?: MoneyAmount | null) {
  const grouped = new Map<string, { label: string; value: number }>();

  for (const position of positions) {
    const value = position.currentValue.value ?? 0;
    const existing = grouped.get(position.typeLabel);
    if (existing) {
      existing.value += value;
    } else {
      grouped.set(position.typeLabel, { label: position.typeLabel, value });
    }
  }

  return [...grouped.values()]
    .map((item) => ({
      ...item,
      share: percentValue(item.value, total?.value ?? null)
    }))
    .sort((left, right) => (right.share ?? 0) - (left.share ?? 0));
}

function buildAlerts(input: {
  events: MoneyEvent[];
  largestPosition?: PositionRow;
  largestShare: number;
  worstPosition?: PositionRow;
  riskModel: ReturnType<typeof buildRiskModel>;
  total?: MoneyAmount | null;
}) {
  const alerts: Array<{ title: string; detail: string; level: "ok" | "warn" | "bad" }> = [];
  const nearCoupon = input.events.find((event) => event.kind === "coupon" && isWithinDays(event.date, 14));
  const nearMaturity = input.events.find((event) => event.kind === "maturity" && isWithinDays(event.date, 45));

  if (nearCoupon) {
    alerts.push({
      title: "Скорый купон",
      detail: `${formatDate(nearCoupon.date)} · ${nearCoupon.title} · ${formatMoney(nearCoupon.amount)}`,
      level: "ok"
    });
  }

  if (nearMaturity) {
    alerts.push({
      title: "Скорое погашение",
      detail: `${formatDate(nearMaturity.date)} · ${nearMaturity.title} · ${formatMoney(nearMaturity.amount)}`,
      level: "warn"
    });
  }

  if (input.largestPosition && input.largestShare > 30) {
    alerts.push({
      title: "Лимит концентрации",
      detail: `${input.largestPosition.ticker || input.largestPosition.name}: ${formatPercent(input.largestShare)}`,
      level: input.largestShare > 45 ? "bad" : "warn"
    });
  }

  if (input.worstPosition && (input.worstPosition.expectedYieldPercent ?? 0) < -12) {
    alerts.push({
      title: "Сильная просадка",
      detail: `${input.worstPosition.ticker || input.worstPosition.name}: ${formatPercent(input.worstPosition.expectedYieldPercent)}`,
      level: "bad"
    });
  }

  if (input.riskModel.score < 60) {
    alerts.push({
      title: "Risk score ниже нормы",
      detail: `${input.riskModel.score}/100 · ${input.riskModel.label}`,
      level: "bad"
    });
  }

  return alerts;
}

function buildSmartInsights(input: {
  largestPosition?: PositionRow;
  largestShare: number;
  bestPosition?: PositionRow;
  worstPosition?: PositionRow;
  nextEvent?: MoneyEvent;
  passiveIncome: ReturnType<typeof buildPassiveIncome>;
  moneyCalendar: ReturnType<typeof buildMoneyCalendar>;
  maturityLadder: ReturnType<typeof buildMaturityLadder>;
  riskModel: ReturnType<typeof buildRiskModel>;
  sessionQualityIssues: number;
}) {
  const insights: Array<{ title: string; detail: string; level: "ok" | "warn" | "bad" }> = [];

  if (input.nextEvent) {
    insights.push({
      title: "Ближайшие деньги",
      detail: `${formatDate(input.nextEvent.date)} · ${eventKindLabel(input.nextEvent.kind)} · ${formatMoney(input.nextEvent.amount)}`,
      level: "ok"
    });
  }

  if (input.passiveIncome.monthlyRunRate.value !== null) {
    insights.push({
      title: "Купонная зарплата",
      detail: `Текущий темп: ${formatMoney(input.passiveIncome.monthlyRunRate)} в месяц`,
      level: "ok"
    });
  }

  if (input.largestPosition && input.largestShare > 20) {
    insights.push({
      title: "Главный перекос",
      detail: `${input.largestPosition.ticker || input.largestPosition.name}: ${formatPercent(input.largestShare)} портфеля`,
      level: input.largestShare > 35 ? "bad" : "warn"
    });
  }

  if (input.bestPosition) {
    insights.push({
      title: "Сильная сторона",
      detail: `${input.bestPosition.ticker || input.bestPosition.name}: ${formatPercent(input.bestPosition.expectedYieldPercent)}`,
      level: "ok"
    });
  }

  if (input.worstPosition && (input.worstPosition.expectedYieldPercent ?? 0) < 0) {
    insights.push({
      title: "Слабое место",
      detail: `${input.worstPosition.ticker || input.worstPosition.name}: ${formatPercent(input.worstPosition.expectedYieldPercent)}`,
      level: (input.worstPosition.expectedYieldPercent ?? 0) < -10 ? "bad" : "warn"
    });
  }

  if (input.maturityLadder.concentratedPeriod) {
    insights.push({
      title: "Погашения скучены",
      detail: `${input.maturityLadder.concentratedPeriod.label}: ${formatPercent(input.maturityLadder.concentratedPeriod.share)}`,
      level: "warn"
    });
  }

  if (input.sessionQualityIssues > 0) {
    insights.push({
      title: "Качество данных",
      detail: `${input.sessionQualityIssues} вопросов по ценам, купонам или нулевым оценкам`,
      level: "warn"
    });
  }

  if (insights.length === 0) {
    insights.push({ title: "Картина спокойная", detail: "Критичных сигналов на текущем срезе нет", level: "ok" });
  }

  return insights.slice(0, 6);
}

function buildDiversification(positionsByValue: PositionRow[]) {
  const shares = positionsByValue
    .map((position) => (position.portfolioSharePercent ?? 0) / 100)
    .filter((share) => share > 0);
  const hhi = shares.reduce((sum, share) => sum + share * share, 0);
  const effectivePositions = hhi > 0 ? 1 / hhi : 0;
  const topTenShare = positionsByValue.slice(0, 10).reduce((sum, position) => sum + (position.portfolioSharePercent ?? 0), 0);
  const smallPositions = positionsByValue.filter((position) => (position.portfolioSharePercent ?? 0) < 1).length;

  return {
    hhi,
    effectivePositions,
    topTenShare,
    smallPositions,
    grade: effectivePositions >= 10 ? "широкая" : effectivePositions >= 5 ? "средняя" : "узкая"
  };
}

function buildCashflowForecast(coupons: Array<{ date?: string; amount: MoneyAmount }>) {
  const next30 = coupons.filter((coupon) => isWithinDays(coupon.date, 30));
  const next90 = coupons.filter((coupon) => isWithinDays(coupon.date, 90));
  const next365 = coupons.filter((coupon) => isWithinDays(coupon.date, 365));
  const next365d = addMoney(next365.map((coupon) => coupon.amount));

  return {
    next30d: addMoney(next30.map((coupon) => coupon.amount)),
    next90d: addMoney(next90.map((coupon) => coupon.amount)),
    next365d,
    monthlyAverage: next365d.value === null ? { value: null, currency: next365d.currency } : { value: next365d.value / 12, currency: next365d.currency },
    payments30d: next30.length,
    payments90d: next90.length,
    payments365d: next365.length
  };
}

function buildScenario(input: {
  positions: PositionRow[];
  summary: {
    totalAmountPortfolio: MoneyAmount;
    expectedYield: MoneyAmount;
    expectedYieldPercent: number | null;
  } | null;
  analytics: ReturnType<typeof buildAnalytics>;
  amountToInvest: number;
  bondSharePercent: number;
  positionKey: string;
  quantityToBuy: number;
}) {
  const total = input.summary?.totalAmountPortfolio ?? { value: null, currency: input.analytics.bond.value.currency || "rub" };
  const currency = total.currency || input.analytics.bond.value.currency || "rub";
  const amountToInvest = Math.max(0, input.amountToInvest);
  const bondShare = clamp(input.bondSharePercent, 0, 100) / 100;
  const selectedPosition = input.positions.find((position) => positionKey(position) === input.positionKey);
  const quantityToBuy = Math.max(0, input.quantityToBuy);
  const selectedUnitValue = selectedPosition ? unitCurrentValue(selectedPosition) : null;
  const buyCostValue = selectedUnitValue !== null ? selectedUnitValue * quantityToBuy : 0;
  const buyAnnualCashflowValue = selectedPosition && isBondPosition(selectedPosition)
    ? perUnitValue(selectedPosition.couponIncomeNext12m, selectedPosition.quantity) * quantityToBuy
    : 0;
  const currentAnnualCashflow = input.analytics.passiveIncome.yearlyExpected.value ?? 0;
  const currentBondYield = percentValue(input.analytics.passiveIncome.yearlyExpected.value, input.analytics.bond.value.value) ?? 0;
  const addedBondCashflow = amountToInvest * bondShare * (currentBondYield / 100);
  const newAnnualCashflowValue = currentAnnualCashflow + addedBondCashflow + buyAnnualCashflowValue;
  const newPortfolioValue = {
    value: (total.value ?? 0) + amountToInvest + buyCostValue,
    currency
  };
  const newBondValue = (input.analytics.bond.value.value ?? 0) + amountToInvest * bondShare + (selectedPosition && isBondPosition(selectedPosition) ? buyCostValue : 0);
  const newBondShare = percentValue(newBondValue, newPortfolioValue.value);
  const riskDelta = newBondShare !== null && newBondShare >= 20 && newBondShare <= 75 ? 3 : newBondShare !== null && newBondShare > 90 ? -8 : 0;

  return {
    newPortfolioValue,
    newAnnualCashflow: { value: newAnnualCashflowValue, currency },
    newMonthlyRunRate: { value: newAnnualCashflowValue / 12, currency },
    newBondShare,
    buyCost: { value: buyCostValue || null, currency },
    newRiskScore: clamp(input.analytics.riskModel.score + riskDelta, 0, 100),
    note: selectedPosition
      ? `Сценарий учитывает довнесение и докупку ${selectedPosition.ticker || selectedPosition.name}. Расчет грубый: цены и купонная доходность берутся из текущего среза.`
      : "Сценарий считает довнесение по текущей купонной доходности облигационной части. Это быстрый what-if, не торговая рекомендация."
  };
}

function buildHealthScore(input: {
  largestShare: number;
  negativeCount: number;
  zeroCount: number;
  blockedCount: number;
  missingPrices: number;
  bondsWithoutCoupons: number;
  foreignCount: number;
  positionsCount: number;
}) {
  const concentrationPenalty = input.largestShare > 35 ? 22 : input.largestShare > 25 ? 12 : input.largestShare > 18 ? 6 : 0;
  const negativePenalty = Math.min(20, input.negativeCount * 3);
  const qualityPenalty = Math.min(20, (input.zeroCount + input.missingPrices + input.bondsWithoutCoupons) * 5);
  const blockedPenalty = input.blockedCount > 0 ? 18 : 0;
  const foreignPenalty = input.foreignCount > Math.max(2, input.positionsCount / 3) ? 8 : 0;
  const score = Math.max(0, Math.round(100 - concentrationPenalty - negativePenalty - qualityPenalty - blockedPenalty - foreignPenalty));
  const tone = score >= 82 ? "good" as const : score >= 62 ? "warn" as const : "bad" as const;

  return {
    score,
    tone,
    label: score >= 82 ? "Система спокойна" : score >= 62 ? "Есть что проверить" : "Нужен взгляд"
  };
}

function buildStructureHints(input: {
  diversification: ReturnType<typeof buildDiversification>;
  largestPosition?: PositionRow;
  largestShare: number;
  topFiveShare: number;
  cashLikeShare: number | null;
  bondsShare: number | null;
  couponsNext12m: MoneyAmount;
}) {
  const hints: Array<{ title: string; detail: string; level: "ok" | "warn" | "bad" }> = [];

  if (input.largestPosition && input.largestShare > 25) {
    hints.push({
      title: "Одна позиция доминирует",
      detail: `${input.largestPosition.ticker || input.largestPosition.name}: ${formatPercent(input.largestShare)}`,
      level: input.largestShare > 35 ? "bad" : "warn"
    });
  }

  if (input.topFiveShare > 70) {
    hints.push({
      title: "Топ-5 очень тяжелые",
      detail: `На пять крупнейших позиций приходится ${formatPercent(input.topFiveShare)}`,
      level: "warn"
    });
  }

  if (input.diversification.effectivePositions < 5 && input.diversification.effectivePositions > 0) {
    hints.push({
      title: "Узкая диверсификация",
      detail: `Эффективно портфель похож на ${input.diversification.effectivePositions.toFixed(1)} позиций`,
      level: "warn"
    });
  }

  if ((input.cashLikeShare ?? 0) < 2) {
    hints.push({
      title: "Мало валютной подушки",
      detail: `Валюта/кэш: ${formatPercent(input.cashLikeShare)}`,
      level: "ok"
    });
  }

  if ((input.bondsShare ?? 0) > 0 && (input.couponsNext12m.value ?? 0) <= 0) {
    hints.push({
      title: "Облигации без выплат",
      detail: "Доля облигаций есть, но купоны на 12 месяцев не видны",
      level: "warn"
    });
  }

  return hints.slice(0, 5);
}

function buildPulse(input: {
  expectedYield: MoneyAmount;
  expectedYieldPercent: number | null;
  health: { score: number; tone: "good" | "warn" | "bad"; label: string };
  nextEvent?: MoneyEvent;
  cashflow90d: MoneyAmount;
}) {
  const result = `${formatMoney(input.expectedYield)} (${formatPercent(input.expectedYieldPercent)})`;
  const event = input.nextEvent
    ? `${eventKindLabel(input.nextEvent.kind)} ${formatDate(input.nextEvent.date)}`
    : "событий нет";
  const cashflow = input.cashflow90d.value ? `купоны 90д ${formatMoney(input.cashflow90d)}` : "купоны 90д —";

  return `${input.health.label}; результат ${result}; ${cashflow}; след. ${event}`;
}

function buildAttentionQueue(input: {
  largestPosition?: PositionRow;
  largestShare: number;
  worstPosition?: PositionRow;
  negativeCount: number;
  zeroCount: number;
  blockedCount: number;
  missingPrices: number;
  bondsWithoutCoupons: number;
  nextEvent?: MoneyEvent;
  health: { score: number; tone: "good" | "warn" | "bad"; label: string };
}) {
  const items: Array<{ title: string; detail: string; level: "ok" | "warn" | "bad" }> = [];

  if (input.health.tone !== "good") {
    items.push({
      title: `Здоровье ${input.health.score}/100`,
      detail: input.health.label,
      level: input.health.tone === "bad" ? "bad" : "warn"
    });
  }

  if (input.largestPosition && input.largestShare > 20) {
    items.push({
      title: "Концентрация",
      detail: `${input.largestPosition.ticker || input.largestPosition.name}: ${formatPercent(input.largestShare)}`,
      level: input.largestShare > 35 ? "bad" : "warn"
    });
  }

  if (input.worstPosition && (input.worstPosition.expectedYieldPercent ?? 0) < 0) {
    items.push({
      title: "Главная просадка",
      detail: `${input.worstPosition.ticker || input.worstPosition.name}: ${formatPercent(input.worstPosition.expectedYieldPercent)}`,
      level: (input.worstPosition.expectedYieldPercent ?? 0) < -10 ? "bad" : "warn"
    });
  }

  if (input.blockedCount > 0) {
    items.push({ title: "Заблокировано", detail: `${input.blockedCount} позиций`, level: "bad" });
  }

  if (input.zeroCount + input.missingPrices + input.bondsWithoutCoupons > 0) {
    items.push({
      title: "Качество данных",
      detail: `${input.zeroCount + input.missingPrices + input.bondsWithoutCoupons} вопросов`,
      level: "warn"
    });
  }

  if (input.nextEvent) {
    items.push({
      title: `Ближайшее событие: ${eventKindLabel(input.nextEvent.kind)}`,
      detail: `${formatDate(input.nextEvent.date)} · ${input.nextEvent.title}`,
      level: "ok"
    });
  }

  return items;
}

function buildCouponMonths(coupons: Array<{ date?: string; amount: MoneyAmount }>) {
  const grouped = new Map<string, MoneyAmount[]>();

  for (const coupon of coupons) {
    if (!coupon.date) {
      continue;
    }

    const key = coupon.date.slice(0, 7);
    grouped.set(key, [...(grouped.get(key) ?? []), coupon.amount]);
  }

  const monthly = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 12)
    .map(([key, amounts]) => ({
      key,
      label: formatMonth(key),
      amount: addMoney(amounts),
      percent: null as number | null
    }));
  const maxValue = Math.max(0, ...monthly.map((month) => month.amount.value ?? 0));

  return monthly.map((month) => ({
    ...month,
    percent: percentValue(month.amount.value, maxValue)
  }));
}

function matchesFilters(position: PositionRow, query: string, typeFilter: string, signalFilter: PositionSignal): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  const textMatches = !normalizedQuery || [
    position.name,
    position.ticker,
    position.figi,
    position.uid,
    position.accountName,
    position.typeLabel
  ].some((value) => value?.toLowerCase().includes(normalizedQuery));

  if (!textMatches) {
    return false;
  }

  if (typeFilter !== ALL_TYPES && position.typeLabel !== typeFilter) {
    return false;
  }

  if (signalFilter === "negative") {
    return (position.expectedYield.value ?? 0) < 0;
  }

  if (signalFilter === "positive") {
    return (position.expectedYield.value ?? 0) > 0;
  }

  if (signalFilter === "blocked") {
    return position.blocked;
  }

  if (signalFilter === "zero") {
    return (position.currentValue.value ?? 0) === 0;
  }

  if (signalFilter === "foreign") {
    return normalizeCurrency(position.currentValue.currency) !== "RUB";
  }

  return true;
}

function sortPositions(positions: PositionRow[], sortState: SortState): PositionRow[] {
  const direction = sortState.direction === "desc" ? -1 : 1;

  return [...positions].sort((left, right) => {
    const result = compareSortValue(sortValue(left, sortState.key), sortValue(right, sortState.key));
    return result * direction;
  });
}

function sortValue(position: PositionRow, key: SortKey): string | number | null {
  if (key === "name") {
    return position.name;
  }

  if (key === "type") {
    return position.typeLabel;
  }

  if (key === "account") {
    return position.accountName;
  }

  if (key === "quantity") {
    return position.quantity;
  }

  if (key === "share") {
    return position.portfolioSharePercent;
  }

  if (key === "yield") {
    return position.expectedYield.value;
  }

  if (key === "yieldPercent") {
    return position.expectedYieldPercent;
  }

  return position.currentValue.value;
}

function compareSortValue(left: string | number | null, right: string | number | null): number {
  if (typeof left === "string" || typeof right === "string") {
    return String(left ?? "").localeCompare(String(right ?? ""), "ru");
  }

  return compareNullableNumbers(left, right);
}

function compareNullableNumbers(left: number | null, right: number | null): number {
  const leftValue = left ?? Number.NEGATIVE_INFINITY;
  const rightValue = right ?? Number.NEGATIVE_INFINITY;
  return leftValue - rightValue;
}

function compareMoneyValue(left: PositionRow, right: PositionRow): number {
  return (left.currentValue.value ?? 0) - (right.currentValue.value ?? 0);
}

function normalizePositionType(typeLabel: string): string {
  const normalized = typeLabel.toLowerCase();

  if (normalized.includes("валют")) {
    return "currency";
  }

  if (normalized.includes("облига")) {
    return "bond";
  }

  if (normalized.includes("акци")) {
    return "share";
  }

  if (normalized.includes("фонд")) {
    return "etf";
  }

  return normalized;
}

function exportPositionsToCsv(positions: PositionRow[]) {
  const headers = [
    "счет",
    "тип",
    "название",
    "тикер",
    "figi",
    "количество",
    "средняя_цена",
    "текущая_цена",
    "стоимость",
    "валюта",
    "доход",
    "доход_процент",
    "заблокировано"
  ];
  const rows = positions.map((position) => [
    position.accountName,
    position.typeLabel,
    position.name,
    position.ticker || "",
    position.figi || "",
    position.quantity ?? "",
    position.averagePrice.value ?? "",
    position.currentPrice.value ?? "",
    position.currentValue.value ?? "",
    position.currentValue.currency || "",
    position.expectedYield.value ?? "",
    position.expectedYieldPercent ?? "",
    position.blocked ? "да" : "нет"
  ]);
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = `t-invest-positions-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function csvCell(value: string | number): string {
  const text = String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function resolveSelectedAccountId(current: string, accounts: AccountDashboardItem[]): string {
  if (current === ALL_ACCOUNTS) {
    return current;
  }

  return accounts.some((item) => item.account.id === current) ? current : ALL_ACCOUNTS;
}

function buildSessionTrend(snapshots: PortfolioSnapshot[]) {
  const normalized = snapshots
    .filter((snapshot) => typeof snapshot.value === "number" && Number.isFinite(snapshot.value))
    .slice(-48);
  const first = normalized[0];
  const previous = normalized[normalized.length - 2];
  const last = normalized[normalized.length - 1];
  const currency = last?.currency || first?.currency || "rub";
  const currentValue = last?.value ?? null;
  const deltaFromStart = currentValue !== null && typeof first?.value === "number"
    ? currentValue - first.value
    : null;
  const deltaFromPrevious = currentValue !== null && typeof previous?.value === "number"
    ? currentValue - previous.value
    : null;
  const values = normalized.map((snapshot) => snapshot.value as number);
  const highValue = values.length > 0 ? Math.max(...values) : null;
  const lowValue = values.length > 0 ? Math.min(...values) : null;
  const drawdown = currentValue !== null && highValue !== null ? currentValue - highValue : null;

  return {
    current: { value: currentValue, currency },
    deltaFromStart: { value: deltaFromStart, currency },
    deltaFromPrevious: { value: deltaFromPrevious, currency },
    deltaFromStartPercent: percentValue(deltaFromStart, first?.value ?? null),
    high: { value: highValue, currency },
    low: { value: lowValue, currency },
    drawdown: { value: drawdown, currency },
    drawdownPercent: percentValue(drawdown, highValue),
    points: values,
    lastFetchedAt: last?.fetchedAt || new Date().toISOString()
  };
}

function buildApiStatus(input: {
  now: number;
  lastSuccessAt: number | null;
  apiLatencyMs: number | null;
  isRefreshing: boolean;
  hasError: boolean;
}) {
  const ageMs = input.lastSuccessAt ? input.now - input.lastSuccessAt : null;
  const stale = ageMs !== null ? ageMs > POLLING_INTERVAL_MS * 4 : input.hasError;
  const tone = input.hasError || stale ? "bad" as const : input.isRefreshing ? "warn" as const : "good" as const;
  const label = input.hasError ? "Ошибка API" : stale ? "Данные устарели" : input.isRefreshing ? "Обновление" : "В эфире";

  return {
    tone,
    label,
    stale,
    isRefreshing: input.isRefreshing,
    latencyLabel: input.apiLatencyMs === null ? "ответ —" : `ответ ${input.apiLatencyMs} мс`,
    ageLabel: ageMs === null ? "нет успешного ответа" : `${Math.max(0, Math.round(ageMs / 1000))} сек назад`,
    lastSuccessLabel: input.lastSuccessAt ? formatTime(new Date(input.lastSuccessAt).toISOString()) : dash()
  };
}

function buildAccountPerformance(dashboard: DashboardPayload | null) {
  if (!dashboard) {
    return [];
  }

  return dashboard.accounts
    .filter((item) => (item.summary.totalAmountPortfolio.value ?? 0) > 0)
    .map((item) => ({
      id: item.account.id,
      name: item.account.name,
      value: item.summary.totalAmountPortfolio,
      expectedYield: item.summary.expectedYield,
      expectedYieldPercent: item.summary.expectedYieldPercent
    }))
    .sort((left, right) => (right.expectedYieldPercent ?? Number.NEGATIVE_INFINITY) - (left.expectedYieldPercent ?? Number.NEGATIVE_INFINITY));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Неизвестная ошибка приложения.";
}

function getInitialAccountId(): string {
  const accountId = new URLSearchParams(window.location.search).get("accountId");
  return accountId && accountId !== ALL_ACCOUNTS ? accountId : ALL_ACCOUNTS;
}

function getInitialTheme(): Theme {
  return window.localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
}

function getInitialKioskMode(): boolean {
  const mode = new URLSearchParams(window.location.search).get("mode");
  return mode === "monitor" || window.localStorage.getItem(KIOSK_STORAGE_KEY) === "true";
}

function getInitialAutoRotate(): boolean {
  const auto = new URLSearchParams(window.location.search).get("auto");
  return auto === "1" || window.localStorage.getItem(AUTO_ROTATE_STORAGE_KEY) === "true";
}

function getInitialSnapshots(): PortfolioSnapshot[] {
  const raw = window.localStorage.getItem(SNAPSHOT_STORAGE_KEY);

  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as PortfolioSnapshot[];
    return Array.isArray(parsed) ? parsed.slice(-MAX_SNAPSHOTS) : [];
  } catch {
    return [];
  }
}

function getInitialStoredNumber(key: string, fallback: number): number {
  const raw = window.localStorage.getItem(key);
  const parsed = raw === null ? Number.NaN : Number(raw);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function buildRotationTargets(dashboard: DashboardPayload | null): Array<{ id: string; label: string }> {
  if (!dashboard) {
    return [{ id: ALL_ACCOUNTS, label: "Все счета" }];
  }

  return [
    { id: ALL_ACCOUNTS, label: "Все счета" },
    ...dashboard.accounts
      .filter((item) => (item.summary.totalAmountPortfolio.value ?? 0) > 0)
      .map((item) => ({ id: item.account.id, label: item.account.name }))
  ];
}

function getNextRotationLabel(targets: Array<{ id: string; label: string }>, currentId: string): string {
  const currentIndex = Math.max(0, targets.findIndex((target) => target.id === currentId));
  return targets[(currentIndex + 1) % targets.length]?.label ?? "Все счета";
}

function syncAccountIdToUrl(accountId: string): void {
  const url = new URL(window.location.href);

  if (accountId === ALL_ACCOUNTS) {
    url.searchParams.delete("accountId");
  } else {
    url.searchParams.set("accountId", accountId);
  }

  window.history.replaceState(null, "", url);
}

function shortAccountId(accountId: string): string {
  return accountId.length > 8 ? `${accountId.slice(0, 4)}...${accountId.slice(-4)}` : accountId;
}

function formatMoney(amount?: MoneyAmount | null): string {
  if (!amount || amount.value === null) {
    return dash();
  }

  const currency = normalizeCurrency(amount.currency);

  try {
    return new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency,
      maximumFractionDigits: 2
    }).format(amount.value);
  } catch {
    return `${formatNumber(amount.value)} ${amount.currency || ""}`.trim();
  }
}

function normalizeCurrency(currency?: string): string {
  if (!currency) {
    return "RUB";
  }

  return currency.toUpperCase() === "RUB" ? "RUB" : currency.toUpperCase();
}

function formatNumber(value?: number | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return dash();
  }

  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 4
  }).format(value);
}

function formatCount(value?: number | null): string {
  return value === undefined || value === null ? dash() : String(value);
}

function formatPercent(value?: number | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return dash();
  }

  return `${new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 2
  }).format(value)}%`;
}

function formatDate(value?: string): string {
  if (!value) {
    return dash();
  }

  return new Intl.DateTimeFormat("ru-RU").format(new Date(value));
}

function formatMonth(value: string): string {
  const [year, month] = value.split("-");
  const date = new Date(Number(year), Number(month) - 1, 1);

  return new Intl.DateTimeFormat("ru-RU", {
    month: "short"
  }).format(date);
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function formatClock(value: number): string {
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}ч ${minutes}м`;
  }

  return `${minutes}м`;
}

function eventKindLabel(kind: MoneyEventKind): string {
  const labels: Record<MoneyEventKind, string> = {
    coupon: "купон",
    maturity: "погашение",
    amortization: "амортизация",
    dividend: "дивиденд"
  };

  return labels[kind];
}

function readInputNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function amountClass(value?: number | null): string {
  if (value === undefined || value === null || value === 0) {
    return "";
  }

  return value > 0 ? "positive" : "negative";
}

function percentValue(part: number | null, base: number | null): number | null {
  if (part === null || base === null || base === 0) {
    return null;
  }

  const result = (part / Math.abs(base)) * 100;
  return Number.isFinite(result) ? result : null;
}

function subtractMoney(left: MoneyAmount, right: MoneyAmount): MoneyAmount {
  const currency = left.currency || right.currency;

  if (left.value === null || right.value === null) {
    return { value: null, currency };
  }

  return { value: left.value - right.value, currency };
}

function estimateMaturityAmount(bond: PositionRow): MoneyAmount {
  const nominalTotal = multiplyMoneyAmount(bond.nominal, bond.quantity);
  return nominalTotal.value !== null ? nominalTotal : bond.currentValue;
}

function multiplyMoneyAmount(amount: MoneyAmount, multiplier: number | null): MoneyAmount {
  if (amount.value === null || multiplier === null || !Number.isFinite(multiplier)) {
    return { value: null, currency: amount.currency };
  }

  return {
    value: amount.value * multiplier,
    currency: amount.currency
  };
}

function unitCurrentValue(position: PositionRow): number | null {
  if (position.quantity && position.quantity > 0 && position.currentValue.value !== null) {
    return position.currentValue.value / position.quantity;
  }

  return position.currentPrice.value;
}

function perUnitValue(amount: MoneyAmount, quantity: number | null): number {
  if (amount.value === null || !quantity || quantity <= 0) {
    return 0;
  }

  return amount.value / quantity;
}

function positionKey(position: PositionRow): string {
  return `${position.accountId}:${position.uid || position.figi || position.ticker || position.name}`;
}

function concentrationPenalty(value: number, warnAt: number, badAt: number): number {
  if (value <= warnAt) {
    return 0;
  }

  if (value >= badAt) {
    return 18;
  }

  return ((value - warnAt) / (badAt - warnAt)) * 18;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isBondPosition(position: PositionRow): boolean {
  return position.typeLabel.toLowerCase().includes("облига");
}

function isWithinDays(value: string | undefined, days: number): boolean {
  if (!value) {
    return false;
  }

  const now = Date.now();
  const time = new Date(value).getTime();

  return time >= now && time <= now + days * 24 * 60 * 60 * 1000;
}

function isFutureDate(value?: string): boolean {
  if (!value) {
    return false;
  }

  return new Date(value).getTime() >= Date.now();
}

function heatSpan(value?: number | null): number {
  const share = value ?? 0;

  if (share >= 24) {
    return 3;
  }

  if (share >= 10) {
    return 2;
  }

  return 1;
}

function heatTone(position: PositionRow): string {
  const value = position.expectedYieldPercent ?? position.expectedYield.value ?? 0;

  if (value > 0) {
    return "good";
  }

  if (value < 0) {
    return "bad";
  }

  return "flat";
}

function dateTime(value?: string): number {
  return value ? new Date(value).getTime() : Number.MAX_SAFE_INTEGER;
}

function chartColor(index: number): string {
  const colors = ["#2f6f73", "#c05850", "#6c6f2f", "#8b5d9a", "#2f5f9f", "#9a6a2f"];
  return colors[index % colors.length];
}

function dash(): string {
  return "—";
}

function buildScreenStatus(isKioskMode: boolean, isAutoRotate: boolean, isFullscreen: boolean, isWakeLockActive: boolean): string {
  return [
    isKioskMode ? "K экран" : "K экран",
    isAutoRotate ? "A авто вкл" : "A авто выкл",
    isFullscreen ? "F весь экран" : "F окно",
    isWakeLockActive ? "W не гаснет" : "W сон"
  ].join(" · ");
}

export default App;
