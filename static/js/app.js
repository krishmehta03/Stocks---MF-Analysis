// Secure fetch helper to inject Supabase access token in Authorization headers
async function authorizedFetch(url, options = {}) {
  options.headers = options.headers || {};
  if (window._authClient) {
    try {
      const { data: { session } } = await window._authClient.auth.getSession();
      if (session && session.access_token) {
        options.headers['Authorization'] = `Bearer ${session.access_token}`;
      }
    } catch (err) {
      console.error('Error fetching Supabase session:', err);
    }
  }
  return fetch(url, options);
}

// Global Application State
let portfolioData = null;
let appConfig = null;
let sectorChart = null;
let assetChart = null;
let performanceChart = null;
let sectorContribChart = null;
let activeTheme = 'emerald';
let activeTab = 'dashboard';
let priceUpdateTimer = null;
let activePeriod = '1M';
let activeBenchmark = 'nifty50';
let activeContribPeriod = '1M';
let contribSortMode = 'contribution';


// Core Constants
const ALL_STOCK_COLUMNS = [
  "Scrip Name", "Exchange", "Sector", "Industry", "Qty", "Buy Price", "Buy Date", "Holding Period",
  "Current Price", "5Y CAGR", "Nifty 5Y CAGR", "Invested Value", 
  "Current Value", "P&L", "Return %", "Dividends", "Tax Flag", "Return (₹)"
];

const ALL_MF_COLUMNS = [
  "Fund Name", "Category", "Units Held", "Invested Value",
  "Current Value", "P&L", "Return %", "XIRR %",
  "Holding Period", "Tax Flag"
];

const DEFAULT_STOCK_COLUMNS = [
  "Scrip Name", "Exchange", "Sector", "Qty", "Buy Price", "Buy Date", "Holding Period",
  "Current Price", "Invested Value", "Current Value", "P&L", "Return %", "Tax Flag"
];

const DEFAULT_MF_COLUMNS = [
  "Fund Name", "Category", "Units Held", "Invested Value",
  "Current Value", "P&L", "Return %", "XIRR %", "Holding Period", "Tax Flag"
];

// Document Ready Initialization
document.addEventListener("DOMContentLoaded", () => {
  initializeApp();
  setupEventListeners();
});

// Initialize Config and Data
async function initializeApp() {
  await fetchConfig();
  await fetchPortfolio();
  await fetchProfilesList();
  checkScraperRunningOnStartup();
}

function setupEventListeners() {
  // Quick Theme Toggle
  document.getElementById("btn-theme-toggle").addEventListener("click", () => {
    const themes = ["emerald", "ocean", "cyberpunk", "rose-gold"];
    let nextIdx = (themes.indexOf(activeTheme) + 1) % themes.length;
    const nextTheme = themes[nextIdx];
    applyTheme(nextTheme);
    
    // Save updated theme to config
    if (appConfig) {
      appConfig.theme = nextTheme;
      saveConfigOnServer(appConfig);
    }
    
    const themeLabels = {
      'emerald': 'Emerald Forest',
      'ocean': 'Deep Blue Ocean',
      'cyberpunk': 'Cyberpunk Dark',
      'rose-gold': 'Rose Gold Premium'
    };
    const displayName = themeLabels[nextTheme] || nextTheme;
    showToast(`Theme updated to ${displayName}`);
  });

  // Reset columns button
  const resetBtn = document.getElementById("settings-reset-columns-btn");
  if (resetBtn) {
    resetBtn.addEventListener("click", resetColumnsToDefault);
  }

  // Price Scraper Trigger
  const updatePricesBtn = document.getElementById("btn-update-prices-trigger");
  if (updatePricesBtn) {
    updatePricesBtn.addEventListener("click", startLivePriceScraper);
  }
  
  // Search Filters
  document.getElementById("stock-search").addEventListener("input", filterStocksTable);
  document.getElementById("mf-search").addEventListener("input", filterMfsTable);
  document.getElementById("signal-search").addEventListener("input", filterSignalsTable);

  // Close scraper box
  document.getElementById("btn-updater-close").addEventListener("click", () => {
    document.getElementById("price-updater-container").style.display = "none";
  });

  // Dynamic live price fetch on stock scrip input
  const stockScripInput = document.getElementById("stock-scrip");
  if (stockScripInput) {
    stockScripInput.addEventListener("input", debounce((e) => {
      fetchLivePriceHelper(e.target.value);
    }, 600));
  }

  // Delete all confirmation input listener
  const deleteAllConfirmInput = document.getElementById("delete-all-confirm-input");
  if (deleteAllConfirmInput) {
    deleteAllConfirmInput.addEventListener("input", (e) => {
      const submitBtn = document.getElementById("btn-delete-all-submit");
      if (submitBtn) {
        submitBtn.disabled = (e.target.value.trim().toUpperCase() !== "DELETE");
      }
    });
  }
}

// SWITCH TABS
function switchTab(tabId) {
  activeTab = tabId;
  
  // Update nav buttons
  const tabBtns = document.querySelectorAll(".tab-btn");
  tabBtns.forEach(btn => {
    if (btn.getAttribute("onclick").includes(tabId)) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });

  // Show/Hide tab content
  const tabContents = document.querySelectorAll(".tab-content");
  tabContents.forEach(content => {
    if (content.id === `tab-${tabId}`) {
      content.style.display = "block";
      content.classList.add("active");
    } else {
      content.style.display = "none";
      content.classList.remove("active");
    }
  });

  // Re-render charts to prevent sizing bugs on tab reveal
  if (tabId === 'dashboard') {
    renderCharts();
  }
}

// FETCH SYSTEM DATA
async function fetchConfig() {
  try {
    const res = await authorizedFetch('/api/config');
    appConfig = await res.json();
    applyTheme(appConfig.theme || 'emerald');
    loadSettingsIntoForm();
  } catch (err) {
    console.error("Error loading config:", err);
  }
}

async function fetchPortfolio() {
  try {
    const res = await authorizedFetch('/api/portfolio');
    portfolioData = await res.json();
    
    if (portfolioData.error) {
      alert("Error: " + portfolioData.error);
      return;
    }
    
    updateDashboardMetrics();
    renderCharts();
    renderStocksTable();
    renderMfsTable();
    renderRiskSignals();
    evaluateRiskAlerts();
    
    // Fetch performance historical trend data
    fetchPerformanceData();
    
    // Fetch sector contribution breakdown data
    fetchSectorContributionData();
  } catch (err) {
    console.error("Error loading portfolio data:", err);
  }
}

// APPLY VISUAL THEME
function applyTheme(themeName) {
  activeTheme = themeName;
  document.body.className = '';
  document.body.classList.add(`theme-${themeName}`);
  
  // Highlight active option in Settings Form
  document.querySelectorAll(".theme-option").forEach(opt => {
    opt.classList.remove("active");
  });
  const activeOpt = document.getElementById(`theme-opt-${themeName}`);
  if (activeOpt) activeOpt.classList.add("active");
}

async function selectThemeOption(themeName) {
  applyTheme(themeName);
  if (appConfig) {
    appConfig.theme = themeName;
    await saveConfigOnServer(appConfig);
  }
  const themeLabels = {
    'emerald': 'Emerald Forest',
    'ocean': 'Deep Blue Ocean',
    'cyberpunk': 'Cyberpunk Dark',
    'rose-gold': 'Rose Gold Premium'
  };
  const displayName = themeLabels[themeName] || themeName;
  showToast(`Theme updated to ${displayName}`);
}

// TOAST NOTIFICATIONS & PREFERENCES AUTO-SAVE
let checkboxToastTimeout = null;
let toastTimeout = null;

function showToast(message) {
  let toastEl = document.getElementById("app-toast");
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.id = "app-toast";
    toastEl.style.position = "fixed";
    toastEl.style.bottom = "20px";
    toastEl.style.right = "20px";
    toastEl.style.background = "rgba(15, 23, 42, 0.95)";
    toastEl.style.color = "#ffffff";
    toastEl.style.padding = "10px 16px";
    toastEl.style.borderRadius = "8px";
    toastEl.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.3)";
    toastEl.style.display = "flex";
    toastEl.style.alignItems = "center";
    toastEl.style.gap = "8px";
    toastEl.style.fontFamily = "'Outfit', sans-serif";
    toastEl.style.fontSize = "13px";
    toastEl.style.zIndex = "10000";
    toastEl.style.transition = "opacity 0.3s ease, transform 0.3s ease";
    document.body.appendChild(toastEl);
  }
  
  toastEl.innerHTML = `<i class="fa-solid fa-circle-check" style="color: #10b981;"></i> <span>${message}</span>`;
  toastEl.style.opacity = "0";
  toastEl.style.transform = "translateY(10px)";
  toastEl.style.display = "flex";
  
  // Trigger animation
  setTimeout(() => {
    toastEl.style.opacity = "1";
    toastEl.style.transform = "translateY(0)";
  }, 10);
  
  if (toastTimeout) {
    clearTimeout(toastTimeout);
  }
  
  toastTimeout = setTimeout(() => {
    toastEl.style.opacity = "0";
    toastEl.style.transform = "translateY(10px)";
    setTimeout(() => {
      toastEl.style.display = "none";
    }, 300);
  }, 2000);
}

function triggerCheckboxToast() {
  if (checkboxToastTimeout) {
    clearTimeout(checkboxToastTimeout);
  }
  checkboxToastTimeout = setTimeout(() => {
    showToast("Column preferences saved");
    saveColumnPreferences();
  }, 1500);
}

async function saveColumnPreferences() {
  if (!appConfig) return;
  
  const stockCols = [];
  document.querySelectorAll("input[name='stock-col']:checked").forEach(cb => {
    stockCols.push(cb.value);
  });
  
  const mfCols = [];
  document.querySelectorAll("input[name='mf-col']:checked").forEach(cb => {
    mfCols.push(cb.value);
  });
  
  appConfig.display_columns.stocks = stockCols;
  appConfig.display_columns.mf = mfCols;
  
  await saveConfigOnServer(appConfig);
  
  // Update tables
  renderStocksTable();
  renderMfsTable();
}

async function resetColumnsToDefault() {
  if (!appConfig) return;
  
  document.querySelectorAll("input[name='stock-col']").forEach(cb => {
    cb.checked = DEFAULT_STOCK_COLUMNS.includes(cb.value);
  });
  
  document.querySelectorAll("input[name='mf-col']").forEach(cb => {
    cb.checked = DEFAULT_MF_COLUMNS.includes(cb.value);
  });
  
  // Save preferences immediately (no debounce needed for reset)
  if (checkboxToastTimeout) clearTimeout(checkboxToastTimeout);
  
  appConfig.display_columns.stocks = [...DEFAULT_STOCK_COLUMNS];
  appConfig.display_columns.mf = [...DEFAULT_MF_COLUMNS];
  
  await saveConfigOnServer(appConfig);
  
  // Update tables
  renderStocksTable();
  renderMfsTable();
  
  showToast("Columns reset to default");
}

// DYNAMIC DASHBOARD METRICS
function updateDashboardMetrics() {
  if (!portfolioData || !portfolioData.summary) return;
  const s = portfolioData.summary;
  
  // Combined Stats
  document.getElementById("val-total-portfolio").innerText = formatINR(s.total_portfolio_value);
  document.getElementById("sub-total-portfolio").innerText = `Invested: ${formatINR(s.total_portfolio_invested)}`;
  
  const pnlVal = document.getElementById("val-total-pnl");
  pnlVal.innerText = formatINR(s.total_portfolio_pnl);
  pnlVal.className = 'value ' + (s.total_portfolio_pnl >= 0 ? 'positive' : 'negative');
  
  const pnlSub = document.getElementById("sub-total-pnl");
  pnlSub.innerText = `Return: ${s.total_portfolio_return_pct.toFixed(2)}%`;
  pnlSub.className = 'sub-value ' + (s.total_portfolio_pnl >= 0 ? 'positive' : 'negative');
  
  // Portfolio Beta
  document.getElementById("val-portfolio-beta").innerText = s.portfolio_beta.toFixed(2);
  const stSub = document.getElementById("sub-portfolio-beta");
  stSub.innerText = "Weighted sensitivity relative to Nifty 50";
  stSub.className = 'sub-value text-secondary';
  
  // Update Combined Portfolio breakdown tooltip values
  document.getElementById("tooltip-stocks-val").innerText = formatINR(s.total_stock_value);
  document.getElementById("tooltip-mfs-val").innerText = formatINR(s.total_mf_value);
  
  // MF Stats (Dynamic empty or populated state)
  const mfCardContent = document.getElementById("mf-card-content");
  const hasMfData = portfolioData.mfs && portfolioData.mfs.length > 0;
  
  if (!hasMfData) {
    // Empty State
    mfCardContent.innerHTML = `
      <h3>Mutual Fund Allocation</h3>
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 0.5rem 0;">
        <i class="fa-solid fa-wallet" style="font-size: 1.25rem; color: var(--text-secondary); margin-bottom: 0.4rem;"></i>
        <div style="font-size: 0.9rem; font-weight: 600; color: var(--text-primary);">No mutual funds yet</div>
        <div style="font-size: 0.75rem; color: var(--text-secondary); margin: 0.15rem 0 0.5rem;">Current Value: ₹0.00</div>
        <button class="btn btn-secondary btn-sm" onclick="switchTab('mfs'); openAddMfModal();" style="font-size: 0.75rem; padding: 0.25rem 0.6rem; border-radius: 6px;"><i class="fa-solid fa-plus"></i> Add Mutual Fund</button>
      </div>
    `;
  } else {
    // Populated State
    const pnlSign = s.total_mf_pnl >= 0 ? '+' : '';
    const pnlClass = s.total_mf_pnl >= 0 ? 'positive' : 'negative';
    const fundCountStr = portfolioData.mfs.length === 1 ? '1 fund' : `${portfolioData.mfs.length} funds`;
    
    mfCardContent.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: flex-start;">
        <h3>Mutual Fund Allocation</h3>
        <span style="font-size: 0.75rem; padding: 0.15rem 0.45rem; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; color: var(--text-secondary); font-weight: 600;">${fundCountStr}</span>
      </div>
      <div class="value" id="val-mf-value" style="margin-top: 0.35rem;">${formatINR(s.total_mf_value)}</div>
      <div class="sub-value" style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 0.15rem;">Invested: ${formatINR(s.total_mf_invested)}</div>
      <div class="sub-value ${pnlClass}" id="sub-mf-value" style="margin-top: 0.25rem; font-weight: 600;">P&L: ${pnlSign}${formatINR(s.total_mf_pnl)} (${s.total_mf_return_pct.toFixed(2)}%)</div>
    `;
  }
  
  // Toggles active widgets display
  toggleWidgetsVisibility();
  
  // Render leaderboard Performers
  renderLeaders();
  renderUnderperformers();
}

function toggleWidgetsVisibility() {
  if (!appConfig || !appConfig.widgets) return;
  const w = appConfig.widgets;
  
  document.getElementById("widget-sector-chart-box").style.display = w.sector_allocation ? 'block' : 'none';
  document.getElementById("widget-asset-chart-box").style.display = w.asset_allocation ? 'block' : 'none';
  document.getElementById("widget-leaders-box").style.display = w.top_performers ? 'block' : 'none';
  document.getElementById("widget-underperformers-box").style.display = (w.top_underperformers !== false) ? 'block' : 'none';
  
  // Recalculate Dashboard details grid layout based on what widgets are visible
  const detGrid = document.querySelector(".dashboard-details");
  const rightColHasContent = w.asset_allocation || w.top_performers || (w.top_underperformers !== false);
  if (!w.sector_allocation && !rightColHasContent) {
    detGrid.style.display = 'none';
  } else if (!w.sector_allocation) {
    detGrid.style.gridTemplateColumns = '1fr';
  } else {
    detGrid.style.gridTemplateColumns = rightColHasContent ? '2fr 1fr' : '1fr';
  }
}

// Renders the Top Stock Performers list on the dashboard
function renderLeaders() {
  const container = document.getElementById("dashboard-leaders-list");
  container.innerHTML = "";
  if (!portfolioData || !portfolioData.stocks || portfolioData.stocks.length === 0) {
    container.innerHTML = `<p style="font-size: 0.85rem; color: var(--text-secondary); text-align: center; padding: 1rem;">No holdings yet</p>`;
    return;
  }
  
  const allInvested = portfolioData.stocks.filter(s => (s["Invested Value"] || 0) > 0);
  const qualifiers = allInvested.filter(s => (s["Return %"] || 0) > 10);
  
  if (qualifiers.length === 0) {
    container.innerHTML = `<p style="font-size: 0.85rem; color: var(--text-secondary); text-align: center; padding: 1rem;">No stocks qualify (Threshold: +10%)</p>`;
    return;
  }
  
  // Sort descending
  const sorted = [...qualifiers].sort((a, b) => b["Return %"] - a["Return %"]);
  
  // Header count note
  const countNote = document.createElement("div");
  countNote.style.fontSize = "0.75rem";
  countNote.style.color = "var(--text-secondary)";
  countNote.style.marginBottom = "0.5rem";
  countNote.style.textAlign = "right";
  countNote.innerText = `${Math.min(3, sorted.length)} of ${sorted.length} qualify`;
  container.appendChild(countNote);
  
  // Render up to 3
  const toDisplay = sorted.slice(0, 3);
  toDisplay.forEach((s, i) => {
    const medals = ['🥇', '🥈', '🥉'];
    const el = document.createElement("div");
    el.className = "leader-item";
    const retVal = s["Return %"];
    const warningIcon = Math.abs(retVal) > 500 ? ` <i class="fa-solid fa-triangle-exclamation" title="Unusually high return — verify buy price and corporate actions" style="color: #f59e0b; cursor: help; margin-left: 4px;"></i>` : '';
    const dateLabel = s["Buy Date"] ? ` (${s["Buy Date"]})` : '';
    el.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 0.15rem;">
        <span class="leader-name">${medals[i]} ${s["Scrip Name"]} <small style="color: var(--text-secondary); font-weight: normal;">(${s["Exchange"]})</small></span>
        <span style="font-size: 0.72rem; color: var(--text-secondary);">since purchase${dateLabel}</span>
      </div>
      <span class="leader-val ${s["P&L"] >= 0 ? 'positive' : 'negative'}">${retVal.toFixed(2)}%${warningIcon}</span>
    `;
    container.appendChild(el);
  });
  
  // If fewer than 3 qualify, append fallback note
  if (sorted.length < 3) {
    const fallbackEl = document.createElement("div");
    fallbackEl.style.fontSize = "0.75rem";
    fallbackEl.style.color = "var(--text-secondary)";
    fallbackEl.style.textAlign = "center";
    fallbackEl.style.padding = "0.5rem";
    fallbackEl.style.borderTop = "1px dashed rgba(255, 255, 255, 0.05)";
    fallbackEl.style.marginTop = "0.5rem";
    fallbackEl.innerText = "No additional stocks qualify (Threshold: 10%)";
    container.appendChild(fallbackEl);
  }
}

