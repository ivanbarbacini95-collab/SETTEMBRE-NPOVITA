'use strict';

const $ = (id) => document.getElementById(id);
const INJ_DECIMALS = 1e18;
const OFFICIAL_APR_ENDPOINT = 'https://api.ui.injective.network/api/v1/cache/stats/apr';
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
  setValue('dailyEstimate', state.personalApr > 0 ? formatInj(dailyInj, 7) : '—', state.personalApr > 0 ? dailyInj : NaN);
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

async function loadWalletMovements(address, { append = false, force = false } = {}) {
  if (!validAddress(address)) return;
  let entry = state.movementsByWallet[address];
  if (!entry || !append) {
    if (entry?.loading) return;
    if (!force && entry?.rows?.length && Date.now() - number(entry.updated) < 60_000) {
      if (state.address === address) renderMovements();
      return;
    }
    entry = { rows: [], page: 0, senderTotal: 0, recipientTotal: 0, loading: false, complete: false, error: '', updated: 0 };
    state.movementsByWallet[address] = entry;
  }
  if (entry.loading || (append && entry.complete)) return;

  const page = append ? entry.page + 1 : 1;
  const limit = 50;
  entry.loading = true;
  entry.error = '';
  if (state.address === address) renderMovements();

  try {
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
    const combined = append ? [...entry.rows, ...nextRows] : nextRows;
    const unique = new Map();
    combined.forEach((row) => unique.set(row.id, row));
    entry.rows = [...unique.values()].sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)) || String(b.hash).localeCompare(String(a.hash)));
    entry.page = page;
    entry.senderTotal = movementTotal(senderData);
    entry.recipientTotal = movementTotal(recipientData);
    const senderDone = entry.senderTotal ? entry.page * limit >= entry.senderTotal : (senderData?.txs || []).length < limit;
    const recipientDone = entry.recipientTotal ? entry.page * limit >= entry.recipientTotal : (recipientData?.txs || []).length < limit;
    entry.complete = senderDone && recipientDone;
    entry.updated = Date.now();
  } catch (error) {
    console.error('Movimenti wallet:', error);
    entry.error = 'Impossibile leggere lo storico movimenti dalla rete Injective.';
  } finally {
    entry.loading = false;
    if (state.address === address) renderMovements();
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
  const walletLabel = $('movementWallet');
  if (!host || !count || !more || !walletLabel) return;

  host.replaceChildren();
  walletLabel.textContent = state.address ? state.address : 'Nessun wallet caricato';
  walletLabel.title = state.address || '';

  if (!state.address) {
    count.textContent = '0';
    more.hidden = true;
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Carica un wallet per vedere prelievi reward, staking, entrate e uscite.';
    host.appendChild(empty);
    return;
  }

  const entry = state.movementsByWallet[state.address];
  if (!entry || (entry.loading && !entry.rows.length)) {
    count.textContent = '…';
    more.hidden = true;
    const empty = document.createElement('div');
    empty.className = 'empty-state movement-loading';
    empty.textContent = 'Lettura movimenti dalla blockchain…';
    host.appendChild(empty);
    return;
  }

  count.textContent = String(entry.rows.length);
  more.hidden = entry.complete || (!entry.rows.length && !entry.loading);
  more.disabled = entry.loading;
  more.textContent = entry.loading ? 'Lettura…' : 'Carica altri';

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

  entry.rows.forEach((movement) => {
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
    const savedAddress = localStorage.getItem('inj_monitor_address') || '';
    const initialWallet = state.wallets.find((item) => item.address === savedAddress) || state.wallets[0];
    if (initialWallet) state.address = initialWallet.address;
    $('addressInput').value = state.address;
  } catch (_) {}

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
