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
  targetByWallet: {},
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

function loadTargetStorage() {
  try {
    const targets = JSON.parse(localStorage.getItem('inj_monitor_targets_v1') || '{}');
    state.targetByWallet = targets && typeof targets === 'object' ? targets : {};
  } catch (_) { state.targetByWallet = {}; }
  try {
    ['inj_monitor_portfolio_history_v1', 'inj_monitor_history_range', 'inj_monitor_compound_mode', 'inj_monitor_compound_weekly'].forEach((key) => localStorage.removeItem(key));
  } catch (_) {}
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

function setStatus(_mode, _message) {
  // Connection status is intentionally not rendered in the top bar.
}

function toast(message) {
  const host = $('toast');
  host.textContent = message;
  host.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => host.classList.remove('show'), 2200);
}

function flashValueCard(element, tone, cardFlash = true) {
  if (!cardFlash) return;
  const card = element.closest('.data-card');
  if (!card) return;
  const mode = cardFlash === 'soft' ? 'soft' : 'standard';
  const now = Date.now();
  if (now - number(card.dataset.lastFlash) <= 900) return;
  card.dataset.lastFlash = String(now);
  card.classList.remove('data-flash-up', 'data-flash-down', 'data-flash-soft-up', 'data-flash-soft-down');
  void card.offsetWidth;
  card.classList.add(mode === 'soft' ? `data-flash-soft-${tone}` : `data-flash-${tone}`);
  clearTimeout(card._flashTimer);
  card._flashTimer = setTimeout(() => {
    card.classList.remove('data-flash-up', 'data-flash-down', 'data-flash-soft-up', 'data-flash-soft-down');
  }, 780);
}

function pulseValue(element, tone, minInterval = 500) {
  const now = Date.now();
  if (now - number(element._lastPulseAt) < minInterval) return;
  element._lastPulseAt = now;
  element.classList.remove('value-pulse-up', 'value-pulse-down');
  void element.offsetWidth;
  element.classList.add(`value-pulse-${tone}`);
  clearTimeout(element._pulseTimer);
  element._pulseTimer = setTimeout(() => {
    element.classList.remove('value-pulse-up', 'value-pulse-down');
  }, 720);
}

function setValue(id, text, numericValue, options = {}) {
  const element = $(id);
  if (!element) return;

  const nextText = String(text);
  const next = Number(numericValue);
  const previousText = element.dataset.displayedValue ?? element.textContent ?? '';
  const previousNumeric = element.dataset.displayedNumeric === undefined
    ? NaN
    : Number(element.dataset.displayedNumeric);

  const textChanged = previousText !== nextText;
  const numericChanged = Number.isFinite(previousNumeric) && Number.isFinite(next) &&
    Math.abs(next - previousNumeric) > Math.max(1e-12, Math.abs(previousNumeric) * 1e-10);

  // Always keep ordinary text in the DOM. This avoids Safari changing the width,
  // baseline or height of financial values while they update.
  if (textChanged) element.textContent = nextText;
  element.dataset.renderedValue = nextText;
  element.dataset.displayedValue = nextText;
  if (Number.isFinite(next)) {
    element.dataset.numericValue = String(next);
    element.dataset.displayedNumeric = String(next);
  } else {
    delete element.dataset.numericValue;
    delete element.dataset.displayedNumeric;
  }

  if (!textChanged || options.animate === false || state.suppressEffects || !numericChanged) return;

  const movement = next > previousNumeric ? 'up' : 'down';
  const positiveWhen = options.positiveWhen || 'up';
  const positive = positiveWhen === 'down' ? movement === 'down' : movement === 'up';
  const tone = positive ? 'up' : 'down';
  const minInterval = Math.max(300, number(options.minInterval) || 500);

  pulseValue(element, tone, minInterval);
  flashValueCard(element, tone, options.cardFlash ?? (options.flash !== false));
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
  setValue('aggregateNetWorth', rows.length ? money(total.total * state.price) : '—', total.total * state.price, { cardFlash: false });
  setValue('aggregateTotalInj', rows.length ? formatInj(total.total, 3) : '—', total.total, { cardFlash: false });
  setValue('aggregateStaked', rows.length ? formatInj(total.staked, 3) : '—', total.staked, { cardFlash: false });
  setValue('aggregateRewards', rows.length ? formatInj(total.rewards, 4) : '—', total.rewards, { cardFlash: false });
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
  renderRewardTracker();
  renderTarget();
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
  // Mantieni sempre visibili gli ultimi dati validi durante la sincronizzazione.
  document.body.classList.toggle('wallet-syncing', loading);
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
  setValue('marketPrice', state.price > 0 ? money(state.price, 4) : '—', state.price || NaN, { cardFlash: true, minInterval: 900 });
  setValue('dayLow', state.low > 0 ? money(state.low, 3) : '—', state.low || NaN, { cardFlash: false });
  setValue('dayHigh', state.high > 0 ? money(state.high, 3) : '—', state.high || NaN, { cardFlash: false });

  const change = $('marketChange');
  const next = Number(state.change);
  setValue('marketChange', state.price > 0 ? `${next > 0 ? '+' : ''}${next.toFixed(2)}%` : '—', state.price > 0 ? next : NaN, { cardFlash: false, minInterval: 650 });
  change.className = `market-change ${next > 0 ? 'positive' : next < 0 ? 'negative' : 'neutral'}`;
  const amount = $('marketChangeAmount');
  setValue('marketChangeAmount', state.price > 0 ? usdt(state.changeAmount, 4) : '— USDT', state.price > 0 ? state.changeAmount : NaN, { cardFlash: false, minInterval: 650 });
  amount.className = state.changeAmount > 0 ? 'positive' : state.changeAmount < 0 ? 'negative' : '';
}