// Renders the Top Underperformers list on the dashboard
function renderUnderperformers() {
  const container = document.getElementById("dashboard-underperformers-list");
  if (!container) return;
  container.innerHTML = "";
  if (!portfolioData || !portfolioData.stocks || portfolioData.stocks.length === 0) {
    container.innerHTML = `<p style="font-size: 0.85rem; color: var(--text-secondary); text-align: center; padding: 1rem;">No holdings yet</p>`;
    return;
  }

  const allInvested = portfolioData.stocks.filter(s => (s["Invested Value"] || 0) > 0);
  const qualifiers = allInvested.filter(s => (s["Return %"] || 0) < -10);

  if (qualifiers.length === 0) {
    container.innerHTML = `<p style="font-size: 0.85rem; color: var(--text-secondary); text-align: center; padding: 1rem;">No stocks qualify (Threshold: -10%)</p>`;
    return;
  }

  // Sort ascending (worst first)
  const sorted = [...qualifiers].sort((a, b) => a["Return %"] - b["Return %"]);

  // Header count note
  const countNote = document.createElement("div");
  countNote.style.fontSize = "0.75rem";
  countNote.style.color = "var(--text-secondary)";
  countNote.style.marginBottom = "0.5rem";
  countNote.style.textAlign = "right";
  countNote.innerText = `${Math.min(3, sorted.length)} of ${sorted.length} qualify`;
  container.appendChild(countNote);

  // Render up to 3
  const toDisplay = sorted.slice(0, 3);
  const rankIcons = ['1️⃣', '2️⃣', '3️⃣'];
  toDisplay.forEach((s, i) => {
    const el = document.createElement("div");
    el.className = "leader-item";
    const retPct = s["Return %"].toFixed(2);
    const pnlClass = s["Return %"] >= 0 ? 'positive' : 'negative';
    const warningIcon = Math.abs(s["Return %"]) > 500 ? ` <i class="fa-solid fa-triangle-exclamation" title="Unusually high return — verify buy price and corporate actions" style="color: #f59e0b; cursor: help; margin-left: 4px;"></i>` : '';
    const dateLabel = s["Buy Date"] ? ` (${s["Buy Date"]})` : '';
    el.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 0.15rem;">
        <span class="leader-name">${rankIcons[i]} ${s["Scrip Name"]} <small style="color: var(--text-secondary); font-weight: normal;">(${s["Exchange"]})</small></span>
        <span style="font-size: 0.72rem; color: var(--text-secondary);">since purchase${dateLabel}</span>
      </div>
      <span class="leader-val ${pnlClass}" style="font-size:0.9rem;">${retPct}%${warningIcon}</span>
    `;
    container.appendChild(el);
  });

  // If fewer than 3 qualify, append fallback note
  if (sorted.length < 3) {
    const fallbackEl = document.createElement("div");
    fallbackEl.style.fontSize = "0.75rem";
    fallbackEl.style.color = "var(--text-secondary)";
    fallbackEl.style.textAlign = "center";
    fallbackEl.style.padding = "0.5rem";
    fallbackEl.style.borderTop = "1px dashed rgba(255, 255, 255, 0.05)";
    fallbackEl.style.marginTop = "0.5rem";
    fallbackEl.innerText = "No additional stocks qualify (Threshold: 10%)";
    container.appendChild(fallbackEl);
  }
}

// RENDER BEAUTIFUL CHARTS
function renderCharts() {
  if (!portfolioData) return;
  
  const w = appConfig ? appConfig.widgets : { sector_allocation: true, asset_allocation: true };
  
  // Theme styling helpers
  const cssVariables = getComputedStyle(document.body);
  const accentColor = cssVariables.getPropertyValue('--accent').trim() || '#10b981';
  const textSecondary = cssVariables.getPropertyValue('--text-secondary').trim() || '#94a3b8';
  
  // 1. SECTOR ALLOCATION DOUGHNUT
  if (w.sector_allocation) {
    const sectorCtx = document.getElementById('chart-sector-allocation');
    if (sectorCtx) {
      if (sectorChart) sectorChart.destroy();
      
      // Calculate sector totals
      const sectorsList = [];
      let totalStockValue = 0;
      portfolioData.stocks.forEach(s => {
        const sec = s["Sector"] || "Other";
        const val = s["Current Value"] || 0;
        totalStockValue += val;
        
        let existing = sectorsList.find(item => item.sector === sec);
        if (existing) {
          existing.value += val;
        } else {
          sectorsList.push({ sector: sec, value: val });
        }
      });
      
      const totalMfValue = portfolioData.summary.total_mf_value || 0;
      const totalPortfolioVal = totalStockValue + totalMfValue;
      
      // Sort descending by value
      sectorsList.sort((a, b) => b.value - a.value);
      
      const mainSectors = [];
      const othersSectors = [];
      
      sectorsList.forEach((item) => {
        const pct = totalPortfolioVal > 0 ? (item.value / totalPortfolioVal) * 100 : 0;
        const isTooSmall = pct < 3.0;
        // Limit to Top 7 if total sectors > 8
        const isBeyondTop7 = sectorsList.length > 8 && mainSectors.length >= 7;
        
        if (isTooSmall || isBeyondTop7) {
          othersSectors.push(item);
        } else {
          mainSectors.push(item);
        }
      });
      
      // Fallback: If all sectors are tiny, keep the largest as main so we don't have 100% Others
      if (mainSectors.length === 0 && sectorsList.length > 0) {
        mainSectors.push(sectorsList[0]);
        const idx = othersSectors.findIndex(item => item.sector === sectorsList[0].sector);
        if (idx !== -1) othersSectors.splice(idx, 1);
      }
      
      const finalSectors = [...mainSectors];
      if (othersSectors.length > 0) {
        const othersVal = othersSectors.reduce((sum, item) => sum + item.value, 0);
        finalSectors.push({
          sector: 'Others',
          value: othersVal,
          isOthers: true,
          breakdown: othersSectors
        });
      }
      
      let labels = [];
      let dataForChart = [];
      
      if (finalSectors.length === 0) {
        labels.push("No Holdings");
        dataForChart.push(1);
      } else {
        labels = finalSectors.map(item => item.sector);
        
        // Force minimum 1% for any slice with value > 0 for visual rendering
        const totalDisplayVal = finalSectors.reduce((sum, item) => sum + item.value, 0);
        const minVal = totalDisplayVal * 0.01;
        
        let displayData = finalSectors.map(item => item.value);
        if (totalDisplayVal > 0) {
          let adjustedSum = 0;
          displayData = finalSectors.map(item => {
            if (item.value > 0 && item.value < minVal) {
              adjustedSum += minVal;
              return minVal;
            }
            return item.value;
          });
          
          const originalRemainingSum = finalSectors.reduce((sum, item) => (item.value >= minVal ? sum + item.value : sum), 0);
          const targetRemainingSum = totalDisplayVal - adjustedSum;
          if (originalRemainingSum > 0 && targetRemainingSum > 0) {
            displayData = displayData.map((val, idx) => {
              if (finalSectors[idx].value >= minVal) {
                return (val / originalRemainingSum) * targetRemainingSum;
              }
              return val;
            });
          }
        }
        dataForChart = displayData;
      }
      
      sectorChart = new Chart(sectorCtx, {
        type: 'doughnut',
        data: {
          labels: labels,
          datasets: [{
            data: dataForChart,
            backgroundColor: labels.map(l => getSectorColor(l)),
            borderColor: 'rgba(255, 255, 255, 0.05)',
            borderWidth: 2
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: 'right',
              labels: {
                color: textSecondary,
                font: { family: 'Plus Jakarta Sans', size: 11 }
              }
            },
            tooltip: {
              callbacks: {
                label: function(context) {
                  const idx = context.dataIndex;
                  const item = finalSectors[idx];
                  if (!item) return '';
                  
                  const actualVal = item.value;
                  const actualPct = totalPortfolioVal > 0 ? (actualVal / totalPortfolioVal) * 100 : 0;
                  
                  if (item.isOthers) {
                    const lines = [`Others (${actualPct.toFixed(1)}%):`];
                    othersSectors.forEach(sub => {
                      const subPct = totalPortfolioVal > 0 ? (sub.value / totalPortfolioVal) * 100 : 0;
                      lines.push(`→ ${sub.sector}: ${subPct.toFixed(1)}%`);
                    });
                    return lines;
                  }
                  
                  return ` ${item.sector}: ${formatINR(actualVal)} (${actualPct.toFixed(1)}%)`;
                }
              }
            }
          }
        }
      });

      // Update concentration warning label below chart
      const concentrationLabelEl = document.getElementById('sector-concentration-label');
      if (concentrationLabelEl && totalPortfolioVal > 0) {
        // Find max sector by portfolio %
        let maxSector = null;
        let maxPct = 0;
        sectorsList.forEach(item => {
          const pct = (item.value / totalPortfolioVal) * 100;
          if (pct > maxPct) { maxPct = pct; maxSector = item.sector; }
        });
        if (maxPct >= 40 && maxSector) {
          concentrationLabelEl.style.display = 'block';
          concentrationLabelEl.innerHTML = `⚠ Heavily concentrated in <strong>${maxSector}</strong> (${maxPct.toFixed(0)}%) — <span style="text-decoration:underline;">view alert ↑</span>`;
        } else {
          concentrationLabelEl.style.display = 'none';
          concentrationLabelEl.innerHTML = '';
        }
      }
    }
  }

  // 2. ASSET ALLOCATION SPLIT PIE/DONUT
  if (w.asset_allocation) {
    const assetCtx = document.getElementById('chart-asset-allocation');
    const chartContainer = document.getElementById('asset-chart-container');
    const emptyState = document.getElementById('asset-empty-state');
    
    if (assetCtx) {
      if (assetChart) assetChart.destroy();
      
      const stVal = portfolioData.summary.total_stock_value;
      const mfVal = portfolioData.summary.total_mf_value;
      
      if (mfVal === 0) {
        if (chartContainer) chartContainer.style.display = 'none';
        if (emptyState) emptyState.style.display = 'flex';
      } else {
        if (chartContainer) chartContainer.style.display = 'flex';
        if (emptyState) emptyState.style.display = 'none';
        
        const totalVal = stVal + mfVal;
        const stPct = totalVal > 0 ? ((stVal / totalVal) * 100).toFixed(1) : '0.0';
        const mfPct = totalVal > 0 ? ((mfVal / totalVal) * 100).toFixed(1) : '0.0';
        
        assetChart = new Chart(assetCtx, {
          type: 'doughnut',
          data: {
            labels: [`Stocks ${stPct}%`, `Mutual Funds ${mfPct}%`],
            datasets: [{
              data: [stVal, mfVal],
              backgroundColor: [
                '#ec4899',
                '#ffffff'
              ],
              borderColor: 'rgba(255, 255, 255, 0.05)',
              borderWidth: 2
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '65%',
            plugins: {
              legend: {
                position: 'bottom',
                labels: {
                  color: textSecondary,
                  boxWidth: 12,
                  font: { family: 'Plus Jakarta Sans', size: 10, weight: 'bold' }
                }
              }
            }
          }
        });
      }
    }
  }
}

// ─── PORTFOLIO PERFORMANCE CHART FUNCTIONS ───────────────────────────────────
async function fetchPerformanceData() {
  const loader = document.getElementById("perf-loading");
  const canvas = document.getElementById("chart-performance");
  const badge = document.getElementById("perf-outperf-badge");
  
  if (loader) loader.style.display = "flex";
  if (canvas) canvas.style.display = "none";
  
  try {
    const res = await authorizedFetch(`/api/portfolio/performance?period=${activePeriod}&benchmark=${activeBenchmark}`);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Failed to fetch performance data");
    }
    const data = await res.json();
    
    if (loader) loader.style.display = "none";
    if (canvas) canvas.style.display = "block";
    
    renderPerformanceChart(data);
  } catch (err) {
    console.error("Error loading performance chart:", err);
    if (loader) {
      const displayMsg = err.message === "No holdings found" ? "Add stocks to see performance chart" : err.message;
      loader.innerHTML = `<span style="color: var(--text-secondary); font-size: 0.95rem;"><i class="fa-solid fa-chart-line" style="margin-right: 0.5rem;"></i> ${displayMsg}</span>`;
    }
    if (badge) {
      badge.innerText = "No Data";
      badge.style.background = "rgba(255,255,255,0.05)";
      badge.style.color = "var(--text-secondary)";
      badge.style.borderColor = "rgba(255,255,255,0.1)";
    }
  }
}

function formatDateCleanly(dateStr) {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${date.getDate()} ${months[date.getMonth()]}`;
}

function renderPerformanceChart(data) {
  const ctx = document.getElementById('chart-performance');
  if (!ctx) return;
  
  if (performanceChart) {
    performanceChart.destroy();
  }
  
  // Theme styling colors
  const cssVars = getComputedStyle(document.body);
  const accentColor = cssVars.getPropertyValue('--accent').trim() || '#10b981';
  const textPrimary = cssVars.getPropertyValue('--text-primary').trim() || '#f8fafc';
  const textSecondary = cssVars.getPropertyValue('--text-secondary').trim() || '#94a3b8';

  // Update dynamic Outperformance Badge
  const badge = document.getElementById("perf-outperf-badge");
  if (badge) {
    const diff = data.outperformance;
    if (diff > 0.5) {
      badge.innerText = `+${diff.toFixed(2)}% Outperformance`;
      badge.style.background = "rgba(16, 185, 129, 0.15)";
      badge.style.color = "#10b981";
      badge.style.borderColor = "rgba(16, 185, 129, 0.3)";
    } else if (diff < -0.5) {
      badge.innerText = `-${Math.abs(diff).toFixed(2)}% Underperformance`;
      badge.style.background = "rgba(239, 68, 68, 0.15)";
      badge.style.color = "#ef4444";
      badge.style.borderColor = "rgba(239, 68, 68, 0.3)";
    } else {
      badge.innerText = "~Tracking Benchmark";
      badge.style.background = "rgba(148, 163, 184, 0.15)";
      badge.style.color = "#94a3b8";
      badge.style.borderColor = "rgba(148, 163, 184, 0.3)";
    }
  }

  // Update Contextual Downturn Note
  const hasCombined = !!data.combined;
  const portfolioArray = hasCombined ? data.combined : data.portfolio;
  const lastPortVal = portfolioArray && portfolioArray.length > 0 ? portfolioArray[portfolioArray.length - 1] : 100;
  const lastBenchVal = data.benchmark && data.benchmark.length > 0 ? data.benchmark[data.benchmark.length - 1] : 100;
  const isDownturn = (lastPortVal < 100) && (lastBenchVal < 100);
  const downturnNote = document.getElementById("perf-downturn-note");
  if (downturnNote) {
    downturnNote.style.display = isDownturn ? "block" : "none";
  }

  // Update Portfolio Context Strip
  const stripPeriodEl = document.getElementById("strip-period");
  const stripPortRetEl = document.getElementById("strip-portfolio-return");
  const stripBenchLabelEl = document.getElementById("strip-bench-label");
  const stripBenchRetEl = document.getElementById("strip-bench-return");
  const stripAlphaEl = document.getElementById("strip-alpha");
  const stripAsOfEl = document.getElementById("strip-as-of");

  const portRet = lastPortVal - 100;
  const benchRet = lastBenchVal - 100;
  const alpha = data.outperformance;

  if (stripPeriodEl) stripPeriodEl.innerText = data.period || activePeriod;
  
  if (stripPortRetEl) {
    stripPortRetEl.innerText = `${portRet >= 0 ? '+' : ''}${portRet.toFixed(2)}%`;
    stripPortRetEl.className = `value ${portRet >= 0 ? 'positive' : 'negative'}`;
  }
  
  if (stripBenchLabelEl) {
    stripBenchLabelEl.innerText = `${data.benchmark_name || 'Benchmark'} Return:`;
  }
  
  if (stripBenchRetEl) {
    stripBenchRetEl.innerText = `${benchRet >= 0 ? '+' : ''}${benchRet.toFixed(2)}%`;
    stripBenchRetEl.className = `value ${benchRet >= 0 ? 'positive' : 'negative'}`;
  }
  
  if (stripAlphaEl) {
    stripAlphaEl.innerText = `${alpha >= 0 ? '+' : ''}${alpha.toFixed(2)}%`;
    if (alpha > 0.5) {
      stripAlphaEl.className = 'value positive';
      stripAlphaEl.style.color = '';
    } else if (alpha < -0.5) {
      stripAlphaEl.className = 'value negative';
      stripAlphaEl.style.color = '';
    } else {
      stripAlphaEl.className = 'value';
      stripAlphaEl.style.color = '#94a3b8';
    }
  }
  
  if (stripAsOfEl) {
    let asOfDate = new Date();
    const timestamp = (portfolioData && portfolioData.last_updated) || localLastUpdatedTimestamp;
    if (timestamp) {
      asOfDate = new Date(timestamp * 1000);
    }
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const day = String(asOfDate.getDate()).padStart(2, '0');
    const mon = MONTHS[asOfDate.getMonth()];
    const year = asOfDate.getFullYear();
    stripAsOfEl.innerText = `${day} ${mon} ${year}`;
  }
  
  // Update Legend Row
  const legendRow = document.getElementById("perf-chart-legend-row");
  if (legendRow) {
    if (hasCombined) {
      legendRow.innerHTML = `
        <div style="display:flex;align-items:center;gap:0.4rem;">
          <div style="width:24px;height:3px;background:#ec4899;border-radius:2px;"></div>
          <span style="color:var(--text-secondary);">Stocks Portfolio</span>
        </div>
        <div style="display:flex;align-items:center;gap:0.4rem;">
          <div style="width:24px;height:3px;background:#ffffff;border-radius:2px;"></div>
          <span style="color:var(--text-secondary);">Combined Portfolio</span>
        </div>
        <div style="display:flex;align-items:center;gap:0.4rem;">
          <div style="width:24px;height:2px;background:rgba(148,163,184,0.6);border-radius:2px;border-top:2px dashed rgba(148,163,184,0.6);"></div>
          <span id="perf-bench-legend" style="color:var(--text-secondary);">${data.benchmark_name}</span>
        </div>
      `;
    } else {
      legendRow.innerHTML = `
        <div style="display:flex;align-items:center;gap:0.4rem;">
          <div style="width:24px;height:3px;background:${accentColor};border-radius:2px;"></div>
          <span style="color:var(--text-secondary);">Your Portfolio</span>
        </div>
        <div style="display:flex;align-items:center;gap:0.4rem;">
          <div style="width:24px;height:2px;background:rgba(148,163,184,0.6);border-radius:2px;border-top:2px dashed rgba(148,163,184,0.6);"></div>
          <span id="perf-bench-legend" style="color:var(--text-secondary);">${data.benchmark_name}</span>
        </div>
      `;
    }
  }

  // Set up datasets dynamically
  const datasets = [];
  if (hasCombined) {
    datasets.push({
      label: 'Stocks Portfolio',
      data: data.portfolio,
      borderColor: '#ec4899',
      borderWidth: 3,
      pointRadius: 0,
      pointHoverRadius: 6,
      pointBackgroundColor: '#ec4899',
      fill: false,
      tension: 0.25
    });
    datasets.push({
      label: 'Combined Portfolio',
      data: data.combined,
      borderColor: '#ffffff',
      borderWidth: 3,
      pointRadius: 0,
      pointHoverRadius: 6,
      pointBackgroundColor: '#ffffff',
      fill: false,
      tension: 0.25
    });
  } else {
    datasets.push({
      label: 'Your Portfolio',
      data: data.portfolio,
      borderColor: accentColor,
      borderWidth: 3,
      pointRadius: 0,
      pointHoverRadius: 6,
      pointBackgroundColor: accentColor,
      fill: false,
      tension: 0.25
    });
  }

  // Add Benchmark dataset
  datasets.push({
    label: data.benchmark_name,
    data: data.benchmark,
    borderColor: 'rgba(148, 163, 184, 0.65)',
    borderWidth: 2,
    borderDash: [5, 5],
    pointRadius: 0,
    pointHoverRadius: 5,
    pointBackgroundColor: 'rgba(148, 163, 184, 0.9)',
    fill: false,
    tension: 0.2
  });
  
  // Calculate dynamic min/max scaling
  const allValues = [];
  if (data.portfolio) {
    data.portfolio.forEach(v => { if (v !== null && v !== undefined && !isNaN(v)) allValues.push(v); });
  }
  if (data.combined) {
    data.combined.forEach(v => { if (v !== null && v !== undefined && !isNaN(v)) allValues.push(v); });
  }
  if (data.benchmark) {
    data.benchmark.forEach(v => { if (v !== null && v !== undefined && !isNaN(v)) allValues.push(v); });
  }
  let yMin = 100;
  let yMax = 100;
  if (allValues.length > 0) {
    const minVal = Math.min(...allValues);
    const maxVal = Math.max(...allValues);
    const range = maxVal - minVal;
    const margin = range > 0 ? range * 0.05 : 1; // 5% padding
    yMin = minVal - margin;
    yMax = maxVal + margin;
  }
  
  performanceChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.dates,
      datasets: datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      hover: {
        mode: 'index',
        intersect: false
      },
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          enabled: true,
          mode: 'index',
          intersect: false,
          backgroundColor: 'rgba(15, 23, 42, 0.95)',
          titleColor: textPrimary,
          bodyColor: textSecondary,
          borderColor: 'rgba(255, 255, 255, 0.12)',
          borderWidth: 1,
          padding: 12,
          bodySpacing: 6,
          titleFont: { family: 'Outfit', size: 13, weight: 'bold' },
          bodyFont: { family: 'Plus Jakarta Sans', size: 12 },
          callbacks: {
            title: function(context) {
              const dateStr = context[0].label;
              return formatDateCleanly(dateStr);
            },
            label: function(context) {
              let label = context.dataset.label || '';
              if (label) {
                label += ': ';
              }
              if (context.parsed.y !== null) {
                label += context.parsed.y.toFixed(2) + '%';
              }
              return label;
            },
            footer: function(context) {
              if (context.length >= 3) {
                const combinedVal = context[1].parsed.y;
                const benchVal = context[2].parsed.y;
                const gap = combinedVal - benchVal;
                const sign = gap >= 0 ? '+' : '';
                return `Combined Gap: ${sign}${gap.toFixed(2)}%`;
              } else if (context.length === 2) {
                const portVal = context[0].parsed.y;
                const benchVal = context[1].parsed.y;
                const gap = portVal - benchVal;
                const sign = gap >= 0 ? '+' : '';
                return `Gap: ${sign}${gap.toFixed(2)}%`;
              }
              return '';
            }
          },
          footerColor: function(context) {
            if (context.length >= 3) {
              const combinedVal = context[1].parsed.y;
              const benchVal = context[2].parsed.y;
              return (combinedVal - benchVal >= 0) ? '#10b981' : '#ef4444';
            } else if (context.length === 2) {
              const portVal = context[0].parsed.y;
              const benchVal = context[1].parsed.y;
              return (portVal - benchVal >= 0) ? '#10b981' : '#ef4444';
            }
            return '#94a3b8';
          },
          footerFont: { family: 'Outfit', size: 12, weight: 'bold' }
        }
      },
      scales: {
        x: {
          grid: {
            display: false
          },
          ticks: {
            color: textSecondary,
            font: { family: 'Plus Jakarta Sans', size: 11 },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 6,
            callback: function(value, index, values) {
              const label = this.getLabelForValue(value);
              return formatDateCleanly(label);
            }
          }
        },
        y: {
          min: yMin,
          max: yMax,
          grid: {
            color: function(context) {
              // Brighter line at 100 baseline
              if (context.tick && Math.abs(context.tick.value - 100) < 0.001) {
                return 'rgba(255, 255, 255, 0.18)';
              }
              return 'rgba(255, 255, 255, 0.04)';
            },
            lineWidth: function(context) {
              if (context.tick && Math.abs(context.tick.value - 100) < 0.001) {
                return 1.5;
              }
              return 1;
            }
          },
          ticks: {
            color: textSecondary,
            font: { family: 'Plus Jakarta Sans', size: 11 },
            callback: function(value) {
              return value.toFixed(0);
            }
          }
        }
      }
    },
    plugins: [{
      // Draw "Start" label on the 100 baseline
      id: 'baselineLabel',
      afterDraw: function(chart) {
        const yScale = chart.scales['y'];
        const xScale = chart.scales['x'];
        if (!yScale || yScale.min > 100 || yScale.max < 100) return;
        const y100 = yScale.getPixelForValue(100);
        const ctx2 = chart.ctx;
        ctx2.save();
        ctx2.font = '10px Plus Jakarta Sans';
        ctx2.fillStyle = 'rgba(255, 255, 255, 0.35)';
        ctx2.textAlign = 'left';
        ctx2.textBaseline = 'bottom';
        ctx2.fillText('Start', xScale.left + 4, y100 - 2);
        ctx2.restore();
      }
    }]
  });
}

