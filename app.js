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
  marketFrames: {
    d1: { open: 0, min: 0, max: 0, at: 0 },
    m1: { open: 0, min: 0, max: 0, at: 0 },
    y1: { open: 0, min: 0, max: 0, at: 0 },
    all: { open: 0, min: 0, max: 0, at: 0 }
  },
  marketFramesUpdated: 0,
  marketFramesLoading: false,
  marketExtremeFlashTimers: {},
  available: 0,
  staked: 0,
  rewards: 0,
  rewardSimulationPrice: 0,
  networkApr: 0,
  networkAprUpdated: 0,
  personalApr: 0,
  weightedCommission: 0,
  validators: [],
  validatorMeta: {},
  wallets: [],
  walletSummaries: {},
  summariesLoading: false,
  summariesLastRefresh: 0,
  targetByWallet: {},
  averagePriceByWallet: {},
  suppressEffects: true,
  currency: 'USD',
  eurRate: 0.86,
  endpoint: '',
  socket: null,
  walletRequest: 0,
  walletPendingAddress: '',
  loading: false,
  nativeChartRange: 'd1',
  nativeChartCache: {},
  nativeChart: { points: [], liveSamples: [], live: null, open: 0, min: 0, max: 0, start: 0, end: 0, loading: false, requestId: 0, renderPoints: [] },
  nativeChartResizeObserver: null,
  nativeChartRenderFrame: 0
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

function usdMoney(value, digits = 0) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(number(value));
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

function loadAveragePriceStorage() {
  try {
    const values = JSON.parse(localStorage.getItem('inj_monitor_average_buy_price_v1') || '{}');
    state.averagePriceByWallet = values && typeof values === 'object' ? values : {};
  } catch (_) { state.averagePriceByWallet = {}; }
}

function saveAveragePrices() {
  try { localStorage.setItem('inj_monitor_average_buy_price_v1', JSON.stringify(state.averagePriceByWallet)); } catch (_) {}
}

function currentAverageBuyPrice() {
  return state.address ? Math.max(0, number(state.averagePriceByWallet[state.address])) : 0;
}

function renderAveragePriceControl() {
  const input = $('averageBuyPrice');
  if (!input) return;
  input.disabled = !state.address;
  const average = currentAverageBuyPrice();
  if (document.activeElement !== input) input.value = average > 0 ? String(average) : '';
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

function setHeaderMenuOpen(open) {
  const host = $('headerMenu');
  if (!host) return;
  host.classList.toggle('open', open);
  $('menuButton')?.setAttribute('aria-expanded', open ? 'true' : 'false');
  $('menuButton')?.setAttribute('aria-label', open ? 'Chiudi menu' : 'Apri menu');
  if (!open) setThemePickerOpen(false);
}

function setSearchOpen(open) {
  if (open) {
    setThemePickerOpen(false);
    setHeaderMenuOpen(false);
  }
  $('headerSearch').classList.toggle('open', open);
  $('searchButton').setAttribute('aria-expanded', open ? 'true' : 'false');
  $('searchButton').setAttribute('aria-label', open ? 'Chiudi ricerca wallet' : 'Apri ricerca wallet');
  if (open) {
    $('addressInput').value = state.address || '';
    requestAnimationFrame(() => $('addressInput').focus());
  }
}

function summaryAge(updated) {
  const age = Math.max(0, Date.now() - number(updated));
  if (!(updated > 0)) return 'In attesa di sincronizzazione';
  if (age < 5_000) return 'Aggiornato ora';
  if (age < 60_000) return `Aggiornato ${Math.floor(age / 1000)}s fa`;
  if (age < 3_600_000) return `Aggiornato ${Math.floor(age / 60_000)}m fa`;
  return `Aggiornato ${Math.floor(age / 3_600_000)}h fa`;
}

function renderWalletCards() {
  const host = $('walletCards');
  if (!host) return;

  host.replaceChildren();
  if (!state.wallets.length) {
    const empty = document.createElement('span');
    empty.className = 'wallet-mini-empty';
    empty.textContent = 'Aggiungi un wallet con la lente';
    host.appendChild(empty);
    return;
  }

  state.wallets.forEach((wallet) => {
    const row = state.walletSummaries[wallet.address];
    const active = wallet.address === state.address;
    const fresh = Boolean(row && Date.now() - number(row.updated) < 90_000);

    const item = document.createElement('div');
    const switching = state.walletPendingAddress === wallet.address;
    item.className = `wallet-mini ${active ? 'active' : ''} ${fresh ? 'synced' : row ? 'cached' : 'loading'} ${switching ? 'switching' : ''}`.trim();

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'wallet-mini-main';
    open.title = `Apri ${wallet.label} · ${shortAddress(wallet.address)}`;
    open.setAttribute('aria-label', `Apri dettaglio ${wallet.label}`);
    open.setAttribute('aria-pressed', active ? 'true' : 'false');

    const heading = document.createElement('span');
    heading.className = 'wallet-mini-heading';

    const status = document.createElement('i');
    status.className = 'wallet-mini-status';
    status.setAttribute('aria-hidden', 'true');

    const name = document.createElement('strong');
    name.className = 'wallet-mini-name';
    name.textContent = wallet.label;

    heading.append(status, name);

    const total = document.createElement('span');
    total.className = 'wallet-mini-total private';
    total.textContent = row ? `${number(row.total).toLocaleString('it-IT', { maximumFractionDigits: 2 })} INJ` : '— INJ';

    const worth = document.createElement('small');
    worth.className = 'wallet-mini-worth private';
    worth.textContent = row && state.price > 0 ? money(row.total * state.price) : (fresh ? 'LIVE' : row ? 'CACHE' : 'SYNC');

    open.append(heading, total, worth);
    open.addEventListener('click', () => {
      if (!active || state.walletPendingAddress) loadWallet(true, wallet.address);
    });

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'wallet-mini-edit';
    edit.title = `Rinomina ${wallet.label}`;
    edit.setAttribute('aria-label', `Rinomina ${wallet.label}`);
    edit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></svg>';
    edit.addEventListener('click', (event) => {
      event.stopPropagation();
      openWalletManager(wallet.address);
    });

    item.append(open, edit);
    host.appendChild(item);
  });
}

function renderWalletControls() {
  $('savedWalletCount').textContent = `${state.wallets.length} salvat${state.wallets.length === 1 ? 'o' : 'i'}`;
  renderWalletCards();
  renderWalletManager();
  renderAggregate();
}

function openWalletManager(address = '') {
  renderWalletManager();
  const dialog = $('walletDialog');
  if (!dialog.open) dialog.showModal();
  if (!address) return;
  requestAnimationFrame(() => {
    const input = [...dialog.querySelectorAll('.wallet-manager-copy input')]
      .find((field) => field.dataset.walletAddress === address);
    if (input) {
      input.focus();
      input.select();
    }
  });
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
    input.dataset.walletAddress = wallet.address;
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

function setStatus(mode, message) {
  const host = $('connectionStatus');
  host.className = `connection ${mode || ''}`.trim();
  $('statusText').textContent = message;
  host.title = message;
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

  // La card si illumina solo in risposta a una variazione realmente visibile.
  // Il piccolo lock evita che due valori della stessa card provochino flash sovrapposti
  // durante lo stesso ciclo di rendering.
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

  const nextText = String(text);
  const previousText = element.dataset.renderedValue;
  const next = Number(numericValue);
  const previous = element.dataset.numericValue === undefined ? NaN : Number(element.dataset.numericValue);

  // Un dato e' considerato cambiato solo quando cambia anche cio' che l'utente vede.
  // Questo elimina i flash causati da refresh identici o da micro-variazioni nascoste
  // dall'arrotondamento del valore mostrato.
  const visibleChange = previousText !== undefined && previousText !== nextText;
  const numericChange = Number.isFinite(previous) && Number.isFinite(next) &&
    Math.abs(next - previous) > Math.max(1e-12, Math.abs(previous) * 1e-10);

  element.textContent = nextText;

  if (flash && !state.suppressEffects && visibleChange && numericChange) {
    signalChange(element, previous, next);
  }

  element.dataset.renderedValue = nextText;
  if (Number.isFinite(next)) element.dataset.numericValue = String(next);
  else delete element.dataset.numericValue;
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
  if (!force && Date.now() - state.summariesLastRefresh < 25_000) return;
  state.summariesLoading = true;
  state.summariesLastRefresh = Date.now();
  renderAggregate();
  let cursor = 0;
  const addresses = state.wallets.map((item) => item.address).filter((address) => {
    const row = state.walletSummaries[address];
    return force || address !== state.address || !row || Date.now() - number(row.updated) > 20_000;
  });
  if (!addresses.length) {
    state.summariesLoading = false;
    renderAggregate();
    renderWalletCards();
    return;
  }
  const worker = async () => {
    while (cursor < addresses.length) {
      const address = addresses[cursor++];
      try {
        state.walletSummaries[address] = await loadWalletSummary(address);
        saveWalletSummaries();
        renderAggregate();
        renderWalletCards();
      } catch (_) {}
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, addresses.length) }, worker));
  state.summariesLoading = false;
  renderAggregate();
  renderWalletCards();
}

