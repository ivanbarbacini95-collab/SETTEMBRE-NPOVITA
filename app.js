'use strict';

const $ = (id) => document.getElementById(id);
const INJ_DECIMALS = 1e18;
const OFFICIAL_APR_ENDPOINT = 'https://api.ui.injective.network/api/v1/cache/stats/apr';
const EXPLORER_API_ENDPOINTS = [
  'https://sentry.exchange.grpc-web.injective.network/api/explorer/v1'
];
const LCD_ENDPOINTS = [
  'https://sentry.lcd.injective.network:443',
  'https://lcd.injective.network',
  'https://1rpc.io/inj-lcd'
];

const state = {
  address: '',
  price: 0,
  change: 0,
  changeAmount: 0,
  low: 0,
  high: 0,
  available: 0,
  staked: 0,
  rewards: 0,
  networkApr: 0,
  personalApr: 0,
  weightedCommission: 0,
  validators: [],
  wallets: [],
  walletSummaries: {},
  summariesLoading: false,
  summariesLastRefresh: 0,
  movementsByWallet: {},
  portfolioHistory: {},
  targetByWallet: {},
  historyRange: '1M',
  movementFilter: 'all',
  compoundMode: 'daily',
  compoundWeekly: 0,
  loadingAllMovements: false,
  historyLastRecord: 0,
  analyticsLastRender: 0,
  suppressEffects: true,
  currency: 'USD',
  eurRate: 0.86,
  endpoint: '',
  socket: null,
  walletRequest: 0,
  loading: false
};

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fromWei(value) {
  return number(value) / INJ_DECIMALS;
}

function rate(value) {
  const parsed = number(value);
  return parsed > 1 ? parsed / INJ_DECIMALS : parsed;
}

function validAddress(value) {
  return /^inj1[0-9a-z]{38,60}$/i.test(String(value || '').trim());
}

function formatInj(value, digits = 6) {
  return `${number(value).toLocaleString('it-IT', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })} INJ`;
}

function currencyValue(value) {
  return state.currency === 'EUR' ? number(value) * state.eurRate : number(value);
}