function setPeriod(period) {
  activePeriod = period;
  
  // Update UI active buttons
  const buttons = document.querySelectorAll(".perf-period-btn");
  buttons.forEach(btn => {
    if (btn.id === `perf-btn-${period}`) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });
  
  fetchPerformanceData();
}

function setBenchmark(benchmark) {
  activeBenchmark = benchmark;
  fetchPerformanceData();
}


// ─── SECTOR CONTRIBUTION TO RETURNS FUNCTIONS ───────────────────────────────
async function fetchSectorContributionData() {
  const loader = document.getElementById("contrib-loading");
  const chartContainer = document.getElementById("contrib-chart-container");
  const summaryRow = document.getElementById("contrib-summary-row");
  const emptyState = document.getElementById("contrib-empty-state");
  
  if (loader) loader.style.display = "flex";
  if (chartContainer) chartContainer.style.display = "none";
  if (summaryRow) summaryRow.style.display = "none";
  if (emptyState) emptyState.style.display = "none";
  
  try {
    const res = await authorizedFetch(`/api/portfolio/sector-contribution?period=${activeContribPeriod}&benchmark=${activeBenchmark}`);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Failed to fetch sector attribution data");
    }
    const data = await res.json();
    
    renderSectorContributionChart(data);
  } catch (err) {
    console.error("Error loading sector contribution:", err);
    if (loader) {
      const displayMsg = err.message === "No holdings found" ? "Add stocks to see sector breakdown" : err.message;
      loader.innerHTML = `<span style="color: var(--text-secondary); font-size: 0.95rem;"><i class="fa-solid fa-chart-pie" style="margin-right: 0.5rem;"></i> ${displayMsg}</span>`;
    }
  }
}

const BACKUP_PALETTE = [
  'rgba(34, 197, 94, 0.85)',   // green
  'rgba(249, 115, 22, 0.85)',   // orange
  'rgba(236, 72, 153, 0.85)',  // pink
  'rgba(168, 85, 247, 0.85)',  // purple
  'rgba(59, 130, 246, 0.85)',   // blue
  'rgba(20, 184, 166, 0.85)',   // teal
  'rgba(99, 102, 241, 0.85)',   // indigo
  'rgba(245, 158, 11, 0.85)',   // amber
  'rgba(255, 127, 80, 0.85)',   // coral
  'rgba(255, 69, 0, 0.85)',     // red-orange
  'rgba(6, 182, 212, 0.85)',    // cyan
  'rgba(253, 224, 71, 0.85)',   // gold
  'rgba(217, 70, 239, 0.85)',   // magenta
  'rgba(106, 90, 205, 0.85)',   // slate blue
  'rgba(120, 113, 108, 0.85)',  // brown
  // Additional backup distinct hues
  'rgba(132, 204, 22, 0.85)',   // lime
  'rgba(244, 63, 94, 0.85)',    // rose
  'rgba(14, 165, 233, 0.85)',   // sky blue
  'rgba(13, 148, 136, 0.85)',   // dark teal
  'rgba(162, 28, 175, 0.85)',   // dark magenta
  'rgba(180, 83, 9, 0.85)',     // dark amber
  'rgba(67, 56, 202, 0.85)',     // dark indigo
];

const sectorColorCache = {};
let backupColorIdx = 0;

function normalizeSectorName(name) {
  if (!name) return "";
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

function getSectorColor(sectorName) {
  const norm = normalizeSectorName(sectorName);
  if (norm === 'others' || norm === 'other' || norm === 'etfs') {
    return 'rgba(71, 85, 105, 0.85)'; // slate-600 for "Others" / "ETFs"
  }
  
  const explicitMappings = {
    'utilities': 'rgba(34, 197, 94, 0.85)', // green
    'energy': 'rgba(249, 115, 22, 0.85)', // orange
    'consumer discretionary': 'rgba(236, 72, 153, 0.85)', // pink
    'consumer cyclical': 'rgba(236, 72, 153, 0.85)', // pink
    'materials': 'rgba(168, 85, 247, 0.85)', // purple
    'basic materials': 'rgba(168, 85, 247, 0.85)', // purple
    'communication': 'rgba(59, 130, 246, 0.85)', // blue
    'telecommunication': 'rgba(59, 130, 246, 0.85)', // blue
    'communication services': 'rgba(59, 130, 246, 0.85)', // blue
    'telecommunication - service provider': 'rgba(59, 130, 246, 0.85)', // blue
    'telecommunication - service  provider': 'rgba(59, 130, 246, 0.85)', // blue // double spaces
    'banking - private': 'rgba(20, 184, 166, 0.85)', // teal
    'bank - private': 'rgba(20, 184, 166, 0.85)', // teal
    'banking - public': 'rgba(99, 102, 241, 0.85)', // indigo
    'bank - public': 'rgba(99, 102, 241, 0.85)', // indigo
    'finance/nbfc': 'rgba(245, 158, 11, 0.85)', // amber
    'banking & finance': 'rgba(245, 158, 11, 0.85)', // amber
    'financial services': 'rgba(245, 158, 11, 0.85)', // amber
    'financials': 'rgba(245, 158, 11, 0.85)', // amber
    'automobiles - passenger cars': 'rgba(255, 127, 80, 0.85)', // coral
    'auto - trucks': 'rgba(255, 69, 0, 0.85)', // red-orange
    'electric equipment': 'rgba(6, 182, 212, 0.85)', // cyan
    'diamond & gold jewellery': 'rgba(253, 224, 71, 0.85)', // gold
    'diamond  & gold  jewellery': 'rgba(253, 224, 71, 0.85)', // gold // double spaces
    'textile': 'rgba(217, 70, 239, 0.85)', // magenta
    'power generation/distribution': 'rgba(106, 90, 205, 0.85)', // slate blue
    'mining & minerals': 'rgba(120, 113, 108, 0.85)', // brown
    'metal - non ferrous': 'rgba(148, 163, 184, 0.85)', // grey
  };
  
  if (explicitMappings[norm]) {
    return explicitMappings[norm];
  }
  
  if (sectorColorCache[norm]) {
    return sectorColorCache[norm];
  }
  
  // Assign next unused backup color (never grey)
  let chosenColor = null;
  for (let i = 0; i < BACKUP_PALETTE.length; i++) {
    const color = BACKUP_PALETTE[(backupColorIdx + i) % BACKUP_PALETTE.length];
    if (color !== 'rgba(148, 163, 184, 0.85)') {
      chosenColor = color;
      backupColorIdx = (backupColorIdx + i + 1) % BACKUP_PALETTE.length;
      break;
    }
  }
  
  if (!chosenColor) {
    chosenColor = 'rgba(34, 197, 94, 0.85)';
  }
  
  sectorColorCache[norm] = chosenColor;
  return chosenColor;
}

function getSectorBaseColor(sectorName) {
  return getSectorColor(sectorName);
}

function formatINRNoSymbol(val) {
  return Math.abs(val).toLocaleString('en-IN', {
    maximumFractionDigits: 0
  });
}

function externalTooltipHandler(context) {
  // Tooltip Element
  let tooltipEl = document.getElementById('chartjs-tooltip');

  // Create element on first render
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'chartjs-tooltip';
    tooltipEl.style.background = 'rgba(15, 23, 42, 0.96)';
    tooltipEl.style.borderRadius = '12px';
    tooltipEl.style.color = '#94a3b8';
    tooltipEl.style.opacity = 1;
    tooltipEl.style.pointerEvents = 'none';
    tooltipEl.style.position = 'absolute';
    tooltipEl.style.transition = 'all .08s ease';
    tooltipEl.style.border = '1px solid rgba(255, 255, 255, 0.12)';
    tooltipEl.style.padding = '12px';
    tooltipEl.style.zIndex = '9999';
    tooltipEl.style.boxShadow = '0 10px 25px -5px rgba(0, 0, 0, 0.5)';
    tooltipEl.style.fontSize = '12px';
    tooltipEl.style.fontFamily = '"Plus Jakarta Sans", sans-serif';
    document.body.appendChild(tooltipEl);
  }

  // Hide if no tooltip
  const tooltipModel = context.tooltip;
  if (tooltipModel.opacity === 0) {
    tooltipEl.style.opacity = 0;
    return;
  }

  // Set Text content
  if (tooltipModel.body) {
    const dataset = context.chart.data.datasets[tooltipModel.dataPoints[0].datasetIndex];
    const sec = dataset.sectorRawData;
    if (sec) {
      const sign = sec.return_pct >= 0 ? '+' : '';
      const rupeesSign = sec.contrib_rupees >= 0 ? '+' : '';
      
      const posColor = '#10b981';
      const negColor = '#ef4444';
      
      let innerHtml = `
        <div style="font-weight: bold; font-family: 'Outfit'; font-size: 13px; color: #f8fafc; margin-bottom: 6px; display: flex; align-items: center; gap: 0.4rem;">
          <span>📁 Sector: ${sec.sector}</span>
        </div>
        <div style="margin-bottom: 4px;">💼 Portfolio Weight: <strong>${sec.weight_pct.toFixed(2)}%</strong></div>
        <div style="margin-bottom: 4px;">📈 Sector Return: <strong style="color: ${sec.return_pct >= 0 ? posColor : negColor};">${sign}${sec.return_pct.toFixed(2)}%</strong></div>
        <div style="margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,0.08);">
          🎯 Contribution: <strong style="color: ${sec.contrib_pct >= 0 ? posColor : negColor};">${sec.contrib_pct >= 0 ? '+' : ''}${sec.contrib_pct.toFixed(2)}% (${rupeesSign}₹${formatINRNoSymbol(sec.contrib_rupees)})</strong>
        </div>
        <div style="font-weight: bold; color: #f8fafc; margin-bottom: 4px; font-size: 11px;">Holdings Detail:</div>
        <ul style="list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px;">
      `;
      
      sec.stocks.forEach(st => {
        const stSign = st.return_pct >= 0 ? '+' : '';
        const stRupeesSign = st.contrib_rupees >= 0 ? '+' : '';
        innerHtml += `
          <li style="font-size: 11px; display: flex; justify-content: space-between; gap: 1.5rem;">
            <span style="color:#e2e8f0;">• ${st.name}</span>
            <span>
              <span style="color: ${st.return_pct >= 0 ? posColor : negColor}; font-weight:600;">${stSign}${st.return_pct.toFixed(2)}%</span>
              <small style="color: #94a3b8; font-weight:normal;">(${stRupeesSign}₹${formatINRNoSymbol(st.contrib_rupees)})</small>
            </span>
          </li>
        `;
      });
      
      innerHtml += '</ul>';
      tooltipEl.innerHTML = innerHtml;
    }
  }

  const position = context.chart.canvas.getBoundingClientRect();

  // Position calculation with right-edge screen overflow check
  tooltipEl.style.opacity = 1;
  const tooltipWidth = tooltipEl.offsetWidth;
  const viewportWidth = window.innerWidth;
  
  let leftPos = window.pageXOffset + position.left + tooltipModel.caretX + 15;
  if (leftPos + tooltipWidth > viewportWidth - 20) {
    leftPos = window.pageXOffset + position.left + tooltipModel.caretX - tooltipWidth - 15;
  }
  
  tooltipEl.style.left = leftPos + 'px';
  tooltipEl.style.top = window.pageYOffset + position.top + tooltipModel.caretY - 40 + 'px';
}