function aggregateCollapsedPreference() {
  try { return localStorage.getItem('inj_monitor_aggregate_collapsed_v1') === '1'; }
  catch (_) { return false; }
}

function setAggregateCollapsed(collapsed, persist = true) {
  const section = $('aggregateSection');
  if (!section) return;
  const next = Boolean(collapsed);
  section.classList.toggle('collapsed', next);
  section.setAttribute('aria-expanded', next ? 'false' : 'true');
  section.title = next ? 'Mostra il totale multi-wallet' : 'Nascondi il totale multi-wallet';
  if (persist) {
    try { localStorage.setItem('inj_monitor_aggregate_collapsed_v1', next ? '1' : '0'); } catch (_) {}
  }
}

function toggleAggregate() {
  const section = $('aggregateSection');
  if (!section || section.hidden) return;
  setAggregateCollapsed(!section.classList.contains('collapsed'));
}

function renderAggregate() {
  const section = $('aggregateSection');
  const enabled = state.wallets.length > 1;
  section.hidden = !enabled;
  if (!enabled) return;
  setAggregateCollapsed(aggregateCollapsedPreference(), false);
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
    : `${rows.length}/${state.wallets.length} wallet aggiornati`;
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


function loadMarketFrameCache() {
  try {
    const cached = JSON.parse(localStorage.getItem('inj_monitor_market_frames_v2') || '{}');
    ['m1', 'y1', 'all'].forEach((key) => {
      const row = cached?.[key];
      if (number(row?.open) > 0 && number(row?.min) > 0 && number(row?.max) > 0) {
        state.marketFrames[key] = {
          open: number(row.open),
          min: number(row.min),
          max: number(row.max),
          at: number(row.at)
        };
      }
    });
    state.marketFramesUpdated = number(cached?.updated);
  } catch (_) {}
}

function saveMarketFrameCache() {
  try {
    localStorage.setItem('inj_monitor_market_frames_v2', JSON.stringify({
      m1: state.marketFrames.m1,
      y1: state.marketFrames.y1,
      all: state.marketFrames.all,
      updated: state.marketFramesUpdated
    }));
  } catch (_) {}
}

async function binanceKlineRange(startTime, interval = '1d') {
  const data = await fetchJson(`https://api.binance.com/api/v3/klines?symbol=INJUSDT&interval=${interval}&startTime=${Math.max(0, Math.floor(startTime))}&limit=1000`, 9000);
  const rows = Array.isArray(data) ? data : [];
  if (!rows.length) return { open: 0, min: 0, max: 0, at: 0 };
  const valid = rows.filter((row) => number(row?.[1]) > 0 && number(row?.[2]) > 0 && number(row?.[3]) > 0);
  if (!valid.length) return { open: 0, min: 0, max: 0, at: 0 };
  return {
    open: number(valid[0][1]),
    min: Math.min(...valid.map((row) => number(row[3]))),
    max: Math.max(...valid.map((row) => number(row[2]))),
    at: number(valid[0][0])
  };
}

async function loadMarketTimeframes(force = false) {
  if (state.marketFramesLoading) return;
  if (!force && state.marketFramesUpdated && Date.now() - state.marketFramesUpdated < 15 * 60_000) return;
  state.marketFramesLoading = true;
  try {
    const now = new Date();
    const monthAgo = new Date(now);
    monthAgo.setMonth(monthAgo.getMonth() - 1);
    const yearAgo = new Date(now);
    yearAgo.setFullYear(yearAgo.getFullYear() - 1);

    const [monthResult, yearResult, allResult] = await Promise.allSettled([
      binanceKlineRange(monthAgo.getTime(), '1d'),
      binanceKlineRange(yearAgo.getTime(), '1d'),
      binanceKlineRange(0, '1M')
    ]);

    if (monthResult.status === 'fulfilled' && monthResult.value.open > 0) state.marketFrames.m1 = monthResult.value;
    if (yearResult.status === 'fulfilled' && yearResult.value.open > 0) state.marketFrames.y1 = yearResult.value;
    if (allResult.status === 'fulfilled' && allResult.value.open > 0) state.marketFrames.all = allResult.value;

    if ([state.marketFrames.m1.open, state.marketFrames.y1.open, state.marketFrames.all.open].some((value) => value > 0)) {
      state.marketFramesUpdated = Date.now();
      saveMarketFrameCache();
    }
    renderMarketTimeframes();
  } catch (_) {
    renderMarketTimeframes();
  } finally {
    state.marketFramesLoading = false;
  }
}

function marketFramePrefix(key) {
  return ({ d1: '1d', m1: '1m', y1: '1y', all: 'All' })[key] || '';
}

function flashMarketFrameExtreme(key, side) {
  if (state.suppressEffects || document.hidden) return;
  const prefix = marketFramePrefix(key);
  const suffix = side === 'min' ? 'Min' : 'Max';
  const elements = [`tf${prefix}${suffix}`, `wtf${prefix}${suffix}`].map($).filter(Boolean);
  if (!elements.length) return;

  const timerKey = `${key}:${side}`;
  clearTimeout(state.marketExtremeFlashTimers[timerKey]);
  elements.forEach((element) => {
    element.classList.remove('market-extreme-flash');
    void element.offsetWidth;
    element.classList.add('market-extreme-flash');
  });
  state.marketExtremeFlashTimers[timerKey] = setTimeout(() => {
    elements.forEach((element) => element.classList.remove('market-extreme-flash'));
    delete state.marketExtremeFlashTimers[timerKey];
  }, 2400);
}

function updateLiveMarketFrameExtremes(current) {
  if (!(number(current) > 0)) return false;
  let changed = false;
  const tolerance = Math.max(1e-10, number(current) * 1e-10);

  ['m1', 'y1', 'all'].forEach((key) => {
    const frame = state.marketFrames[key];
    if (!(number(frame?.open) > 0) || !(number(frame?.min) > 0) || !(number(frame?.max) > 0)) return;

    if (current < number(frame.min) - tolerance) {
      frame.min = current;
      changed = true;
      requestAnimationFrame(() => flashMarketFrameExtreme(key, 'min'));
    }
    if (current > number(frame.max) + tolerance) {
      frame.max = current;
      changed = true;
      requestAnimationFrame(() => flashMarketFrameExtreme(key, 'max'));
    }
  });

  if (changed) saveMarketFrameCache();
  return changed;
}

function marketCenteredRangePosition(value, min, open, max) {
  const v = number(value);
  const lo = number(min);
  const op = number(open);
  const hi = number(max);
  if (!(v > 0) || !(lo > 0) || !(op > 0) || !(hi > 0)) return 50;

  // L'apertura resta sempre al centro. Le due meta' della barra hanno
  // scale indipendenti: Min -> Apertura occupa 0-50%, Apertura -> Max 50-100%.
  if (v <= op) {
    if (!(op > lo)) return 50;
    const ratio = (v - lo) / (op - lo);
    return Math.max(1.5, Math.min(50, ratio * 50));
  }

  if (!(hi > op)) return 50;
  const ratio = (v - op) / (hi - op);
  return Math.max(50, Math.min(98.5, 50 + ratio * 50));
}

function renderMarketFrame(key, prefix) {
  const row = $(`tf${prefix}Row`);
  const minEl = $(`tf${prefix}Min`);
  const openEl = $(`tf${prefix}Open`);
  const maxEl = $(`tf${prefix}Max`);
  const changeEl = $(`tf${prefix}Change`);
  const track = $(`tf${prefix}Track`);
  if (!row || !minEl || !openEl || !maxEl || !changeEl || !track) return;

  const frame = state.marketFrames[key] || {};
  const open = number(frame.open);
  const current = number(state.price);
  let min = number(frame.min);
  let max = number(frame.max);

  if (!(open > 0) || !(current > 0) || !(min > 0) || !(max > 0)) {
    minEl.textContent = '—';
    openEl.textContent = open > 0 ? money(open, open < 1 ? 4 : 3) : '—';
    maxEl.textContent = '—';
    changeEl.textContent = '—';
    row.className = 'market-tf neutral';
    track.style.setProperty('--tf-pos', '50%');
    track.style.setProperty('--tf-open-pos', '50%');
    track.style.setProperty('--tf-fill-start', '50%');
    track.style.setProperty('--tf-fill-width', '0%');
    return;
  }

  min = Math.min(min, open, current);
  max = Math.max(max, open, current);
  const openPosition = 50;
  const currentPosition = marketCenteredRangePosition(current, min, open, max);
  const start = Math.min(50, currentPosition);
  const width = Math.abs(currentPosition - 50);
  const changePercent = ((current / open) - 1) * 100;
  const digits = (value) => value < 1 ? 4 : value >= 100 ? 2 : 3;

  minEl.textContent = money(min, digits(min));
  openEl.textContent = money(open, digits(open));
  maxEl.textContent = money(max, digits(max));
  changeEl.textContent = `${changePercent > 0 ? '+' : ''}${changePercent.toFixed(Math.abs(changePercent) >= 100 ? 1 : 2)}%`;
  row.className = `market-tf ${changePercent > 0 ? 'positive' : changePercent < 0 ? 'negative' : 'neutral'}`;
  track.style.setProperty('--tf-pos', `${currentPosition.toFixed(3)}%`);
  track.style.setProperty('--tf-open-pos', '50%');
  track.style.setProperty('--tf-fill-start', `${start.toFixed(3)}%`);
  track.style.setProperty('--tf-fill-width', `${width.toFixed(3)}%`);
  track.title = `Min ${money(min, digits(min))} · Apertura ${money(open, digits(open))} · Ora ${money(current, digits(current))} · Max ${money(max, digits(max))}`;
}

function renderMarketTimeframes() {
  renderMarketFrame('d1', '1d');
  renderMarketFrame('m1', '1m');
  renderMarketFrame('y1', '1y');
  renderMarketFrame('all', 'All');
}

function timeframeCollapsedPreference(kind) {
  try { return localStorage.getItem(`inj_monitor_${kind}_timeframes_collapsed_v1`) === '1'; }
  catch (_) { return false; }
}

function setTimeframeCollapsed(kind, collapsed, persist = true) {
  if (kind !== 'market') return;
  const card = $('marketCard');
  const toggle = $('marketTimeframeToggle');
  const panel = $('marketTimeframesPanel');
  if (!card || !toggle || !panel) return;
  const next = Boolean(collapsed);
  card.classList.toggle('timeframes-collapsed', next);
  panel.hidden = next;
  toggle.setAttribute('aria-expanded', next ? 'false' : 'true');
  toggle.title = next ? 'Mostra i timeframe' : 'Nascondi i timeframe';
  if (persist) {
    try { localStorage.setItem('inj_monitor_market_timeframes_collapsed_v1', next ? '1' : '0'); } catch (_) {}
  }
}

function toggleTimeframes(kind) {
  if (kind !== 'market') return;
  const card = $('marketCard');
  if (!card) return;
  setTimeframeCollapsed('market', !card.classList.contains('timeframes-collapsed'));
}

function trackerCollapsedPreference(kind) {
  try { return localStorage.getItem(`inj_monitor_${kind}_tracker_collapsed_v1`) === '1'; }
  catch (_) { return false; }
}

function setTrackerCollapsed(kind, collapsed, persist = true) {
  const reward = kind === 'reward';
  const card = reward ? $('yieldCard') : $('targetCard');
  const panel = reward ? $('rewardTrackerPanel') : $('targetTrackerPanel');
  const toggle = reward ? $('rewardTrackerToggle') : $('targetTrackerToggle');
  if (!card || !panel || !toggle) return;

  const next = Boolean(collapsed);
  card.classList.toggle('tracker-collapsed', next);
  panel.hidden = next;
  toggle.setAttribute('aria-expanded', next ? 'false' : 'true');
  toggle.title = next ? `Mostra i dati ${reward ? 'Reward Tracker' : 'Target Tracker'}` : `Nascondi i dati ${reward ? 'Reward Tracker' : 'Target Tracker'}`;
  if (persist) {
    try { localStorage.setItem(`inj_monitor_${kind}_tracker_collapsed_v1`, next ? '1' : '0'); } catch (_) {}
  }
}

function toggleTracker(kind) {
  const card = kind === 'reward' ? $('yieldCard') : $('targetCard');
  if (!card) return;
  setTrackerCollapsed(kind, !card.classList.contains('tracker-collapsed'));
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
  const previousD1 = { ...state.marketFrames.d1 };
  const nextPrice = number(next.price);
  if (nextPrice > 0) state.price = nextPrice;
  if (Number.isFinite(Number(next.change))) state.change = Number(next.change);
  if (Number.isFinite(Number(next.changeAmount))) state.changeAmount = Number(next.changeAmount);
  if (number(next.low) > 0) state.low = number(next.low);
  if (number(next.high) > 0) state.high = number(next.high);

  if (number(next.open24h) > 0 && number(next.low) > 0 && number(next.high) > 0) {
    const nextD1 = { open: number(next.open24h), min: number(next.low), max: number(next.high), at: Date.now() - 86_400_000 };
    const tolerance = Math.max(1e-10, number(state.price) * 1e-10);
    const newMin = number(previousD1.min) > 0 && nextD1.min < number(previousD1.min) - tolerance;
    const newMax = number(previousD1.max) > 0 && nextD1.max > number(previousD1.max) + tolerance;
    state.marketFrames.d1 = nextD1;
    if (newMin) requestAnimationFrame(() => flashMarketFrameExtreme('d1', 'min'));
    if (newMax) requestAnimationFrame(() => flashMarketFrameExtreme('d1', 'max'));
  }

  updateLiveMarketFrameExtremes(state.price);
  renderMarket();
  renderPortfolio();
  renderRewardTracker();
  renderTarget();
  renderAggregate();
  updateNativeChartLive(state.price);
}

async function loadMarket() {
  try {
    const ticker = await fetchJson('https://api.binance.com/api/v3/ticker/24hr?symbol=INJUSDT');
    updateMarket({
      price: ticker.lastPrice,
      change: ticker.priceChangePercent,
      changeAmount: ticker.priceChange,
      low: ticker.lowPrice,
      high: ticker.highPrice,
      open24h: ticker.openPrice
    });
    setStatus('online', state.address ? 'Wallet online' : 'Mercato live');
  } catch (primaryError) {
    try {
      const data = await fetchJson('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=injective-protocol&sparkline=false');
      const coin = data?.[0];
      const fallbackPrice = number(coin?.current_price);
      const fallbackChangeAmount = number(coin?.price_change_24h);
      updateMarket({ price: fallbackPrice, change: coin?.price_change_percentage_24h, changeAmount: fallbackChangeAmount, low: coin?.low_24h, high: coin?.high_24h, open24h: fallbackPrice - fallbackChangeAmount });
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
        updateMarket({ price: tick.c, change: tick.P, changeAmount: tick.p, low: tick.l, high: tick.h, open24h: tick.o });
      } catch (_) {}
    };
    socket.onerror = () => setStatus('', 'Riconnessione…');
    socket.onclose = () => setTimeout(connectMarketSocket, 4000);
  } catch (_) {
    setTimeout(connectMarketSocket, 5000);
  }
}