function renderPortfolio() {
  const totalInj = state.available + state.staked + state.rewards;
  const netWorth = totalInj * state.price;
  const netWorthChange24h = totalInj * state.changeAmount;
  // La barra di allocazione confronta solo INJ realmente in staking e INJ realmente disponibili.
  // Le reward non ancora prelevate fanno parte del patrimonio totale, ma non sono ancora saldo liquido.
  const allocatedInj = state.staked + state.available;
  const stakedShare = allocatedInj > 0 ? (state.staked / allocatedInj) * 100 : 0;
  const liquidShare = allocatedInj > 0 ? (state.available / allocatedInj) * 100 : 0;

  $('walletState').textContent = state.address ? shortAddress(state.address) : 'Wallet non caricato';
  setValue('netWorthUsd', state.address ? money(netWorth) : '—', state.address ? netWorth : NaN, { cardFlash: 'soft', minInterval: 1100 });
  setValue('netWorthInj', formatInj(totalInj, 4), totalInj, { cardFlash: false });
  setValue('availableInj', formatInj(state.available), state.available, { cardFlash: true, minInterval: 900 });
  setValue('availableUsd', money(state.available * state.price), state.available * state.price, { animate: false, cardFlash: false });
  setValue('stakedInj', formatInj(state.staked), state.staked, { cardFlash: true, minInterval: 900 });
  setValue('stakedUsd', money(state.staked * state.price), state.staked * state.price, { animate: false, cardFlash: false });
  setValue('rewardsInj', formatInj(state.rewards), state.rewards, { cardFlash: true, minInterval: 900 });
  setValue('rewardsUsd', money(state.rewards * state.price), state.rewards * state.price, { animate: false, cardFlash: false });
  setValue('aprValue', state.personalApr > 0 ? `${state.personalApr.toFixed(3)}%` : '—', state.personalApr || NaN, { cardFlash: false, minInterval: 1200 });
  setValue('stakedShare', `${stakedShare.toFixed(1)}%`, stakedShare, { animate: false, cardFlash: false });
  setValue('liquidShare', `${liquidShare.toFixed(1)}%`, liquidShare, { animate: false, cardFlash: false });
  const worthChange = $('netWorthChange24h');
  if (state.address && state.price > 0) {
    const label = netWorthChange24h > 0 ? 'Guadagno 24h' : netWorthChange24h < 0 ? 'Perdita 24h' : 'Variazione 24h';
    setValue('netWorthChange24h', `${label} ${signedMoney(netWorthChange24h, 2)} (${state.change > 0 ? '+' : ''}${state.change.toFixed(2)}%)`, netWorthChange24h, { cardFlash: false, minInterval: 800 });
    worthChange.className = `worth-change private ${netWorthChange24h > 0 ? 'positive' : netWorthChange24h < 0 ? 'negative' : 'neutral'}`;
  } else {
    setValue('netWorthChange24h', 'Variazione 24h —', NaN, { animate: false, cardFlash: false });
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

function renderRewardTracker() {
  const active = state.staked > 0 && state.personalApr > 0;
  const daily = active ? state.staked * (state.personalApr / 100) / 365 : 0;
  const hourly = daily / 24;
  const weekly = daily * 7;
  const monthly = daily * 30;
  const yearly = daily * 365;

  // Reward Tracker: i numeri possono scorrere/colorarsi, ma la card non fa mai glow.
  // Gli importi INJ dipendono da staking/APR; i controvalori fiat anche dal prezzo live.
  setValue('hourlyEstimate', active ? formatInj(hourly, 8) : '—', active ? hourly : NaN, { cardFlash: false, minInterval: 900 });
  setValue('hourlyUsd', active ? money(hourly * state.price, 4) : '—', active ? hourly * state.price : NaN, { animate: false, cardFlash: false });
  setValue('dailyEstimate', active ? formatInj(daily, 7) : '—', active ? daily : NaN, { cardFlash: false, minInterval: 900 });
  setValue('dailyUsd', active ? money(daily * state.price, 3) : '—', active ? daily * state.price : NaN, { animate: false, cardFlash: false });
  setValue('weeklyEstimate', active ? formatInj(weekly, 6) : '—', active ? weekly : NaN, { cardFlash: false, minInterval: 900 });
  setValue('weeklyUsd', active ? money(weekly * state.price, 3) : '—', active ? weekly * state.price : NaN, { animate: false, cardFlash: false });
  setValue('monthlyEstimate', active ? formatInj(monthly, 6) : '—', active ? monthly : NaN, { cardFlash: false, minInterval: 900 });
  setValue('monthlyUsd', active ? money(monthly * state.price) : '—', active ? monthly * state.price : NaN, { animate: false, cardFlash: false });
  setValue('yearlyEstimate', active ? formatInj(yearly, 5) : '—', active ? yearly : NaN, { cardFlash: false, minInterval: 900 });
  setValue('yearlyUsd', active ? money(yearly * state.price) : '—', active ? yearly * state.price : NaN, { animate: false, cardFlash: false });

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
  if (!(dailyRate > 0) || !(state.staked + state.rewards > 0)) return Infinity;
  let principal = Math.max(0, state.staked + state.rewards);
  const fixed = Math.max(0, state.available);
  const maxDays = 365 * 40;
  for (let day = 1; day <= maxDays; day++) {
    principal += principal * dailyRate;
    if (fixed + principal >= target) return day;
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
    $('targetPercentBadge').textContent = '—';
    $('targetEta').textContent = '—';
    return;
  }
  const total = currentTotalInj();
  const target = activeTarget();
  if (document.activeElement !== input) input.value = String(Number(target.toFixed(3)));
  const percent = target > 0 ? Math.min(100, (total / target) * 100) : 0;
  const missing = Math.max(0, target - total);
  setValue('targetProgressCopy', `${formatInj(total, 3)} / ${formatInj(target, 0)}`, total, { cardFlash: false });
  $('targetProgressBar').style.width = `${percent}%`;
  setValue('targetMissing', formatInj(missing, missing < 10 ? 4 : 2), missing, { cardFlash: false, positiveWhen: 'down' });
  setValue('targetPercent', `${percent.toFixed(2)}%`, percent, { cardFlash: false });
  setValue('targetPercentBadge', `${percent.toFixed(1)}%`, percent, { cardFlash: false });
  const targetDays = estimateTargetDays(target);
  setValue('targetEta', etaText(targetDays), Number.isFinite(targetDays) ? targetDays : NaN, { cardFlash: false, positiveWhen: 'down', minInterval: 900 });
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
  renderRewardTracker();
  renderTarget();
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
  const previousSuppress = state.suppressEffects;
  state.suppressEffects = true;
  renderAll();
  state.suppressEffects = previousSuppress;
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
  const applyTargetInput = ({ feedback = false } = {}) => {
    if (!state.address) {
      if (feedback) toast('Carica prima un wallet');
      return false;
    }
    const input = $('targetInput');
    const rawTarget = Number(String(input.value || '').replace(',', '.'));
    if (!Number.isFinite(rawTarget) || rawTarget <= 0) {
      if (feedback) toast('Inserisci un target INJ valido');
      input.focus();
      return false;
    }
    const target = Math.max(1, rawTarget);
    state.targetByWallet[state.address] = target;
    saveTargets();
    input.value = String(Number(target.toFixed(3)));
    renderTarget();
    if (feedback) toast(`Target aggiornato a ${formatInj(target, target % 1 ? 3 : 0)}`);
    return true;
  };

  $('targetApplyButton').addEventListener('click', () => {
    if (applyTargetInput({ feedback: true })) $('targetInput').blur();
  });

  $('targetInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (applyTargetInput({ feedback: true })) $('targetInput').blur();
    }
  });

  // Su iPhone il tasto Done/OK della tastiera può limitarsi a togliere il focus:
  // in quel caso il blur conferma comunque il nuovo target.
  $('targetInput').addEventListener('blur', () => {
    const saved = number(state.targetByWallet[state.address]);
    const typed = Number(String($('targetInput').value || '').replace(',', '.'));
    if (state.address && Number.isFinite(typed) && typed > 0 && Math.abs(typed - saved) > 1e-9) {
      applyTargetInput();
    } else {
      renderTarget();
    }
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
    loadTargetStorage();
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
  }, 10_000);
}

init();