function renderSectorContributionChart(data) {
  const ctx = document.getElementById('chart-sector-contribution');
  if (!ctx) return;
  
  if (sectorContribChart) {
    sectorContribChart.destroy();
  }
  
  // Clean elements
  const loader = document.getElementById("contrib-loading");
  const chartContainer = document.getElementById("contrib-chart-container");
  const summaryRow = document.getElementById("contrib-summary-row");
  const emptyState = document.getElementById("contrib-empty-state");
  const legendBox = document.getElementById("contrib-legend");
  
  // Sort sectors based on active sorting mode
  let sortedSectors = [...data.sectors];
  if (contribSortMode === 'contribution') {
    sortedSectors.sort((a, b) => b.contrib_pct - a.contrib_pct);
  } else {
    sortedSectors.sort((a, b) => a.sector.localeCompare(b.sector));
  }
  
  // Empty State Check: If only 1 sector exists, show the requested empty state
  if (sortedSectors.length <= 1) {
    if (loader) loader.style.display = "none";
    if (chartContainer) chartContainer.style.display = "none";
    if (summaryRow) summaryRow.style.display = "none";
    if (legendBox) legendBox.style.display = "none";
    if (emptyState) emptyState.style.display = "flex";
    return;
  } else {
    if (loader) loader.style.display = "none";
    if (emptyState) emptyState.style.display = "none";
    if (chartContainer) chartContainer.style.display = "block";
    if (summaryRow) summaryRow.style.display = "grid";
    if (legendBox) {
      legendBox.style.display = "block";
      legendBox.style.flexWrap = "unset";
      legendBox.style.justifyContent = "unset";
      legendBox.style.gap = "unset";
      
      const top5 = sortedSectors.slice(0, 5);
      const remaining = sortedSectors.slice(5);
      
      const renderLegendItem = (sec) => {
        const isNeg = sec.contrib_pct < 0;
        const color = getSectorColor(sec.sector);
        const sign = sec.contrib_pct >= 0 ? '+' : '';
        const rupeesSign = sec.contrib_rupees >= 0 ? '₹' : '-₹';
        const rupeesVal = formatINRNoSymbol(Math.abs(sec.contrib_rupees));
        return `
          <div style="display: flex; align-items: center; gap: 0.5rem; font-size: 12px; height: 16px;">
            <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background-color: ${color}; flex-shrink: 0;"></span>
            <span style="color: var(--text-secondary); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;" title="${sec.sector}">${sec.sector}</span>
            <strong style="color: ${isNeg ? '#f87171' : '#34d399'}; margin-left: auto; padding-left: 4px; font-weight: 600;">${sign}${sec.contrib_pct.toFixed(2)}%</strong>
            <span style="color: var(--text-primary); font-family: 'Outfit'; font-weight: 500; margin-left: 6px;">${rupeesSign}${rupeesVal}</span>
          </div>
        `;
      };
      
      let legendHTML = `
        <div style="width: 100%; display: flex; flex-direction: column; gap: 8px; font-size: 12px; padding: 0.5rem 0 0;">
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px;">
            ${top5.map(sec => renderLegendItem(sec)).join('')}
          </div>
      `;
      
      if (remaining.length > 0) {
        legendHTML += `
          <div id="contrib-remaining-sectors" style="display: none; margin-top: 8px;">
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px;">
              ${remaining.map(sec => renderLegendItem(sec)).join('')}
            </div>
          </div>
          <div style="text-align: center; margin-top: 8px; border-top: 1px solid rgba(255,255,255,0.03); padding-top: 6px;">
            <button id="contrib-more-btn" style="
              background: none; border: none; color: var(--accent); cursor: pointer;
              font-family: 'Outfit', sans-serif; font-size: 12px; font-weight: 600;
              padding: 4px 8px; display: inline-flex; align-items: center; gap: 4px;
            ">
              <span id="contrib-more-text">+${remaining.length} more sectors</span>
              <i id="contrib-more-icon" class="fa-solid fa-chevron-down"></i>
            </button>
          </div>
        `;
      }
      
      legendHTML += `</div>`;
      legendBox.innerHTML = legendHTML;
      
      if (remaining.length > 0) {
        const moreBtn = document.getElementById("contrib-more-btn");
        if (moreBtn) {
          moreBtn.addEventListener("click", () => {
            const container = document.getElementById("contrib-remaining-sectors");
            const textEl = document.getElementById("contrib-more-text");
            const iconEl = document.getElementById("contrib-more-icon");
            if (container.style.display === "none") {
              container.style.display = "block";
              textEl.innerText = "Show less";
              iconEl.className = "fa-solid fa-chevron-up";
            } else {
              container.style.display = "none";
              textEl.innerText = `+${remaining.length} more sectors`;
              iconEl.className = "fa-solid fa-chevron-down";
            }
          });
        }
      }
    }
  }
  
  // CSS Vars for styling tooltips
  const cssVars = getComputedStyle(document.body);
  const textPrimary = cssVars.getPropertyValue('--text-primary').trim() || '#f8fafc';
  const textSecondary = cssVars.getPropertyValue('--text-secondary').trim() || '#94a3b8';
  
  // Update summary stats
  document.getElementById("contrib-summary-portfolio").innerText = `${data.portfolio_return_pct >= 0 ? '+' : ''}${data.portfolio_return_pct.toFixed(2)}%`;
  document.getElementById("contrib-summary-portfolio").className = data.portfolio_return_pct >= 0 ? 'positive' : 'negative';
  
  document.getElementById("contrib-summary-bench-name").innerText = `${data.benchmark_name} Return`;
  document.getElementById("contrib-summary-bench").innerText = `${data.benchmark_return_pct >= 0 ? '+' : ''}${data.benchmark_return_pct.toFixed(2)}%`;
  document.getElementById("contrib-summary-bench").className = data.benchmark_return_pct >= 0 ? 'positive' : 'negative';
  
  const alphaVal = data.alpha;
  const valEl = document.getElementById("contrib-summary-alpha");
  const labelEl = document.getElementById("contrib-summary-alpha-label");
  valEl.innerText = `${alphaVal >= 0 ? '+' : ''}${alphaVal.toFixed(2)}%`;
  valEl.style.color = '';
  
  if (alphaVal > 0.5) {
    valEl.className = 'value positive';
    if (labelEl) labelEl.innerText = "Generated Alpha";
  } else if (alphaVal < -0.5) {
    valEl.className = 'value negative';
    if (labelEl) labelEl.innerText = "Generated Alpha";
  } else {
    valEl.className = 'value';
    valEl.style.color = '#94a3b8';
    if (labelEl) labelEl.innerText = "Flat vs Benchmark";
  }

  // Update downturn context note under sector contribution alpha figure
  const downturnEl = document.getElementById("contrib-downturn-note");
  if (downturnEl) {
    if (data.portfolio_return_pct < 0 && data.benchmark_return_pct < 0) {
      downturnEl.style.display = "block";
      if (alphaVal > 0.5) {
        downturnEl.innerText = "Market was down this period — your portfolio showed resilience vs benchmark";
      } else if (alphaVal < -0.5) {
        downturnEl.innerText = "Market was down this period — your portfolio underperformed the benchmark";
      } else {
        downturnEl.innerText = "Market was down this period — your portfolio closely tracked the benchmark";
      }
    } else {
      downturnEl.style.display = "none";
    }
  }
  
  // Build Chart.js horizontal stacked datasets
  const datasets = sortedSectors.map(sec => {
    const isNeg = sec.contrib_pct < 0;
    const color = getSectorColor(sec.sector);
    
    // Ensure thin visible sliver for near-zero contributions (min +/- 0.35% display value for 3px width)
    const originalValue = sec.contrib_pct;
    let displayValue = originalValue;
    const minVisPct = 0.35;
    if (Math.abs(originalValue) < 1.0) {
      if (originalValue >= 0) {
        displayValue = Math.max(originalValue, minVisPct);
      } else {
        displayValue = Math.min(originalValue, -minVisPct);
      }
    }
    
    return {
      label: sec.sector,
      data: [displayValue],
      backgroundColor: color,
      borderColor: color.replace('0.85', '1.0').replace('0.75', '1.0').replace('0.22', '0.6'),
      borderWidth: 1,
      stack: 'stack1',
      sectorRawData: sec,
      originalValue: originalValue
    };
  });
  
  // Inline Custom Plugin to render sector labels inside segments if they fit
  const segmentLabelsPlugin = {
    id: 'segmentLabels',
    afterDatasetDraw(chart, args, options) {
      const { ctx } = chart;
      const meta = args.meta;
      const dataset = chart.data.datasets[args.index];
      const rawData = dataset.sectorRawData;
      if (!rawData) return;

      const element = meta.data[0];
      if (!element) return;

      // Midpoint coordinate and width of horizontal bar segment
      const x = element.x;
      const base = element.base;
      const midX = (base + x) / 2;
      const y = element.y;
      const segmentWidth = Math.abs(x - base);

      // Save canvas state
      ctx.save();
      ctx.font = 'bold 10px "Plus Jakarta Sans"';
      const pct = rawData.contrib_pct;
      const text = (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';

      // Font padding check to guarantee no fonts ever overlap
      if (segmentWidth > 40) {
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        // Smooth shadow for perfect readability on all gradients
        ctx.shadowColor = 'rgba(15, 23, 42, 0.75)';
        ctx.shadowBlur = 4;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;

        ctx.fillText(text, midX, y);
      }
      ctx.restore();
    }
  };
  
  sectorContribChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['Contribution'],
      datasets: datasets
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      hover: {
        mode: 'dataset',
        intersect: true
      },
      scales: {
        x: {
          stacked: true,
          grid: {
            color: 'rgba(255, 255, 255, 0.04)'
          },
          ticks: {
            color: textSecondary,
            font: { family: 'Plus Jakarta Sans', size: 10 },
            callback: function(value) {
              return (value >= 0 ? '+' : '') + value.toFixed(1) + '%';
            }
          }
        },
        y: {
          stacked: true,
          display: false
        }
      },
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          enabled: false,
          external: externalTooltipHandler
        }
      }
    },
    plugins: [segmentLabelsPlugin]
  });
}

function setContribPeriod(period) {
  activeContribPeriod = period;
  
  // Update UI active buttons
  const buttons = document.querySelectorAll("#widget-sector-contribution-chart .perf-period-btn");
  buttons.forEach(btn => {
    if (btn.id === `contrib-btn-${period}`) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });
  
  fetchSectorContributionData();
}

function toggleContribSorting() {
  const btn = document.getElementById("contrib-sort-btn");
  if (contribSortMode === 'contribution') {
    contribSortMode = 'sector';
    btn.innerHTML = `<i class="fa-solid fa-sort-alpha-down"></i> Sort: Sector`;
  } else {
    contribSortMode = 'contribution';
    btn.innerHTML = `<i class="fa-solid fa-sort-amount-down"></i> Sort: Contribution`;
  }
  
  // Re-fetch or re-render
  fetchSectorContributionData();
}