async function loadValidator(row) {
  const cached = state.validatorMeta[row.operator];
  if (cached && Date.now() - number(cached.updated) < 10 * 60_000) {
    return { ...row, ...cached };
  }
  try {
    const response = await lcd(`/cosmos/staking/v1beta1/validators/${row.operator}`);
    const validator = response?.validator || {};
    const meta = {
      moniker: validator?.description?.moniker || shortAddress(row.operator),
      commission: Math.max(0, Math.min(1, rate(validator?.commission?.commission_rates?.rate))),
      status: validator?.status || '',
      jailed: Boolean(validator?.jailed),
      updated: Date.now()
    };
    state.validatorMeta[row.operator] = meta;
    return { ...row, ...meta };
  } catch (_) {
    if (cached) return { ...row, ...cached };
    return { ...row, moniker: shortAddress(row.operator), commission: 0, status: '', jailed: false };
  }
}

async function ensureNetworkApr(force = false) {
  if (!force && state.networkApr > 0 && Date.now() - state.networkAprUpdated < 5 * 60_000) {
    return state.networkApr;
  }

  const [annual, pool, distribution, officialApr] = await Promise.all([
    lcd('/cosmos/mint/v1beta1/annual_provisions'),
    lcd('/cosmos/staking/v1beta1/pool'),
    lcd('/cosmos/distribution/v1beta1/params').catch(() => null),
    fetchJson(OFFICIAL_APR_ENDPOINT, 7000).catch(() => null)
  ]);

  const officialBaseApr = aprPercent(officialApr?.apr);
  const annualProvisions = number(annual?.annual_provisions);
  const bondedTokens = number(pool?.pool?.bonded_tokens);
  const communityTax = rate(distribution?.params?.community_tax);
  const fallbackGrossApr = bondedTokens > 0 ? (annualProvisions / bondedTokens) * 100 : 0;
  const fallbackDelegatorApr = fallbackGrossApr * Math.max(0, 1 - communityTax);
  const nextApr = officialBaseApr || fallbackDelegatorApr;
  if (nextApr > 0) {
    state.networkApr = nextApr;
    state.networkAprUpdated = Date.now();
  }
  return state.networkApr;
}

function activateWalletImmediately(address) {
  const wallet = ensureSavedWallet(address);
  const cached = state.walletSummaries[address];

  state.address = address;
  state.walletPendingAddress = address;
  state.suppressEffects = true;
  state.available = number(cached?.available);
  state.staked = number(cached?.staked);
  state.rewards = number(cached?.rewards);
  state.validators = Array.isArray(cached?.validators) ? cached.validators : [];
  state.personalApr = number(cached?.personalApr);
  state.weightedCommission = number(cached?.weightedCommission);
  if (number(cached?.networkApr) > 0) state.networkApr = number(cached.networkApr);

  $('addressInput').value = address;
  $('lastUpdate').textContent = cached?.updated
    ? new Date(cached.updated).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—';
  setStatus('', `Apertura ${wallet.label}…`);
  renderAll();
  renderWalletControls();
  setSearchOpen(false);
}