function money(value, digits = 2) {
  return new Intl.NumberFormat(state.currency === 'EUR' ? 'it-IT' : 'en-US', {
    style: 'currency',
    currency: state.currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(currencyValue(value));
}

function signedMoney(value, digits = 4) {
  const formatted = money(Math.abs(value), digits);
  return `${value >= 0 ? '+' : '−'}${formatted}`;
}

function usdt(value, digits = 4) {
  return `${value < 0 ? '−' : value > 0 ? '+' : ''}${Math.abs(number(value)).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })} USDT`;
}

function shortAddress(value) {
  const text = String(value || '');
  return text.length > 18 ? `${text.slice(0, 10)}…${text.slice(-6)}` : text;
}

function loadSavedWallets() {
  let rows = [];
  try { rows = JSON.parse(localStorage.getItem('inj_monitor_wallets_v1') || '[]'); } catch (_) {}
  state.wallets = Array.isArray(rows) ? rows.map((item, index) => ({
    address: String(item?.address || '').trim().toLowerCase(),
    label: String(item?.label || `Wallet ${index + 1}`).trim().slice(0, 28)
  })).filter((item, index, all) => validAddress(item.address) && all.findIndex((row) => row.address === item.address) === index) : [];

  const legacy = localStorage.getItem('inj_monitor_address') || '';
  if (validAddress(legacy) && !state.wallets.some((item) => item.address === legacy)) {
    state.wallets.push({ address: legacy, label: `Wallet ${state.wallets.length + 1}` });
  }
  try {
    const cached = JSON.parse(localStorage.getItem('inj_monitor_summaries_v1') || '{}');
    state.walletSummaries = cached && typeof cached === 'object' ? cached : {};
  } catch (_) { state.walletSummaries = {}; }
  saveWallets();
}

function saveWallets() {
  localStorage.setItem('inj_monitor_wallets_v1', JSON.stringify(state.wallets));
}

function saveWalletSummaries() {
  localStorage.setItem('inj_monitor_summaries_v1', JSON.stringify(state.walletSummaries));
}

function loadAnalyticsStorage() {
  try {
    const history = JSON.parse(localStorage.getItem('inj_monitor_portfolio_history_v1') || '{}');
    state.portfolioHistory = history && typeof history === 'object' ? history : {};
  } catch (_) { state.portfolioHistory = {}; }
  try {
    const targets = JSON.parse(localStorage.getItem('inj_monitor_targets_v1') || '{}');
    state.targetByWallet = targets && typeof targets === 'object' ? targets : {};
  } catch (_) { state.targetByWallet = {}; }
  state.historyRange = ['24H', '7G', '1M', '3M', '1A', 'ALL'].includes(localStorage.getItem('inj_monitor_history_range'))
    ? localStorage.getItem('inj_monitor_history_range') : '1M';
  state.compoundMode = localStorage.getItem('inj_monitor_compound_mode') === 'none' ? 'none' : 'daily';
  state.compoundWeekly = Math.max(0, number(localStorage.getItem('inj_monitor_compound_weekly')));
}

function savePortfolioHistory() {
  try { localStorage.setItem('inj_monitor_portfolio_history_v1', JSON.stringify(state.portfolioHistory)); } catch (_) {}
}

function saveTargets() {
  try { localStorage.setItem('inj_monitor_targets_v1', JSON.stringify(state.targetByWallet)); } catch (_) {}
}

function ensureSavedWallet(address) {
  let wallet = state.wallets.find((item) => item.address === address);
  if (!wallet) {
    wallet = { address, label: `Wallet ${state.wallets.length + 1}` };
    state.wallets.push(wallet);
    saveWallets();
  }
  localStorage.setItem('inj_monitor_address', address);
  return wallet;
}

function setSearchOpen(open) {
  if (open) setThemePickerOpen(false);
  $('headerSearch').classList.toggle('open', open);
  $('searchButton').setAttribute('aria-expanded', open ? 'true' : 'false');
  $('searchButton').setAttribute('aria-label', open ? 'Chiudi ricerca wallet' : 'Apri ricerca wallet');
  if (open) {
    $('addressInput').value = state.address || '';
    requestAnimationFrame(() => $('addressInput').focus());
  }
}

function renderWalletControls() {
  const chips = $('walletChips');
  chips.replaceChildren();
  $('savedWalletCount').textContent = `${state.wallets.length} salvat${state.wallets.length === 1 ? 'o' : 'i'}`;

  if (!state.wallets.length) {
    const empty = document.createElement('span');
    empty.className = 'wallet-empty';
    empty.textContent = 'Usa la lente per aggiungere un indirizzo';
    chips.appendChild(empty);
  } else {
    state.wallets.forEach((wallet) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `wallet-chip ${wallet.address === state.address ? 'active' : ''}`.trim();
      button.title = `${wallet.label} · ${wallet.address}`;
      const dot = document.createElement('i');
      const address = document.createElement('b');
      address.textContent = shortAddress(wallet.address);
      button.append(dot, address);
      button.addEventListener('click', () => loadWallet(true, wallet.address));
      chips.appendChild(button);
    });
  }
  renderWalletManager();
  renderAggregate();
}

function renderWalletManager() {
  const host = $('walletManagerList');
  host.replaceChildren();
  if (!state.wallets.length) {
    const empty = document.createElement('div');
    empty.className = 'wallet-manager-empty';
    empty.textContent = 'Non ci sono ancora indirizzi salvati.';
    host.appendChild(empty);
    return;
  }

  state.wallets.forEach((wallet) => {
    const row = document.createElement('div');
    row.className = 'wallet-manager-row';
    const copy = document.createElement('div');
    copy.className = 'wallet-manager-copy';
    const input = document.createElement('input');
    input.value = wallet.label;
    input.maxLength = 28;
    input.setAttribute('aria-label', `Nome per ${shortAddress(wallet.address)}`);
    const address = document.createElement('small');
    address.textContent = wallet.address;
    input.addEventListener('change', () => {
      wallet.label = input.value.trim() || wallet.label;
      input.value = wallet.label;
      saveWallets();
      renderWalletControls();
    });
    copy.append(input, address);

    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = wallet.address === state.address ? 'Attivo' : 'Apri';
    open.disabled = wallet.address === state.address;
    open.addEventListener('click', () => {
      $('walletDialog').close();
      loadWallet(true, wallet.address);
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.textContent = 'Rimuovi';
    remove.addEventListener('click', () => removeWallet(wallet.address));
    row.append(copy, open, remove);
    host.appendChild(row);
  });
}

function removeWallet(address) {
  const wallet = state.wallets.find((item) => item.address === address);
  if (!wallet || !window.confirm(`Rimuovere “${wallet.label}” dai wallet salvati?`)) return;
  const wasActive = state.address === address;
  state.wallets = state.wallets.filter((item) => item.address !== address);
  delete state.walletSummaries[address];
  delete state.movementsByWallet[address];
  saveWallets();
  saveWalletSummaries();
  if (wasActive) {
    const next = state.wallets[0];
    if (next) loadWallet(false, next.address);
    else resetWallet();
  }
  renderWalletControls();
}

function resetWallet() {
  state.address = '';
  state.available = 0;
  state.staked = 0;
  state.rewards = 0;
  state.networkApr = 0;
  state.personalApr = 0;
  state.weightedCommission = 0;
  state.validators = [];
  $('addressInput').value = '';
  $('lastUpdate').textContent = '—';
  localStorage.removeItem('inj_monitor_address');
  renderAll();
  renderWalletControls();
}

function aprPercent(value) {
  const parsed = number(value);
  if (!(parsed > 0)) return 0;
  return parsed <= 1 ? parsed * 100 : parsed;
}

function setStatus(mode, message) {
  const host = $('connectionStatus');
  host.className = `connection ${mode || ''}`.trim();
  $('statusText').textContent = message;
}

function toast(message) {
  const host = $('toast');
  host.textContent = message;
  host.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => host.classList.remove('show'), 2200);
}

function signalChange(element, previous, next) {
  const tolerance = Math.max(1e-12, Math.abs(previous) * 1e-10);
  if (!Number.isFinite(previous) || !Number.isFinite(next) || Math.abs(next - previous) <= tolerance) return;
  const direction = next > previous ? 'up' : 'down';
  const card = element.closest('.data-card');
  const now = Date.now();

  element.classList.remove('value-change-up', 'value-change-down');
  void element.offsetWidth;
  element.classList.add(`value-change-${direction}`);

  if (card && now - number(card.dataset.lastFlash) > 420) {
    card.dataset.lastFlash = String(now);
    card.classList.remove('data-flash-up', 'data-flash-down');
    void card.offsetWidth;
    card.classList.add(`data-flash-${direction}`);
    clearTimeout(card._flashTimer);
    card._flashTimer = setTimeout(() => {
      card.classList.remove('data-flash-up', 'data-flash-down');
    }, 1400);
  }
}

function setValue(id, text, numericValue, { flash = true } = {}) {
  const element = $(id);
  if (!element) return;
  const next = Number(numericValue);
  const previous = element.dataset.numericValue === undefined ? NaN : Number(element.dataset.numericValue);
  element.textContent = String(text);
  if (Number.isFinite(next)) {
    if (flash && !state.suppressEffects) signalChange(element, previous, next);
    element.dataset.numericValue = String(next);
  }
}

async function fetchJson(url, timeout = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function lcd(path) {
  let lastError;
  for (const base of LCD_ENDPOINTS) {
    try {
      const data = await fetchJson(base + path);
      state.endpoint = base;
      $('endpointLabel').textContent = `API · ${new URL(base).hostname}`;
      return data;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Rete Injective non disponibile');
}

async function explorerJson(path, timeout = 10000) {
  let lastError;
  for (const base of EXPLORER_API_ENDPOINTS) {
    try {
      const data = await fetchJson(base + path, timeout);
      if (data?.s === 'error') throw new Error(data?.errmsg || 'Explorer Indexer error');
      return data;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Explorer Indexer Injective non disponibile');
}

function findInj(coins = []) {
  const coin = coins.find((item) => item?.denom === 'inj');
  return coin ? fromWei(coin.amount) : 0;
}

function delegationRows(data) {
  return (data?.delegation_responses || []).map((row) => ({
    operator: row?.delegation?.validator_address || '',
    amount: fromWei(row?.balance?.amount)
  })).filter((row) => row.operator && row.amount > 0);
}

function rewardTotal(data) {
  return (data?.total || [])
    .filter((coin) => coin?.denom === 'inj')
    .reduce((sum, coin) => sum + fromWei(coin.amount), 0);
}

async function loadWalletSummary(address) {
  const [bank, delegations, rewards] = await Promise.all([
    lcd(`/cosmos/bank/v1beta1/balances/${address}`),
    lcd(`/cosmos/staking/v1beta1/delegations/${address}`),
    lcd(`/cosmos/distribution/v1beta1/delegators/${address}/rewards`)
  ]);
  const available = findInj(bank?.balances || []);
  const staked = delegationRows(delegations).reduce((sum, item) => sum + item.amount, 0);
  const reward = rewardTotal(rewards);
  return { available, staked, rewards: reward, total: available + staked + reward, updated: Date.now() };
}

async function refreshWalletSummaries(force = false) {
  if (state.summariesLoading || !state.wallets.length) return;
  if (!force && Date.now() - state.summariesLastRefresh < 60_000) return;
  state.summariesLoading = true;
  state.summariesLastRefresh = Date.now();
  renderAggregate();
  let cursor = 0;
  const addresses = state.wallets.map((item) => item.address);
  const worker = async () => {
    while (cursor < addresses.length) {
      const address = addresses[cursor++];
      try {
        state.walletSummaries[address] = await loadWalletSummary(address);
        saveWalletSummaries();
        renderAggregate();
      } catch (_) {}
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, addresses.length) }, worker));
  state.summariesLoading = false;
  renderAggregate();
}

function renderAggregate() {
  const section = $('aggregateSection');
  const enabled = state.wallets.length > 1;
  section.hidden = !enabled;
  if (!enabled) return;
  const rows = state.wallets.map((wallet) => state.walletSummaries[wallet.address]).filter(Boolean);
  const total = rows.reduce((acc, row) => ({
    available: acc.available + number(row.available),
    staked: acc.staked + number(row.staked),
    rewards: acc.rewards + number(row.rewards),
    total: acc.total + number(row.total)
  }), { available: 0, staked: 0, rewards: 0, total: 0 });
  setValue('aggregateNetWorth', rows.length ? money(total.total * state.price) : '—', total.total * state.price, { flash: false });
  setValue('aggregateTotalInj', rows.length ? formatInj(total.total, 3) : '—', total.total, { flash: false });
  setValue('aggregateStaked', rows.length ? formatInj(total.staked, 3) : '—', total.staked, { flash: false });
  setValue('aggregateRewards', rows.length ? formatInj(total.rewards, 4) : '—', total.rewards, { flash: false });
  $('aggregateStatus').textContent = state.summariesLoading
    ? `${rows.length}/${state.wallets.length} sincronizzati`
    : `${state.wallets.length} wallet aggiornati`;
}

function validatorActive(validator) {
  return Boolean(validator && !validator.jailed && (!validator.status || validator.status === 'BOND_STATUS_BONDED'));
}

function validatorNetApr(validator) {
  return validatorActive(validator)
    ? state.networkApr * Math.max(0, 1 - number(validator.commission))
    : 0;
}

function calculatePersonalApr() {
  const delegated = state.validators.reduce((sum, item) => sum + item.amount, 0);
  state.weightedCommission = delegated > 0
    ? state.validators.reduce((sum, item) => sum + item.amount * item.commission, 0) / delegated
    : 0;

  const annualNetInj = state.validators.reduce((sum, item) => {
    return sum + item.amount * (validatorNetApr(item) / 100);
  }, 0);

  state.personalApr = state.staked > 0 ? (annualNetInj / state.staked) * 100 : 0;
}

async function loadEurRate() {
  try {
    const cached = number(localStorage.getItem('inj_monitor_eur_rate'));
    if (cached > 0) state.eurRate = cached;
    const data = await fetchJson('https://api.frankfurter.app/latest?from=USD&to=EUR', 6000);
    const current = number(data?.rates?.EUR);
    if (current > 0) {
      state.eurRate = current;
      localStorage.setItem('inj_monitor_eur_rate', String(current));
      renderAll();
    }
  } catch (_) {}
}

function updateMarket(next) {
  if (number(next.price) > 0) state.price = number(next.price);
  if (Number.isFinite(Number(next.change))) state.change = Number(next.change);
  if (Number.isFinite(Number(next.changeAmount))) state.changeAmount = Number(next.changeAmount);
  if (number(next.low) > 0) state.low = number(next.low);
  if (number(next.high) > 0) state.high = number(next.high);
  renderMarket();
  renderPortfolio();
  if (state.address) recordPortfolioSnapshot();
  const now = Date.now();
  if (now - state.analyticsLastRender > 5000) {
    state.analyticsLastRender = now;
    renderPortfolioHistory();
    renderPerformanceAnalytics();
    renderRewardTracker();
    renderStakingPnl();
    renderCompound();
    renderTarget();
  }
  renderAggregate();
}

async function loadMarket() {
  try {
    const ticker = await fetchJson('https://api.binance.com/api/v3/ticker/24hr?symbol=INJUSDT');
    updateMarket({
      price: ticker.lastPrice,
      change: ticker.priceChangePercent,
      changeAmount: ticker.priceChange,
      low: ticker.lowPrice,
      high: ticker.highPrice
    });
    setStatus('online', state.address ? 'Wallet online' : 'Mercato live');
  } catch (primaryError) {
    try {
      const data = await fetchJson('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=injective-protocol&sparkline=false');
      const coin = data?.[0];
      updateMarket({ price: coin?.current_price, change: coin?.price_change_percentage_24h, changeAmount: coin?.price_change_24h, low: coin?.low_24h, high: coin?.high_24h });
      setStatus('online', 'Mercato online');
    } catch (_) {
      setStatus('offline', 'Mercato non disponibile');
    }
  }
}

function connectMarketSocket() {
  try { state.socket?.close(); } catch (_) {}
  try {
    const socket = new WebSocket('wss://stream.binance.com:9443/ws/injusdt@ticker');
    state.socket = socket;
    socket.onopen = () => setStatus('online', state.address ? 'Wallet online' : 'Mercato live');
    socket.onmessage = (event) => {
      try {
        const tick = JSON.parse(event.data);
        updateMarket({ price: tick.c, change: tick.P, changeAmount: tick.p, low: tick.l, high: tick.h });
      } catch (_) {}
    };
    socket.onerror = () => setStatus('', 'Riconnessione…');
    socket.onclose = () => setTimeout(connectMarketSocket, 4000);
  } catch (_) {
    setTimeout(connectMarketSocket, 5000);
  }
}

async function loadValidator(row) {
  try {
    const response = await lcd(`/cosmos/staking/v1beta1/validators/${row.operator}`);
    const validator = response?.validator || {};
    return {
      ...row,
      moniker: validator?.description?.moniker || shortAddress(row.operator),
      commission: Math.max(0, Math.min(1, rate(validator?.commission?.commission_rates?.rate))),
      status: validator?.status || '',
      jailed: Boolean(validator?.jailed)
    };
  } catch (_) {
    return { ...row, moniker: shortAddress(row.operator), commission: 0, status: '', jailed: false };
  }
}

function setLoading(loading) {
  state.loading = loading;
  $('loadButton').disabled = loading;
  $('refreshButton').disabled = loading;
  $('refreshButton').classList.toggle('loading', loading);
  $('loadButton').textContent = loading ? 'Lettura…' : 'Apri';
}

async function loadWallet(showFeedback = true, requestedAddress = '') {
  const address = String(requestedAddress || $('addressInput').value || '').trim().toLowerCase();
  if (!validAddress(address)) {
    toast('Inserisci un indirizzo Injective valido');
    $('addressInput').focus();
    return;
  }

  const switchingWallet = state.address !== address;
  if (switchingWallet) state.suppressEffects = true;
  const requestId = ++state.walletRequest;
  setLoading(true);
  setStatus('', 'Lettura wallet…');

  try {
    const [bank, delegations, rewards, annual, pool, distribution, officialApr] = await Promise.all([
      lcd(`/cosmos/bank/v1beta1/balances/${address}`),
      lcd(`/cosmos/staking/v1beta1/delegations/${address}`),
      lcd(`/cosmos/distribution/v1beta1/delegators/${address}/rewards`),
      lcd('/cosmos/mint/v1beta1/annual_provisions'),
      lcd('/cosmos/staking/v1beta1/pool'),
      lcd('/cosmos/distribution/v1beta1/params').catch(() => null),
      fetchJson(OFFICIAL_APR_ENDPOINT, 7000).catch(() => null)
    ]);
    if (requestId !== state.walletRequest) return;

    const validatorRows = delegationRows(delegations);
    const validators = await Promise.all(validatorRows.map(loadValidator));
    if (requestId !== state.walletRequest) return;

    state.address = address;
    state.available = findInj(bank?.balances || []);
    state.staked = validatorRows.reduce((sum, item) => sum + item.amount, 0);
    state.rewards = rewardTotal(rewards);
    state.validators = validators;
    state.walletSummaries[address] = {
      available: state.available,
      staked: state.staked,
      rewards: state.rewards,
      total: state.available + state.staked + state.rewards,
      updated: Date.now()
    };
    saveWalletSummaries();

    const officialBaseApr = aprPercent(officialApr?.apr);
    const annualProvisions = number(annual?.annual_provisions);
    const bondedTokens = number(pool?.pool?.bonded_tokens);
    const communityTax = rate(distribution?.params?.community_tax);
    const fallbackGrossApr = bondedTokens > 0 ? (annualProvisions / bondedTokens) * 100 : 0;
    const fallbackDelegatorApr = fallbackGrossApr * Math.max(0, 1 - communityTax);
    state.networkApr = officialBaseApr || fallbackDelegatorApr;
    calculatePersonalApr();

    ensureSavedWallet(address);
    $('addressInput').value = address;
    $('lastUpdate').textContent = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setStatus('online', 'Wallet online');
    recordPortfolioSnapshot(true);
    renderAll();
    renderWalletControls();
    setSearchOpen(false);
    state.suppressEffects = false;
    refreshWalletSummaries(false);
    loadWalletMovements(address, { force: switchingWallet }).catch(() => {});
    if (showFeedback) toast('Dati wallet aggiornati');
  } catch (error) {
    console.error(error);
    setStatus('offline', 'Errore rete Injective');
    if (showFeedback) toast('Impossibile leggere il wallet');
  } finally {
    if (requestId === state.walletRequest) {
      state.suppressEffects = false;
      setLoading(false);
    }
  }
}

function renderMarket() {
  setValue('marketPrice', state.price > 0 ? money(state.price, 4) : '—', state.price || NaN);
  setValue('dayLow', state.low > 0 ? money(state.low, 3) : '—', state.low || NaN, { flash: false });
  setValue('dayHigh', state.high > 0 ? money(state.high, 3) : '—', state.high || NaN, { flash: false });

  const change = $('marketChange');
  const next = Number(state.change);
  change.textContent = state.price > 0 ? `${next > 0 ? '+' : ''}${next.toFixed(2)}%` : '—';
  change.className = `market-change ${next > 0 ? 'positive' : next < 0 ? 'negative' : 'neutral'}`;
  if (state.price > 0) {
    change.dataset.numericValue = String(next);
  }
  const amount = $('marketChangeAmount');
  amount.textContent = state.price > 0 ? usdt(state.changeAmount, 4) : '— USDT';
  amount.className = state.changeAmount > 0 ? 'positive' : state.changeAmount < 0 ? 'negative' : '';
}

function renderPortfolio() {
  const totalInj = state.available + state.staked + state.rewards;
  const netWorth = totalInj * state.price;
  const netWorthChange24h = totalInj * state.changeAmount;
  const dailyInj = state.staked * (state.personalApr / 100) / 365;
  const hourlyInj = dailyInj / 24;
  const weeklyInj = dailyInj * 7;
  const monthlyInj = dailyInj * 30;
  const yearlyInj = dailyInj * 365;
  const stakedShare = totalInj > 0 ? (state.staked / totalInj) * 100 : 0;
  const liquidShare = totalInj > 0 ? ((state.available + state.rewards) / totalInj) * 100 : 0;

  $('walletState').textContent = state.address ? shortAddress(state.address) : 'Wallet non caricato';
  setValue('netWorthUsd', state.address ? money(netWorth) : '—', state.address ? netWorth : NaN, { flash: false });
  setValue('netWorthInj', formatInj(totalInj, 4), totalInj);
  setValue('availableInj', formatInj(state.available), state.available);
  setValue('availableUsd', money(state.available * state.price), state.available * state.price, { flash: false });
  setValue('stakedInj', formatInj(state.staked), state.staked);
  setValue('stakedUsd', money(state.staked * state.price), state.staked * state.price, { flash: false });
  setValue('rewardsInj', formatInj(state.rewards), state.rewards);
  setValue('rewardsUsd', money(state.rewards * state.price), state.rewards * state.price, { flash: false });
  setValue('aprValue', state.personalApr > 0 ? `${state.personalApr.toFixed(3)}%` : '—', state.personalApr || NaN);
  setValue('hourlyEstimate', state.personalApr > 0 ? formatInj(hourlyInj, 8) : '—', state.personalApr > 0 ? hourlyInj : NaN, { flash: false });
  setValue('dailyEstimate', state.personalApr > 0 ? formatInj(dailyInj, 7) : '—', state.personalApr > 0 ? dailyInj : NaN);
  setValue('weeklyEstimate', state.personalApr > 0 ? formatInj(weeklyInj, 6) : '—', state.personalApr > 0 ? weeklyInj : NaN, { flash: false });
  setValue('dailyUsd', state.personalApr > 0 ? money(dailyInj * state.price, 3) : '—', state.personalApr > 0 ? dailyInj * state.price : NaN, { flash: false });
  setValue('monthlyEstimate', state.personalApr > 0 ? formatInj(monthlyInj, 6) : '—', state.personalApr > 0 ? monthlyInj : NaN, { flash: false });
  setValue('monthlyUsd', state.personalApr > 0 ? money(monthlyInj * state.price) : '—', state.personalApr > 0 ? monthlyInj * state.price : NaN, { flash: false });
  setValue('yearlyEstimate', state.personalApr > 0 ? formatInj(yearlyInj, 5) : '—', state.personalApr > 0 ? yearlyInj : NaN, { flash: false });
  setValue('yearlyUsd', state.personalApr > 0 ? money(yearlyInj * state.price) : '—', state.personalApr > 0 ? yearlyInj * state.price : NaN, { flash: false });
  setValue('stakedShare', `${stakedShare.toFixed(1)}%`, stakedShare, { flash: false });
  setValue('liquidShare', `${liquidShare.toFixed(1)}%`, liquidShare, { flash: false });
  const worthChange = $('netWorthChange24h');
  if (state.address && state.price > 0) {
    const label = netWorthChange24h > 0 ? 'Guadagno 24h' : netWorthChange24h < 0 ? 'Perdita 24h' : 'Variazione 24h';
    worthChange.textContent = `${label} ${signedMoney(netWorthChange24h, 2)} (${state.change > 0 ? '+' : ''}${state.change.toFixed(2)}%)`;
    worthChange.className = `worth-change private ${netWorthChange24h > 0 ? 'positive' : netWorthChange24h < 0 ? 'negative' : 'neutral'}`;
  } else {
    worthChange.textContent = 'Variazione 24h —';
    worthChange.className = 'worth-change private neutral';
  }
  $('allocationBar').style.width = `${Math.max(0, Math.min(100, stakedShare))}%`;
  if (state.personalApr > 0) {
    $('aprMethod').textContent = `Stima netta sui ${formatInj(state.staked, 4)} realmente delegati. I validator inattivi o jailed producono 0% nel calcolo; le commissioni sono ponderate per quantità delegata.`;
  } else if (state.address && state.staked <= 0) {
    $('aprMethod').textContent = 'L’APR personale apparirà quando l’indirizzo avrà una delegazione attiva.';
  } else {
    $('aprMethod').textContent = 'La stima usa solo gli INJ effettivamente delegati dall’indirizzo, con commissioni e stato di ciascun validator.';
  }
}


function currentTotalInj() {
  return state.available + state.staked + state.rewards;
}

function recordPortfolioSnapshot(force = false) {
  if (!validAddress(state.address) || !(state.price > 0)) return;
  const now = Date.now();
  if (!force && now - state.historyLastRecord < 60_000) return;
  const totalInj = currentTotalInj();
  if (!(totalInj > 0)) return;
  const sample = {
    t: now,
    i: totalInj,
    s: state.staked,
    r: state.rewards,
    a: state.available,
    p: state.price,
    v: totalInj * state.price
  };
  const rows = Array.isArray(state.portfolioHistory[state.address]) ? state.portfolioHistory[state.address] : [];
  const last = rows[rows.length - 1];
  if (!last || now - number(last.t) >= 60 * 60 * 1000) rows.push(sample);
  else rows[rows.length - 1] = sample;
  const cutoff = now - 730 * 24 * 60 * 60 * 1000;
  state.portfolioHistory[state.address] = rows.filter((row) => number(row.t) >= cutoff).slice(-15000);
  savePortfolioHistory();
  state.historyLastRecord = now;
}

function historyWindowMs(range) {
  return {
    '24H': 24 * 60 * 60 * 1000,
    '7G': 7 * 24 * 60 * 60 * 1000,
    '1M': 30 * 24 * 60 * 60 * 1000,
    '3M': 90 * 24 * 60 * 60 * 1000,
    '1A': 365 * 24 * 60 * 60 * 1000
  }[range] || 0;
}

function historyRowsForActiveWallet() {
  if (!state.address) return [];
  const rows = Array.isArray(state.portfolioHistory[state.address]) ? state.portfolioHistory[state.address] : [];
  const windowMs = historyWindowMs(state.historyRange);
  const cutoff = windowMs ? Date.now() - windowMs : 0;
  return rows.filter((row) => !cutoff || number(row.t) >= cutoff).sort((a, b) => number(a.t) - number(b.t));
}

function svgNode(name, attrs = {}, text = '') {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
  if (text) node.textContent = text;
  return node;
}

function historyAxisMoney(value) {
  const converted = currencyValue(value);
  const locale = state.currency === 'EUR' ? 'it-IT' : 'en-US';
  if (Math.abs(converted) >= 1000) {
    return new Intl.NumberFormat(locale, {
      style: 'currency', currency: state.currency, notation: 'compact',
      minimumFractionDigits: 0, maximumFractionDigits: 1
    }).format(converted);
  }
  return new Intl.NumberFormat(locale, {
    style: 'currency', currency: state.currency,
    minimumFractionDigits: converted < 100 ? 2 : 0,
    maximumFractionDigits: converted < 100 ? 2 : 0
  }).format(converted);
}

function historyAxisInj(value) {
  const v = number(value);
  if (Math.abs(v) >= 1000) {
    return `${new Intl.NumberFormat('it-IT', { notation: 'compact', maximumFractionDigits: 2 }).format(v)} INJ`;
  }
  return `${v.toLocaleString('it-IT', { maximumFractionDigits: v < 10 ? 3 : 2 })} INJ`;
}

function renderPortfolioHistory() {
  const svg = $('portfolioHistoryChart');
  const empty = $('historyEmpty');
  if (!svg || !empty) return;
  document.querySelectorAll('[data-history-range]').forEach((button) => button.classList.toggle('active', button.dataset.historyRange === state.historyRange));
  svg.replaceChildren();
  const rows = historyRowsForActiveWallet();
  const values = rows.map((row) => number(row.v)).filter((value) => value >= 0);
  const current = values.length ? values[values.length - 1] : 0;
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  const change = values.length > 1 && values[0] > 0 ? ((current / values[0]) - 1) * 100 : 0;
  setValue('historyCurrent', values.length ? money(current) : '—', values.length ? current : NaN, { flash: false });
  setValue('historyMin', values.length ? money(min) : '—', values.length ? min : NaN, { flash: false });
  setValue('historyMax', values.length ? money(max) : '—', values.length ? max : NaN, { flash: false });
  const historyChange = $('historyChange');
  historyChange.textContent = values.length > 1 ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` : '—';
  historyChange.className = `private ${change > 0 ? 'positive' : change < 0 ? 'negative' : ''}`.trim();

  if (!state.address || !rows.length) {
    empty.hidden = false;
    empty.textContent = state.address ? 'Primo snapshot in attesa. Aggiorna il wallet per iniziare lo storico.' : 'Carica un wallet per iniziare a registrare il patrimonio.';
    return;
  }

  // Anche con un solo snapshot il grafico resta visibile: niente overlay che lo faccia sembrare bloccato.
  empty.hidden = true;

  const rect = svg.getBoundingClientRect();
  const width = Math.max(320, Math.round(rect.width || 900));
  const height = Math.max(240, Math.round(rect.height || 300));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  // ViewBox e dimensione CSS coincidono: testi e assi non vengono compressi orizzontalmente.
  const compact = width < 620;
  const pad = { left: compact ? 76 : 98, right: compact ? 76 : 98, top: 22, bottom: 38 };

  let yMin = min;
  let yMax = max;
  if (Math.abs(yMax - yMin) < Math.max(0.01, yMax * 0.002)) {
    const margin = Math.max(1, yMax * 0.015);
    yMin = Math.max(0, yMin - margin);
    yMax += margin;
  }
  const injValues = rows.map((row) => number(row.i));
  let injMin = Math.min(...injValues);
  let injMax = Math.max(...injValues);
  if (Math.abs(injMax - injMin) < Math.max(0.0001, injMax * 0.0005)) {
    const margin = Math.max(0.01, injMax * 0.002);
    injMin = Math.max(0, injMin - margin);
    injMax += margin;
  }
  const xMin = number(rows[0].t);
  const lastTime = number(rows[rows.length - 1].t);
  const xMax = lastTime > xMin ? lastTime : xMin + 1;
  const xSpan = Math.max(1, xMax - xMin);
  const ySpan = Math.max(1e-9, yMax - yMin);
  const injSpan = Math.max(1e-9, injMax - injMin);
  const plotWidth = Math.max(40, width - pad.left - pad.right);
  const plotHeight = Math.max(40, height - pad.top - pad.bottom);
  const x = (t) => pad.left + ((number(t) - xMin) / xSpan) * plotWidth;
  const y = (v) => pad.top + (1 - ((number(v) - yMin) / ySpan)) * plotHeight;
  const yInj = (v) => pad.top + (1 - ((number(v) - injMin) / injSpan)) * plotHeight;

  for (let i = 0; i <= 4; i++) {
    const yy = pad.top + (i / 4) * plotHeight;
    const value = yMax - (i / 4) * ySpan;
    const injValue = injMax - (i / 4) * injSpan;
    svg.appendChild(svgNode('line', { x1: pad.left, y1: yy, x2: width - pad.right, y2: yy, class: 'chart-grid-line' }));
    // Le etichette sono dentro il canvas, con formato compatto: non possono più essere tagliate/schiacciate.
    svg.appendChild(svgNode('text', { x: 10, y: yy + 4, 'text-anchor': 'start', class: 'chart-axis-label chart-axis-value' }, historyAxisMoney(value)));
    svg.appendChild(svgNode('text', { x: width - 10, y: yy + 4, 'text-anchor': 'end', class: 'chart-axis-label chart-axis-inj' }, historyAxisInj(injValue)));
  }

  const labelCount = Math.min(compact ? 3 : 5, Math.max(1, rows.length));
  for (let i = 0; i < labelCount; i++) {
    const index = Math.round((i / Math.max(1, labelCount - 1)) * (rows.length - 1));
    const row = rows[index];
    const date = new Date(number(row.t));
    const label = state.historyRange === '24H'
      ? date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
      : date.toLocaleDateString('it-IT', { day: '2-digit', month: 'short' });
    svg.appendChild(svgNode('text', { x: x(row.t), y: height - 10, 'text-anchor': i === 0 ? 'start' : i === labelCount - 1 ? 'end' : 'middle', class: 'chart-axis-label chart-date-label' }, label));
  }

  if (rows.length === 1) {
    const yy = y(rows[0].v);
    const yi = yInj(rows[0].i);
    svg.appendChild(svgNode('line', { x1: pad.left, y1: yy, x2: width - pad.right, y2: yy, class: 'chart-line' }));
    svg.appendChild(svgNode('line', { x1: pad.left, y1: yi, x2: width - pad.right, y2: yi, class: 'chart-line-inj' }));
    svg.appendChild(svgNode('circle', { cx: width - pad.right, cy: yy, r: 4.5, class: 'chart-dot' }));
    return;
  }

  const points = rows.map((row) => `${x(row.t).toFixed(2)},${y(row.v).toFixed(2)}`);
  const injPoints = rows.map((row) => `${x(row.t).toFixed(2)},${yInj(row.i).toFixed(2)}`);
  const linePath = `M ${points.join(' L ')}`;
  const injPath = `M ${injPoints.join(' L ')}`;
  const areaPath = `${linePath} L ${x(rows[rows.length - 1].t).toFixed(2)},${(height - pad.bottom).toFixed(2)} L ${x(rows[0].t).toFixed(2)},${(height - pad.bottom).toFixed(2)} Z`;
  svg.appendChild(svgNode('path', { d: areaPath, class: 'chart-area' }));
  svg.appendChild(svgNode('path', { d: linePath, class: 'chart-line' }));
  svg.appendChild(svgNode('path', { d: injPath, class: 'chart-line-inj' }));

  const movements = Array.isArray(state.movementsByWallet[state.address]?.rows) ? state.movementsByWallet[state.address].rows : [];
  movements.filter((movement) => ['in', 'out'].includes(movement.kind)).slice(0, 80).forEach((movement) => {
    const t = new Date(movement.timestamp).getTime();
    if (!(t >= xMin && t <= xMax)) return;
    const nearest = rows.reduce((best, row) => Math.abs(number(row.t) - t) < Math.abs(number(best.t) - t) ? row : best, rows[0]);
    const marker = svgNode('circle', { cx: x(t), cy: y(nearest.v), r: 4, class: `chart-event chart-event-${movement.kind}` });
    marker.appendChild(svgNode('title', {}, `${movement.label}: ${movementAmountText(movement)}`));
    svg.appendChild(marker);
  });

  const last = rows[rows.length - 1];
  svg.appendChild(svgNode('circle', { cx: x(last.t), cy: y(last.v), r: 4.5, class: 'chart-dot' }));
}

function movementAnalytics() {
  const entry = state.address ? state.movementsByWallet[state.address] : null;
  const rows = Array.isArray(entry?.rows) ? entry.rows : [];
  const now = Date.now();
  const yearStart = new Date(new Date().getFullYear(), 0, 1).getTime();
  const rewards = rows.filter((row) => row.kind === 'reward' && row.amount > 0);
  const sumSince = (cutoff) => rewards.filter((row) => new Date(row.timestamp).getTime() >= cutoff).reduce((sum, row) => sum + row.amount, 0);
  const claimed = rewards.reduce((sum, row) => sum + row.amount, 0);
  const incoming = rows.filter((row) => row.kind === 'in').reduce((sum, row) => sum + row.amount, 0);
  const outgoing = rows.filter((row) => row.kind === 'out').reduce((sum, row) => sum + row.amount, 0);
  const generated = claimed + state.rewards;
  const total = currentTotalInj();
  const nonRewardBase = Math.max(0, total - generated);
  const roi = nonRewardBase > 0 ? (generated / nonRewardBase) * 100 : 0;
  return {
    rows,
    complete: Boolean(entry?.complete),
    loading: Boolean(entry?.loading || state.loadingAllMovements),
    claimed,
    current: state.rewards,
    generated,
    nonRewardBase,
    roi,
    incoming,
    outgoing,
    netFlow: incoming - outgoing,
    reward7d: sumSince(now - 7 * 86400000),
    reward30d: sumSince(now - 30 * 86400000),
    rewardYtd: sumSince(yearStart)
  };
}

function renderPerformanceAnalytics() {
  const data = movementAnalytics();
  const hasWallet = Boolean(state.address);
  const status = $('performanceStatus');
  if (status) {
    status.textContent = !hasWallet ? '—' : data.loading ? 'LETTURA' : data.complete ? 'COMPLETO' : 'PARZIALE';
    status.classList.toggle('complete', hasWallet && data.complete);
  }
  setValue('reward7d', hasWallet ? formatInj(data.reward7d, 6) : '—', hasWallet ? data.reward7d : NaN, { flash: false });
  setValue('reward30d', hasWallet ? formatInj(data.reward30d, 6) : '—', hasWallet ? data.reward30d : NaN, { flash: false });
  setValue('rewardYtd', hasWallet ? formatInj(data.rewardYtd, 5) : '—', hasWallet ? data.rewardYtd : NaN, { flash: false });
  setValue('rewardTotalTracked', hasWallet ? formatInj(data.generated, 5) : '—', hasWallet ? data.generated : NaN, { flash: false });
  setValue('stakingRoi', hasWallet && data.nonRewardBase > 0 ? `${data.roi.toFixed(2)}%` : '—', hasWallet ? data.roi : NaN, { flash: false });
  if ($('performanceNote')) {
    $('performanceNote').textContent = data.complete
      ? 'Storico transazioni caricato completamente. I periodi usano i claim reward on-chain; le reward non ancora prelevate sono incluse solo nel totale.'
      : 'Dati parziali finché non viene caricato tutto lo storico. I periodi usano i claim reward presenti nelle transazioni caricate; le reward non ancora prelevate sono incluse nel totale.';
  }
}

function renderRewardTracker() {
  const active = state.staked > 0 && state.personalApr > 0;
  const daily = active ? state.staked * (state.personalApr / 100) / 365 : 0;
  const hourly = daily / 24;
  const weekly = daily * 7;
  setValue('hourlyEstimate', active ? formatInj(hourly, 8) : '—', active ? hourly : NaN, { flash: false });
  setValue('weeklyEstimate', active ? formatInj(weekly, 6) : '—', active ? weekly : NaN, { flash: false });
  const milestones = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50];
  const milestone = milestones.find((value) => value > daily + 1e-9) || Math.ceil(daily / 10) * 10 + 10;
  const required = active ? milestone * 365 / (state.personalApr / 100) : 0;
  const missing = Math.max(0, required - state.staked);
  $('rewardMilestoneLabel').textContent = active ? `${milestone.toLocaleString('it-IT')} INJ / giorno` : '—';
  $('rewardMilestoneMissing').textContent = active ? `${formatInj(missing, 3)} di staking mancanti` : '—';
  $('rewardMilestoneBar').style.width = active ? `${Math.min(100, (daily / milestone) * 100)}%` : '0%';
}

function renderStakingPnl() {
  const data = movementAnalytics();
  const hasWallet = Boolean(state.address);
  const status = $('pnlStatus');
  if (status) {
    status.textContent = !hasWallet ? '—' : data.loading ? 'LETTURA' : data.complete ? 'COMPLETO' : 'PARZIALE';
    status.classList.toggle('complete', hasWallet && data.complete);
  }
  setValue('pnlClaimed', hasWallet ? formatInj(data.claimed, 5) : '—', hasWallet ? data.claimed : NaN, { flash: false });
  setValue('pnlUnclaimed', hasWallet ? formatInj(data.current, 6) : '—', hasWallet ? data.current : NaN, { flash: false });
  setValue('pnlGenerated', hasWallet ? formatInj(data.generated, 5) : '—', hasWallet ? data.generated : NaN, { flash: false });
  setValue('pnlGeneratedValue', hasWallet ? money(data.generated * state.price) : '—', hasWallet ? data.generated * state.price : NaN, { flash: false });
  setValue('pnlBase', hasWallet ? formatInj(data.nonRewardBase, 4) : '—', hasWallet ? data.nonRewardBase : NaN, { flash: false });
  const flowText = hasWallet ? `${data.netFlow >= 0 ? '+' : '−'}${formatInj(Math.abs(data.netFlow), 4)}` : '—';
  setValue('pnlNetFlow', flowText, hasWallet ? data.netFlow : NaN, { flash: false });
}

function simulateStaking(years, mode = state.compoundMode, weeklyAdd = state.compoundWeekly) {
  const start = Math.max(0, state.staked);
  const dailyRate = Math.max(0, state.personalApr) / 100 / 365;
  const days = Math.max(0, Math.round(years * 365));
  let principal = start;
  let rewards = 0;
  let contributions = 0;
  for (let day = 1; day <= days; day++) {
    const reward = principal * dailyRate;
    if (mode === 'daily') principal += reward;
    else rewards += reward;
    if (weeklyAdd > 0 && day % 7 === 0) {
      principal += weeklyAdd;
      contributions += weeklyAdd;
    }
  }
  const total = principal + rewards;
  const rewardGain = Math.max(0, total - start - contributions);
  return { total, rewardGain, contributions };
}

function renderCompound() {
  const body = $('compoundRows');
  if (!body) return;
  body.replaceChildren();
  [1, 3, 5, 10].forEach((years) => {
    const result = simulateStaking(years);
    const row = document.createElement('tr');
    const cells = [
      `${years} ${years === 1 ? 'anno' : 'anni'}`,
      state.address ? formatInj(result.total, 3) : '—',
      state.address ? formatInj(result.rewardGain, 3) : '—',
      state.address ? formatInj(result.contributions, 1) : '—',
      state.address ? money(result.total * state.price) : '—'
    ];
    cells.forEach((value, index) => {
      const cell = document.createElement(index === 0 ? 'th' : 'td');
      cell.textContent = value;
      if (index > 0) cell.classList.add('private');
      row.appendChild(cell);
    });
    body.appendChild(row);
  });
}

function defaultTarget(total) {
  if (!(total > 0)) return 2000;
  const step = total < 1000 ? 100 : total < 5000 ? 500 : 1000;
  return (Math.floor(total / step) + 1) * step;
}

function activeTarget() {
  if (!state.address) return 0;
  let target = number(state.targetByWallet[state.address]);
  const total = currentTotalInj();
  if (!(target > 0)) {
    target = defaultTarget(total);
    state.targetByWallet[state.address] = target;
    saveTargets();
  }
  return target;
}

function estimateTargetDays(target) {
  const totalNow = currentTotalInj();
  if (!(target > totalNow)) return 0;
  const dailyRate = Math.max(0, state.personalApr) / 100 / 365;
  if (!(dailyRate > 0) && !(state.compoundWeekly > 0)) return Infinity;
  let principal = Math.max(0, state.staked);
  let rewardPool = 0;
  const fixed = Math.max(0, state.available + state.rewards);
  const maxDays = 365 * 40;
  for (let day = 1; day <= maxDays; day++) {
    const reward = principal * dailyRate;
    if (state.compoundMode === 'daily') principal += reward;
    else rewardPool += reward;
    if (state.compoundWeekly > 0 && day % 7 === 0) principal += state.compoundWeekly;
    if (fixed + principal + rewardPool >= target) return day;
  }
  return Infinity;
}

function etaText(days) {
  if (!Number.isFinite(days)) return 'Oltre 40 anni / n.d.';
  if (days <= 0) return 'Raggiunto';
  const date = new Date(Date.now() + days * 86400000);
  if (days < 60) return `${days} giorni · ${date.toLocaleDateString('it-IT', { day: '2-digit', month: 'short' })}`;
  const months = Math.round(days / 30.4375);
  return `${months} mesi · ${date.toLocaleDateString('it-IT', { month: 'short', year: 'numeric' })}`;
}

function renderTarget() {
  const input = $('targetInput');
  if (!input) return;
  if (!state.address) {
    input.value = '';
    $('targetProgressCopy').textContent = '—';
    $('targetProgressBar').style.width = '0%';
    $('targetMissing').textContent = '—';
    $('targetPercent').textContent = '—';
    $('targetEta').textContent = '—';
    return;
  }
  const total = currentTotalInj();
  const target = activeTarget();
  if (document.activeElement !== input) input.value = String(Number(target.toFixed(3)));
  const percent = target > 0 ? Math.min(100, (total / target) * 100) : 0;
  const missing = Math.max(0, target - total);
  $('targetProgressCopy').textContent = `${formatInj(total, 3)} / ${formatInj(target, 0)}`;
  $('targetProgressBar').style.width = `${percent}%`;
  $('targetMissing').textContent = formatInj(missing, missing < 10 ? 4 : 2);
  $('targetPercent').textContent = `${percent.toFixed(2)}%`;
  $('targetEta').textContent = etaText(estimateTargetDays(target));
}

async function loadAllWalletMovements(address) {
  if (!validAddress(address) || state.loadingAllMovements) return;
  state.loadingAllMovements = true;
  renderMovements();
  renderPerformanceAnalytics();
  renderStakingPnl();
  try {
    let safety = 0;
    let entry = state.movementsByWallet[address];
    if (!entry?.rows?.length) {
      await loadWalletMovements(address, { force: true });
      entry = state.movementsByWallet[address];
    }
    while (entry && !entry.complete && safety < 100) {
      await loadWalletMovements(address, { append: true, force: true });
      entry = state.movementsByWallet[address];
      safety += 1;
      if (entry?.error) break;
    }
    if (state.address === address) toast(entry?.complete ? 'Storico completo caricato' : 'Storico molto esteso: caricati fino a 10.000 movimenti');
  } finally {
    state.loadingAllMovements = false;
    renderMovements();
    renderPerformanceAnalytics();
    renderStakingPnl();
  }
}


function txEventValue(value) {
  const text = String(value ?? '');
  if (!text || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return text;
  try {
    const decoded = atob(text);
    return /^[\x20-\x7E]+$/.test(decoded) ? decoded : text;
  } catch (_) {
    return text;
  }
}

function injFromCoin(coin) {
  if (!coin || coin.denom !== 'inj') return 0;
  return fromWei(coin.amount);
}

function injFromCoins(coins = []) {
  return (Array.isArray(coins) ? coins : []).reduce((sum, coin) => sum + injFromCoin(coin), 0);
}

function injFromEventAmount(value) {
  const text = txEventValue(value);
  const matches = String(text).matchAll(/([0-9]+(?:\.[0-9]+)?)inj/g);
  let total = 0;
  for (const match of matches) total += number(match[1]) / INJ_DECIMALS;
  return total;
}

function logEventsForMessage(response, messageIndex) {
  const logs = Array.isArray(response?.logs) ? response.logs : [];
  const log = logs.find((item) => number(item?.msg_index) === messageIndex);
  return Array.isArray(log?.events) ? log.events : [];
}

function rewardAmountFromResponse(response, messageIndex) {
  const sources = [logEventsForMessage(response, messageIndex), Array.isArray(response?.events) ? response.events : []];
  for (const events of sources) {
    for (const event of events) {
      if (!['withdraw_rewards', 'coin_received'].includes(String(event?.type || ''))) continue;
      const attrs = Array.isArray(event?.attributes) ? event.attributes : [];
      const amount = attrs.find((attr) => txEventValue(attr?.key) === 'amount');
      const parsed = injFromEventAmount(amount?.value);
      if (parsed > 0) return parsed;
    }
  }
  return 0;
}

function movementTypeLabel(typeUrl) {
  const name = String(typeUrl || '').split('.').pop()?.replace(/^Msg/, '') || 'Transazione';
  return name.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function movementRow({ hash, timestamp, index, kind, label, amount = 0, detail = '', direction = '', typeUrl = '' }) {
  return {
    id: `${hash || 'tx'}:${index}:${kind}:${direction}:${detail}`,
    hash: hash || '',
    timestamp: timestamp || '',
    index,
    kind,
    label,
    amount: number(amount),
    detail,
    direction,
    typeUrl
  };
}

function extractMovements(tx, response, address) {
  if (number(response?.code) !== 0) return [];
  const hash = String(response?.txhash || '');
  const timestamp = String(response?.timestamp || '');
  const messages = Array.isArray(tx?.body?.messages) ? tx.body.messages : [];
  const rows = [];

  messages.forEach((message, index) => {
    const typeUrl = String(message?.['@type'] || message?.type_url || '');
    const lower = typeUrl.toLowerCase();

    if (lower.endsWith('msgwithdrawdelegatorreward')) {
      const delegator = String(message?.delegator_address || '').toLowerCase();
      if (delegator === address) {
        rows.push(movementRow({
          hash, timestamp, index, kind: 'reward', label: 'Prelievo reward',
          amount: rewardAmountFromResponse(response, index),
          detail: shortAddress(message?.validator_address || ''), direction: 'in', typeUrl
        }));
      }
      return;
    }

    if (lower.endsWith('msgdelegate')) {
      const delegator = String(message?.delegator_address || '').toLowerCase();
      if (delegator === address) {
        rows.push(movementRow({
          hash, timestamp, index, kind: 'stake', label: 'Messa in staking',
          amount: injFromCoin(message?.amount),
          detail: shortAddress(message?.validator_address || ''), direction: 'stake', typeUrl
        }));
      }
      return;
    }

    if (lower.endsWith('msgbeginredelegate')) {
      const delegator = String(message?.delegator_address || '').toLowerCase();
      if (delegator === address) {
        rows.push(movementRow({
          hash, timestamp, index, kind: 'stake', label: 'Ridelega staking',
          amount: injFromCoin(message?.amount),
          detail: `${shortAddress(message?.validator_src_address || '')} → ${shortAddress(message?.validator_dst_address || '')}`,
          direction: 'stake', typeUrl
        }));
      }
      return;
    }

    if (lower.endsWith('msgundelegate')) {
      const delegator = String(message?.delegator_address || '').toLowerCase();
      if (delegator === address) {
        rows.push(movementRow({
          hash, timestamp, index, kind: 'unstake', label: 'Uscita dallo staking',
          amount: injFromCoin(message?.amount),
          detail: shortAddress(message?.validator_address || ''), direction: 'unstake', typeUrl
        }));
      }
      return;
    }

    if (lower.endsWith('msgsend')) {
      const from = String(message?.from_address || '').toLowerCase();
      const to = String(message?.to_address || '').toLowerCase();
      const amount = injFromCoins(message?.amount);
      if (from === address && to !== address) {
        rows.push(movementRow({ hash, timestamp, index, kind: 'out', label: 'Uscita', amount, detail: shortAddress(to), direction: 'out', typeUrl }));
      } else if (to === address && from !== address) {
        rows.push(movementRow({ hash, timestamp, index, kind: 'in', label: 'Entrata', amount, detail: shortAddress(from), direction: 'in', typeUrl }));
      }
      return;
    }

    if (lower.endsWith('msgmultisend')) {
      const input = (message?.inputs || []).find((item) => String(item?.address || '').toLowerCase() === address);
      const output = (message?.outputs || []).find((item) => String(item?.address || '').toLowerCase() === address);
      const sent = injFromCoins(input?.coins);
      const received = injFromCoins(output?.coins);
      if (sent > 0) rows.push(movementRow({ hash, timestamp, index, kind: 'out', label: 'Uscita', amount: sent, detail: 'MultiSend', direction: 'out', typeUrl }));
      if (received > 0) rows.push(movementRow({ hash, timestamp, index, kind: 'in', label: 'Entrata', amount: received, detail: 'MultiSend', direction: 'in', typeUrl }));
      return;
    }

    const sender = String(message?.sender || message?.from_address || message?.delegator_address || '').toLowerCase();
    if (sender === address) {
      rows.push(movementRow({
        hash, timestamp, index, kind: 'other', label: movementTypeLabel(typeUrl),
        amount: 0, detail: 'Transazione del wallet', direction: 'other', typeUrl
      }));
    }
  });

  return rows;
}

async function txSearch(event, page = 1, limit = 50) {
  const params = new URLSearchParams();
  params.set('events', event);
  params.set('page', String(page));
  params.set('limit', String(limit));
  params.set('order_by', 'ORDER_BY_DESC');
  return lcd(`/cosmos/tx/v1beta1/txs?${params.toString()}`);
}

function movementBatchRows(data, address) {
  const txs = Array.isArray(data?.txs) ? data.txs : [];
  const responses = Array.isArray(data?.tx_responses) ? data.tx_responses : [];
  return txs.flatMap((tx, index) => extractMovements(tx, responses[index] || {}, address));
}

function movementTotal(data) {
  return Math.max(0, number(data?.total || data?.pagination?.total));
}

function maybeJson(value) {
  if (value && typeof value === 'object') return value;
  const text = String(value || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) {}
  try {
    const decoded = atob(text);
    return JSON.parse(decoded);
  } catch (_) {}
  return null;
}

function indexerEventPairs(event) {
  const attrs = event?.attributes;
  if (Array.isArray(attrs)) {
    return attrs.map((attr) => ({
      key: txEventValue(attr?.key),
      value: txEventValue(attr?.value)
    }));
  }
  if (attrs && typeof attrs === 'object') {
    return Object.entries(attrs).map(([key, value]) => ({ key: txEventValue(key), value: txEventValue(value) }));
  }
  return [];
}

function indexerEventValues(event, key) {
  const wanted = String(key).toLowerCase();
  return indexerEventPairs(event)
    .filter((pair) => String(pair.key).toLowerCase() === wanted)
    .map((pair) => String(pair.value || ''));
}

function indexerEvents(item) {
  if (Array.isArray(item?.events)) return item.events;
  const parsedEvents = maybeJson(item?.events);
  if (Array.isArray(parsedEvents)) return parsedEvents;
  const parsedLogs = maybeJson(item?.logs);
  if (Array.isArray(parsedLogs)) {
    return parsedLogs.flatMap((log) => Array.isArray(log?.events) ? log.events : []);
  }
  return [];
}

function indexerTimestamp(item) {
  const direct = String(item?.block_timestamp || item?.timestamp || '').trim();
  if (direct && !Number.isNaN(new Date(direct).getTime())) return new Date(direct).toISOString();
  let raw = number(item?.block_unix_timestamp || item?.timeStamp || item?.timestamp);
  if (!(raw > 0)) return '';
  if (raw > 1e17) raw /= 1e6; // nanosecondi -> millisecondi
  else if (raw < 1e11) raw *= 1000; // secondi -> millisecondi
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function indexerTypeText(item) {
  const raw = item?.tx_msg_types ?? item?.tx_type ?? item?.type ?? '';
  const decoded = typeof raw === 'string' ? txEventValue(raw) : raw;
  const parsed = maybeJson(decoded);
  if (Array.isArray(parsed)) return parsed.join(' ');
  return String(decoded || '');
}

function indexerMovementRows(item, address, txIndex = 0) {
  if (number(item?.code) !== 0) return [];
  const hash = String(item?.hash || item?.txhash || item?.tx_hash || '');
  const timestamp = indexerTimestamp(item);
  const events = indexerEvents(item);
  const typeText = indexerTypeText(item);
  const typeLower = typeText.toLowerCase();
  const rows = [];
  let semanticMovement = false;

  events.forEach((event, eventIndex) => {
    const eventType = String(event?.type || '').toLowerCase();
    const amountValues = indexerEventValues(event, 'amount');
    const amount = amountValues.reduce((sum, value) => sum + injFromEventAmount(value), 0);
    const validator = indexerEventValues(event, 'validator')[0] || indexerEventValues(event, 'validator_address')[0] || '';

    if (eventType.includes('withdraw') && eventType.includes('reward')) {
      semanticMovement = true;
      rows.push(movementRow({
        hash, timestamp, index: txIndex * 1000 + eventIndex, kind: 'reward', label: 'Prelievo reward',
        amount, detail: shortAddress(validator), direction: 'in', typeUrl: typeText
      }));
      return;
    }

    if (eventType.includes('redelegate')) {
      semanticMovement = true;
      const src = indexerEventValues(event, 'source_validator')[0] || indexerEventValues(event, 'validator_src_address')[0] || '';
      const dst = indexerEventValues(event, 'destination_validator')[0] || indexerEventValues(event, 'validator_dst_address')[0] || validator;
      rows.push(movementRow({
        hash, timestamp, index: txIndex * 1000 + eventIndex, kind: 'stake', label: 'Ridelega staking',
        amount, detail: `${shortAddress(src)}${src && dst ? ' → ' : ''}${shortAddress(dst)}`, direction: 'stake', typeUrl: typeText
      }));
      return;
    }

    if (eventType === 'delegate' || (eventType.includes('delegate') && !eventType.includes('un') && !eventType.includes('re'))) {
      semanticMovement = true;
      rows.push(movementRow({
        hash, timestamp, index: txIndex * 1000 + eventIndex, kind: 'stake', label: 'Messa in staking',
        amount, detail: shortAddress(validator), direction: 'stake', typeUrl: typeText
      }));
      return;
    }

    if (eventType.includes('unbond') || eventType.includes('undelegate')) {
      semanticMovement = true;
      rows.push(movementRow({
        hash, timestamp, index: txIndex * 1000 + eventIndex, kind: 'unstake', label: 'Uscita dallo staking',
        amount, detail: shortAddress(validator), direction: 'unstake', typeUrl: typeText
      }));
    }
  });

  // Per claim/staking evitiamo di riclassificare i trasferimenti interni dei moduli come entrate/uscite esterne.
  const explicitSend = typeLower.includes('msgsend') || typeLower.includes('multisend') || typeLower.includes('bank');
  if (!semanticMovement || explicitSend) {
    events.filter((event) => String(event?.type || '').toLowerCase() === 'transfer').forEach((event, eventIndex) => {
      const senders = indexerEventValues(event, 'sender');
      const recipients = indexerEventValues(event, 'recipient');
      const amounts = indexerEventValues(event, 'amount');
      const size = Math.max(senders.length, recipients.length, amounts.length, 1);
      for (let i = 0; i < size; i++) {
        const from = String(senders[i] ?? senders[0] ?? '').toLowerCase();
        const to = String(recipients[i] ?? recipients[0] ?? '').toLowerCase();
        const amount = injFromEventAmount(amounts[i] ?? amounts[0] ?? '');
        if (!(amount > 0)) continue;
        if (from === address && to !== address) {
          rows.push(movementRow({ hash, timestamp, index: txIndex * 1000 + 500 + eventIndex * 10 + i, kind: 'out', label: 'Uscita', amount, detail: shortAddress(to), direction: 'out', typeUrl: typeText }));
        } else if (to === address && from !== address) {
          rows.push(movementRow({ hash, timestamp, index: txIndex * 1000 + 500 + eventIndex * 10 + i, kind: 'in', label: 'Entrata', amount, detail: shortAddress(from), direction: 'in', typeUrl: typeText }));
        }
      }
    });
  }

  if (!rows.length) {
    const fallbackLabel = movementTypeLabel(typeText || item?.tx_type || 'Transazione');
    rows.push(movementRow({
      hash, timestamp, index: txIndex * 1000 + 999, kind: 'other', label: fallbackLabel,
      amount: 0, detail: 'Transazione del wallet', direction: 'other', typeUrl: typeText
    }));
  }

  const unique = new Map();
  rows.forEach((row) => unique.set(`${row.hash}:${row.kind}:${row.direction}:${row.amount}:${row.detail}`, row));
  return [...unique.values()];
}

async function explorerAccountTxs(address, page = 1, limit = 100) {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('skip', String(Math.max(0, (page - 1) * limit)));
  params.set('status', 'success');
  return explorerJson(`/accountTxs/${encodeURIComponent(address)}?${params.toString()}`, 12000);
}

function indexerBatchRows(data, address) {
  const txs = Array.isArray(data?.data) ? data.data : Array.isArray(data?.transactions) ? data.transactions : [];
  return txs.flatMap((tx, index) => indexerMovementRows(tx, address, index));
}

function indexerPageLength(data) {
  return Array.isArray(data?.data) ? data.data.length : Array.isArray(data?.transactions) ? data.transactions.length : 0;
}

function indexerTotal(data) {
  return Math.max(0, number(data?.paging?.total || data?.pagination?.total || data?.total));
}

async function loadMovementPageIndexer(address, entry, page, limit) {
  const data = await explorerAccountTxs(address, page, limit);
  const nextRows = indexerBatchRows(data, address);
  const combined = page > 1 ? [...entry.rows, ...nextRows] : nextRows;
  const unique = new Map();
  combined.forEach((row) => unique.set(row.id, row));
  entry.rows = [...unique.values()].sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)) || String(b.hash).localeCompare(String(a.hash)));
  entry.page = page;
  entry.total = indexerTotal(data);
  const fetched = indexerPageLength(data);
  entry.complete = entry.total > 0 ? page * limit >= entry.total : fetched < limit;
  entry.source = 'indexer';
}

async function loadMovementPageLcd(address, entry, page, limit) {
  const senderEvent = `message.sender='${address}'`;
  const recipientEvent = `transfer.recipient='${address}'`;
  const [senderResult, recipientResult] = await Promise.allSettled([
    txSearch(senderEvent, page, limit),
    txSearch(recipientEvent, page, limit)
  ]);
  const senderData = senderResult.status === 'fulfilled' ? senderResult.value : { txs: [], tx_responses: [], pagination: { total: 0 } };
  const recipientData = recipientResult.status === 'fulfilled' ? recipientResult.value : { txs: [], tx_responses: [], pagination: { total: 0 } };
  if (senderResult.status === 'rejected' && recipientResult.status === 'rejected') throw senderResult.reason || recipientResult.reason;

  const nextRows = [...movementBatchRows(senderData, address), ...movementBatchRows(recipientData, address)];
  const combined = page > 1 ? [...entry.rows, ...nextRows] : nextRows;
  const unique = new Map();
  combined.forEach((row) => unique.set(row.id, row));
  entry.rows = [...unique.values()].sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)) || String(b.hash).localeCompare(String(a.hash)));
  entry.page = page;
  entry.senderTotal = movementTotal(senderData);
  entry.recipientTotal = movementTotal(recipientData);
  const senderDone = entry.senderTotal ? page * limit >= entry.senderTotal : (senderData?.txs || []).length < limit;
  const recipientDone = entry.recipientTotal ? page * limit >= entry.recipientTotal : (recipientData?.txs || []).length < limit;
  entry.complete = senderDone && recipientDone;
  entry.source = 'lcd';
}

async function loadWalletMovements(address, { append = false, force = false } = {}) {
  if (!validAddress(address)) return;
  let entry = state.movementsByWallet[address];
  if (!entry || !append) {
    if (entry?.loading) return;
    if (!force && entry?.rows?.length && Date.now() - number(entry.updated) < 60_000) {
      if (state.address === address) renderMovements();
      return;
    }
    entry = { rows: [], page: 0, total: 0, senderTotal: 0, recipientTotal: 0, loading: false, complete: false, error: '', source: '', updated: 0 };
    state.movementsByWallet[address] = entry;
  }
  if (entry.loading || (append && entry.complete)) return;

  const page = append ? entry.page + 1 : 1;
  const limit = entry.source === 'lcd' ? 50 : 100;
  entry.loading = true;
  entry.error = '';
  if (state.address === address) renderMovements();

  try {
    if (entry.source === 'lcd') {
      await loadMovementPageLcd(address, entry, page, limit);
    } else {
      try {
        await loadMovementPageIndexer(address, entry, page, limit);
      } catch (indexerError) {
        // Fallback solo sulla prima pagina, per non mischiare due sistemi di paginazione diversi.
        if (append || entry.rows.length) throw indexerError;
        console.warn('Explorer Indexer non disponibile, uso LCD fallback:', indexerError);
        await loadMovementPageLcd(address, entry, 1, 50);
      }
    }
    entry.updated = Date.now();
  } catch (error) {
    console.error('Movimenti wallet:', error);
    entry.error = entry.rows.length
      ? 'Aggiornamento dello storico non riuscito. I movimenti già caricati restano disponibili.'
      : 'Storico temporaneamente non disponibile. Premi Aggiorna per riprovare.';
  } finally {
    entry.loading = false;
    if (state.address === address) {
      renderMovements();
      renderPortfolioHistory();
      renderPerformanceAnalytics();
      renderStakingPnl();
    }
  }
}

function movementAmountText(row) {
  if (!(row.amount > 0)) return '—';
  const prefix = row.direction === 'out' ? '−' : row.direction === 'in' ? '+' : '';
  return `${prefix}${formatInj(row.amount, row.amount < 1 ? 7 : 5)}`;
}

function movementDateText(timestamp) {
  const date = new Date(timestamp);
  if (!timestamp || Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function renderMovements() {
  const host = $('movementList');
  const count = $('movementCount');
  const more = $('movementMoreButton');
  const all = $('movementAllButton');
  const walletLabel = $('movementWallet');
  const source = $('movementSource');
  if (!host || !count || !more || !all || !walletLabel) return;

  host.replaceChildren();
  walletLabel.textContent = state.address ? state.address : 'Nessun wallet caricato';
  if (source) {
    source.textContent = 'INDEXER';
    source.classList.remove('complete', 'warning');
  }
  walletLabel.title = state.address || '';
  document.querySelectorAll('[data-movement-filter]').forEach((button) => button.classList.toggle('active', button.dataset.movementFilter === state.movementFilter));

  const setSummary = (incoming = NaN, outgoing = NaN, rewards = NaN) => {
    setValue('movementInTotal', Number.isFinite(incoming) ? `+${formatInj(incoming, 4)}` : '—', incoming, { flash: false });
    setValue('movementOutTotal', Number.isFinite(outgoing) ? `−${formatInj(outgoing, 4)}` : '—', outgoing, { flash: false });
    setValue('movementRewardTotal', Number.isFinite(rewards) ? formatInj(rewards, 5) : '—', rewards, { flash: false });
  };

  if (!state.address) {
    count.textContent = '0';
    more.hidden = true;
    all.hidden = true;
    setSummary();
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Carica un wallet per vedere prelievi reward, staking, entrate e uscite.';
    host.appendChild(empty);
    return;
  }

  const entry = state.movementsByWallet[state.address];
  if (source && entry) {
    source.textContent = entry.source === 'lcd' ? 'LCD FALLBACK' : entry.source === 'indexer' ? 'INDEXER LIVE' : 'INDEXER';
    source.classList.toggle('complete', entry.source === 'indexer' && !entry.error);
    source.classList.toggle('warning', entry.source === 'lcd' || Boolean(entry.error));
  }
  if (!entry || (entry.loading && !entry.rows.length)) {
    count.textContent = '…';
    more.hidden = true;
    all.hidden = true;
    setSummary();
    const empty = document.createElement('div');
    empty.className = 'empty-state movement-loading';
    empty.textContent = 'Lettura movimenti dalla blockchain…';
    host.appendChild(empty);
    return;
  }

  const incoming = entry.rows.filter((row) => row.kind === 'in').reduce((sum, row) => sum + row.amount, 0);
  const outgoing = entry.rows.filter((row) => row.kind === 'out').reduce((sum, row) => sum + row.amount, 0);
  const rewards = entry.rows.filter((row) => row.kind === 'reward').reduce((sum, row) => sum + row.amount, 0);
  setSummary(incoming, outgoing, rewards);

  const filteredRows = state.movementFilter === 'all'
    ? entry.rows
    : entry.rows.filter((movement) => movement.kind === state.movementFilter);

  count.textContent = state.movementFilter === 'all' ? String(entry.rows.length) : `${filteredRows.length}/${entry.rows.length}`;
  more.hidden = entry.complete || (!entry.rows.length && !entry.loading) || state.loadingAllMovements;
  all.hidden = entry.complete || (!entry.rows.length && !entry.loading);
  more.disabled = entry.loading || state.loadingAllMovements;
  all.disabled = entry.loading || state.loadingAllMovements;
  more.textContent = entry.loading ? 'Lettura…' : 'Carica altri';
  all.textContent = state.loadingAllMovements ? 'Caricamento…' : 'Carica tutto';

  if (entry.error && !entry.rows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = entry.error;
    host.appendChild(empty);
    return;
  }

  if (!entry.rows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Nessun movimento trovato per questo indirizzo.';
    host.appendChild(empty);
    return;
  }

  if (entry.error) {
    const warning = document.createElement('div');
    warning.className = 'movement-inline-warning';
    warning.textContent = entry.error;
    host.appendChild(warning);
  }

  if (!filteredRows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Nessun movimento corrisponde al filtro selezionato.';
    host.appendChild(empty);
    return;
  }

  filteredRows.forEach((movement) => {
    const row = document.createElement('div');
    row.className = `movement-row movement-${movement.kind}`;

    const time = document.createElement('time');
    time.dateTime = movement.timestamp;
    time.textContent = movementDateText(movement.timestamp);

    const type = document.createElement('span');
    type.className = `movement-type movement-type-${movement.kind}`;
    type.textContent = movement.label;

    const info = document.createElement('div');
    info.className = 'movement-info';
    const detail = document.createElement('strong');
    detail.textContent = movement.detail || movementTypeLabel(movement.typeUrl);
    const hash = document.createElement('small');
    hash.textContent = movement.hash ? `${movement.hash.slice(0, 10)}…${movement.hash.slice(-6)}` : 'Hash non disponibile';
    hash.title = movement.hash;
    info.append(detail, hash);

    const amount = document.createElement('strong');
    amount.className = `movement-amount private ${movement.direction === 'in' ? 'positive' : movement.direction === 'out' ? 'negative' : ''}`.trim();
    amount.textContent = movementAmountText(movement);

    row.append(time, type, info, amount);
    host.appendChild(row);
  });
}

function renderValidators() {
  const host = $('validatorList');
  $('validatorCount').textContent = String(state.validators.length);
  host.replaceChildren();

  if (!state.validators.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = state.address ? 'Nessuna delegazione trovata per questo wallet.' : 'Carica un wallet per vedere dove sono delegati gli INJ.';
    host.appendChild(empty);
    return;
  }

  [...state.validators].sort((a, b) => b.amount - a.amount).forEach((validator) => {
    const row = document.createElement('div');
    row.className = 'validator-row';

    const name = document.createElement('div');
    name.className = 'validator-name';
    const title = document.createElement('strong');
    title.textContent = validator.moniker;
    const status = document.createElement('small');
    status.className = `validator-status ${validatorActive(validator) ? '' : 'inactive'}`.trim();
    status.textContent = validatorActive(validator) ? 'Attivo' : validator.jailed ? 'Jailed' : 'Inattivo';
    name.append(title, status);

    const stake = metricCell('Delegati', formatInj(validator.amount, 3), true);
    const commission = metricCell('Commissione', `${(validator.commission * 100).toFixed(2)}%`);
    const netApr = metricCell('APR netto', `${validatorNetApr(validator).toFixed(3)}%`);
    if (!validatorActive(validator) || validator.commission >= 0.1) {
      row.classList.add('validator-alert');
      commission.classList.add('warning');
    }
    row.append(name, stake, commission, netApr);
    host.appendChild(row);
  });
}

function metricCell(label, value, isPrivate = false) {
  const cell = document.createElement('div');
  const small = document.createElement('span');
  const strong = document.createElement('strong');
  small.textContent = label;
  strong.textContent = value;
  if (isPrivate) strong.classList.add('private');
  cell.append(small, strong);
  return cell;
}

function renderAll() {
  renderMarket();
  renderPortfolio();
  renderPortfolioHistory();
  renderPerformanceAnalytics();
  renderRewardTracker();
  renderStakingPnl();
  renderCompound();
  renderTarget();
  renderMovements();
  renderValidators();
  renderAggregate();
}

async function refreshAll(showFeedback = true) {
  await Promise.all([
    loadMarket(),
    state.address ? loadWallet(false, state.address) : Promise.resolve()
  ]);
  if (showFeedback && state.address) toast('Tutti i dati sono aggiornati');
}

function togglePrivacy() {
  const active = !document.body.classList.contains('privacy-on');
  document.body.classList.toggle('privacy-on', active);
  $('privacyButton').classList.toggle('active', active);
  $('privacyButton').setAttribute('aria-label', active ? 'Mostra valori' : 'Nascondi valori');
  localStorage.setItem('inj_monitor_privacy', active ? '1' : '0');
}

function applyTheme(theme, notify = false) {
  const themes = {
    navy: { label: 'Blu notte', color: '#030816' },
    black: { label: 'Nero', color: '#030405' },
    light: { label: 'Chiaro', color: '#eef5ff' }
  };
  const selected = themes[theme] ? theme : 'navy';
  document.documentElement.dataset.theme = selected;
  localStorage.setItem('inj_monitor_theme', selected);
  $('themeButton').dataset.theme = selected;
  $('themeButton').title = `Tema: ${themes[selected].label}`;
  $('themeButton').setAttribute('aria-label', `Tema attuale ${themes[selected].label}. Cambia tema`);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themes[selected].color);
  document.querySelectorAll('[data-theme-choice]').forEach((button) => {
    const active = button.dataset.themeChoice === selected;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  if (notify) toast(`Tema ${themes[selected].label}`);
}

function setThemePickerOpen(open) {
  $('themeControl').classList.toggle('open', open);
  $('themeButton').setAttribute('aria-expanded', open ? 'true' : 'false');
}

function toggleCurrency() {
  state.currency = state.currency === 'USD' ? 'EUR' : 'USD';
  $('currencyButton').textContent = state.currency === 'EUR' ? '€' : '$';
  $('currencyButton').title = state.currency === 'EUR' ? 'Valori in euro' : 'Valori in dollari';
  localStorage.setItem('inj_monitor_currency', state.currency);
  renderAll();
}

function bindEvents() {
  $('addressForm').addEventListener('submit', (event) => {
    event.preventDefault();
    loadWallet(true, $('addressInput').value);
  });
  $('searchButton').addEventListener('click', () => setSearchOpen(!$('headerSearch').classList.contains('open')));
  $('manageWalletsButton').addEventListener('click', () => {
    renderWalletManager();
    $('walletDialog').showModal();
  });
  $('closeWalletDialog').addEventListener('click', () => $('walletDialog').close());
  $('refreshButton').addEventListener('click', () => refreshAll(true));
  $('movementMoreButton').addEventListener('click', () => {
    if (state.address) loadWalletMovements(state.address, { append: true, force: true });
  });
  $('movementAllButton').addEventListener('click', () => {
    if (state.address) loadAllWalletMovements(state.address);
  });
  document.querySelectorAll('[data-movement-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      state.movementFilter = button.dataset.movementFilter || 'all';
      renderMovements();
    });
  });
  document.querySelectorAll('[data-history-range]').forEach((button) => {
    button.addEventListener('click', () => {
      state.historyRange = button.dataset.historyRange || '1M';
      localStorage.setItem('inj_monitor_history_range', state.historyRange);
      renderPortfolioHistory();
    });
  });
  $('compoundMode').addEventListener('change', () => {
    state.compoundMode = $('compoundMode').value === 'none' ? 'none' : 'daily';
    localStorage.setItem('inj_monitor_compound_mode', state.compoundMode);
    renderCompound();
    renderTarget();
  });
  $('compoundWeekly').addEventListener('input', () => {
    state.compoundWeekly = Math.max(0, number($('compoundWeekly').value));
    localStorage.setItem('inj_monitor_compound_weekly', String(state.compoundWeekly));
    renderCompound();
    renderTarget();
  });
  $('targetInput').addEventListener('change', () => {
    if (!state.address) return;
    const target = Math.max(1, number($('targetInput').value));
    state.targetByWallet[state.address] = target;
    saveTargets();
    renderTarget();
  });
  $('privacyButton').addEventListener('click', togglePrivacy);
  $('themeButton').addEventListener('click', () => {
    const open = !$('themeControl').classList.contains('open');
    if (open) setSearchOpen(false);
    setThemePickerOpen(open);
  });
  document.querySelectorAll('[data-theme-choice]').forEach((button) => {
    button.addEventListener('click', () => {
      applyTheme(button.dataset.themeChoice, true);
      setThemePickerOpen(false);
    });
  });
  $('currencyButton').addEventListener('click', toggleCurrency);
  document.addEventListener('pointerdown', (event) => {
    if ($('headerSearch').classList.contains('open') && !$('headerSearch').contains(event.target)) setSearchOpen(false);
    if ($('themeControl').classList.contains('open') && !$('themeControl').contains(event.target)) setThemePickerOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && $('headerSearch').classList.contains('open')) setSearchOpen(false);
    if (event.key === 'Escape' && $('themeControl').classList.contains('open')) setThemePickerOpen(false);
  });
  window.addEventListener('online', () => refreshAll(false));
  window.addEventListener('offline', () => setStatus('offline', 'Offline'));
  window.addEventListener('resize', () => {
    clearTimeout(bindEvents.historyResizeTimer);
    bindEvents.historyResizeTimer = setTimeout(renderPortfolioHistory, 80);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshAll(false);
  });
}

async function init() {
  try {
    state.currency = localStorage.getItem('inj_monitor_currency') === 'EUR' ? 'EUR' : 'USD';
    $('currencyButton').textContent = state.currency === 'EUR' ? '€' : '$';
    if (localStorage.getItem('inj_monitor_privacy') === '1') {
      document.body.classList.add('privacy-on');
      $('privacyButton').classList.add('active');
      $('privacyButton').setAttribute('aria-label', 'Mostra valori');
    }
    loadSavedWallets();
    loadAnalyticsStorage();
    const savedAddress = localStorage.getItem('inj_monitor_address') || '';
    const initialWallet = state.wallets.find((item) => item.address === savedAddress) || state.wallets[0];
    if (initialWallet) state.address = initialWallet.address;
    $('addressInput').value = state.address;
  } catch (_) {}

  $('compoundMode').value = state.compoundMode;
  $('compoundWeekly').value = String(state.compoundWeekly || 0);
  bindEvents();
  applyTheme(document.documentElement.dataset.theme);
  renderAll();
  renderWalletControls();
  loadEurRate();
  await loadMarket();
  connectMarketSocket();
  if (state.address) await loadWallet(false, state.address);
  state.suppressEffects = false;

  setInterval(loadMarket, 60_000);
  setInterval(() => refreshWalletSummaries(true), 120_000);
  setInterval(() => {
    if (state.address && !document.hidden && !state.loading) loadWallet(false, state.address);
  }, 30_000);
}

init();