// RENDER STOCKS GRID WITH CUSTOM COLUMNS
function renderStocksTable() {
  if (!portfolioData) return;
  
  const headersRow = document.getElementById("stocks-table-headers");
  const body = document.getElementById("stocks-table-body");
  headersRow.innerHTML = "";
  body.innerHTML = "";
  
  // Determine visible columns from user config or default
  const visCols = appConfig ? appConfig.display_columns.stocks : ALL_STOCK_COLUMNS;
  
  // Generate Table Headers
  visCols.forEach(col => {
    const th = document.createElement("th");
    th.innerText = col;
    headersRow.appendChild(th);
  });
  
  // Add Actions header
  const thActions = document.createElement("th");
  thActions.innerText = "Actions";
  headersRow.appendChild(thActions);
  
  // Generate rows
  if (portfolioData.stocks.length === 0) {
    body.innerHTML = `<tr><td colspan="${visCols.length + 1}" style="text-align: center; color: var(--text-secondary); padding: 3rem 1rem;">
      <div style="display:flex;flex-direction:column;align-items:center;gap:0.75rem;">
        <i class="fa-solid fa-folder-open" style="font-size:2rem;opacity:0.3;"></i>
        <p style="margin:0;font-size:0.95rem;">No stock holdings found in your database.</p>
        <div style="display:flex;gap:0.5rem;justify-content:center;">
          <button class="btn btn-secondary btn-sm" onclick="openAddStockModal()"><i class="fa-solid fa-plus"></i> Add New Stock</button>
          <button class="btn btn-secondary btn-sm" onclick="document.getElementById('csv-file-input').click()"><i class="fa-solid fa-file-import"></i> Import Broker CSV</button>
        </div>
      </div>
    </td></tr>`;
    return;
  }
  
  let hasMissingBuyDates = false;
  let missingSectorsCount = 0;
  
  portfolioData.stocks.forEach(s => {
    const tr = document.createElement("tr");
    tr.id = `stock-row-${s.row_idx}`;
    
    visCols.forEach(col => {
      const td = document.createElement("td");
      const rawVal = col === "Return (₹)" ? s["Total Return"] : s[col];
      
      // Formatting cells beautifully
      if (col === "Scrip Name") {
        td.innerHTML = `<strong>${rawVal}</strong>`;
      } else if (col === "Exchange" || col === "Sector" || col === "Industry") {
        if (col === "Sector" && s.is_sector_missing) {
          const SECTOR_CHOICES = ["Banking", "IT", "Energy", "Pharma", "FMCG", "Automobile", "Infrastructure", "Metal", "Telecom", "Chemicals", "Consumer Durables", "Real Estate", "ETFs", "Others"];
          td.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 0.35rem;" onclick="event.stopPropagation();">
              <span style="color: #f97316; font-size: 0.8rem; font-weight: 600;"><i class="fa-solid fa-triangle-exclamation"></i> Sector not assigned</span>
              <select class="form-control form-control-sm" onchange="saveInlineSector(${s.row_idx}, this)" style="padding: 0.2rem 0.4rem; font-size: 0.8rem; background: rgba(249, 115, 22, 0.05); border: 1px solid rgba(249, 115, 22, 0.25); color: var(--text-primary); border-radius: 4px;">
                <option value="">Select Sector...</option>
                ${SECTOR_CHOICES.map(sec => `<option value="${sec}">${sec}</option>`).join("")}
              </select>
            </div>
          `;
          missingSectorsCount++;
        } else {
          td.innerText = rawVal || "-";
          td.style.color = "var(--text-secondary)";
        }
      } else if (col === "Qty") {
        td.innerText = rawVal.toLocaleString();
      } else if (col === "Buy Price" || col === "Current Price" || col === "Invested Value" || col === "Current Value" || col === "Dividends") {
        td.innerText = formatINR(rawVal);
      } else if (col === "P&L" || col === "Return (₹)") {
        td.innerText = formatINR(rawVal);
        td.className = rawVal >= 0 ? 'positive' : 'negative';
      } else if (col === "Return %" || col === "5Y CAGR" || col === "Nifty 5Y CAGR") {
        if (rawVal !== null && rawVal !== undefined && !isNaN(rawVal)) {
          if (col === "Return %") {
            td.className = rawVal >= 0 ? 'positive' : 'negative';
            if (Math.abs(rawVal) > 500) {
              td.innerHTML = `${rawVal.toFixed(2)}% <i class="fa-solid fa-triangle-exclamation" title="Unusually high return — verify buy price and corporate actions" style="color: #f59e0b; cursor: help; margin-left: 4px;"></i>`;
            } else {
              td.innerText = `${rawVal.toFixed(2)}%`;
            }
          } else {
            td.innerText = `${rawVal.toFixed(2)}%`;
          }
        } else {
          td.innerText = "N/A";
        }
      } else if (col === "Buy Date") {
        if (!rawVal || rawVal.trim() === "") {
          td.innerHTML = `
            <div style="display: flex; align-items: center; gap: 0.35rem;" onclick="event.stopPropagation();">
              <input type="date" class="form-control form-control-sm" id="inline-date-${s.row_idx}" style="padding: 0.2rem 0.4rem; font-size: 0.8rem; min-width: 115px; background: rgba(249, 115, 22, 0.05); border: 1px solid rgba(249, 115, 22, 0.25);">
              <button class="btn btn-secondary btn-sm" onclick="saveInlineBuyDate(${s.row_idx}, this)" style="padding: 0.25rem 0.45rem; font-size: 0.8rem; background: var(--accent); color: white;" title="Save Date"><i class="fa-solid fa-check"></i></button>
            </div>
          `;
          hasMissingBuyDates = true;
        } else {
          td.innerText = rawVal;
        }
      } else if (col === "Holding Period") {
        const yrs = s["Holding Period Yrs"];
        const type = s["Holding Type"] || "ST";
        const badgeClass = type === "LT" ? "badge-lt" : "badge-st";
        if (yrs !== null && yrs !== undefined && !isNaN(yrs)) {
          const formatted = formatHoldingPeriod(yrs);
          td.innerHTML = `${formatted} <span class="${badgeClass}">${type}</span>`;
        } else {
          td.innerText = "—";
        }
      } else if (col === "Tax Flag") {
        if (rawVal) {
          td.innerHTML = `<span class="badge ${rawVal.toLowerCase()}">${rawVal}</span>`;
        } else {
          td.innerText = "-";
        }
      } else {
        td.innerText = rawVal !== null ? rawVal : "-";
      }
      
      tr.appendChild(td);
    });
    
    // Add edit/delete buttons
    const tdActions = document.createElement("td");
    tdActions.innerHTML = `
      <div style="display: flex; gap: 0.5rem;">
        <button class="btn btn-secondary btn-sm" onclick="openEditStockModal(${JSON.stringify(s).replace(/"/g, '&quot;')})" title="Edit"><i class="fa-solid fa-edit"></i></button>
        <button class="btn btn-danger btn-sm" onclick="deleteStockHolding(${s.row_idx})" title="Delete"><i class="fa-solid fa-trash"></i></button>
      </div>
    `;
    tr.appendChild(tdActions);
    body.appendChild(tr);
  });
  
  const banner = document.getElementById("missing-buy-dates-banner");
  if (banner) {
    banner.style.display = hasMissingBuyDates ? "flex" : "none";
  }

  const bannerSectors = document.getElementById("missing-sectors-banner");
  const sectorsCountSpan = document.getElementById("missing-sectors-count");
  if (bannerSectors) {
    if (missingSectorsCount > 0) {
      if (sectorsCountSpan) sectorsCountSpan.innerText = missingSectorsCount;
      bannerSectors.style.display = "flex";
    } else {
      bannerSectors.style.display = "none";
    }
  }
}

// FILTER TABLES
function filterStocksTable() {
  const q = document.getElementById("stock-search").value.toLowerCase();
  const rows = document.querySelectorAll("#stocks-table-body tr");
  
  rows.forEach(row => {
    const text = row.innerText.toLowerCase();
    row.style.display = text.includes(q) ? "" : "none";
  });
}

// RENDER MUTUAL FUNDS GRID
let mfSortCol = null;
let mfSortDir = 1; // 1 = asc, -1 = desc

function renderMfsTable() {
  if (!portfolioData) return;
  
  const headersRow = document.getElementById("mfs-table-headers");
  const body = document.getElementById("mfs-table-body");
  headersRow.innerHTML = "";
  body.innerHTML = "";
  
  // Use custom columns if loaded in config
  const visCols = appConfig ? appConfig.display_columns.mf : ALL_MF_COLUMNS;
  
  // Build sortable headers
  visCols.forEach(col => {
    const th = document.createElement("th");
    th.className = "th-sortable";
    th.dataset.col = col;
    
    // Nice display labels
    const labels = {
      "Fund Name": "Fund Name",
      "Category": "Category",
      "Units Held": "Units",
      "Invested Value": "Invested",
      "Current Value": "Current Value",
      "P&L": "P&L",
      "Return %": "Return %",
      "XIRR %": "XIRR %",
      "Holding Period": "Holding Period",
      "Tax Flag": "Tax Type"
    };
    th.innerText = labels[col] || col;
    
    if (mfSortCol === col) th.classList.add(mfSortDir === 1 ? "th-asc" : "th-desc");
    
    th.addEventListener("click", () => {
      if (mfSortCol === col) mfSortDir *= -1;
      else { mfSortCol = col; mfSortDir = 1; }
      renderMfsTable();
    });
    headersRow.appendChild(th);
  });
  
  const thActions = document.createElement("th");
  thActions.innerText = "Actions";
  headersRow.appendChild(thActions);
  
  if (portfolioData.mfs.length === 0) {
    body.innerHTML = `<tr><td colspan="${visCols.length + 1}" style="text-align: center; color: var(--text-secondary); padding: 3rem 1rem;">
      <div style="display:flex;flex-direction:column;align-items:center;gap:0.75rem;">
        <i class="fa-solid fa-folder-open" style="font-size:2rem;opacity:0.3;"></i>
        <p style="margin:0;font-size:0.95rem;">No mutual funds added yet.</p>
        <button class="btn btn-secondary btn-sm" onclick="openAddMfModal()"><i class="fa-solid fa-plus"></i> Add New Fund</button>
      </div>
    </td></tr>`;
    renderMfSummaryFooter();
    return;
  }
  
  // Sort data
  let mfRows = [...portfolioData.mfs];
  if (mfSortCol) {
    mfRows.sort((a, b) => {
      const colKey = mfSortCol === "Return %" ? "Absolute Return %" : mfSortCol;
      let aVal = colKey === "Holding Period" ? (a["Holding Period Yrs"] ?? 0) : (a[colKey] ?? "");
      let bVal = colKey === "Holding Period" ? (b["Holding Period Yrs"] ?? 0) : (b[colKey] ?? "");
      if (typeof aVal === "string") aVal = aVal.toLowerCase();
      if (typeof bVal === "string") bVal = bVal.toLowerCase();
      if (aVal < bVal) return -mfSortDir;
      if (aVal > bVal) return mfSortDir;
      return 0;
    });
  }
  
  mfRows.forEach(m => {
    const tr = document.createElement("tr");
    tr.id = `mf-row-${m.row_idx}`;
    tr.dataset.category = (m["Category"] || "").toLowerCase();
    tr.dataset.taxflag = (m["Tax Flag"] || "").toLowerCase();
    
    visCols.forEach(col => {
      const td = document.createElement("td");
      
      if (col === "Fund Name") {
        td.innerHTML = `<span class="mf-fund-link" onclick="openMfDetailDrawer(${JSON.stringify(m).replace(/"/g, '&quot;')})">${m["Fund Name"]}</span>`;
        
      } else if (col === "Category") {
        td.innerText = m["Category"] || "—";
        td.style.color = "var(--text-secondary)";
        
      } else if (col === "Units Held") {
        td.innerText = (m["Units Held"] || 0).toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
        
      } else if (col === "Invested Value" || col === "Current Value") {
        td.innerText = formatINR(m[col]);
        
      } else if (col === "P&L") {
        const pnl = m["P&L"];
        td.innerText = formatINR(pnl);
        td.className = pnl >= 0 ? "positive" : "negative";
        
      } else if (col === "Return %") {
        const ret = m["Absolute Return %"];
        if (ret !== null && ret !== undefined) {
          td.className = ret >= 0 ? "positive" : "negative";
          if (Math.abs(ret) > 500) {
            td.innerHTML = `${ret >= 0 ? "+" : ""}${ret.toFixed(2)}% <i class="fa-solid fa-triangle-exclamation" title="Unusually high return — verify purchase history and corporate actions" style="color: #f59e0b; cursor: help; margin-left: 4px;"></i>`;
          } else {
            td.innerText = `${ret >= 0 ? "+" : ""}${ret.toFixed(2)}%`;
          }
        } else {
          td.innerText = "N/A";
        }
        
      } else if (col === "XIRR %") {
        const xirr = m["XIRR %"];
        if (xirr === null || xirr === undefined) {
          td.innerText = "—";
          td.style.color = "var(--text-secondary)";
          td.title = "XIRR unavailable (holding period < 7 days or insufficient data)";
        } else {
          td.innerText = `${xirr >= 0 ? "+" : ""}${xirr.toFixed(2)}%`;
          td.className = xirr >= 0 ? "positive" : "negative";
        }
        
      } else if (col === "Holding Period") {
        const yrs = m["Holding Period Yrs"] || 0;
        const type = m["Holding Type"] || "ST";
        const badgeClass = type === "LT" ? "badge-lt" : "badge-st";
        td.innerHTML = `${yrs.toFixed(2)} Yrs<span class="${badgeClass}">${type}</span>`;
        
      } else if (col === "Tax Flag") {
        const flag = m["Tax Flag"] || "";
        const est = m["Estimated Tax"] || 0;
        const taxLabel = flag === "LTCG" ? "LTCG" : (flag === "STCG" ? "STCG" : flag);
        const badgeCls = flag === "LTCG" ? "ltcg" : "stcg";
        const rateHint = flag === "LTCG" ? "12.5% above ₹1.25L" : "20% flat";
        td.innerHTML = `<span class="badge ${badgeCls}" title="Est. tax if redeemed today: ${formatINR(est)} (${rateHint})">${taxLabel}</span>`;
        
      } else {
        td.innerText = m[col] !== null && m[col] !== undefined ? m[col] : "—";
      }
      
      tr.appendChild(td);
    });
    
    const tdActions = document.createElement("td");
    const mJson = JSON.stringify(m).replace(/"/g, '&quot;');
    tdActions.innerHTML = `
      <div style="display: flex; gap: 0.5rem;">
        <button class="btn btn-secondary btn-sm" onclick="openMfDetailDrawer(${mJson})" title="View Details"><i class="fa-solid fa-eye"></i></button>
        <button class="btn btn-secondary btn-sm" onclick="openEditMfModal(${mJson})" title="Edit"><i class="fa-solid fa-edit"></i></button>
        <button class="btn btn-danger btn-sm" onclick="deleteMfHolding(${m.row_idx})" title="Delete"><i class="fa-solid fa-trash"></i></button>
      </div>
    `;
    tr.appendChild(tdActions);
    body.appendChild(tr);
  });
  
  renderMfSummaryFooter();
  filterMfsTable();
}

function renderMfSummaryFooter() {
  const footer = document.getElementById("mf-summary-footer");
  if (!footer || !portfolioData) return;
  
  const mfs = portfolioData.mfs;
  if (mfs.length === 0) { footer.style.display = "none"; return; }
  
  const s = portfolioData.summary;
  const pnl = s.total_mf_pnl;
  
  footer.style.display = "flex";
  document.getElementById("mf-sum-invested").innerText = formatINR(s.total_mf_invested);
  document.getElementById("mf-sum-value").innerText = formatINR(s.total_mf_value);
  const pnlEl = document.getElementById("mf-sum-pnl");
  pnlEl.innerText = `${formatINR(pnl)} (${s.total_mf_return_pct.toFixed(2)}%)`;
  pnlEl.style.color = pnl >= 0 ? "var(--positive)" : "var(--negative)";
  document.getElementById("mf-sum-stcg").innerText = formatINR(s.total_mf_stcg_tax || 0);
  document.getElementById("mf-sum-ltcg").innerText = formatINR(s.total_mf_ltcg_tax || 0);
}

function openMfDetailDrawer(m) {
  const drawer = document.getElementById("mf-detail-drawer");
  const overlay = document.getElementById("mf-drawer-overlay");
  const body = document.getElementById("mf-drawer-body");
  
  document.getElementById("mf-drawer-title").innerText = m["Fund Name"];
  document.getElementById("mf-drawer-subtitle").innerText = `${m["AMC"] || "—"}  ·  ${m["Category"] || "—"}`;
  
  const pnl = m["P&L"] || 0;
  const pnlColor = pnl >= 0 ? "var(--positive)" : "var(--negative)";
  const xirr = m["XIRR %"];
  const xirrStr = (xirr === null || xirr === undefined) ? "—" : `${xirr >= 0 ? "+" : ""}${xirr.toFixed(2)}%`;
  const rateHint = m["Tax Flag"] === "LTCG" ? "12.5% above ₹1.25L exemption" : "20% flat";

  body.innerHTML = `
    <div class="mf-drawer-section-title">Fund Identity</div>
    <div class="mf-drawer-row"><span class="mf-drawer-label">Fund Name</span><span class="mf-drawer-value" style="max-width:240px;text-align:right;line-height:1.4;">${m["Fund Name"]}</span></div>
    <div class="mf-drawer-row"><span class="mf-drawer-label">AMC</span><span class="mf-drawer-value">${m["AMC"] || "—"}</span></div>
    <div class="mf-drawer-row"><span class="mf-drawer-label">Category</span><span class="mf-drawer-value">${m["Category"] || "—"}</span></div>
    <div class="mf-drawer-row"><span class="mf-drawer-label">Sub-Category</span><span class="mf-drawer-value">${m["Sub-Category"] || "—"}</span></div>
    <div class="mf-drawer-row"><span class="mf-drawer-label">Investment Type</span><span class="mf-drawer-value">${m["Investment Type"] || "Lumpsum"}</span></div>

    <div class="mf-drawer-section-title">NAV & Units</div>
    <div class="mf-drawer-row"><span class="mf-drawer-label">Buy NAV</span><span class="mf-drawer-value">${formatINR(m["Buy NAV"])}</span></div>
    <div class="mf-drawer-row"><span class="mf-drawer-label">Current NAV</span><span class="mf-drawer-value">${formatINR(m["Current NAV"])}</span></div>
    <div class="mf-drawer-row"><span class="mf-drawer-label">Units Held</span><span class="mf-drawer-value">${(m["Units Held"] || 0).toLocaleString(undefined, {minimumFractionDigits:3, maximumFractionDigits:3})}</span></div>
    <div class="mf-drawer-row"><span class="mf-drawer-label">Purchase Date</span><span class="mf-drawer-value">${m["Buy Date"] || "—"}</span></div>
    <div class="mf-drawer-row"><span class="mf-drawer-label">Holding Period</span><span class="mf-drawer-value">${(m["Holding Period Yrs"] || 0).toFixed(2)} Yrs <span class="${m["Holding Type"] === "LT" ? "badge-lt" : "badge-st"}">${m["Holding Type"] || "ST"}</span></span></div>

    <div class="mf-drawer-section-title">Returns</div>
    <div class="mf-drawer-row"><span class="mf-drawer-label">Invested Amount</span><span class="mf-drawer-value">${formatINR(m["Invested Value"])}</span></div>
    <div class="mf-drawer-row"><span class="mf-drawer-label">Current Value</span><span class="mf-drawer-value">${formatINR(m["Current Value"])}</span></div>
    <div class="mf-drawer-row"><span class="mf-drawer-label">Unrealised P&L</span><span class="mf-drawer-value" style="color:${pnlColor}">${formatINR(pnl)}</span></div>
    <div class="mf-drawer-row"><span class="mf-drawer-label">Absolute Return %</span><span class="mf-drawer-value ${pnl >= 0 ? "positive" : "negative"}">${m["Absolute Return %"] !== null ? (m["Absolute Return %"] >= 0 ? "+" : "") + m["Absolute Return %"].toFixed(2) + "%" : "N/A"}</span></div>
    <div class="mf-drawer-row"><span class="mf-drawer-label">XIRR % (Annualised)</span><span class="mf-drawer-value ${xirr !== null && xirr !== undefined ? (xirr >= 0 ? "positive" : "negative") : ""}">${xirrStr}</span></div>

    <div class="mf-drawer-section-title">Tax & Fund Info</div>
    <div class="mf-drawer-row"><span class="mf-drawer-label">Tax Classification</span><span class="mf-drawer-value"><span class="badge ${(m["Tax Flag"] || "").toLowerCase()}">${m["Tax Flag"] || "—"}</span></span></div>
    <div class="mf-drawer-row"><span class="mf-drawer-label">Est. Tax if Redeemed</span><span class="mf-drawer-value" style="color:#fb923c;">${formatINR(m["Estimated Tax"] || 0)} <small style="font-weight:400;color:var(--text-secondary);">(${rateHint})</small></span></div>
    <div class="mf-drawer-row"><span class="mf-drawer-label">Expense Ratio</span><span class="mf-drawer-value">${m["Expense Ratio %"] ? m["Expense Ratio %"].toFixed(2) + "%" : "—"}</span></div>
    <div class="mf-drawer-row"><span class="mf-drawer-label">Benchmark 1Y Return</span><span class="mf-drawer-value">${m["Benchmark 1Y Return %"] !== null && m["Benchmark 1Y Return %"] !== undefined ? m["Benchmark 1Y Return %"].toFixed(2) + "%" : "—"}</span></div>
  `;
  
  // Wire up Edit button
  document.getElementById("mf-drawer-edit-btn").onclick = () => {
    closeMfDetailDrawer();
    openEditMfModal(m);
  };
  
  drawer.classList.add("open");
  overlay.classList.add("open");
  document.body.style.overflow = "hidden";
}

function closeMfDetailDrawer() {
  document.getElementById("mf-detail-drawer").classList.remove("open");
  document.getElementById("mf-drawer-overlay").classList.remove("open");
  document.body.style.overflow = "";
}

function filterMfsTable() {
  const q = (document.getElementById("mf-search")?.value || "").toLowerCase();
  const catFilter = (document.getElementById("mf-category-filter")?.value || "").toLowerCase();
  const taxFilter = (document.getElementById("mf-tax-filter")?.value || "").toLowerCase();
  
  const rows = document.querySelectorAll("#mfs-table-body tr");
  rows.forEach(row => {
    const text = row.innerText.toLowerCase();
    const cat = (row.dataset.category || "").toLowerCase();
    const tax = (row.dataset.taxflag || "").toLowerCase();
    
    const matchQ = !q || text.includes(q);
    const matchCat = !catFilter || cat.includes(catFilter);
    const matchTax = !taxFilter || tax === taxFilter;
    
    row.style.display = (matchQ && matchCat && matchTax) ? "" : "none";
  });
}



// RENDER RISK & SIGNALS GRID
function renderRiskSignals() {
  if (!portfolioData) return;
  
  const body = document.getElementById("signals-table-body");
  if (!body) return;
  body.innerHTML = "";
  
  const signals = portfolioData.signals || [];
  
  let gCount = 0;
  let lCount = 0;
  let underCount = 0;
  
  signals.forEach(s => {
    const sig = s["Signal"] ? s["Signal"].toLowerCase() : "";
    const priority = s["Priority"] ? s["Priority"].toLowerCase() : "";
    const ret = s["Return %"];
    
    // Increment counts for the summary widget cards
    if (sig.includes("strong") || ret > 20) {
      gCount++;
    } else if (sig.includes("loss") || ret < 0) {
      lCount++;
    } else if (sig.includes("tiny") || priority.includes("medium") || priority.includes("high")) {
      underCount++;
    }
  });

  document.getElementById("signal-cnt-gainers").innerText = gCount;
  document.getElementById("signal-cnt-losers").innerText = lCount;
  document.getElementById("signal-cnt-under").innerText = underCount;
  
  if (signals.length === 0) {
    body.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-secondary); padding: 2.5rem;">No action signals found in Excel sheet. Check back later!</td></tr>`;
    return;
  }
  
  // Render table rows
  signals.forEach(s => {
    const tr = document.createElement("tr");
    
    // Styled rows based on priority levels
    let rowClass = "";
    let priorityBadge = "ltcg"; // blue
    
    if (s["Priority"].includes("HIGH")) {
      rowClass = "priority-high-row";
      priorityBadge = "stcg"; // red
    } else if (s["Priority"].includes("MEDIUM")) {
      rowClass = "priority-medium-row";
      priorityBadge = "warning-badge"; // yellow badge
    }
    
    if (rowClass) tr.className = rowClass;
    
    // 1. Scrip
    const tdScrip = document.createElement("td");
    tdScrip.innerHTML = `<strong>${s["Scrip Name"]}</strong>`;
    tr.appendChild(tdScrip);
    
    // 2. Value
    const tdVal = document.createElement("td");
    tdVal.innerText = formatINR(s["Current Value"]);
    tr.appendChild(tdVal);
    
    // 3. Return
    const tdRet = document.createElement("td");
    const rVal = s["Return %"];
    if (typeof rVal === 'number') {
      tdRet.innerText = `${rVal.toFixed(2)}%`;
      tdRet.className = rVal >= 0 ? 'positive' : 'negative';
    } else {
      tdRet.innerText = rVal || "0.00%";
    }
    tr.appendChild(tdRet);
    
    // 4. Signal Type
    const tdSig = document.createElement("td");
    let sigBadgeClass = "badge ltcg";
    if (s["Signal"].includes("Tiny")) sigBadgeClass = "badge warning-badge";
    if (s["Signal"].includes("Loss")) sigBadgeClass = "badge stcg";
    tdSig.innerHTML = `<span class="${sigBadgeClass}">${s["Signal"] || "Active"}</span>`;
    tr.appendChild(tdSig);
    
    // 5. Priority Level
    const tdPriority = document.createElement("td");
    tdPriority.innerHTML = `<span class="badge ${priorityBadge}">${s["Priority"] || "LOW"}</span>`;
    tr.appendChild(tdPriority);
    
    // 6. Action Recommendation
    const tdAction = document.createElement("td");
    tdAction.innerText = s["Recommended Action"] || "-";
    tdAction.style.fontSize = "0.85rem";
    tdAction.style.color = "var(--text-secondary)";
    tr.appendChild(tdAction);
    
    body.appendChild(tr);
  });
}