function setLoading(loading) {
  state.loading = loading;
  $('loadButton').disabled = loading;
  const refreshMenuButton = $('refreshMenuButton');
  if (refreshMenuButton) {
    refreshMenuButton.disabled = loading;
    refreshMenuButton.classList.toggle('loading', loading);
  }
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
  const requestId = ++state.walletRequest;

  // Feedback immediato: selezione e snapshot locale cambiano prima delle chiamate di rete.
  if (switchingWallet) activateWalletImmediately(address);
  else {
    state.walletPendingAddress = address;
    renderWalletCards();
    setStatus('', 'Aggiornamento wallet…');
  }

  setLoading(true);
  const aprPromise = ensureNetworkApr(false).catch(() => state.networkApr);

  try {
    // Primo stadio: i tre dati essenziali. Appena arrivano, aggiorniamo subito la UI.
    const [bank, delegations, rewards] = await Promise.all([
      lcd(`/cosmos/bank/v1beta1/balances/${address}`),
      lcd(`/cosmos/staking/v1beta1/delegations/${address}`),
      lcd(`/cosmos/distribution/v1beta1/delegators/${address}/rewards`)
    ]);
    if (requestId !== state.walletRequest) return;

    const validatorRows = delegationRows(delegations);
    state.address = address;
    state.available = findInj(bank?.balances || []);
    state.staked = validatorRows.reduce((sum, item) => sum + item.amount, 0);
    state.rewards = rewardTotal(rewards);

    const previous = state.walletSummaries[address] || {};
    state.walletSummaries[address] = {
      ...previous,
      available: state.available,
      staked: state.staked,
      rewards: state.rewards,
      total: state.available + state.staked + state.rewards,
      updated: Date.now()
    };
    saveWalletSummaries();
    ensureSavedWallet(address);
    $('addressInput').value = address;
    $('lastUpdate').textContent = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // Il patrimonio cambia già qui, senza aspettare APR/validator.
    renderPortfolio();
    renderTarget();
    renderAggregate();
    renderWalletCards();
    setStatus('', 'Dati principali aggiornati…');

    // Secondo stadio: dettagli più costosi. Sono cache-izzati e non bloccano il cambio wallet.
    const [validators] = await Promise.all([
      Promise.all(validatorRows.map(loadValidator)),
      aprPromise
    ]);
    if (requestId !== state.walletRequest) return;

    state.validators = validators;
    await aprPromise;
    if (requestId !== state.walletRequest) return;
    calculatePersonalApr();

    state.walletSummaries[address] = {
      ...state.walletSummaries[address],
      validators,
      personalApr: state.personalApr,
      weightedCommission: state.weightedCommission,
      networkApr: state.networkApr,
      updated: Date.now()
    };
    saveWalletSummaries();

    state.walletPendingAddress = '';
    setStatus('online', 'Wallet online');
    renderAll();
    renderWalletControls();
    state.suppressEffects = false;
    if (showFeedback) toast(switchingWallet ? 'Wallet aperto' : 'Dati wallet aggiornati');
  } catch (error) {
    if (requestId !== state.walletRequest) return;
    console.error(error);
    state.walletPendingAddress = '';
    setStatus('offline', 'Errore rete Injective');
    renderWalletCards();
    if (showFeedback) toast('Impossibile aggiornare il wallet');
  } finally {
    if (requestId === state.walletRequest) {
      state.walletPendingAddress = '';
      state.suppressEffects = false;
      setLoading(false);
      renderWalletCards();
    }
  }
}

function syncFocusDisplayViewport() {
  const dialog = $('focusDisplayDialog');
  if (!dialog?.open) return;
  const viewport = window.visualViewport;
  const top = viewport ? viewport.offsetTop : 0;
  const left = viewport ? viewport.offsetLeft : 0;
  const width = viewport ? viewport.width : window.innerWidth;
  const height = viewport ? viewport.height : window.innerHeight;
  dialog.style.setProperty('--focus-viewport-top', `${Math.round(top)}px`);
  dialog.style.setProperty('--focus-viewport-left', `${Math.round(left)}px`);
  dialog.style.setProperty('--focus-viewport-width', `${Math.round(width)}px`);
  dialog.style.setProperty('--focus-viewport-height', `${Math.round(height)}px`);
}

function setFocusDisplayValue(element, text, numericValue) {
  if (!element) return;
  const next = Number(numericValue);
  const previous = element.dataset.focusNumericValue === undefined ? NaN : Number(element.dataset.focusNumericValue);
  const previousText = element.dataset.focusRenderedValue;
  const nextText = String(text);

  element.textContent = nextText;

  const visibleChange = previousText !== undefined && previousText !== nextText;
  const numericChange = Number.isFinite(previous) && Number.isFinite(next) &&
    Math.abs(next - previous) > Math.max(1e-12, Math.abs(previous) * 1e-10);

  if ($('focusDisplayDialog')?.open && !state.suppressEffects && visibleChange && numericChange) {
    const direction = next > previous ? 'up' : 'down';
    element.classList.remove('focus-value-up', 'focus-value-down');
    void element.offsetWidth;
    element.classList.add(`focus-value-${direction}`);
    clearTimeout(element._focusValueTimer);
    element._focusValueTimer = setTimeout(() => {
      element.classList.remove('focus-value-up', 'focus-value-down');
    }, 1250);
  }

  element.dataset.focusRenderedValue = nextText;
  if (Number.isFinite(next)) element.dataset.focusNumericValue = String(next);
  else delete element.dataset.focusNumericValue;
}

function renderFocusDisplay() {
  const price = $('focusDisplayPrice');
  const worth = $('focusDisplayWorth');
  const priceValue = state.price > 0 ? state.price : NaN;
  setFocusDisplayValue(price, state.price > 0 ? money(state.price, state.price < 10 ? 3 : 2) : '—', priceValue);

  const change = $('focusDisplayChange24h');
  if (change) {
    const next = Number(state.change);
    change.textContent = state.price > 0 ? `${next > 0 ? '+' : ''}${next.toFixed(2)}% · 24H` : '— · 24H';
    change.className = `focus-display-change ${next > 0 ? 'positive' : next < 0 ? 'negative' : 'neutral'}`;
  }

  const activeWallet = state.wallets.find((wallet) => wallet.address === state.address);
  if ($('focusDisplayWallet')) $('focusDisplayWallet').textContent = activeWallet?.label || (state.address ? shortAddress(state.address) : 'Wallet non caricato');

  const total = currentTotalInj();
  const value = total * state.price;
  if (worth) {
    setFocusDisplayValue(
      worth,
      state.address && state.price > 0 ? money(value, 2) : '—',
      state.address && state.price > 0 ? value : NaN
    );
  }

  if ($('focusDisplayTotalInj')) {
    $('focusDisplayTotalInj').textContent = state.address ? formatInj(total, 4) : '—';
  }

  const dailyReward = state.staked > 0 && state.personalApr > 0
    ? state.staked * (state.personalApr / 100) / 365
    : 0;
  if ($('focusDisplayDailyReward')) {
    $('focusDisplayDailyReward').textContent = dailyReward > 0
      ? `+${dailyReward.toLocaleString('it-IT', { minimumFractionDigits: 6, maximumFractionDigits: 6 })} INJ / giorno`
      : 'Reward / giorno —';
  }

  if ($('focusDisplayRangeMin')) $('focusDisplayRangeMin').textContent = state.low > 0 ? money(state.low, state.low < 10 ? 3 : 2) : '—';
  if ($('focusDisplayRangeMax')) $('focusDisplayRangeMax').textContent = state.high > 0 ? money(state.high, state.high < 10 ? 3 : 2) : '—';
  const span = state.high - state.low;
  const rangePosition = span > 0 && state.price > 0
    ? Math.max(0, Math.min(100, ((state.price - state.low) / span) * 100))
    : 50;
  if ($('focusDisplayRangeMarker')) $('focusDisplayRangeMarker').style.left = `${rangePosition}%`;
  if ($('focusDisplayRangeFill')) $('focusDisplayRangeFill').style.width = `${rangePosition}%`;
}

function openFocusDisplay() {
  const dialog = $('focusDisplayDialog');
  if (!dialog) return;
  setHeaderMenuOpen(false);
  setSearchOpen(false);
  renderFocusDisplay();
  if (!dialog.open) dialog.showModal();
  document.body.classList.add('focus-display-open');
  requestAnimationFrame(syncFocusDisplayViewport);
}