function filterSignalsTable() {
  const q = document.getElementById("signal-search").value.toLowerCase();
  const rows = document.querySelectorAll("#signals-table-body tr");
  
  rows.forEach(row => {
    const text = row.innerText.toLowerCase();
    row.style.display = text.includes(q) ? "" : "none";
  });
}

// REAL-TIME CONCENTRATION & HIGH DRAWDOWN RISK ALERTS
let alertsExpanded = false; // session preference — collapses by default

function reviewHolding(scripName, rowIdx) {
  // 1. Switch to Stocks tab
  switchTab('stocks');
  // 2. Find the row, scroll to it, and briefly highlight it
  setTimeout(() => {
    let targetRow = null;

    // Try direct ID lookup first (most precise)
    if (rowIdx) {
      targetRow = document.getElementById(`stock-row-${rowIdx}`);
    }

    // Fall back to name-based search
    if (!targetRow) {
      const rows = document.querySelectorAll('#stocks-table-body tr');
      for (const row of rows) {
        const firstCell = row.querySelector('td');
        if (firstCell && firstCell.innerText.trim().toLowerCase().includes(scripName.toLowerCase())) {
          targetRow = row;
          break;
        }
      }
    }

    if (targetRow) {
      targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
      targetRow.style.transition = 'box-shadow 0.3s ease, background 0.3s ease';
      targetRow.style.boxShadow = '0 0 0 2px var(--accent), 0 0 20px var(--accent-glow)';
      targetRow.style.background = 'rgba(var(--accent-rgb), 0.12)';
      setTimeout(() => {
        targetRow.style.transition = 'box-shadow 1.5s ease, background 1.5s ease';
        targetRow.style.boxShadow = '';
        targetRow.style.background = '';
      }, 3000);
    }
  }, 350);
}

function evaluateRiskAlerts() {
  const container = document.getElementById("alerts-container");
  container.innerHTML = "";
  if (!portfolioData || !appConfig) return;

  const hasHoldings = (portfolioData.stocks && portfolioData.stocks.length > 0) || (portfolioData.mfs && portfolioData.mfs.length > 0);
  if (!hasHoldings) {
    container.style.display = "none";
    return;
  }
  container.style.display = "block";

  if (appConfig.widgets && appConfig.widgets.risk_alerts === false) {
    return;
  }

  const rules = appConfig.custom_alerts || { high_concentration_pct: 20, high_loss_pct: 10 };
  const alerts = [];

  // 1. Sector Concentration Alerts
  const sectorsMap = {};
  const totalStockVal = portfolioData.summary.total_stock_value || 0;
  const totalMfVal = portfolioData.summary.total_mf_value || 0;
  const totalPortfolioVal = totalStockVal + totalMfVal;

  if (totalPortfolioVal > 0) {
    portfolioData.stocks.forEach(s => {
      const sec = s["Sector"] || "Other";
      sectorsMap[sec] = (sectorsMap[sec] || 0) + (s["Current Value"] || 0);
    });

    Object.keys(sectorsMap).forEach(sec => {
      const pct = (sectorsMap[sec] / totalPortfolioVal) * 100;
      if (pct >= 40) {
        alerts.push({
          severity: 'critical',
          severityScore: 5,
          isCritical: true,
          html: `
            <div style="display:flex;align-items:center;gap:0.6rem;flex:1;">
              <span style="font-size:1.1rem;">🔴</span>
              <span><strong>Critical Concentration:</strong> Sector <strong>${sec}</strong> makes up <strong>${pct.toFixed(0)}%</strong> of your portfolio. This is a high risk level. Diversify immediately.</span>
            </div>
          `
        });
      } else if (pct >= 20) {
        alerts.push({
          severity: 'warning',
          severityScore: 3,
          isCritical: false,
          html: `
            <div style="display:flex;align-items:center;gap:0.6rem;flex:1;">
              <span style="font-size:1.1rem;">⚠</span>
              <span><strong>Concentration Warning:</strong> Sector <strong>${sec}</strong> makes up <strong>${pct.toFixed(0)}%</strong> of your portfolio (Threshold: 20%). Consider diversifying.</span>
            </div>
          `
        });
      }
    });
  }

  // 2. High Drawdown Stock Alerts (Severity-Sorted)
  portfolioData.stocks.forEach(s => {
    const ret = s["Return %"];
    if (ret >= 0) return; // only drawdowns
    const lossPct = -ret; // positive number
    const drawdownDays = s["Drawdown Days"]; // -1 = unknown, 0+ = real count
    const hasBuyDate = !!s["Buy Date"];

    // Build drawdown duration label
    let durationLabel;
    if (drawdownDays === -1 || drawdownDays === undefined || drawdownDays === null) {
      durationLabel = `Drawdown: Duration unknown — add buy date to calculate`;
    } else {
      durationLabel = `Drawdown: ${drawdownDays} consecutive trading days`;
    }

    let severity = null;
    let score = 0;
    let label = '';
    let icon = '';
    let isCritical = false;

    // Use specified thresholds: Critical ≥35%, Warning 20-35%, Low 10-20%
    if (lossPct >= 35) {
      severity = 'critical';
      score = 4;
      label = 'Critical Drawdown';
      icon = '🔴';
      isCritical = true;
    } else if (lossPct >= 20) {
      severity = 'warning';
      score = 3;
      label = 'High Drawdown';
      icon = '⚠';
      isCritical = false;
    } else if (lossPct >= 10) {
      severity = 'low';
      score = 2;
      label = 'Moderate Drawdown';
      icon = '🟡';
      isCritical = false;
    }

    if (severity) {
      const scrip = s["Scrip Name"];
      const rowIdx = s["row_idx"];
      alerts.push({
        severity: severity,
        severityScore: score,
        isCritical: isCritical,
        html: `
          <div style="display:flex;align-items:center;gap:0.6rem;flex:1;">
            <span style="font-size:1.1rem;">${icon}</span>
            <span><strong>${label}:</strong> Position <strong>'${scrip}'</strong> is down <strong>${lossPct.toFixed(1)}%</strong> (${durationLabel}).</span>
          </div>
          <button class="alert-review-btn" onclick="reviewHolding('${scrip.replace(/'/g, "\\'")}', ${rowIdx})">
            <i class="fa-solid fa-arrow-right-to-bracket"></i> Review Holding
          </button>
        `
      });
    }
  });

  if (alerts.length === 0) {
    // No alerts — container stays empty
    container.innerHTML = '';
    return;
  }

  // Sort: Critical(5/4) → Warning(3) → Low(2)
  alerts.sort((a, b) => b.severityScore - a.severityScore);

  const criticalAlerts = alerts.filter(a => a.isCritical);
  const otherAlerts    = alerts.filter(a => !a.isCritical);
  const warnCount      = alerts.filter(a => a.severity === 'warning').length;
  const lowCount       = alerts.filter(a => a.severity === 'low').length;

  // Build the collapsed summary bar
  const summaryBar = document.createElement("div");
  summaryBar.id = "alerts-summary-bar";
  const hasCrit = criticalAlerts.length > 0;
  summaryBar.style.cssText = `
    display: flex; align-items: center; justify-content: space-between;
    padding: 0.6rem 1rem; border-radius: 8px; font-size: 0.85rem; font-weight: 600;
    margin-bottom: 0.5rem; cursor: pointer; user-select: none;
    background: ${hasCrit ? 'rgba(239,68,68,0.15)' : 'rgba(249,115,22,0.1)'};
    border: 1px solid ${hasCrit ? 'rgba(239,68,68,0.35)' : 'rgba(249,115,22,0.3)'};
    color: ${hasCrit ? '#f87171' : '#fb923c'};
  `;
  const parts = [];
  if (criticalAlerts.length > 0) parts.push(`🔴 ${criticalAlerts.length} Critical`);
  if (warnCount > 0) parts.push(`⚠ ${warnCount} Warning`);
  if (lowCount > 0) parts.push(`🟡 ${lowCount} Low Severity`);
  summaryBar.innerHTML = `
    <span>${parts.join('&nbsp;&nbsp;•&nbsp;&nbsp;')}</span>
    <span id="alerts-toggle-icon" style="font-size:0.8rem;">${alertsExpanded ? '▲ Collapse' : '▼ Show all'}</span>
  `;
  summaryBar.addEventListener('click', () => {
    alertsExpanded = !alertsExpanded;
    document.getElementById("alerts-toggle-icon").innerText = alertsExpanded ? '▲ Collapse' : '▼ Show all';
    const collapsible = document.getElementById("alerts-collapsible");
    if (collapsible) collapsible.style.display = alertsExpanded ? 'block' : 'none';
  });
  container.appendChild(summaryBar);

  // Critical alerts always rendered (always visible)
  criticalAlerts.forEach(alert => {
    const div = document.createElement("div");
    div.className = `alert-banner-critical`;
    div.innerHTML = alert.html;
    container.appendChild(div);
  });

  // Non-critical alerts go in collapsible section
  if (otherAlerts.length > 0) {
    const collapsible = document.createElement("div");
    collapsible.id = "alerts-collapsible";
    collapsible.style.display = alertsExpanded ? 'block' : 'none';

    otherAlerts.forEach(alert => {
      const div = document.createElement("div");
      div.className = `alert-banner-${alert.severity}`;
      div.innerHTML = alert.html;
      collapsible.appendChild(div);
    });

    container.appendChild(collapsible);
  }
}

// CONVERT TO FORMATTED INR
function formatINR(val) {
  if (val === null || val === undefined) return "₹0.00";
  return "₹" + val.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// STOCK CRUD MODAL INTERACTIONS
function openAddStockModal() {
  document.getElementById("modal-stock-title").innerText = "Add New Stock Holding";
  document.getElementById("stock-form").reset();
  document.getElementById("stock-row-idx").value = "";
  document.getElementById("stock-buy-date").value = "";
  document.getElementById("stock-live-price-helper").innerText = "";
  document.getElementById("btn-stock-submit").innerText = "Add Holding";
  document.getElementById("modal-stock").classList.add("active");
}

function openEditStockModal(s) {
  document.getElementById("modal-stock-title").innerText = `Edit: ${s["Scrip Name"]}`;
  document.getElementById("stock-row-idx").value = s.row_idx;
  document.getElementById("stock-scrip").value = s["Scrip Name"] || "";
  document.getElementById("stock-sector").value = s["Sector"] || "";
  document.getElementById("stock-qty").value = s["Qty"];
  document.getElementById("stock-buy-price").value = s["Buy Price"];
  document.getElementById("stock-buy-date").value = s["Buy Date"] || "";
  document.getElementById("stock-current-price").value = s["Current Price"] || "";
  document.getElementById("stock-live-price-helper").innerText = "";
  
  if (s["Scrip Name"]) {
    fetchLivePriceHelper(s["Scrip Name"]);
  }
  
  document.getElementById("btn-stock-submit").innerText = "Save Changes";
  document.getElementById("modal-stock").classList.add("active");
}

function closeStockModal() {
  document.getElementById("modal-stock").classList.remove("active");
}

async function submitStockForm(e) {
  e.preventDefault();
  const rowIdx = document.getElementById("stock-row-idx").value;
  const url = rowIdx ? '/api/stock/edit' : '/api/stock/add';
  
  const payload = {
    row_idx: rowIdx,
    "Company Name":       document.getElementById("stock-scrip").value.trim(),
    "Sector":             document.getElementById("stock-sector").value.trim(),
    "Total Quantity":     parseFloat(document.getElementById("stock-qty").value) || 0,
    "Avg Trading Price":  parseFloat(document.getElementById("stock-buy-price").value) || 0,
    "Buy Date":           document.getElementById("stock-buy-date").value.trim(),
    "Current Price":      parseFloat(document.getElementById("stock-current-price").value) || null,
    // For edit compatibility — these map to the same fields the backend reads
    "Scrip Name":         document.getElementById("stock-scrip").value.trim(),
    "Exchange":           "NSE",
    "Qty":                parseFloat(document.getElementById("stock-qty").value) || 0,
    "Buy Price":          parseFloat(document.getElementById("stock-buy-price").value) || 0,
  };

  try {
    const res = await authorizedFetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.status === 'success') {
      closeStockModal();
      await fetchPortfolio();
    } else {
      alert("Error: " + data.message);
    }
  } catch (err) {
    alert("API connection failed. Ensure Flask app is running!");
  }
}

// ─── CSV IMPORT MODAL ──────────────────────────────────────────────────────────
let selectedCsvFile = null;

function openImportCsvModal() {
  clearCsvSelection();
  document.getElementById("csv-import-result").style.display = "none";
  document.getElementById("modal-import-csv").classList.add("active");
}

function closeImportCsvModal() {
  document.getElementById("modal-import-csv").classList.remove("active");
  clearCsvSelection();
  document.getElementById("csv-import-result").style.display = "none";
}

function csvDragOver(e) {
  e.preventDefault();
  e.stopPropagation();
  const zone = document.getElementById("csv-drop-zone");
  zone.style.borderColor = "var(--accent)";
  zone.style.background = "rgba(var(--accent-rgb), 0.1)";
}

function csvDragLeave(e) {
  const zone = document.getElementById("csv-drop-zone");
  zone.style.borderColor = "rgba(var(--accent-rgb), 0.5)";
  zone.style.background = "rgba(var(--accent-rgb), 0.04)";
}

function csvDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  csvDragLeave(e);
  const file = e.dataTransfer.files[0];
  if (file) setCsvFile(file);
}

function csvFileSelected(e) {
  const file = e.target.files[0];
  if (file) setCsvFile(file);
}

function setCsvFile(file) {
  if (!file.name.toLowerCase().endsWith('.csv')) {
    showCsvResult(false, 'Invalid file type. Please select a .csv file.');
    return;
  }
  selectedCsvFile = file;
  document.getElementById("csv-filename").innerText = file.name;
  document.getElementById("csv-filesize").innerText = `${(file.size / 1024).toFixed(1)} KB`;
  document.getElementById("csv-file-preview").style.display = "block";
  document.getElementById("btn-csv-import-submit").disabled = false;
  document.getElementById("csv-import-result").style.display = "none";
}

function clearCsvSelection() {
  selectedCsvFile = null;
  document.getElementById("csv-file-input").value = "";
  document.getElementById("csv-file-preview").style.display = "none";
  document.getElementById("btn-csv-import-submit").disabled = true;
}

function showCsvResult(success, message) {
  const el = document.getElementById("csv-import-result");
  el.style.display = "block";
  el.style.background = success
    ? "rgba(16, 185, 129, 0.12)"
    : "rgba(239, 68, 68, 0.12)";
  el.style.border = success
    ? "1px solid rgba(16, 185, 129, 0.35)"
    : "1px solid rgba(239, 68, 68, 0.35)";
  el.style.color = success ? "#10b981" : "#ef4444";
  el.innerHTML = success
    ? `<i class="fa-solid fa-circle-check"></i> ${message}`
    : `<i class="fa-solid fa-circle-xmark"></i> ${message}`;
}

async function submitCsvImport() {
  if (!selectedCsvFile) return;

  const btn = document.getElementById("btn-csv-import-submit");
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Importing...';

  try {
    const formData = new FormData();
    formData.append('file', selectedCsvFile);

    const res = await authorizedFetch('/api/stock/import-csv', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();

    if (data.status === 'success') {
      showCsvResult(true, data.message);
      clearCsvSelection();
      await fetchPortfolio();  // Refresh the table
    } else {
      showCsvResult(false, data.message);
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-file-import"></i> Import Stocks';
    }
  } catch (err) {
    showCsvResult(false, 'Network error. Make sure the Flask server is running.');
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-file-import"></i> Import Stocks';
  }
}

async function deleteStockHolding(rowIdx) {
  if (!confirm("Are you sure you want to delete this stock from your portfolio and the underlying Excel file?")) return;
  try {
    const res = await authorizedFetch('/api/stock/delete', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({row_idx: rowIdx})
    });
    const data = await res.json();
    if (data.status === 'success') {
      await fetchPortfolio();
    } else {
      alert("Error: " + data.message);
    }
  } catch (err) {
    console.error("Delete stock request failed", err);
  }
}

function openDeleteAllModal() {
  const count = portfolioData && portfolioData.stocks ? portfolioData.stocks.length : 0;
  document.getElementById("delete-all-count").innerText = count;
  document.getElementById("delete-all-confirm-input").value = "";
  document.getElementById("btn-delete-all-submit").disabled = true;
  document.getElementById("modal-delete-all-confirm").classList.add("active");
}

function closeDeleteAllModal() {
  document.getElementById("modal-delete-all-confirm").classList.remove("active");
}