function closeFocusDisplay() {
  const dialog = $('focusDisplayDialog');
  if (!dialog?.open) return;
  dialog.close();
  document.body.classList.remove('focus-display-open');
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

  const terminalPrice = $('chartHeaderPrice');
  const terminalChange = $('chartHeaderChange');
  if (terminalPrice) {
    terminalPrice.textContent = state.price > 0
      ? `$${state.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: state.price < 10 ? 4 : 2 })}`
      : '$—';
  }
  if (terminalChange) {
    terminalChange.textContent = state.price > 0 ? `${next > 0 ? '+' : ''}${next.toFixed(2)}% · 24H` : '—';
    terminalChange.className = next > 0 ? 'positive' : next < 0 ? 'negative' : 'neutral';
  }
  renderMarketTimeframes();
  renderFocusDisplay();
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

  const activeWallet = state.wallets.find((wallet) => wallet.address === state.address);
  $('walletState').textContent = activeWallet ? `${activeWallet.label} · ${shortAddress(state.address)}` : state.address ? shortAddress(state.address) : 'Wallet non caricato';
  setValue('netWorthUsd', state.address ? money(netWorth) : '—', state.address ? netWorth : NaN, { flash: false });
  setValue('netWorthInj', formatInj(totalInj, 4), totalInj);
  setValue('availableInj', formatInj(state.available), state.available);
  setValue('availableUsd', money(state.available * state.price), state.available * state.price, { flash: false });
  setValue('ownedTotalInj', formatInj(totalInj), totalInj);
  setValue('ownedTotalUsd', money(totalInj * state.price), totalInj * state.price, { flash: false });
  const ownedVsStaked = Math.max(0, totalInj - state.staked);
  setValue('ownedVsStakedInj', formatInj(ownedVsStaked), ownedVsStaked);
  setValue('stakedInj', formatInj(state.staked), state.staked);
  setValue('stakedUsd', money(state.staked * state.price), state.staked * state.price, { flash: false });
  setValue('rewardsInj', formatInj(state.rewards), state.rewards);
  setValue('rewardsUsd', money(state.rewards * state.price), state.rewards * state.price, { flash: false });
  setValue('aprValue', state.personalApr > 0 ? `${state.personalApr.toFixed(3)}%` : '—', state.personalApr || NaN);
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

  const pnlElement = $('netWorthPnl');
  const averageBuyPrice = currentAverageBuyPrice();
  if (state.address && state.price > 0 && averageBuyPrice > 0) {
    const costBasis = totalInj * averageBuyPrice;
    const pnl = netWorth - costBasis;
    const pnlPercent = averageBuyPrice > 0 ? ((state.price / averageBuyPrice) - 1) * 100 : 0;
    const prefix = pnl > 0 ? '+' : pnl < 0 ? '−' : '';
    pnlElement.textContent = `PnL totale ${prefix}${money(Math.abs(pnl), 2)} (${pnlPercent > 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)`;
    pnlElement.className = `worth-change private ${pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : 'neutral'}`;
  } else {
    pnlElement.textContent = 'PnL totale —';
    pnlElement.className = 'worth-change private neutral';
  }
  renderAveragePriceControl();
  $('allocationBar').style.width = `${Math.max(0, Math.min(100, stakedShare))}%`;
  renderFocusDisplay();
}


function currentTotalInj() {
  return state.available + state.staked + state.rewards;
}

function clearRewardSimulation() {
  if (!(state.rewardSimulationPrice > 0) && !$('rewardSimPrice')?.value) return;
  state.rewardSimulationPrice = 0;
  if ($('rewardSimPrice')) $('rewardSimPrice').value = '';
  renderRewardTracker();
}

function renderRewardTracker() {
  const simulationPrice = Math.max(0, number(state.rewardSimulationPrice));
  const simulationActive = simulationPrice > 0;
  const stakingBase = state.staked;
  const valuationPrice = simulationActive ? simulationPrice : state.price;
  const active = stakingBase > 0 && state.personalApr > 0;
  const daily = active ? stakingBase * (state.personalApr / 100) / 365 : 0;
  const hourly = daily / 24;
  const weekly = daily * 7;
  const monthly = daily * 30;
  const yearly = daily * 365;

  $('yieldCard')?.classList.toggle('simulation-active', simulationActive);
  if ($('rewardModePill')) $('rewardModePill').textContent = simulationActive ? 'SIMULAZIONE' : 'LIVE';

  setValue('hourlyEstimate', active ? formatInj(hourly, 8) : '—', active ? hourly : NaN, { flash: false });
  setValue('hourlyUsd', active && valuationPrice > 0 ? money(hourly * valuationPrice, 4) : '—', active && valuationPrice > 0 ? hourly * valuationPrice : NaN, { flash: false });
  setValue('dailyEstimate', active ? formatInj(daily, 7) : '—', active ? daily : NaN, { flash: false });
  setValue('dailyUsd', active && valuationPrice > 0 ? money(daily * valuationPrice, 3) : '—', active && valuationPrice > 0 ? daily * valuationPrice : NaN, { flash: false });
  setValue('weeklyEstimate', active ? formatInj(weekly, 6) : '—', active ? weekly : NaN, { flash: false });
  setValue('weeklyUsd', active && valuationPrice > 0 ? money(weekly * valuationPrice, 3) : '—', active && valuationPrice > 0 ? weekly * valuationPrice : NaN, { flash: false });
  setValue('monthlyEstimate', active ? formatInj(monthly, 6) : '—', active ? monthly : NaN, { flash: false });
  setValue('monthlyUsd', active && valuationPrice > 0 ? money(monthly * valuationPrice) : '—', active && valuationPrice > 0 ? monthly * valuationPrice : NaN, { flash: false });
  setValue('yearlyEstimate', active ? formatInj(yearly, 5) : '—', active ? yearly : NaN, { flash: false });
  setValue('yearlyUsd', active && valuationPrice > 0 ? money(yearly * valuationPrice) : '—', active && valuationPrice > 0 ? yearly * valuationPrice : NaN, { flash: false });

  const milestones = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50];
  const milestone = milestones.find((value) => value > daily + 1e-9) || Math.ceil(daily / 10) * 10 + 10;
  const required = active ? milestone * 365 / (state.personalApr / 100) : 0;
  const missing = Math.max(0, required - stakingBase);
  if ($('rewardMilestoneHeading')) $('rewardMilestoneHeading').textContent = 'Prossimo livello';
  $('rewardMilestoneLabel').textContent = active ? `${milestone.toLocaleString('it-IT')} INJ / giorno` : '—';
  $('rewardMilestoneMissing').textContent = active ? `${formatInj(missing, 3)} di staking mancanti` : '—';
  $('rewardMilestoneBar').style.width = active ? `${Math.min(100, (daily / milestone) * 100)}%` : '0%';

  if (simulationActive) {
    $('aprMethod').textContent = `Simulazione sui ${formatInj(stakingBase, 4)} realmente delegati in questo wallet, valorizzati a ${usdMoney(simulationPrice)} per INJ. APR netto personale ${state.personalApr.toFixed(3)}%. Clicca fuori dalla card per tornare al prezzo LIVE.`;
  } else if (state.personalApr > 0) {
    $('aprMethod').textContent = `Stima netta sui ${formatInj(state.staked, 4)} realmente delegati. I validator inattivi o jailed producono 0% nel calcolo; le commissioni sono ponderate per quantità delegata.`;
  } else if (state.address && state.staked <= 0) {
    $('aprMethod').textContent = 'L’APR personale apparirà quando l’indirizzo avrà una delegazione attiva.';
  } else {
    $('aprMethod').textContent = 'La stima usa solo gli INJ effettivamente delegati dall’indirizzo, con commissioni e stato di ciascun validator.';
  }
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
  renderWalletCards();
}

async function refreshAll(showFeedback = true) {
  await Promise.all([
    loadMarket(),
    state.address ? loadWallet(false, state.address) : Promise.resolve()
  ]);
  await refreshWalletSummaries(true);
  if (showFeedback && state.address) toast('Tutti gli account sono aggiornati');
}

const NATIVE_CHART_CONFIG = {
  h1: { label: '1H', interval: '1m', sampleMs: 5_000 },
  d1: { label: '1D', interval: '5m', sampleMs: 30_000 },
  w1: { label: '1S', interval: '15m', sampleMs: 120_000 },
  m1: { label: '1M', interval: '1h', sampleMs: 300_000 },
  y1: { label: 'ALL', interval: '1d', sampleMs: 1_800_000 }
};

function nativeChartPeriodBounds(range, reference = new Date()) {
  const now = new Date(reference);
  let start;
  let end;

  if (range === 'h1') {
    start = new Date(now);
    start.setMinutes(0, 0, 0);
    end = new Date(start);
    end.setHours(end.getHours() + 1);
  } else if (range === 'd1') {
    start = new Date(now);
    start.setHours(0, 0, 0, 0);
    end = new Date(start);
    end.setDate(end.getDate() + 1);
  } else if (range === 'w1') {
    start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const mondayOffset = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - mondayOffset);
    end = new Date(start);
    end.setDate(end.getDate() + 7);
  } else if (range === 'm1') {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  } else {
    start = new Date(now.getFullYear(), 0, 1);
    end = new Date(now.getFullYear() + 1, 0, 1);
  }

  return { start: start.getTime(), end: end.getTime() };
}