async function submitDeleteAllStocks() {
  const confirmVal = document.getElementById("delete-all-confirm-input").value.trim().toUpperCase();
  if (confirmVal !== "DELETE") {
    alert("Please type DELETE to confirm.");
    return;
  }
  
  const btn = document.getElementById("btn-delete-all-submit");
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Deleting...';
  
  try {
    const res = await authorizedFetch('/api/stock/delete-all', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'}
    });
    const data = await res.json();
    if (data.status === 'success') {
      closeDeleteAllModal();
      await fetchPortfolio();
      showToast("All stock holdings deleted successfully!");
    } else {
      alert("Error: " + data.message);
      btn.disabled = false;
      btn.innerHTML = "Permanently Delete All";
    }
  } catch (err) {
    console.error("Delete all stocks request failed", err);
    alert("Connection error occurred.");
    btn.disabled = false;
    btn.innerHTML = "Permanently Delete All";
  }
}

function formatHoldingPeriod(yrs) {
  if (yrs === null || yrs === undefined || isNaN(yrs)) return "—";
  if (yrs < 0) return "—";
  
  const totalDays = Math.round(yrs * 365);
  if (totalDays < 30) {
    return `${totalDays} Day${totalDays !== 1 ? 's' : ''}`;
  }
  
  const totalMonths = Math.round(yrs * 12);
  const years = Math.floor(totalMonths / 12);
  const months = totalMonths % 12;
  
  let parts = [];
  if (years > 0) {
    parts.push(`${years} Yr${years !== 1 ? 's' : ''}`);
  }
  if (months > 0) {
    parts.push(`${months} Mo`);
  }
  return parts.join(" ") || "0 Mo";
}

async function saveInlineBuyDate(rowIdx, btn) {
  const input = document.getElementById(`inline-date-${rowIdx}`);
  if (!input || !input.value) {
    alert("Please select a valid date first.");
    return;
  }
  
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
  
  try {
    const res = await authorizedFetch('/api/stock/save-buy-date', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        row_idx: rowIdx,
        "Buy Date": input.value
      })
    });
    const data = await res.json();
    if (data.status === 'success') {
      showToast("Buy date saved successfully!");
      await fetchPortfolio();
    } else {
      alert("Error: " + data.message);
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-check"></i>';
    }
  } catch (err) {
    alert("Connection error while saving date.");
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-check"></i>';
  }
}

async function saveInlineSector(rowIdx, selectElement) {
  const sector = selectElement.value;
  if (!sector) return;
  
  selectElement.disabled = true;
  
  try {
    const res = await authorizedFetch('/api/stock/save-sector', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        row_idx: rowIdx,
        Sector: sector
      })
    });
    const data = await res.json();
    if (data.status === 'success') {
      showToast("Sector saved successfully!");
      await fetchPortfolio();
    } else {
      alert("Error: " + data.message);
      selectElement.disabled = false;
    }
  } catch (err) {
    alert("Connection error while saving sector.");
    selectElement.disabled = false;
  }
}

// MUTUAL FUND CRUD MODAL INTERACTIONS
function openAddMfModal() {
  document.getElementById("modal-mf-title").innerText = "Add New Mutual Fund Holding";
  document.getElementById("mf-form").reset();
  document.getElementById("mf-row-idx").value = "";
  document.getElementById("btn-mf-submit").innerText = "Add Fund";
  document.getElementById("modal-mf").classList.add("active");
}

function openEditMfModal(m) {
  document.getElementById("modal-mf-title").innerText = `Edit: ${m["Fund Name"]}`;
  document.getElementById("mf-row-idx").value = m.row_idx;
  document.getElementById("mf-name").value = m["Fund Name"] || "";
  document.getElementById("mf-amc").value = m["AMC"] || "";
  document.getElementById("mf-category").value = m["Category"] || "";
  document.getElementById("mf-subcategory").value = m["Sub-Category"] || "";
  document.getElementById("mf-units").value = m["Units Held"] || "";
  document.getElementById("mf-buy-nav").value = m["Buy NAV"] || "";
  document.getElementById("mf-buy-date").value = m["Buy Date"] || "";
  document.getElementById("mf-current-nav").value = m["Current NAV"] || "";
  document.getElementById("mf-benchmark").value = m["Benchmark 1Y Return %"] || "";
  document.getElementById("mf-expense").value = m["Expense Ratio %"] || 0;
  document.getElementById("mf-investment-type").value = m["Investment Type"] || "Lumpsum";
  
  document.getElementById("btn-mf-submit").innerText = "Save Changes";
  document.getElementById("modal-mf").classList.add("active");
}

function closeMfModal() {
  document.getElementById("modal-mf").classList.remove("active");
}

async function submitMfForm(e) {
  e.preventDefault();
  const rowIdx = document.getElementById("mf-row-idx").value;
  const url = rowIdx ? '/api/mf/edit' : '/api/mf/add';
  
  const payload = {
    row_idx: rowIdx,
    "Fund Name": document.getElementById("mf-name").value,
    AMC: document.getElementById("mf-amc").value,
    Category: document.getElementById("mf-category").value,
    "Sub-Category": document.getElementById("mf-subcategory").value,
    "Units Held": document.getElementById("mf-units").value,
    "Buy NAV": document.getElementById("mf-buy-nav").value,
    "Buy Date": document.getElementById("mf-buy-date").value,
    "Current NAV": document.getElementById("mf-current-nav").value || document.getElementById("mf-buy-nav").value,
    "Benchmark 1Y Return %": document.getElementById("mf-benchmark").value,
    "Expense Ratio %": document.getElementById("mf-expense").value,
    "Investment Type": document.getElementById("mf-investment-type").value || "Lumpsum"
  };

  try {
    const res = await authorizedFetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.status === 'success') {
      closeMfModal();
      await fetchPortfolio();
    } else {
      alert("Error: " + data.message);
    }
  } catch (err) {
    alert("API connection failed.");
  }
}

async function deleteMfHolding(rowIdx) {
  if (!confirm("Are you sure you want to delete this Mutual Fund holding from your portfolio?")) return;
  try {
    const res = await authorizedFetch('/api/mf/delete', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({row_idx: rowIdx})
    });
    const data = await res.json();
    if (data.status === 'success') {
      await fetchPortfolio();
    } else {
      alert("Error: " + data.message);
    }
  } catch (err) {
    console.error("Delete fund failed", err);
  }
}

// VISUAL SETTINGS PANEL logic
function loadSettingsIntoForm() {
  if (!appConfig) return;
  
  // Theme highlights
  applyTheme(appConfig.theme);
  
  // Columns Checkboxes inside Settings
  const stChecksContainer = document.getElementById("settings-stock-columns-checks");
  const mfChecksContainer = document.getElementById("settings-mf-columns-checks");
  stChecksContainer.innerHTML = "";
  mfChecksContainer.innerHTML = "";
  
  ALL_STOCK_COLUMNS.forEach(col => {
    const isChecked = appConfig.display_columns.stocks.includes(col);
    const label = document.createElement("label");
    label.className = "checkbox-label";
    label.innerHTML = `<input type="checkbox" name="stock-col" value="${col}" ${isChecked ? 'checked' : ''}> ${col}`;
    label.querySelector("input").addEventListener("change", triggerCheckboxToast);
    stChecksContainer.appendChild(label);
  });

  ALL_MF_COLUMNS.forEach(col => {
    const isChecked = appConfig.display_columns.mf.includes(col);
    const label = document.createElement("label");
    label.className = "checkbox-label";
    label.innerHTML = `<input type="checkbox" name="mf-col" value="${col}" ${isChecked ? 'checked' : ''}> ${col}`;
    label.querySelector("input").addEventListener("change", triggerCheckboxToast);
    mfChecksContainer.appendChild(label);
  });
  
  // Widgets toggles
  document.getElementById("widget-check-sector").checked = appConfig.widgets.sector_allocation;
  document.getElementById("widget-check-asset").checked = appConfig.widgets.asset_allocation;
  document.getElementById("widget-check-leaders").checked = appConfig.widgets.top_performers;
  document.getElementById("widget-check-underperformers").checked = (appConfig.widgets.top_underperformers !== false);
  document.getElementById("widget-check-alerts").checked = (appConfig.widgets.risk_alerts !== false);
  
  // Tax flags days
  document.getElementById("settings-stock-ltcg").value = appConfig.tax_rules.stocks_ltcg_days;
  document.getElementById("settings-mf-ltcg").value = appConfig.tax_rules.mf_ltcg_days;
  
  // Custom limits
  document.getElementById("settings-alert-concentration").value = appConfig.custom_alerts.high_concentration_pct;
  document.getElementById("settings-alert-loss").value = appConfig.custom_alerts.high_loss_pct;
  
  // Auto update price settings
  document.getElementById("settings-auto-update").checked = (appConfig.auto_update_prices !== false);
}

// SAVE CONFIGURATION SETTINGS
async function saveCustomSettings(e) {
  e.preventDefault();
  
  // Gather active Stock columns checkboxes
  const stockCols = [];
  document.querySelectorAll("input[name='stock-col']:checked").forEach(cb => {
    stockCols.push(cb.value);
  });
  
  // Gather active Mutual Fund columns checkboxes
  const mfCols = [];
  document.querySelectorAll("input[name='mf-col']:checked").forEach(cb => {
    mfCols.push(cb.value);
  });
  
  // Map payload
  const payload = {
    theme: activeTheme,
    auto_update_prices: document.getElementById("settings-auto-update").checked,
    tax_rules: {
      stocks_ltcg_days: parseInt(document.getElementById("settings-stock-ltcg").value),
      mf_ltcg_days: parseInt(document.getElementById("settings-mf-ltcg").value)
    },
    display_columns: {
      stocks: stockCols,
      mf: mfCols
    },
    widgets: {
      sector_allocation: document.getElementById("widget-check-sector").checked,
      asset_allocation: document.getElementById("widget-check-asset").checked,
      top_performers: document.getElementById("widget-check-leaders").checked,
      top_underperformers: document.getElementById("widget-check-underperformers").checked,
      risk_alerts: document.getElementById("widget-check-alerts").checked,
      portfolio_signals: true,
      dividend_yield: true
    },
    custom_alerts: {
      high_concentration_pct: parseInt(document.getElementById("settings-alert-concentration").value),
      high_loss_pct: parseInt(document.getElementById("settings-alert-loss").value)
    }
  };
  
  await saveConfigOnServer(payload);
  appConfig = payload;
  
  // Instantly apply settings without full reload
  updateDashboardMetrics();
  renderCharts();
  renderStocksTable();
  renderMfsTable();
  evaluateRiskAlerts();
  
  showToast("Settings saved successfully!");
}

async function saveConfigOnServer(config) {
  try {
    await authorizedFetch('/api/config', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(config)
    });
  } catch (err) {
    console.error("Config save failed", err);
  }
}

// BACKGROUND LIVE PRICE UPDATER PROCESS
async function startLivePriceScraper() {
  // Trigger update prices background thread
  try {
    const res = await authorizedFetch('/api/update-prices', { method: 'POST' });
    const data = await res.json();
    if (data.status === 'success') {
      showScraperProgressWidget();
      startPollingProgress();
    } else {
      alert("Error starting scraper: " + data.message);
    }
  } catch (err) {
    console.error("Failed to start prices update", err);
  }
}

let localLastUpdatedTimestamp = null;
let priceStatusTimer = null;

function checkScraperRunningOnStartup() {
  // Query status once to check if running
  authorizedFetch('/api/update-status')
    .then(res => res.json())
    .then(data => {
      if (data.status === 'running') {
        showScraperProgressWidget();
        startPollingProgress();
      }
      
      if (data.last_updated) {
        localLastUpdatedTimestamp = data.last_updated;
      }
      
      // Immediately set header badge
      const dotEl = document.getElementById("price-status-dot");
      const textEl = document.getElementById("price-status-text");
      if (dotEl && textEl) {
        dotEl.className = "status-dot " + data.status;
        if (data.status === "running") {
          textEl.innerText = `Updating (${data.progress_pct}%)`;
        } else if (data.status === "background_running") {
          textEl.innerText = `Auto-updating (${data.progress_pct}%)`;
        } else if (data.status === "locked") {
          textEl.innerText = "Excel Locked (retrying)";
        } else if (data.status === "error") {
          textEl.innerHTML = `<span style="color: var(--danger); font-weight: bold; cursor: pointer;" onclick="startLivePriceScraper()">Update failed — Retry</span>`;
        } else {
          textEl.innerText = data.last_updated 
            ? `Last updated: ${formatLastUpdated(data.last_updated)}`
            : "Last updated: Never";
        }
      }
      
      // Start periodic status checking
      startPriceStatusPolling();
    });
}

function startPriceStatusPolling() {
  if (priceStatusTimer) clearInterval(priceStatusTimer);
  
  priceStatusTimer = setInterval(async () => {
    try {
      const res = await authorizedFetch('/api/update-status');
      const data = await res.json();
      
      const dotEl = document.getElementById("price-status-dot");
      const textEl = document.getElementById("price-status-text");
      if (dotEl && textEl) {
        dotEl.className = "status-dot " + data.status;
        if (data.status === "running") {
          textEl.innerText = `Updating (${data.progress_pct}%)`;
        } else if (data.status === "background_running") {
          textEl.innerText = `Auto-updating (${data.progress_pct}%)`;
        } else if (data.status === "locked") {
          textEl.innerText = "Excel Locked (retrying)";
        } else if (data.status === "error") {
          textEl.innerHTML = `<span style="color: var(--danger); font-weight: bold; cursor: pointer;" onclick="startLivePriceScraper()">Update failed — Retry</span>`;
        } else {
          textEl.innerText = data.last_updated 
            ? `Last updated: ${formatLastUpdated(data.last_updated)}`
            : "Last updated: Never";
        }
      }
      
      // Refresh portfolio if new updates came in
      if (data.last_updated) {
        if (localLastUpdatedTimestamp === null) {
          localLastUpdatedTimestamp = data.last_updated;
        } else if (data.last_updated > localLastUpdatedTimestamp) {
          console.log("[Auto Price Updater] Detected newer prices. Refreshing portfolio data...");
          localLastUpdatedTimestamp = data.last_updated;
          await fetchPortfolio();
        }
      }
    } catch (err) {
      console.error("Error polling price status", err);
    }
  }, 10000);
}

function formatLastUpdated(timestamp) {
  if (!timestamp) return "Never";
  const diffSec = Math.floor((Date.now() / 1000) - timestamp);
  if (diffSec < 10) return "Just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return new Date(timestamp * 1000).toLocaleDateString();
}

function showScraperProgressWidget() {
  document.getElementById("price-updater-container").style.display = "flex";
  document.getElementById("btn-updater-close").style.display = "none";
  console.log("Initializing scraping connections...");
}

function startPollingProgress() {
  if (priceUpdateTimer) clearInterval(priceUpdateTimer);
  
  let lastLoggedLength = 0;
  
  priceUpdateTimer = setInterval(async () => {
    try {
      const res = await authorizedFetch('/api/update-status');
      const data = await res.json();
      
      // Update UI labels
      document.getElementById("updater-progress-pct").innerText = `${data.progress_pct}%`;
      document.getElementById("updater-progress-bar").style.width = `${data.progress_pct}%`;
      document.getElementById("updater-current-ticker").innerText = data.current_ticker 
        ? `Active scrip: ${data.current_ticker} (${data.current_index}/${data.total_tickers}) — Elapsed: ${data.elapsed_seconds}s` 
        : "Checking sheet...";
        
      // Redirect logs to console
      if (data.logs && data.logs.length > lastLoggedLength) {
        for (let i = lastLoggedLength; i < data.logs.length; i++) {
          console.log("[Scraper] " + data.logs[i]);
        }
        lastLoggedLength = data.logs.length;
      }
      
      if (data.status === 'completed') {
        clearInterval(priceUpdateTimer);
        document.getElementById("updater-status-title").innerHTML = `<i class="fa-solid fa-circle-check" style="color: var(--success);"></i> Live Price Update Complete!`;
        document.getElementById("btn-updater-close").style.display = "none";
        
        // Refresh tables to see fresh prices
        await fetchPortfolio();
        
        // Set local timestamp to match
        if (data.last_updated) {
          localLastUpdatedTimestamp = data.last_updated;
        }
        
        // Auto-dismiss the widget after 3 seconds
        setTimeout(() => {
          document.getElementById("price-updater-container").style.display = "none";
        }, 3000);
      } else if (data.status === 'error') {
        clearInterval(priceUpdateTimer);
        document.getElementById("updater-status-title").innerHTML = `<span style="color: var(--danger); font-weight: bold;"><i class="fa-solid fa-circle-xmark"></i> Update failed — Retry</span>`;
        document.getElementById("updater-current-ticker").innerHTML = `
          <button class="btn btn-secondary btn-sm" onclick="startLivePriceScraper()" style="background: var(--danger); border-color: var(--danger); color: white; font-weight: bold; margin-top: 0.5rem;">Retry Now</button>
        `;
        document.getElementById("btn-updater-close").style.display = "inline-block";
        
        // Auto-dismiss the widget after 10 seconds
        setTimeout(() => {
          authorizedFetch('/api/update-status')
            .then(res => res.json())
            .then(d => {
              if (d.status === 'error') {
                document.getElementById("price-updater-container").style.display = "none";
              }
            });
        }, 10000);
      }
    } catch (err) {
      console.error("Scraper status poll failed", err);
      clearInterval(priceUpdateTimer);
    }
  }, 1200);
}

// AI ADVISOR CHAT INTERACTION
function handleAdvisorKeyPress(event) {
  if (event.key === 'Enter') {
    submitAdvisorMessage();
  }
}

function sendSuggestedPrompt(text) {
  document.getElementById("advisor-user-input").value = text;
  submitAdvisorMessage();
}

async function submitAdvisorMessage() {
  const inputEl = document.getElementById("advisor-user-input");
  const promptText = inputEl.value.trim();
  if (!promptText) return;
  
  // Clear input
  inputEl.value = "";
  
  const chatBox = document.getElementById("advisor-chat-box");
  
  // 1. Append User Message
  const userMsgDiv = document.createElement("div");
  userMsgDiv.className = "advisor-message user";
  userMsgDiv.style.display = "flex";
  userMsgDiv.style.gap = "0.75rem";
  userMsgDiv.style.maxWidth = "85%";
  userMsgDiv.style.alignSelf = "flex-end";
  
  userMsgDiv.innerHTML = `
    <div style="background: var(--accent-gradient); border-radius: 16px 0 16px 16px; padding: 1rem; color: #ffffff; font-size: 0.9rem; line-height: 1.5; box-shadow: 0 4px 15px var(--accent-glow);">
      ${promptText}
    </div>
    <div style="width: 36px; height: 36px; border-radius: 50%; background: var(--bg-tertiary); display: flex; justify-content: center; align-items: center; color: var(--text-primary); font-size: 0.9rem; flex-shrink: 0;">
      <i class="fa-solid fa-user"></i>
    </div>
  `;
  chatBox.appendChild(userMsgDiv);
  chatBox.scrollTop = chatBox.scrollHeight;
  
  // 2. Append Spinner / Loading State
  const loadingDiv = document.createElement("div");
  loadingDiv.className = "advisor-message system loading";
  loadingDiv.style.display = "flex";
  loadingDiv.style.gap = "0.75rem";
  loadingDiv.style.maxWidth = "85%";
  loadingDiv.style.alignSelf = "flex-start";
  
  loadingDiv.innerHTML = `
    <div style="width: 36px; height: 36px; border-radius: 50%; background: var(--accent-gradient); display: flex; justify-content: center; align-items: center; color: white; font-size: 0.95rem; font-weight: 700; box-shadow: 0 0 10px var(--accent-glow); flex-shrink: 0;">
      <i class="fa-solid fa-user-tie"></i>
    </div>
    <div style="background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.03); border-radius: 0 16px 16px 16px; padding: 1rem; color: var(--text-secondary); font-size: 0.9rem; display: flex; align-items: center; gap: 0.5rem;">
      <i class="fa-solid fa-spinner fa-spin" style="color: var(--accent);"></i> Analyzing portfolio sheets...
    </div>
  `;
  chatBox.appendChild(loadingDiv);
  chatBox.scrollTop = chatBox.scrollHeight;
  
  // 3. Post to API
  try {
    const res = await authorizedFetch('/api/advisor/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: promptText })
    });
    const data = await res.json();
    
    // Remove loading indicator
    chatBox.removeChild(loadingDiv);
    
    // Append Advisor Response
    const responseDiv = document.createElement("div");
    responseDiv.className = "advisor-message system";
    responseDiv.style.display = "flex";
    responseDiv.style.gap = "0.75rem";
    responseDiv.style.maxWidth = "85%";
    responseDiv.style.alignSelf = "flex-start";
    
    responseDiv.innerHTML = `
      <div style="width: 36px; height: 36px; border-radius: 50%; background: var(--accent-gradient); display: flex; justify-content: center; align-items: center; color: white; font-size: 0.95rem; font-weight: 700; box-shadow: 0 0 10px var(--accent-glow); flex-shrink: 0;">
        <i class="fa-solid fa-user-tie"></i>
      </div>
      <div style="background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.03); border-radius: 0 16px 16px 16px; padding: 1rem; color: var(--text-primary); font-size: 0.9rem; line-height: 1.6;">
        <span style="font-weight: 700; display: block; margin-bottom: 0.4rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent);">CFA Senior Advisor</span>
        ${data.response}
      </div>
    `;
    chatBox.appendChild(responseDiv);
    chatBox.scrollTop = chatBox.scrollHeight;
    
  } catch (err) {
    if (chatBox.contains(loadingDiv)) {
      chatBox.removeChild(loadingDiv);
    }
    console.error("Advisor API call failed:", err);
  }
}

// MULTI-PROFILE CONTROLLER OPERATIONS
function openProfileModal() {
  document.getElementById("modal-profile").classList.add("active");
  fetchProfilesList();
}

function closeProfileModal() {
  document.getElementById("modal-profile").classList.remove("active");
}

async function fetchProfilesList() {
  try {
    const res = await authorizedFetch('/api/profiles');
    const data = await res.json();
    
    // Update header label with profile name
    const activeProfileNameEl = document.getElementById("active-profile-name");
    if (activeProfileNameEl) {
      activeProfileNameEl.innerHTML = `<i class="fa-solid fa-user-circle"></i> Profile: ${data.active_profile}`;
    }
    
    // Populate dynamic profiles list inside modal
    const listContainer = document.getElementById("profiles-list-container");
    if (listContainer) {
      listContainer.innerHTML = "";
      data.profiles.forEach(pObj => {
        const p = pObj.name;
        const hasPin = pObj.has_pin;
        const isActive = p === data.active_profile;
        const isDefault = p === "Default Portfolio";
        
        if (isActive) {
          // Show current-pin input in Settings tab if active profile is protected by a PIN
          const currentPinGroup = document.getElementById("pin-current-group");
          if (currentPinGroup) {
            currentPinGroup.style.display = hasPin ? "block" : "none";
          }
        }
        
        const item = document.createElement("div");
        item.className = `profile-item ${isActive ? 'active' : ''}`;
        
        // Clicking on the profile item (except action buttons) switches to it
        item.onclick = (e) => {
          if (e.target.closest('.btn-profile-delete')) return;
          if (e.target.closest('.btn-profile-rename')) return;
          if (e.target.closest('.btn-profile-pin')) return;
          if (!isActive) switchProfile(p, hasPin);
        };
        
        item.innerHTML = `
          <div class="profile-item-info">
            <span class="profile-item-name">
              ${p} ${hasPin ? '<i class="fa-solid fa-lock" style="font-size: 0.75rem; margin-left: 0.35rem; opacity: 0.6;" title="PIN Protected"></i>' : ''}
            </span>
            ${isActive ? '<span class="profile-item-status"><i class="fa-solid fa-circle-dot"></i> Active Portfolio</span>' : ''}
          </div>
          <div class="profile-item-actions">
            ${!isDefault ? `
              <button class="btn-profile-pin" title="Change/Set PIN">
                <i class="fa-solid fa-key"></i>
              </button>
              <button class="btn-profile-rename" title="Rename Profile">
                <i class="fa-solid fa-pencil"></i>
              </button>
              <button class="btn-profile-delete" title="Delete Profile">
                <i class="fa-solid fa-trash-can"></i>
              </button>
            ` : ''}
          </div>
        `;
        
        // Bind click events for pin, rename and delete buttons
        const pinBtn = item.querySelector(".btn-profile-pin");
        if (pinBtn) {
          pinBtn.onclick = (e) => {
            e.stopPropagation();
            configureProfilePin(p, hasPin);
          };
        }
        const renameBtn = item.querySelector(".btn-profile-rename");
        if (renameBtn) {
          renameBtn.onclick = (e) => {
            e.stopPropagation();
            renameProfile(p, hasPin);
          };
        }
        const delBtn = item.querySelector(".btn-profile-delete");
        if (delBtn) {
          delBtn.onclick = (e) => {
            e.stopPropagation();
            deleteProfile(p, hasPin);
          };
        }
        
        listContainer.appendChild(item);
      });
    }
  } catch (err) {
    console.error("Failed to fetch profiles list:", err);
  }
}

async function renameProfile(oldName, hasPin) {
  if (oldName === "Default Portfolio") {
    alert("The Default Portfolio profile cannot be renamed.");
    return;
  }

  let pin = "";
  if (hasPin) {
    pin = await showCustomPrompt(`Security Required`, `Enter security PIN to rename profile "${oldName}":`, true, "e.g. 1234");
    if (pin === null) return;
  }

  const newName = await showCustomPrompt(`Rename Profile`, `Enter a new name for the profile "${oldName}":`, false, "Profile Name", oldName);
  if (!newName || !newName.trim() || newName.trim() === oldName) return;

  try {
    const res = await authorizedFetch('/api/profiles/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_name: oldName, new_name: newName.trim(), pin: pin })
    });
    const data = await res.json();
    if (data.status === 'success') {
      // Refresh header label, profile list, and theme
      await fetchConfig();
      await fetchProfilesList();
      if (appConfig && appConfig.theme) applyTheme(appConfig.theme);
    } else {
      alert("Error renaming profile: " + data.message);
    }
  } catch (err) {
    console.error("Failed to rename profile:", err);
    alert("API connection failed. Ensure Flask app is running!");
  }
}

async function deleteProfile(profileName, hasPin) {
  if (profileName === "Default Portfolio") {
    alert("The Default Portfolio profile cannot be deleted.");
    return;
  }
  
  const confirmed = await showCustomConfirm(`Delete Profile`, `Are you sure you want to delete the profile "${profileName}"? This will permanently delete its associated Excel workbook, config file, and all recorded holdings. This action CANNOT be undone.`);
  if (!confirmed) {
    return;
  }
  
  let pin = "";
  if (hasPin) {
    pin = await showCustomPrompt(`Security Required`, `Enter security PIN to delete profile "${profileName}":`, true, "e.g. 1234");
    if (pin === null) return;
  }

  try {
    const res = await authorizedFetch('/api/profiles/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_name: profileName, pin: pin })
    });
    
    const data = await res.json();
    if (data.status === 'success') {
      alert(data.message);
      
      // Reload entire visual layout & charts instantly
      await fetchConfig();
      await fetchPortfolio();
      await fetchProfilesList();
      
      // Reset visual theme to active profile's theme
      if (appConfig && appConfig.theme) {
        applyTheme(appConfig.theme);
      }
    } else {
      alert("Error deleting profile: " + data.message);
    }
  } catch (err) {
    console.error("Failed to delete profile:", err);
    alert("API connection failed. Ensure Flask app is running!");
  }
}

async function switchProfile(profileName, hasPin) {
  let pin = "";
  if (hasPin) {
    pin = await showCustomPrompt(`PIN Protection`, `Enter security PIN to switch to profile "${profileName}":`, true, "e.g. 1234");
    if (pin === null) return;
  }

  try {
    const res = await authorizedFetch('/api/profiles/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_name: profileName, pin: pin })
    });
    const data = await res.json();
    if (data.status === 'success') {
      alert(data.message);
      closeProfileModal();
      
      // Reload entire visual layout & charts instantly from new Excel & config
      await fetchConfig();
      await fetchPortfolio();
      await fetchProfilesList();
      
      // Reset visual theme to the profile's saved preference
      if (appConfig && appConfig.theme) {
        applyTheme(appConfig.theme);
      }
    } else {
      alert("Error switching profile: " + data.message);
    }
  } catch (err) {
    console.error("Failed to switch profile:", err);
  }
}

async function submitCreateProfile(e) {
  e.preventDefault();
  const inputEl = document.getElementById("new-profile-input");
  const pinEl = document.getElementById("new-profile-pin");
  const profileName = inputEl.value.trim();
  const pinVal = pinEl ? pinEl.value.trim() : "";
  if (!profileName) return;
  
  try {
    const res = await authorizedFetch('/api/profiles/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_name: profileName, pin: pinVal })
    });
    const data = await res.json();
    if (data.status === 'success') {
      alert(data.message);
      inputEl.value = "";
      if (pinEl) pinEl.value = "";
      closeProfileModal();
      
      // Reload entire visual layout & charts instantly from new Excel & config
      await fetchConfig();
      await fetchPortfolio();
      await fetchProfilesList();
      
      // Set visual theme to standard default
      if (appConfig && appConfig.theme) {
        applyTheme(appConfig.theme);
      }
    } else {
      alert("Error creating profile: " + data.message);
    }
  } catch (err) {
    console.error("Failed to create profile:", err);
  }
}

async function clearPortfolioHoldings() {
  if (!confirm("⚠️ WARNING: Are you sure you want to delete and clear ALL stock and mutual fund holdings inside the currently active profile? This will completely empty your portfolio data and cannot be undone.")) {
    return;
  }
  
  try {
    const res = await authorizedFetch('/api/portfolio/reset', {
      method: 'POST'
    });
    
    const data = await res.json();
    if (data.status === 'success') {
      alert(data.message);
      
      // Reload entire visual layout & charts instantly
      await fetchPortfolio();
      
      // Navigate user back to executive dashboard to show clean slate
      switchTab('dashboard');
    } else {
      alert("Error resetting portfolio: " + data.message);
    }
  } catch (err) {
    console.error("Failed to reset portfolio:", err);
    alert("API connection failed. Ensure Flask app is running!");
  }
}

async function updateProfilePin() {
  const currentPinEl = document.getElementById("settings-current-pin");
  const newPinEl = document.getElementById("settings-new-pin");
  const newPinConfirmEl = document.getElementById("settings-new-pin-confirm");
  
  const currentPin = currentPinEl ? currentPinEl.value : "";
  const newPin = newPinEl ? newPinEl.value.trim() : "";
  const newPinConfirm = newPinConfirmEl ? newPinConfirmEl.value.trim() : "";
  
  if (newPin !== newPinConfirm) {
    alert("New PIN and confirmation PIN do not match.");
    return;
  }
  
  try {
    const res = await authorizedFetch('/api/profiles/set-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_pin: currentPin, new_pin: newPin })
    });
    
    const data = await res.json();
    if (data.status === 'success') {
      alert(data.message);
      // Clear fields
      if (currentPinEl) currentPinEl.value = "";
      if (newPinEl) newPinEl.value = "";
      if (newPinConfirmEl) newPinConfirmEl.value = "";
      
      // Refresh profile list (which updates whether the active profile has a pin)
      await fetchProfilesList();
    } else {
      alert("Error setting PIN: " + data.message);
    }
  } catch (err) {
    console.error("Failed to set profile PIN:", err);
    alert("API connection failed. Ensure Flask app is running!");
  }
}

async function configureProfilePin(profileName, hasPin) {
  let currentPin = "";
  if (hasPin) {
    currentPin = await showCustomPrompt(`PIN Authorization`, `Enter CURRENT security PIN to confirm authorization for "${profileName}":`, true, "Current PIN");
    if (currentPin === null) return;
  }
  
  const newPin = await showCustomPrompt(`Set Profile PIN`, `Enter NEW security PIN for "${profileName}" (leave blank and click OK to disable/remove PIN):`, true, "New PIN (or blank)");
  if (newPin === null) return;
  
  try {
    const res = await authorizedFetch('/api/profiles/set-pin-by-name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_name: profileName, current_pin: currentPin, new_pin: newPin })
    });
    const data = await res.json();
    if (data.status === 'success') {
      alert(data.message);
      await fetchProfilesList();
    } else {
      alert("Error: " + data.message);
    }
  } catch (err) {
    console.error("Failed to set profile PIN:", err);
    alert("API connection failed. Ensure Flask app is running!");
  }
}

// DEBOUNCE HELPER
function debounce(func, delay) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), delay);
  };
}

// FETCH LIVE STOCK PRICE HELPER FOR MODAL
async function fetchLivePriceHelper(scripName) {
  const helper = document.getElementById("stock-live-price-helper");
  if (!scripName || scripName.trim() === "") {
    helper.innerText = "";
    return;
  }
  helper.innerText = "Fetching live...";
  try {
    const res = await authorizedFetch(`/api/stock/live-price?scrip=${encodeURIComponent(scripName.trim())}`);
    const data = await res.json();
    if (data.status === "success" && data.price) {
      helper.innerText = `Live: ₹${data.price.toFixed(2)}`;
      const priceInput = document.getElementById("stock-current-price");
      // Only auto-fill if empty or 0 to avoid overwriting user edits
      if (priceInput && (!priceInput.value || parseFloat(priceInput.value) === 0 || priceInput.value === "")) {
        priceInput.value = data.price;
      }
    } else {
      helper.innerText = "Live price N/A";
    }
  } catch (err) {
    console.error("Failed to fetch helper price", err);
    helper.innerText = "";
  }
}

// --- CUSTOM DIALOGS AND PROMPTS SYSTEM SYSTEM ---
let customPromptPromiseResolver = null;

function showCustomPrompt(title, message, isPassword = false, placeholder = "", defaultValue = "") {
  return new Promise((resolve) => {
    const modal = document.getElementById("modal-custom-prompt");
    document.getElementById("custom-prompt-title-text").innerText = title;
    document.getElementById("custom-prompt-message").innerText = message;
    
    const input = document.getElementById("custom-prompt-input");
    input.type = isPassword ? "password" : "text";
    input.placeholder = placeholder;
    input.value = defaultValue;
    
    if (isPassword) {
      input.maxLength = 6;
      input.pattern = "\\d*";
      input.style.letterSpacing = "0.5rem";
      input.style.textAlign = "center";
      input.style.fontFamily = "monospace";
    } else {
      input.maxLength = 100;
      input.pattern = "";
      input.style.letterSpacing = "normal";
      input.style.textAlign = "left";
      input.style.fontFamily = "inherit";
    }
    
    modal.classList.add("active");
    setTimeout(() => input.focus(), 50);
    
    if (defaultValue) {
      input.setSelectionRange(defaultValue.length, defaultValue.length);
    }
    
    customPromptPromiseResolver = resolve;
  });
}

function closeCustomPrompt() {
  const modal = document.getElementById("modal-custom-prompt");
  modal.classList.remove("active");
  if (customPromptPromiseResolver) {
    customPromptPromiseResolver(null);
    customPromptPromiseResolver = null;
  }
}

function submitCustomPrompt() {
  const modal = document.getElementById("modal-custom-prompt");
  const value = document.getElementById("custom-prompt-input").value;
  modal.classList.remove("active");
  if (customPromptPromiseResolver) {
    customPromptPromiseResolver(value);
    customPromptPromiseResolver = null;
  }
}

// Bind Enter key to submit custom prompt
document.addEventListener("DOMContentLoaded", () => {
  const customPromptInput = document.getElementById("custom-prompt-input");
  if (customPromptInput) {
    customPromptInput.addEventListener("keyup", (e) => {
      if (e.key === "Enter") {
        submitCustomPrompt();
      }
    });
  }
});

let customConfirmPromiseResolver = null;

function showCustomConfirm(title, message) {
  return new Promise((resolve) => {
    const modal = document.getElementById("modal-custom-confirm");
    document.getElementById("custom-confirm-title-text").innerText = title;
    document.getElementById("custom-confirm-message").innerText = message;
    
    modal.classList.add("active");
    
    customConfirmPromiseResolver = resolve;
  });
}

function closeCustomConfirm(result) {
  const modal = document.getElementById("modal-custom-confirm");
  modal.classList.remove("active");
  if (customConfirmPromiseResolver) {
    customConfirmPromiseResolver(result);
    customConfirmPromiseResolver = null;
  }
}