function nativeChartPrice(value) {
  const v = number(value);
  if (!(v > 0)) return '—';
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: v < 10 ? 4 : 2 })}`;
}

function nativeChartDateLabel(timestamp, range = state.nativeChartRange) {
  const date = new Date(timestamp);
  if (range === 'h1' || range === 'd1') {
    return date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  }
  if (range === 'w1' || range === 'm1') {
    return date.toLocaleDateString('it-IT', { day: '2-digit', month: 'short' });
  }
  return date.toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: '2-digit' });
}

function nativeChartAxisLabels(range, bounds) {
  const start = new Date(bounds.start);
  const end = new Date(Math.max(bounds.start, bounds.end - 1));

  if (range === 'h1' || range === 'd1') {
    return [
      start.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }),
      end.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
    ];
  }

  if (range === 'w1') {
    return [
      start.toLocaleDateString('it-IT', { weekday: 'short' }).replace('.', ''),
      end.toLocaleDateString('it-IT', { weekday: 'short' }).replace('.', '')
    ];
  }

  if (range === 'm1') {
    return [
      start.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }).replace('.', ''),
      end.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }).replace('.', '')
    ];
  }

  return [
    start.toLocaleDateString('it-IT', { month: 'short' }).replace('.', ''),
    end.toLocaleDateString('it-IT', { month: 'short' }).replace('.', '')
  ];
}

function nativeChartCacheKey(range, bounds) {
  return `${range}:${bounds.start}`;
}

async function fetchNativeChartSeries(range, bounds) {
  const config = NATIVE_CHART_CONFIG[range] || NATIVE_CHART_CONFIG.d1;
  const endTime = Math.min(Date.now(), bounds.end - 1);
  const url = `https://api.binance.com/api/v3/klines?symbol=INJUSDT&interval=${encodeURIComponent(config.interval)}&startTime=${Math.floor(bounds.start)}&endTime=${Math.floor(endTime)}&limit=1000`;
  const data = await fetchJson(url, 10_000);
  const rows = Array.isArray(data) ? data.filter((row) => number(row?.[1]) > 0 && number(row?.[4]) > 0) : [];
  if (!rows.length) throw new Error('Storico mercato non disponibile');

  const open = number(rows[0][1]);
  const points = [{ t: bounds.start, price: open }];
  rows.forEach((row) => {
    const t = Math.min(Date.now(), number(row[6]) || number(row[0]));
    const price = number(row[4]);
    if (t >= bounds.start && price > 0) points.push({ t, price });
  });

  const min = Math.min(...rows.map((row) => number(row[3])).filter((v) => v > 0), open);
  const max = Math.max(...rows.map((row) => number(row[2])).filter((v) => v > 0), open);
  return { points, open, min, max, start: bounds.start, end: bounds.end, loadedAt: Date.now() };
}

function renderNativeChartControls() {
  document.querySelectorAll('[data-native-chart-range]').forEach((button) => {
    const active = button.dataset.nativeChartRange === state.nativeChartRange;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function setNativeChartPlaceholder(mode, message = '') {
  const host = $('nativeChartPlaceholder');
  if (!host) return;
  host.hidden = mode === 'hidden';
  host.classList.toggle('error', mode === 'error');
  const copy = host.querySelector('span');
  if (copy && message) copy.textContent = message;
}

function nativeChartCombinedPoints() {
  const base = Array.isArray(state.nativeChart.points) ? state.nativeChart.points : [];
  const samples = Array.isArray(state.nativeChart.liveSamples) ? state.nativeChart.liveSamples : [];
  const live = state.nativeChart.live?.price > 0 ? [state.nativeChart.live] : [];
  const all = [...base, ...samples, ...live]
    .filter((row) => number(row?.t) > 0 && number(row?.price) > 0)
    .sort((a, b) => a.t - b.t);

  const deduped = [];
  all.forEach((row) => {
    const previous = deduped[deduped.length - 1];
    if (previous && Math.abs(row.t - previous.t) < 800) deduped[deduped.length - 1] = row;
    else deduped.push(row);
  });
  return deduped;
}

function nativeChartPerformance(price, open = state.nativeChart.open) {
  const p = number(price);
  const o = number(open);
  return p > 0 && o > 0 ? ((p / o) - 1) * 100 : 0;
}

function renderNativeChartSummary() {
  const chart = state.nativeChart;
  const current = number(chart.live?.price) || state.price || number(chart.points?.[chart.points.length - 1]?.price);
  const open = number(chart.open);
  const values = nativeChartCombinedPoints().map((row) => number(row.price)).filter((v) => v > 0);
  const low = values.length ? Math.min(number(chart.min) || Infinity, ...values) : number(chart.min);
  const high = values.length ? Math.max(number(chart.max), ...values) : number(chart.max);
  const perf = nativeChartPerformance(current, open);

  if ($('nativeChartOpen')) $('nativeChartOpen').textContent = nativeChartPrice(open);
  if ($('nativeChartLow')) $('nativeChartLow').textContent = nativeChartPrice(low);
  if ($('nativeChartHigh')) $('nativeChartHigh').textContent = nativeChartPrice(high);
  if ($('nativeChartNow')) $('nativeChartNow').textContent = nativeChartPrice(current);
  if ($('chartHeaderPrice')) $('chartHeaderPrice').textContent = nativeChartPrice(current);

  const change = $('chartHeaderChange');
  if (change) {
    const label = state.nativeChartRange === 'y1' ? 'ALL · 1Y' : NATIVE_CHART_CONFIG[state.nativeChartRange]?.label || '1D';
    change.textContent = open > 0 ? `${perf >= 0 ? '+' : ''}${perf.toFixed(2)}% · ${label}` : '—';
    change.className = perf > 0 ? 'positive' : perf < 0 ? 'negative' : 'neutral';
  }
}

function nativeChartSvgText(x, y, text, anchor = 'start', className = '') {
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" class="${className}">${text}</text>`;
}

function nativeChartColoredSegments(points = []) {
  const segments = [];
  let current = null;

  const sideOf = (perf) => perf > 1e-9 ? 'positive' : perf < -1e-9 ? 'negative' : 'neutral';

  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const aSide = sideOf(a.perf);
    const bSide = sideOf(b.perf);

    if (aSide === 'neutral' && bSide === 'neutral') continue;

    const startSide = aSide === 'neutral' ? bSide : aSide;
    if (!current || current.side !== startSide) {
      current = { side: startSide, points: [a] };
      segments.push(current);
    } else if (current.points[current.points.length - 1] !== a) {
      current.points.push(a);
    }

    if (aSide !== 'neutral' && bSide !== 'neutral' && aSide !== bSide) {
      const ratio = Math.abs(a.perf) / Math.max(1e-12, Math.abs(a.perf) + Math.abs(b.perf));
      const cross = {
        t: a.t + (b.t - a.t) * ratio,
        price: a.price + (b.price - a.price) * ratio,
        perf: 0,
        x: a.x + (b.x - a.x) * ratio,
        y: a.y + (b.y - a.y) * ratio
      };
      current.points.push(cross);
      current = { side: bSide, points: [cross, b] };
      segments.push(current);
    } else {
      current.points.push(b);
    }
  }

  return segments.filter((segment) => segment.points.length > 1 && segment.side !== 'neutral');
}

function nativeChartSegmentPath(points = []) {
  return points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
}

function renderNativeChart() {
  cancelAnimationFrame(state.nativeChartRenderFrame);
  state.nativeChartRenderFrame = requestAnimationFrame(() => {
    const host = $('nativeChartHost');
    const svg = $('nativeChartSvg');
    if (!host || !svg || !$('chartDialog')?.open) return;

    const rows = nativeChartCombinedPoints();
    if (!rows.length || !(state.nativeChart.open > 0)) {
      svg.replaceChildren();
      return;
    }

    const rect = host.getBoundingClientRect();
    const width = Math.max(280, Math.round(rect.width));
    const height = Math.max(220, Math.round(rect.height));
    const pad = { l: width < 480 ? 58 : 64, r: 14, t: 22, b: 34 };
    const plotW = Math.max(1, width - pad.l - pad.r);
    const plotH = Math.max(1, height - pad.t - pad.b);
    const periodStart = state.nativeChart.start;
    const periodEnd = state.nativeChart.end;
    const now = Date.now();

    const plotted = rows.map((row) => ({
      ...row,
      perf: nativeChartPerformance(row.price, state.nativeChart.open)
    }));

    // La linea usa sempre tutta la larghezza per il periodo realmente trascorso.
    // Niente spazio vuoto fino a fine ora/giorno/settimana/mese/anno.
    const latestTimestamp = Math.max(periodStart + 1, plotted[plotted.length - 1]?.t || now, Math.min(now, periodEnd));
    const visibleEnd = Math.min(periodEnd, latestTimestamp);

    const perfValues = plotted.map((row) => row.perf);
    const rawMin = Math.min(0, ...perfValues);
    const rawMax = Math.max(0, ...perfValues);
    const maxAbs = Math.max(0.25, Math.abs(rawMin), Math.abs(rawMax));

    // Mantiene la baseline 0% lontana dai bordi anche nei periodi quasi
    // interamente positivi o negativi, senza rendere la scala artificiosamente simmetrica.
    let minPerf = Math.min(rawMin, -maxAbs * 0.28);
    let maxPerf = Math.max(rawMax, maxAbs * 0.28);
    let span = Math.max(0.45, maxPerf - minPerf);
    const margin = Math.max(0.06, span * 0.08);
    minPerf -= margin;
    maxPerf += margin;
    span = maxPerf - minPerf;

    const xFor = (t) => pad.l + Math.max(0, Math.min(1, (t - periodStart) / Math.max(1, visibleEnd - periodStart))) * plotW;
    const yFor = (perf) => pad.t + (1 - ((perf - minPerf) / span)) * plotH;
    const zeroY = yFor(0);
    const bottomY = height - pad.b;
    const points = plotted.map((row) => ({ ...row, x: xFor(row.t), y: yFor(row.perf) }));
    state.nativeChart.renderPoints = points;

    const coloredSegments = nativeChartColoredSegments(points);
    const last = points[points.length - 1];
    const [leftLabel, rightLabel] = nativeChartAxisLabels(state.nativeChartRange, { start: periodStart, end: visibleEnd + 1 });
    const topLabel = `${maxPerf >= 0 ? '+' : ''}${maxPerf.toFixed(Math.abs(maxPerf) < 1 ? 2 : 1)}%`;
    const bottomLabel = `${minPerf >= 0 ? '+' : ''}${minPerf.toFixed(Math.abs(minPerf) < 1 ? 2 : 1)}%`;
    const currentPerf = last.perf;
    const currentClass = currentPerf > 0 ? 'positive' : currentPerf < 0 ? 'negative' : 'neutral';
    const midTopY = pad.t + Math.max(0, (zeroY - pad.t) / 2);
    const midBottomY = zeroY + Math.max(0, (bottomY - zeroY) / 2);

    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const segmentMarkup = coloredSegments.map((segment) =>
      `<path class="native-chart-line ${segment.side}" d="${nativeChartSegmentPath(segment.points)}"/>`
    ).join('');

    svg.innerHTML = `
      <g class="native-chart-grid">
        <line x1="${pad.l}" y1="${midTopY}" x2="${width - pad.r}" y2="${midTopY}"/>
        <line x1="${pad.l}" y1="${zeroY}" x2="${width - pad.r}" y2="${zeroY}" class="zero"/>
        <line x1="${pad.l}" y1="${midBottomY}" x2="${width - pad.r}" y2="${midBottomY}"/>
      </g>
      ${segmentMarkup}
      <circle class="native-chart-current ${currentClass}" cx="${last.x}" cy="${last.y}" r="4.5"/>
      ${nativeChartSvgText(pad.l - 8, pad.t + 4, topLabel, 'end', 'axis-value positive-axis')}
      ${nativeChartSvgText(pad.l - 8, zeroY + 4, '0%', 'end', 'axis-zero')}
      ${nativeChartSvgText(pad.l - 8, bottomY + 4, bottomLabel, 'end', 'axis-value negative-axis')}
      ${nativeChartSvgText(pad.l, height - 10, leftLabel, 'start', 'axis-time')}
      ${nativeChartSvgText(width - pad.r, height - 10, rightLabel, 'end', 'axis-time')}
    `;

    setNativeChartPlaceholder('hidden');
    renderNativeChartSummary();
  });
}

function scheduleNativeChartRender() {
  renderNativeChart();
}

async function loadNativeChart(range = state.nativeChartRange, force = false) {
  if (!NATIVE_CHART_CONFIG[range]) range = 'd1';
  state.nativeChartRange = range;
  try { localStorage.setItem('inj_monitor_native_chart_range', range); } catch (_) {}
  renderNativeChartControls();

  const bounds = nativeChartPeriodBounds(range);
  const key = nativeChartCacheKey(range, bounds);
  const cache = state.nativeChartCache[key];
  const config = NATIVE_CHART_CONFIG[range];
  const cacheAge = range === 'h1' ? 30_000 : range === 'd1' ? 60_000 : 5 * 60_000;
  const requestId = ++state.nativeChart.requestId;

  if (!force && cache && Date.now() - cache.loadedAt < cacheAge) {
    state.nativeChart = {
      ...state.nativeChart,
      ...cache,
      points: cache.points.map((row) => ({ ...row })),
      liveSamples: [],
      live: state.price > 0 ? { t: Date.now(), price: state.price } : null,
      loading: false,
      requestId
    };
    renderNativeChart();
    return;
  }

  state.nativeChart.loading = true;
  setNativeChartPlaceholder('loading', 'Caricamento dati…');
  try {
    const result = await fetchNativeChartSeries(range, bounds);
    if (requestId !== state.nativeChart.requestId) return;
    state.nativeChartCache[key] = result;
    state.nativeChart = {
      ...state.nativeChart,
      ...result,
      points: result.points.map((row) => ({ ...row })),
      liveSamples: [],
      live: state.price > 0 ? { t: Date.now(), price: state.price } : null,
      loading: false,
      requestId
    };
    renderNativeChart();
  } catch (error) {
    if (requestId !== state.nativeChart.requestId) return;
    state.nativeChart.loading = false;
    setNativeChartPlaceholder('error', 'Storico non disponibile');
    console.error(error);
  }
}

function updateNativeChartLive(price) {
  const p = number(price);
  if (!(p > 0) || !$('chartDialog')?.open) return;
  const bounds = nativeChartPeriodBounds(state.nativeChartRange);
  if (state.nativeChart.start && state.nativeChart.start !== bounds.start) {
    loadNativeChart(state.nativeChartRange, true);
    return;
  }
  if (!(state.nativeChart.open > 0)) return;

  const now = Date.now();
  const config = NATIVE_CHART_CONFIG[state.nativeChartRange] || NATIVE_CHART_CONFIG.d1;
  const samples = state.nativeChart.liveSamples || (state.nativeChart.liveSamples = []);
  const lastSample = samples[samples.length - 1];
  if (!lastSample || now - lastSample.t >= config.sampleMs) samples.push({ t: now, price: p });
  if (samples.length > 800) samples.splice(0, samples.length - 800);
  state.nativeChart.live = { t: now, price: p };
  state.nativeChart.min = state.nativeChart.min > 0 ? Math.min(state.nativeChart.min, p) : p;
  state.nativeChart.max = Math.max(state.nativeChart.max, p);
  scheduleNativeChartRender();
}

function nativeChartTooltipAt(event) {
  const host = $('nativeChartHost');
  const tooltip = $('nativeChartTooltip');
  const points = state.nativeChart.renderPoints || [];
  if (!host || !tooltip || !points.length) return;
  const rect = host.getBoundingClientRect();
  const clientX = event.clientX ?? event.touches?.[0]?.clientX;
  const clientY = event.clientY ?? event.touches?.[0]?.clientY;
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
  const x = clientX - rect.left;
  let nearest = points[0];
  let distance = Math.abs(nearest.x - x);
  for (let i = 1; i < points.length; i += 1) {
    const nextDistance = Math.abs(points[i].x - x);
    if (nextDistance < distance) { nearest = points[i]; distance = nextDistance; }
  }
  tooltip.replaceChildren();
  const time = document.createElement('span');
  time.textContent = nativeChartDateLabel(nearest.t);
  const price = document.createElement('strong');
  price.textContent = nativeChartPrice(nearest.price);
  const perf = document.createElement('b');
  perf.textContent = `${nearest.perf >= 0 ? '+' : ''}${nearest.perf.toFixed(2)}%`;
  perf.className = nearest.perf > 0 ? 'positive' : nearest.perf < 0 ? 'negative' : 'neutral';
  tooltip.append(time, price, perf);
  tooltip.hidden = false;
  const tipWidth = 128;
  const left = Math.max(8, Math.min(rect.width - tipWidth - 8, x + 12));
  const top = Math.max(8, Math.min(rect.height - 76, (clientY - rect.top) - 44));
  tooltip.style.transform = `translate(${left}px, ${top}px)`;
}

function hideNativeChartTooltip() {
  const tooltip = $('nativeChartTooltip');
  if (tooltip) tooltip.hidden = true;
}

function syncChartViewport() {
  const dialog = $('chartDialog');
  if (!dialog) return;
  const viewport = window.visualViewport;
  const width = Math.max(280, Math.round(viewport?.width || window.innerWidth || document.documentElement.clientWidth));
  const height = Math.max(260, Math.round(viewport?.height || window.innerHeight || document.documentElement.clientHeight));
  const offsetTop = Math.round(viewport?.offsetTop || 0);
  const offsetLeft = Math.round(viewport?.offsetLeft || 0);
  dialog.style.setProperty('--chart-viewport-width', `${width}px`);
  dialog.style.setProperty('--chart-viewport-height', `${height}px`);
  dialog.style.setProperty('--chart-viewport-top', `${offsetTop}px`);
  dialog.style.setProperty('--chart-viewport-left', `${offsetLeft}px`);
  dialog.dataset.orientation = width > height ? 'landscape' : 'portrait';
  requestAnimationFrame(renderNativeChart);
}

function openChartDialog() {
  setHeaderMenuOpen(false);
  setSearchOpen(false);
  const dialog = $('chartDialog');
  if (!dialog) return;
  syncChartViewport();
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => {
    syncChartViewport();
    renderNativeChartControls();
    loadNativeChart(state.nativeChartRange, false);
    if (!state.nativeChartResizeObserver && window.ResizeObserver) {
      state.nativeChartResizeObserver = new ResizeObserver(() => renderNativeChart());
      if ($('nativeChartHost')) state.nativeChartResizeObserver.observe($('nativeChartHost'));
    }
  });
}

function closeChartDialog() {
  const dialog = $('chartDialog');
  if (dialog?.open) dialog.close();
  hideNativeChartTooltip();
}

function setNativeChartRange(range) {
  if (!NATIVE_CHART_CONFIG[range] || range === state.nativeChartRange && state.nativeChart.open > 0) return;
  state.nativeChart.liveSamples = [];
  loadNativeChart(range, false);
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
    navy: { label: 'Aurora', color: '#03070b' },
    black: { label: 'Obsidian', color: '#030303' },
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
  if ($('chartDialog')?.open) requestAnimationFrame(renderNativeChart);
  if (notify) toast(`Tema ${themes[selected].label}`);
}

function setThemePickerOpen(open) {
  $('themeControl').classList.toggle('open', open);
  $('themeButton').setAttribute('aria-expanded', open ? 'true' : 'false');
}

function toggleCurrency() {
  state.currency = state.currency === 'USD' ? 'EUR' : 'USD';
  if ($('currencyValue')) $('currencyValue').textContent = state.currency === 'EUR' ? '€' : '$';
  $('currencyButton').title = state.currency === 'EUR' ? 'Valori in euro' : 'Valori in dollari';
  localStorage.setItem('inj_monitor_currency', state.currency);
  renderAll();
}

function bindEvents() {
  $('addressForm').addEventListener('submit', (event) => {
    event.preventDefault();
    loadWallet(true, $('addressInput').value);
  });
  $('menuButton').addEventListener('click', () => {
    const open = !$('headerMenu').classList.contains('open');
    if (open) setSearchOpen(false);
    setHeaderMenuOpen(open);
  });
  $('searchButton').addEventListener('click', () => setSearchOpen(!$('headerSearch').classList.contains('open')));
  $('manageWalletsMenuButton').addEventListener('click', () => {
    setHeaderMenuOpen(false);
    openWalletManager();
  });
  $('closeWalletDialog').addEventListener('click', () => $('walletDialog').close());
  $('refreshMenuButton').addEventListener('click', async () => {
    setHeaderMenuOpen(false);
    await refreshAll(true);
  });
  $('focusDisplayMenuButton')?.addEventListener('click', openFocusDisplay);
  $('closeFocusDisplayButton')?.addEventListener('click', closeFocusDisplay);
  $('focusDisplayDialog')?.addEventListener('close', () => document.body.classList.remove('focus-display-open'));
  $('focusDisplayDialog')?.addEventListener('click', (event) => { if (event.target === $('focusDisplayDialog')) closeFocusDisplay(); });
  $('chartButton').addEventListener('click', openChartDialog);
  $('closeChartButton')?.addEventListener('click', closeChartDialog);
  $('chartDialog')?.addEventListener('close', hideNativeChartTooltip);
  $('chartDialog')?.addEventListener('click', (event) => { if (event.target === $('chartDialog')) closeChartDialog(); });
  document.querySelectorAll('[data-native-chart-range]').forEach((button) => {
    button.addEventListener('click', () => setNativeChartRange(button.dataset.nativeChartRange));
  });
  $('nativeChartHost')?.addEventListener('pointermove', nativeChartTooltipAt);
  $('nativeChartHost')?.addEventListener('pointerdown', nativeChartTooltipAt);
  $('nativeChartHost')?.addEventListener('pointerleave', hideNativeChartTooltip);
  window.addEventListener('resize', () => { syncChartViewport(); syncFocusDisplayViewport(); }, { passive: true });
  window.addEventListener('orientationchange', () => { requestAnimationFrame(() => { syncChartViewport(); syncFocusDisplayViewport(); }); setTimeout(() => { syncChartViewport(); syncFocusDisplayViewport(); }, 180); }, { passive: true });
  window.visualViewport?.addEventListener('resize', () => { syncChartViewport(); syncFocusDisplayViewport(); }, { passive: true });
  window.visualViewport?.addEventListener('scroll', () => { syncChartViewport(); syncFocusDisplayViewport(); }, { passive: true });
  $('averageBuyPrice').addEventListener('input', () => {
    if (!state.address) return;
    const value = Math.max(0, number($('averageBuyPrice').value));
    if (value > 0) state.averagePriceByWallet[state.address] = value;
    else delete state.averagePriceByWallet[state.address];
    renderPortfolio();
  });
  $('averageBuyPrice').addEventListener('change', saveAveragePrices);
  $('aggregateSection').addEventListener('click', toggleAggregate);
  $('aggregateSection').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleAggregate();
    }
  });
  $('marketTimeframeToggle').addEventListener('click', () => toggleTimeframes('market'));
  $('rewardTrackerToggle').addEventListener('click', () => toggleTracker('reward'));
  $('targetTrackerToggle').addEventListener('click', () => toggleTracker('target'));
  $('rewardSimPrice').addEventListener('input', () => {
    state.rewardSimulationPrice = Math.max(0, number($('rewardSimPrice').value));
    renderRewardTracker();
  });
  $('rewardSimPrice').addEventListener('focus', () => {
    requestAnimationFrame(() => $('rewardSimPrice').select());
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
    if ($('headerMenu').classList.contains('open') && !$('headerMenu').contains(event.target)) setHeaderMenuOpen(false);
    if ($('themeControl').classList.contains('open') && !$('themeControl').contains(event.target)) setThemePickerOpen(false);
    if (state.rewardSimulationPrice > 0 && !$('yieldCard').contains(event.target)) clearRewardSimulation();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && $('headerSearch').classList.contains('open')) setSearchOpen(false);
    if (event.key === 'Escape' && $('headerMenu').classList.contains('open')) setHeaderMenuOpen(false);
    if (event.key === 'Escape' && $('themeControl').classList.contains('open')) setThemePickerOpen(false);
    if (event.key === 'Escape' && state.rewardSimulationPrice > 0) clearRewardSimulation();
    if (event.key === 'Escape' && $('chartDialog')?.open) closeChartDialog();
    if (event.key === 'Escape' && $('focusDisplayDialog')?.open) closeFocusDisplay();
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
    state.nativeChartRange = ['h1', 'd1', 'w1', 'm1', 'y1'].includes(localStorage.getItem('inj_monitor_native_chart_range'))
      ? localStorage.getItem('inj_monitor_native_chart_range')
      : 'd1';
    if ($('currencyValue')) $('currencyValue').textContent = state.currency === 'EUR' ? '€' : '$';
    if (localStorage.getItem('inj_monitor_privacy') === '1') {
      document.body.classList.add('privacy-on');
      $('privacyButton').classList.add('active');
      $('privacyButton').setAttribute('aria-label', 'Mostra valori');
    }
    loadSavedWallets();
    loadTargetStorage();
    loadAveragePriceStorage();
    loadMarketFrameCache();
    const savedAddress = localStorage.getItem('inj_monitor_address') || '';
    const initialWallet = state.wallets.find((item) => item.address === savedAddress) || state.wallets[0];
    if (initialWallet) state.address = initialWallet.address;
    $('addressInput').value = state.address;
  } catch (_) {}

  bindEvents();
  applyTheme(document.documentElement.dataset.theme);
  setTimeframeCollapsed('market', timeframeCollapsedPreference('market'), false);
  setTrackerCollapsed('reward', trackerCollapsedPreference('reward'), false);
  setTrackerCollapsed('target', trackerCollapsedPreference('target'), false);
  renderAll();
  renderWalletControls();
  loadEurRate();
  await loadMarket();
  loadMarketTimeframes(false);
  connectMarketSocket();
  if (state.address) await loadWallet(false, state.address);
  if (state.wallets.length) await refreshWalletSummaries(true);
  state.suppressEffects = false;

  setInterval(loadMarket, 60_000);
  setInterval(() => { if (!document.hidden) loadMarketTimeframes(false); }, 15 * 60_000);
  setTimeout(() => {
    if (!document.hidden) refreshWalletSummaries(false);
    setInterval(() => {
      if (!document.hidden) refreshWalletSummaries(false);
    }, 30_000);
  }, 15_000);
  setInterval(() => renderWalletCards(), 10_000);
  setInterval(() => {
    if (state.address && !document.hidden && !state.loading) loadWallet(false, state.address);
  }, 30_000);
}

init();
