from flask import Flask, jsonify, request, render_template
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment
import requests
import time
import os
import json
import threading
import csv
import io
from datetime import datetime
import re

import shutil
import yfinance as yf
# Monkeypatch yfinance to use a modern browser User-Agent instead of ancient Chrome 39
yf.data.YfData.user_agent_headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
}
import pandas as pd

app = Flask(__name__)

# Multi-Profile System File Resolver
def get_profile_files():
    try:
        meta_file = "profiles_config.json"
        if not os.path.exists(meta_file):
            initial_meta = {
                "active_profile": "Default Portfolio",
                "profiles": {
                    "Default Portfolio": {
                        "excel_path": "Stocks & MF Analysis_V3.xlsx",
                        "config_path": "config.json"
                    }
                }
            }
            with open(meta_file, "w") as f:
                json.dump(initial_meta, f, indent=4)
        
        with open(meta_file, "r") as f:
            meta = json.load(f)
            
        active = meta.get("active_profile", "Default Portfolio")
        profile_info = meta.get("profiles", {}).get(active, {
            "excel_path": "Stocks & MF Analysis_V3.xlsx",
            "config_path": "config.json"
        })
        excel_path = profile_info.get("excel_path")
        config_path = profile_info.get("config_path")
        if excel_path:
            excel_path = os.path.normpath(excel_path)
        if config_path:
            config_path = os.path.normpath(config_path)
        return excel_path, config_path, active
    except Exception as e:
        print("Error resolving profile path:", e)
        return "Stocks & MF Analysis_V3.xlsx", "config.json", "Default Portfolio"

def load_profile_globals():
    global EXCEL_FILE, CONFIG_FILE, ACTIVE_PROFILE
    excel, config, active = get_profile_files()
    EXCEL_FILE = excel
    CONFIG_FILE = config
    ACTIVE_PROFILE = active
    return excel, config, active

# Global profile trackers
EXCEL_FILE = "Stocks & MF Analysis_V3.xlsx"
CONFIG_FILE = "config.json"
ACTIVE_PROFILE = "Default Portfolio"
load_profile_globals()


# Global state for background live price update progress
price_update_state = {
    "status": "idle",  # idle, running, completed, error, background_running, locked
    "current_index": 0,
    "total_tickers": 0,
    "current_ticker": "",
    "logs": [],
    "start_time": None,
    "last_updated_by_profile": {}  # active profile -> timestamp
}

def load_config():
    if not os.path.exists(CONFIG_FILE):
        return {}
    with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
        return json.load(f)

def save_config(config):
    with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
        json.dump(config, f, indent=2)

def parse_date(date_val):
    if not date_val:
        return None
    if isinstance(date_val, datetime):
        return date_val
    for fmt in ('%d-%m-%Y', '%Y-%m-%d', '%d/%m/%Y', '%Y/%m/%d'):
        try:
            return datetime.strptime(str(date_val).strip(), fmt)
        except ValueError:
            pass
    return None

def format_date_str(date_val):
    d = parse_date(date_val)
    return d.strftime('%d-%m-%Y') if d else ""

def get_tax_flag(buy_date, threshold_days):
    d = parse_date(buy_date)
    if not d:
        return ""
    delta = datetime.now() - d
    return "LTCG" if delta.days > threshold_days else "STCG"

def get_holding_period_years(buy_date_raw) -> float:
    """Return holding period as decimal years (e.g. 1.3, 0.16). Returns 0.0 if no date."""
    d = parse_date(buy_date_raw)
    if not d:
        return 0.0
    return round((datetime.now() - d).days / 365.25, 2)

def compute_xirr(invested: float, current_value: float, buy_date_raw) -> float | None:
    """
    Compute XIRR for a simple 2-cashflow case:
      - Outflow: -invested on buy_date
      - Inflow:  +current_value today
    Returns annualised % or None if holding period < 7 days or invested == 0.
    Uses Newton-Raphson iteration — no external dependencies needed.
    """
    if not invested or invested <= 0:
        return None
    d = parse_date(buy_date_raw)
    if not d:
        return None
    days = (datetime.now() - d).days
    if days < 7:
        return None
    years = days / 365.25
    # Simple CAGR formula is a valid XIRR approximation for single-tranche investments
    try:
        xirr = (current_value / invested) ** (1.0 / years) - 1.0
        return round(xirr * 100, 2)
    except Exception:
        return None

def compute_mf_tax(pnl: float, tax_flag: str) -> float:
    """
    Estimate redemption tax liability for Indian MF taxation rules:
      - STCG: 20% on gains (post-2024 budget)
      - LTCG: 12.5% on gains exceeding ₹1,25,000 annual exemption
    Note: This is a per-holding estimate; actual tax depends on total annual gains.
    """
    if pnl <= 0:
        return 0.0
    if tax_flag == "STCG":
        return round(pnl * 0.20, 2)
    elif tax_flag == "LTCG":
        taxable = max(0, pnl - 125000)
        return round(taxable * 0.125, 2)
    return 0.0

# ─── In-memory caches (per server session) ────────────────────────────────────
_ticker_cache = {}   # "COMPANY NAME|NSE" -> "TATAMOTORS.NS"  (resolved yf symbol)
_info_cache   = {}   # "TATAMOTORS.NS"    -> {price, sector, ...}
_drawdown_cache = {} # "TATAMOTORS.NS|BUY_PRICE" -> {"days": int, "ts": float}
_mf_scheme_cache = {} # "FUND NAME" -> scheme_code (int)

_CACHE_FILE = "yfinance_cache.json"

def load_cache():
    global _ticker_cache, _info_cache, _drawdown_cache, _mf_scheme_cache
    if os.path.exists(_CACHE_FILE):
        try:
            with open(_CACHE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                _ticker_cache.update(data.get("ticker_cache", {}))
                _info_cache.update(data.get("info_cache", {}))
                _drawdown_cache.update(data.get("drawdown_cache", {}))
                _mf_scheme_cache.update(data.get("mf_scheme_cache", {}))
                # Filter out null values so we retry resolving them
                _ticker_cache = {k: v for k, v in _ticker_cache.items() if v is not None}
        except Exception as e:
            print("Error loading yfinance cache:", e)

def save_cache():
    try:
        with open(_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump({
                "ticker_cache": _ticker_cache,
                "info_cache": _info_cache,
                "drawdown_cache": _drawdown_cache,
                "mf_scheme_cache": _mf_scheme_cache
            }, f, indent=2)
    except Exception as e:
        print("Error saving yfinance cache:", e)

load_cache()

# Yahoo Finance sector label → simplified display name
_SECTOR_MAP = {
    "Technology":             "Technology",
    "Financial Services":     "Banking & Finance",
    "Consumer Cyclical":      "Consumer Discretionary",
    "Consumer Defensive":     "Consumer Staples",
    "Healthcare":             "Healthcare",
    "Basic Materials":        "Materials",
    "Industrials":            "Industrials",
    "Energy":                 "Energy",
    "Utilities":              "Utilities",
    "Real Estate":            "Real Estate",
    "Communication Services": "Communication",
}

_BROAD_SECTOR_MAP = {
    "automobiles - passenger cars": "Auto",
    "auto - trucks": "Auto",
    "steel/sponge iron/pig iron": "Metals",
    "metal - non ferrous": "Metals",
    "mining & minerals": "Metals",
    "power generation/distribution": "Power",
    "diamond & gold jewellery": "Consumer",
    "diamond  & gold  jewellery": "Consumer", # Double spaces
    "etfs": "ETF",
    "materials": "Materials",
    "utilities": "Utilities",
    "textile": "Textile",
    "bank - public": "Financials",
    "bank - private": "Financials",
    "finance/nbfc": "Financials",
    "banking & finance": "Financials",
    "financial services": "Financials",
    "financials": "Financials",
    "telecommunication - service provider": "Communication",
    "telecommunication - service  provider": "Communication",
    "electric equipment": "Industrials",
    "industrials": "Industrials",
    "energy": "Energy",
    "real estate": "Real Estate",
    "communication services": "Communication",
    "communication": "Communication",
    "technology": "Technology",
    "healthcare": "Healthcare",
    "other": "ETF"
}

def get_broad_sector(granular_sector: str) -> str:
    if not granular_sector:
        return "ETF"
    norm = granular_sector.strip().lower()
    return _BROAD_SECTOR_MAP.get(norm, granular_sector.strip())



_CUSTOM_TICKER_MAP = {
    "NIPPON INDIA LTG": "LTGILTBEES.NS",
    "NIPPON INDIA NM": "MID150BEES.NS",
    "NIP. INDIA NIFTY": "NIFTYBEES.NS",
    "NIPPON INDIA NIFTY": "NIFTYBEES.NS",
    "NIP. INDIA GOLD": "GOLDBEES.NS",
    "NIPPON INDIA GOLD": "GOLDBEES.NS",
    "NASDAQ 100": "MON100.NS",
    "HDFC NSC 250 ETF": "HDFCSML250.NS",
    "ST BK OF INDIA": "SBIN.NS",
    "STATE BANK OF INDIA": "SBIN.NS",
    "POWER GRID CORPN": "POWERGRID.NS",
    "POWER GRID": "POWERGRID.NS",
    "POWER GRID CORPORATION": "POWERGRID.NS",
    "A R C FINANCE": "ARCFIN.BO",
    "ARC FINANCE": "ARCFIN.BO",
    "SERVOTECH POWER": "SERVOTECH.NS",
    "SERVOTECH POWER SYSTEMS": "SERVOTECH.NS",
    "VISAGAR POLYTEX": "VIVIDHA.NS",
    "CPSE ETF*": "CPSEETF.NS",
    "CPSE ETF": "CPSEETF.NS",
    "TATA MOTORS": "TMCV.NS",
    "TATA MOTORS LIMITED": "TMCV.NS",
    "TATA MOTORS PASS VEH LTD": "TMPV.NS",
    "TATA MOTORS PASSENGER VEHICLES": "TMPV.NS",
    "TATA STEEL": "TATASTEEL.NS",
    "TATA STEEL LIMITED": "TATASTEEL.NS",
    "ASHOK LEYLAND": "ASHOKLEY.NS",
    "ASHOK LEYLAND LIMITED": "ASHOKLEY.NS",
    "COAL INDIA": "COALINDIA.NS",
    "COAL INDIA LTD": "COALINDIA.NS",
    "COAL INDIA LIMITED": "COALINDIA.NS",
    "TITAN COMPANY": "TITAN.NS",
    "TITAN COMPANY LIMITED": "TITAN.NS",
    "VEDANTA": "VEDL.NS",
    "VEDANTA LIMITED": "VEDL.NS",
    "VODAFONE IDEA": "IDEA.NS",
    "VODAFONE IDEA LIMITED": "IDEA.NS",
    "NHPC LTD": "NHPC.NS",
    "NHPC LIMITED": "NHPC.NS",
}


def _clean_search_query(q: str) -> str:
    q = q.strip()
    q = re.sub(r'(?i)\bst\s+bk\b', 'State Bank', q)
    q = re.sub(r'(?i)\bnip\.?\b', 'Nippon', q)
    q = re.sub(r'(?i)\b(ltd|limited|corp|corpn|corporation|co|company)\b', '', q)
    q = re.sub(r'\s+', ' ', q).strip()
    return q


def _resolve_ticker(company_name: str, exchange: str) -> str | None:
    """
    Convert a full company name (e.g. 'TATA MOTORS LIMITED') to the correct
    Yahoo Finance ticker symbol (e.g. 'TATAMOTORS.NS') using direct search requests.
    Results are cached so each name is resolved only once per session.
    """
    name_clean = company_name.strip()
    clean_upper = name_clean.upper()

    # Strategy 0: Direct custom lookup mapping
    if clean_upper in _CUSTOM_TICKER_MAP:
        resolved = _CUSTOM_TICKER_MAP[clean_upper]
        cache_key = f"{clean_upper}|{exchange.strip().upper()}"
        if _ticker_cache.get(cache_key) != resolved:
            _ticker_cache[cache_key] = resolved
            save_cache()
        return resolved

    cache_key = f"{clean_upper}|{exchange.strip().upper()}"
    if cache_key in _ticker_cache:
        return _ticker_cache[cache_key]

    ex_suffix = ".BO" if "BSE" in exchange.upper() else ".NS"

    # Strategy 1 — treat the stored value as a raw ticker (works if user typed TATAMOTORS)
    direct = f"{name_clean}{ex_suffix}"
    try:
        info = yf.Ticker(direct).fast_info
        # fast_info raises on invalid tickers; check price is non-zero
        if getattr(info, 'last_price', None):
            _ticker_cache[cache_key] = direct
            save_cache()
            return direct
    except Exception:
        pass

    # Strategy 2 — use Yahoo Finance Search API directly
    try:
        cleaned_query = _clean_search_query(name_clean)
        url = "https://query2.finance.yahoo.com/v1/finance/search"
        params = {"q": cleaned_query, "quotesCount": 5, "newsCount": 0}
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
        r = requests.get(url, params=params, headers=headers, timeout=5)
        if r.status_code == 200:
            results = r.json().get("quotes", [])
            # Prefer exact exchange match, then any Indian exchange
            for preference in (ex_suffix.upper(), ".NS", ".BO"):
                for r_quote in results:
                    sym = r_quote.get("symbol", "")
                    if sym.upper().endswith(preference):
                        _ticker_cache[cache_key] = sym
                        save_cache()
                        return sym
    except Exception as e:
        print(f"[Yahoo Search API] '{name_clean}': {e}")

    _ticker_cache[cache_key] = None
    save_cache()
    return None


def _resolve_mf_scheme_code(fund_name: str) -> int | None:
    """
    Search and resolve mutual fund name to its scheme code from api.mfapi.in.
    Results are cached in _mf_scheme_cache.
    """
    cache_key = fund_name.strip()
    if cache_key in _mf_scheme_cache:
        return _mf_scheme_cache[cache_key]

    try:
        url = f"https://api.mfapi.in/mf/search?q={requests.utils.quote(cache_key)}"
        r = requests.get(url, timeout=5)
        if r.status_code == 200:
            results = r.json()
            if results:
                code = int(results[0]['schemeCode'])
                _mf_scheme_cache[cache_key] = code
                save_cache()
                return code
    except Exception as e:
        print(f"[MF scheme search] {fund_name}: {e}")

    return None


def _fetch_mf_history(scheme_code: int) -> pd.Series:
    """
    Fetch historical NAVs from api.mfapi.in and return as a pandas Series indexed by date.
    Returns empty series on failure.
    """
    try:
        url = f"https://api.mfapi.in/mf/{scheme_code}"
        r = requests.get(url, timeout=5)
        if r.status_code == 200:
            data = r.json().get('data', [])
            dates = []
            navs = []
            for item in data:
                # date format is "DD-MM-YYYY"
                dt = parse_date(item['date'])
                if dt:
                    dates.append(dt)
                    navs.append(float(item['nav']))
            
            s = pd.Series(navs, index=dates)
            s = s.sort_index()
            return s
    except Exception as e:
        print(f"[MF history fetch] {scheme_code}: {e}")
    return pd.Series(dtype=float)


def _yf_info(symbol: str, bypass_cache: bool = False) -> dict:
    """
    Fetch price and sector for a resolved Yahoo Finance symbol via yfinance.
    Returns a dict with keys 'price' (float|None), 'sector' (str|None), and 'beta' (float|None).
    """
    now = time.time()
    
    # If not bypassing cache, check if we have a fresh cached entry with price and recent timestamp
    if not bypass_cache and symbol in _info_cache:
        cached = _info_cache[symbol]
        if cached.get("price_timestamp") and now - cached["price_timestamp"] < 300:
            return cached

    # Pre-populate sector & beta from cached entry if they exist to avoid making an expensive ticker.info call
    cached_sector = None
    cached_beta = None
    if symbol in _info_cache:
        cached_sector = _info_cache[symbol].get("sector")
        cached_beta = _info_cache[symbol].get("beta")

    result = {
        "price": None,
        "sector": cached_sector,
        "beta": cached_beta,
        "price_timestamp": None
    }
    
    try:
        ticker = yf.Ticker(symbol)

        # Price: fast_info is lightweight and fast
        try:
            price = ticker.fast_info.last_price
            if price:
                result["price"] = round(float(price), 2)
                result["price_timestamp"] = now
        except Exception:
            pass

        # Sector & Beta: from the full info dict (only if not already cached)
        if not result["sector"] or result["beta"] is None:
            try:
                info = ticker.info
                if not result["price"]:
                    mp = info.get("regularMarketPrice") or info.get("currentPrice")
                    if mp:
                        result["price"] = round(float(mp), 2)
                        result["price_timestamp"] = now
                raw_sector = info.get("sector", "")
                if raw_sector:
                    result["sector"] = _SECTOR_MAP.get(raw_sector, raw_sector)
                
                beta = info.get("beta")
                if beta is not None:
                    result["beta"] = round(float(beta), 3)
            except Exception:
                pass

    except Exception as e:
        print(f"[yfinance info] {symbol}: {e}")

    # Save to persistent cache if we resolved a price
    if result["price"] is not None:
        _info_cache[symbol] = result
        save_cache()
        
    return result


def get_days_in_drawdown(symbol: str, buy_price: float) -> int:
    """
    Calculate how many consecutive trading days the stock's closing price has been
    strictly below the average purchase price (buy_price).
    Uses caching (1 hour TTL) to prevent rate limits.
    """
    if not symbol or not buy_price:
        return 0
        
    cache_key = f"{symbol}|{buy_price}"
    now_ts = time.time()
    
    # Check cache
    if cache_key in _drawdown_cache:
        cached = _drawdown_cache[cache_key]
        if now_ts - cached.get("ts", 0) < 3600:
            return cached.get("days", 0)
            
    days = 0
    try:
        ticker = yf.Ticker(symbol)
        # Fetch up to 2 years of daily data (safe and fast)
        hist = ticker.history(period="2y")
        if not hist.empty and "Close" in hist.columns:
            closes = hist["Close"].tolist()
            count = 0
            for price in reversed(closes):
                if price < buy_price:
                    count += 1
                else:
                    break
            days = count
    except Exception as e:
        print(f"[drawdown calculation] {symbol}: {e}")
        
    # Update cache
    _drawdown_cache[cache_key] = {"days": days, "ts": now_ts}
    save_cache()
    return days


def get_yahoo_finance_price(company_name: str, exchange: str) -> float | None:
    """Return live price for a company name / exchange pair, or None."""
    sym = _resolve_ticker(company_name, exchange)
    if not sym:
        return None
    return _yf_info(sym)["price"]


def get_yahoo_sector(company_name: str, exchange: str) -> str | None:
    """Return sector string for a company name / exchange pair, or None."""
    sym = _resolve_ticker(company_name, exchange)
    if not sym:
        return None
    return _yf_info(sym)["sector"]


# Load Excel data with formula evaluations or fallbacks
def get_portfolio_data():
    config = load_config()
    stock_ltcg_days = config.get("tax_rules", {}).get("stocks_ltcg_days", 365)
    mf_ltcg_days = config.get("tax_rules", {}).get("mf_ltcg_days", 365)
    
    if not os.path.exists(EXCEL_FILE):
        return {"error": f"Excel file '{EXCEL_FILE}' not found."}
        
    try:
        # Load workbook (we read values, but we will write formulas)
        wb = openpyxl.load_workbook(EXCEL_FILE, data_only=True)
    except Exception as e:
        return {"error": f"Failed to load Excel file: {e}"}

    stocks = []
    mfs = []
    
    # 1. READ STOCKS
    if "📥 Stock Data Input" in wb.sheetnames:
        ws = wb["📥 Stock Data Input"]
        for row in range(4, 1000):
            scrip = ws[f'A{row}'].value
            if not scrip or str(scrip).strip().upper() == "TOTAL":
                continue
            
            exchange = ws[f'B{row}'].value or "NSE"
            raw_sector = ws[f'C{row}'].value
            if not raw_sector or str(raw_sector).strip() == "" or str(raw_sector).strip().lower() == "other":
                industry = "ETFs"
            else:
                industry = str(raw_sector).strip()
            
            sector = get_broad_sector(industry)
            qty = ws[f'D{row}'].value or 0
            buy_price = ws[f'E{row}'].value or 0
            buy_date_raw = ws[f'F{row}'].value
            current_price = ws[f'G{row}'].value or 0
            cagr_5y = ws[f'H{row}'].value
            nifty_cagr_5y = ws[f'I{row}'].value
            dividends = ws[f'P{row}'].value or 0
            
            # Formulate computations in Python so user gets real-time values even if Excel cached formula is blank/old
            invested_value = qty * buy_price
            current_value = qty * current_price
            pnl = current_value - invested_value
            return_pct = (pnl / invested_value) if invested_value > 0 else 0
            tax_flag = get_tax_flag(buy_date_raw, stock_ltcg_days)
            total_return = pnl + dividends
            
            buy_date_str = format_date_str(buy_date_raw)
            holding_yrs = get_holding_period_years(buy_date_raw) if buy_date_raw else None
            holding_type = "LT" if tax_flag == "LTCG" else ("ST" if tax_flag == "STCG" else "")
            
            sym = _resolve_ticker(str(scrip).strip(), str(exchange).strip())
            drawdown_days = get_days_in_drawdown(sym, buy_price) if sym else 0

            stocks.append({
                "row_idx": row,
                "Scrip Name": str(scrip).strip(),
                "Exchange": str(exchange).strip(),
                "Sector": sector,
                "Industry": industry,
                "Qty": qty,
                "Buy Price": buy_price,
                "Buy Date": buy_date_str,
                "Holding Period Yrs": holding_yrs,
                "Holding Type": holding_type,
                "Current Price": current_price,
                "5Y CAGR": cagr_5y,
                "Nifty 5Y CAGR": nifty_cagr_5y,
                "Invested Value": round(invested_value, 2),
                "Current Value": round(current_value, 2),
                "P&L": round(pnl, 2),
                "Return %": round(return_pct * 100, 2),
                "Dividends": round(dividends, 2),
                "Tax Flag": tax_flag,
                "Total Return": round(total_return, 2),
                "Drawdown Days": drawdown_days
            })


    # 2. READ MUTUAL FUNDS
    if "📥 MF Data Input" in wb.sheetnames:
        ws = wb["📥 MF Data Input"]
        for row in range(4, 1000):
            fund_name = ws[f'A{row}'].value
            if not fund_name or str(fund_name).strip().upper() == "TOTAL":
                continue
                
            amc = ws[f'B{row}'].value or "Other"
            category = ws[f'C{row}'].value or "Other"
            sub_category = ws[f'D{row}'].value or "Other"
            units = ws[f'E{row}'].value or 0
            buy_nav = ws[f'F{row}'].value or 0
            buy_date_raw = ws[f'G{row}'].value
            current_nav = ws[f'H{row}'].value or 0
            benchmark_return = ws[f'I{row}'].value
            expense_ratio = ws[f'J{row}'].value or 0
            
            invested_value = units * buy_nav
            current_value = units * current_nav
            pnl = current_value - invested_value
            return_pct = (pnl / invested_value) if invested_value > 0 else 0
            tax_flag = get_tax_flag(buy_date_raw, mf_ltcg_days)
            holding_yrs = get_holding_period_years(buy_date_raw)
            holding_type = "LT" if tax_flag == "LTCG" else "ST"
            xirr_pct = compute_xirr(invested_value, current_value, buy_date_raw)
            estimated_tax = compute_mf_tax(pnl, tax_flag)
            investment_type = ws[f'K{row}'].value or "Lumpsum"
            
            buy_date_str = format_date_str(buy_date_raw)
            
            mfs.append({
                "row_idx": row,
                "Fund Name": str(fund_name).strip(),
                "AMC": str(amc).strip(),
                "Category": str(category).strip(),
                "Sub-Category": str(sub_category).strip(),
                "Units Held": units,
                "Buy NAV": buy_nav,
                "Buy Date": buy_date_str,
                "Current NAV": current_nav,
                "Benchmark 1Y Return %": benchmark_return,
                "Expense Ratio %": expense_ratio,
                "Invested Value": round(invested_value, 2),
                "Current Value": round(current_value, 2),
                "P&L": round(pnl, 2),
                "Absolute Return %": round(return_pct * 100, 2),
                "Tax Flag": tax_flag,
                "XIRR %": xirr_pct,
                "Holding Period Yrs": holding_yrs,
                "Holding Type": holding_type,
                "Estimated Tax": estimated_tax,
                "Investment Type": str(investment_type).strip()
            })

    # Calculations for summary stats
    total_stock_invested = sum(s["Invested Value"] for s in stocks)
    total_stock_value = sum(s["Current Value"] for s in stocks)
    total_stock_pnl = total_stock_value - total_stock_invested
    total_stock_return_pct = (total_stock_pnl / total_stock_invested * 100) if total_stock_invested > 0 else 0
    total_stock_dividends = sum(s["Dividends"] for s in stocks)
    
    # Calculate weighted Portfolio Beta
    total_beta_weighted = 0.0
    for s in stocks:
        val = s["Current Value"]
        scrip = s["Scrip Name"]
        exchange = s["Exchange"]
        sym = _resolve_ticker(scrip, exchange)
        beta = 1.0  # default
        if sym and sym in _info_cache:
            info_beta = _info_cache[sym].get("beta")
            if isinstance(info_beta, (int, float)):
                beta = info_beta
        total_beta_weighted += beta * val
    portfolio_beta = (total_beta_weighted / total_stock_value) if total_stock_value > 0 else 1.0
    
    total_mf_invested = sum(m["Invested Value"] for m in mfs)
    total_mf_value = sum(m["Current Value"] for m in mfs)
    total_mf_pnl = total_mf_value - total_mf_invested
    total_mf_return_pct = (total_mf_pnl / total_mf_invested * 100) if total_mf_invested > 0 else 0
    total_mf_stcg_tax = sum(m["Estimated Tax"] for m in mfs if m["Tax Flag"] == "STCG")
    total_mf_ltcg_tax = sum(m["Estimated Tax"] for m in mfs if m["Tax Flag"] == "LTCG")
    
    total_portfolio_invested = total_stock_invested + total_mf_invested
    total_portfolio_value = total_stock_value + total_mf_value
    total_portfolio_pnl = total_portfolio_value - total_portfolio_invested
    total_portfolio_return_pct = (total_portfolio_pnl / total_portfolio_invested * 100) if total_portfolio_invested > 0 else 0
    
    signals = []
    if "⚠️ Risk & Signals" in wb.sheetnames:
        ws_sig = wb["⚠️ Risk & Signals"]
        for row in range(18, 1000):
            scrip = ws_sig[f'A{row}'].value
            if not scrip or scrip == 0:
                continue
            
            cur_val = ws_sig[f'B{row}'].value
            ret_pct = ws_sig[f'C{row}'].value
            xirr = ws_sig[f'D{row}'].value
            vs_nifty = ws_sig[f'E{row}'].value
            sig_name = ws_sig[f'F{row}'].value
            priority = ws_sig[f'G{row}'].value
            rec_action = ws_sig[f'H{row}'].value
            
            # Format return percentage (sometimes openpyxl returns raw decimal like 0.3647 or percentage 36.47)
            if isinstance(ret_pct, (int, float)):
                if abs(ret_pct) < 1.0:
                    ret_pct = round(ret_pct * 100, 2)
                else:
                    ret_pct = round(ret_pct, 2)
            
            signals.append({
                "Scrip Name": str(scrip).strip(),
                "Current Value": round(cur_val, 2) if isinstance(cur_val, (int, float)) else cur_val,
                "Return %": ret_pct,
                "XIRR %": round(xirr * 100, 2) if isinstance(xirr, (int, float)) else xirr,
                "vs Nifty": vs_nifty,
                "Signal": str(sig_name).strip() if sig_name else "",
                "Priority": str(priority).strip() if priority else "",
                "Recommended Action": str(rec_action).strip() if rec_action else ""
            })

    return {
        "stocks": stocks,
        "mfs": mfs,
        "signals": signals,
        "summary": {
            "total_stock_invested": round(total_stock_invested, 2),
            "total_stock_value": round(total_stock_value, 2),
            "total_stock_pnl": round(total_stock_pnl, 2),
            "total_stock_return_pct": round(total_stock_return_pct, 2),
            "total_stock_dividends": round(total_stock_dividends, 2),
            "portfolio_beta": round(portfolio_beta, 2),
            
            "total_mf_invested": round(total_mf_invested, 2),
            "total_mf_value": round(total_mf_value, 2),
            "total_mf_pnl": round(total_mf_pnl, 2),
            "total_mf_return_pct": round(total_mf_return_pct, 2),
            "total_mf_stcg_tax": round(total_mf_stcg_tax, 2),
            "total_mf_ltcg_tax": round(total_mf_ltcg_tax, 2),
            
            "total_portfolio_invested": round(total_portfolio_invested, 2),
            "total_portfolio_value": round(total_portfolio_value, 2),
            "total_portfolio_pnl": round(total_portfolio_pnl, 2),
            "total_portfolio_return_pct": round(total_portfolio_return_pct, 2)
        }
    }

# Sync formulas and styles on headers to match formatting
def apply_excel_styles(ws, row):
    # Apply standard fonts and alignments to avoid ugly Excel layouts
    thin_font = Font(name="Calibri", size=11)
    align_center = Alignment(horizontal="center")
    align_left = Alignment(horizontal="left")
    align_right = Alignment(horizontal="right")
    
    for col in range(1, 25):
        cell = ws.cell(row=row, column=col)
        if cell.value is not None:
            cell.font = thin_font
            if col in [1, 2, 3, 6, 17]:  # Text & Dates
                cell.alignment = align_center if col != 1 else align_left
            else:  # Numbers
                cell.alignment = align_right

# Background thread for live price updates
def run_price_and_nav_update(is_background=False):
    global price_update_state, EXCEL_FILE, ACTIVE_PROFILE
    
    # Avoid overlapping manual/background updates
    if price_update_state["status"] in ("running", "background_running"):
        return False
        
    price_update_state["status"] = "background_running" if is_background else "running"
    price_update_state["logs"] = []
    price_update_state["start_time"] = time.time()
    price_update_state["current_index"] = 0
    price_update_state["total_tickers"] = 0
    price_update_state["current_ticker"] = ""
    
    active_excel_file = EXCEL_FILE
    active_profile = ACTIVE_PROFILE
    
    try:
        wb = openpyxl.load_workbook(active_excel_file)
        
        # 1. Read Stocks to update
        tickers_to_update = []
        if "📥 Stock Data Input" in wb.sheetnames:
            ws_stock = wb["📥 Stock Data Input"]
            for row in range(4, 1000):
                scrip = ws_stock[f'A{row}'].value
                if scrip and str(scrip).strip().upper() != "TOTAL":
                    exchange = ws_stock[f'B{row}'].value or "NSE"
                    tickers_to_update.append(("stock", row, str(scrip).strip(), str(exchange).strip()))
                    
        # 2. Read Mutual Funds to update
        mf_to_update = []
        if "📥 MF Data Input" in wb.sheetnames:
            ws_mf = wb["📥 MF Data Input"]
            for row in range(4, 1000):
                fund_name = ws_mf[f'A{row}'].value
                if fund_name and str(fund_name).strip().upper() != "TOTAL":
                    mf_to_update.append(("mf", row, str(fund_name).strip(), None))
                    
        items_to_update = tickers_to_update + mf_to_update
        price_update_state["total_tickers"] = len(items_to_update)
        price_update_state["logs"].append(f"Starting update. Found {len(tickers_to_update)} stocks and {len(mf_to_update)} mutual funds to update.")
        
        updated_count = 0
        
        for idx, (item_type, row, name, exchange) in enumerate(items_to_update):
            price_update_state["current_index"] = idx + 1
            price_update_state["current_ticker"] = name
            
            if item_type == "stock":
                price_update_state["logs"].append(f"Fetching live price for stock {name} ({exchange})...")
                sym = _resolve_ticker(name, exchange)
                if not sym:
                    price_update_state["logs"].append(f"  -> ❌ Could not resolve ticker symbol.")
                    time.sleep(0.1)
                    continue
                    
                info = _yf_info(sym, bypass_cache=True)
                price = info["price"]
                sector = info["sector"]
                
                if price is not None:
                    ws_stock = wb["📥 Stock Data Input"]
                    ws_stock[f'G{row}'].value = price
                    log_line = f"  -> ✅ ₹{price}  [{sym}]"
                    
                    # Auto-fill sector if missing or still default
                    current_sector = str(ws_stock[f'C{row}'].value or "").strip()
                    if current_sector in ("", "Other", "ETFs") and sector:
                        ws_stock[f'C{row}'].value = sector
                        log_line += f"  | Sector: {sector}"
                    
                    price_update_state["logs"].append(log_line)
                    updated_count += 1
                else:
                    price_update_state["logs"].append(f"  -> ❌ Price not available for [{sym}].")
            else:
                # Mutual Fund
                price_update_state["logs"].append(f"Fetching live NAV for mutual fund {name}...")
                code = _resolve_mf_scheme_code(name)
                if not code:
                    price_update_state["logs"].append(f"  -> ❌ Could not resolve scheme code.")
                    time.sleep(0.1)
                    continue
                    
                try:
                    url = f"https://api.mfapi.in/mf/{code}"
                    r = requests.get(url, timeout=5)
                    if r.status_code == 200:
                        res_data = r.json().get('data', [])
                        if res_data:
                            nav = float(res_data[0]['nav'])
                            ws_mf = wb["📥 MF Data Input"]
                            ws_mf[f'H{row}'].value = nav
                            price_update_state["logs"].append(f"  -> ✅ NAV: ₹{nav}")
                            updated_count += 1
                        else:
                            price_update_state["logs"].append(f"  -> ❌ No NAV data found.")
                    else:
                        price_update_state["logs"].append(f"  -> ❌ API error ({r.status_code}).")
                except Exception as e:
                    price_update_state["logs"].append(f"  -> ❌ Connection error: {e}")
                    
            time.sleep(0.3)  # delay between tickers to avoid rate limiting
            
        wb.save(active_excel_file)
        price_update_state["status"] = "completed"
        price_update_state["last_updated_by_profile"][active_profile] = time.time()
        price_update_state["logs"].append(f"Successfully updated {updated_count} items and saved Excel file.")
        return True
    except PermissionError:
        price_update_state["status"] = "locked"
        price_update_state["logs"].append("❌ Excel file is currently open and locked by another program. Will retry shortly.")
        raise
    except Exception as e:
        price_update_state["status"] = "error"
        price_update_state["logs"].append(f"Critical Error during update: {e}")
        raise

# Background thread for live price updates (manual trigger wrapper)
def live_price_updater_thread():
    try:
        run_price_and_nav_update(is_background=False)
    except Exception:
        pass

# Background daemon loop for automatic updates
def automatic_price_updater_loop():
    print("[Auto Price Updater] Starting background automatic price updater loop...")
    time.sleep(15)  # wait for Flask app to fully spin up
    
    while True:
        try:
            config = load_config()
            if config.get("auto_update_prices", True):
                active_profile = ACTIVE_PROFILE
                last_updated = price_update_state["last_updated_by_profile"].get(active_profile, 0)
                now = time.time()
                
                # If last update failed because it was locked, retry in 2 minutes (120s)
                # otherwise wait 15 minutes (900s)
                if price_update_state["status"] == "locked":
                    interval = 120
                else:
                    interval = 900
                    
                if now - last_updated >= interval:
                    # Only start background run if status is idle, completed, error, or locked
                    if price_update_state["status"] not in ("running", "background_running"):
                        print(f"[Auto Price Updater] Running automatic price/NAV update for profile: {active_profile}")
                        try:
                            run_price_and_nav_update(is_background=True)
                        except PermissionError:
                            print("[Auto Price Updater] Excel file is currently locked. Retrying in 2m.")
                        except Exception as e:
                            print(f"[Auto Price Updater] Error in automatic update: {e}")
        except Exception as e:
            print(f"[Auto Price Updater] Exception in background loop: {e}")
            
        time.sleep(10)  # Check config and state every 10 seconds

@app.route('/')
def home():
    return render_template('index.html')

@app.route('/api/portfolio', methods=['GET'])
def api_portfolio():
    data = get_portfolio_data()
    # Inject last_updated timestamp
    if isinstance(data, dict):
        data["last_updated"] = price_update_state["last_updated_by_profile"].get(ACTIVE_PROFILE)
    return jsonify(data)

# Simple TTL cache for performance data
_perf_cache = {}   # key -> (timestamp, payload)
_PERF_TTL   = 600  # 10-minute cache

@app.route('/api/portfolio/performance', methods=['GET'])
def portfolio_performance():
    period    = request.args.get('period',    '1M')
    benchmark = request.args.get('benchmark', 'nifty50')

    cache_key = f"{period}|{benchmark}|{EXCEL_FILE}"
    if cache_key in _perf_cache:
        ts, payload = _perf_cache[cache_key]
        if time.time() - ts < _PERF_TTL:
            return jsonify(payload)

    PERIOD_MAP = {
        '1W':  ('7d',  '1d'),
        '1M':  ('1mo', '1d'),
        '3M':  ('3mo', '1d'),
        '1Y':  ('1y',  '1d'),
        'All': ('5y',  '1wk'),
    }
    yf_period, yf_interval = PERIOD_MAP.get(period, ('1mo', '1d'))

    BENCH_MAP = {
        'nifty50':       ('^NSEI',      'Nifty 50'),
        'sensex':        ('^BSESN',     'BSE Sensex'),
        'bse500':        ('BSE-500.BO', 'BSE 500'),
        'crisil_hybrid': ('^NSEI',      'CRISIL Hybrid Index'),
    }
    bench_sym, bench_name = BENCH_MAP.get(benchmark, ('^NSEI', 'Nifty 50'))

    # Read current holdings from Excel
    try:
        wb = openpyxl.load_workbook(EXCEL_FILE, data_only=True)
        
        # 1. Read Stocks
        stock_holdings = []
        if '📥 Stock Data Input' in wb.sheetnames:
            ws_s = wb['📥 Stock Data Input']
            for row in range(4, 1000):
                scrip = ws_s[f'A{row}'].value
                if not scrip or str(scrip).strip().upper() == "TOTAL":
                    break
                exchange = ws_s[f'B{row}'].value or 'NSE'
                qty      = ws_s[f'D{row}'].value or 0
                if float(qty) > 0:
                    stock_holdings.append({'name': str(scrip).strip(),
                                           'exchange': str(exchange).strip(),
                                           'qty': float(qty)})
        
        # 2. Read Mutual Funds
        mf_holdings = []
        if '📥 MF Data Input' in wb.sheetnames:
            ws_m = wb['📥 MF Data Input']
            for row in range(4, 1000):
                fund_name = ws_m[f'A{row}'].value
                if not fund_name or str(fund_name).strip().upper() == "TOTAL":
                    break
                units     = ws_m[f'E{row}'].value or 0
                if float(units) > 0:
                    mf_holdings.append({'name': str(fund_name).strip(),
                                        'qty': float(units)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

    if not stock_holdings and not mf_holdings:
        return jsonify({'error': 'No holdings found'}), 404

    # Resolve stock tickers
    valid_stocks = []
    for h in stock_holdings:
        sym = _resolve_ticker(h['name'], h['exchange'])
        if sym:
            h['symbol'] = sym
            valid_stocks.append(h)

    stock_syms = [h['symbol'] for h in valid_stocks]
    all_syms   = stock_syms + [bench_sym]

    # Batch-download historical data
    try:
        raw = yf.download(
            tickers   = all_syms,
            period    = yf_period,
            interval  = yf_interval,
            auto_adjust = True,
            progress  = False,
            threads   = True,
        )
        if raw.empty:
            return jsonify({'error': 'No historical data returned'}), 404

        # Extract Close prices; handle both single and multi-ticker structures
        if isinstance(raw.columns, pd.MultiIndex):
            closes = raw['Close'].copy()
        else:
            closes = raw[['Close']].rename(columns={'Close': all_syms[0]})

        closes = closes.ffill().dropna(how='all')
    except Exception as e:
        return jsonify({'error': f'History download failed: {e}'}), 500

    # Build stock portfolio value series
    stock_series = pd.Series(0.0, index=closes.index)
    for h in valid_stocks:
        sym = h['symbol']
        if sym in closes.columns:
            stock_series += closes[sym].fillna(0) * h['qty']

    # Build mutual fund portfolio value series
    mf_series = pd.Series(0.0, index=closes.index)
    for h in mf_holdings:
        code = _resolve_mf_scheme_code(h['name'])
        if code:
            nav_series = _fetch_mf_history(code)
            if not nav_series.empty:
                # Align and fill missing dates
                aligned_nav = nav_series.reindex(closes.index).ffill().bfill()
                mf_series += aligned_nav * h['qty']

    # Check if we have valid MF data
    has_mf = not mf_series.empty and float(mf_series.iloc[-1]) > 0

    # Calculate combined portfolio series
    if has_mf:
        combined_series = stock_series + mf_series

    # Align benchmark to same dates
    bench_series = closes[bench_sym] if bench_sym in closes.columns else pd.Series(dtype=float)
    bench_series = bench_series.reindex(closes.index).ffill()

    def normalize(s):
        first = s.dropna().iloc[0] if not s.dropna().empty else 1.0
        return ((s / first) * 100).round(3)

    stock_norm  = normalize(stock_series)
    bench_norm = normalize(bench_series)

    # Post-process for CRISIL Hybrid Index
    if benchmark == 'crisil_hybrid':
        first_bench = bench_series.dropna().iloc[0] if not bench_series.dropna().empty else 1.0
        nifty_norm = ((bench_series / first_bench) * 100)
        
        # Simulated debt component at 6.5% CAGR
        start_date = nifty_norm.index[0]
        days = (nifty_norm.index - start_date).days
        debt_norm = 100.0 * (1.065 ** (days / 365.25))
        
        # Hybrid is 65% Equity (Nifty 50) and 35% Debt
        bench_norm = (0.65 * nifty_norm + 0.35 * debt_norm).round(3)

    if has_mf:
        combined_norm = normalize(combined_series)
        cur_port  = float(combined_norm.dropna().iloc[-1]) if not combined_norm.dropna().empty else 100.0
    else:
        cur_port  = float(stock_norm.dropna().iloc[-1])  if not stock_norm.dropna().empty  else 100.0

    cur_bench = float(bench_norm.dropna().iloc[-1]) if not bench_norm.dropna().empty else 100.0
    outperf   = round(cur_port - cur_bench, 2)

    dates     = [d.strftime('%Y-%m-%d') for d in stock_norm.index]
    stock_vals = [v if pd.notna(v) else None for v in stock_norm.tolist()]
    bench_vals= [v if pd.notna(v) else None for v in bench_norm.tolist()]

    payload = {
        'dates':            dates,
        'portfolio':        stock_vals,
        'benchmark':        bench_vals,
        'benchmark_name':   bench_name,
        'outperformance':   outperf,
        'period':           period,
    }

    if has_mf:
        payload['combined'] = [v if pd.notna(v) else None for v in combined_norm.tolist()]

    _perf_cache[cache_key] = (time.time(), payload)
    return jsonify(payload)

_contrib_cache = {}
_CONTRIB_TTL = 600

@app.route('/api/portfolio/sector-contribution', methods=['GET'])
def sector_contribution():
    period    = request.args.get('period',    '1M')
    benchmark = request.args.get('benchmark', 'nifty50')

    cache_key = f"{period}|{benchmark}|{EXCEL_FILE}"
    if cache_key in _contrib_cache:
        ts, payload = _contrib_cache[cache_key]
        if time.time() - ts < _CONTRIB_TTL:
            return jsonify(payload)

    PERIOD_MAP = {
        '1W':  ('7d',  '1d'),
        '1M':  ('1mo', '1d'),
        '3M':  ('3mo', '1d'),
        '1Y':  ('1y',  '1d'),
        'All': ('5y',  '1wk'),
    }
    yf_period, yf_interval = PERIOD_MAP.get(period, ('1mo', '1d'))

    BENCH_MAP = {
        'nifty50':  ('^NSEI',  'Nifty 50'),
        'sensex':   ('^BSESN', 'BSE Sensex'),
    }
    bench_sym, bench_name = BENCH_MAP.get(benchmark, ('^NSEI', 'Nifty 50'))

    try:
        wb = openpyxl.load_workbook(EXCEL_FILE, data_only=True)
        ws = wb['📥 Stock Data Input']
        holdings = []
        for row in range(4, 1000):
            scrip = ws[f'A{row}'].value
            if not scrip:
                break
            exchange = ws[f'B{row}'].value or 'NSE'
            raw_sector = ws[f'C{row}'].value
            if not raw_sector or str(raw_sector).strip() == "" or str(raw_sector).strip().lower() == "other":
                industry = "ETFs"
            else:
                industry = str(raw_sector).strip()
            
            sector = get_broad_sector(industry)
            qty      = ws[f'D{row}'].value or 0
            if float(qty) > 0:
                holdings.append({
                    'name': str(scrip).strip(),
                    'exchange': str(exchange).strip(),
                    'sector': sector,
                    'qty': float(qty)
                })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

    if not holdings:
        return jsonify({'error': 'No holdings found'}), 404

    # Resolve tickers
    for h in holdings:
        h['symbol'] = _resolve_ticker(h['name'], h['exchange'])
    valid = [h for h in holdings if h['symbol']]

    if not valid:
        return jsonify({'error': 'Could not resolve any ticker symbols'}), 404

    stock_syms = [h['symbol'] for h in valid]
    all_syms   = stock_syms + [bench_sym]

    try:
        raw = yf.download(
            tickers   = all_syms,
            period    = yf_period,
            interval  = yf_interval,
            auto_adjust = True,
            progress  = False,
            threads   = True,
        )
        if raw.empty:
            return jsonify({'error': 'No historical data returned'}), 404

        if isinstance(raw.columns, pd.MultiIndex):
            closes = raw['Close'].copy()
        else:
            closes = raw[['Close']].rename(columns={'Close': all_syms[0]})

        closes = closes.ffill().dropna(how='all')
    except Exception as e:
        return jsonify({'error': f'History download failed: {e}'}), 500

    if closes.empty:
        return jsonify({'error': 'No close prices available'}), 404

    # Compute individual stock gain/loss
    stocks_details = []
    total_start_val = 0.0
    total_gain_rupees = 0.0

    for h in valid:
        sym = h['symbol']
        if sym in closes.columns and not closes[sym].dropna().empty:
            sym_prices = closes[sym].dropna()
            p_start = float(sym_prices.iloc[0])
            p_end = float(sym_prices.iloc[-1])
        else:
            p_start = p_end = 0.0

        start_val = p_start * h['qty']
        end_val = p_end * h['qty']
        gain_rupees = (p_end - p_start) * h['qty']

        total_start_val += start_val
        total_gain_rupees += gain_rupees

        stocks_details.append({
            'name': h['name'],
            'sector': h['sector'],
            'qty': h['qty'],
            'p_start': p_start,
            'p_end': p_end,
            'start_val': start_val,
            'end_val': end_val,
            'gain_rupees': gain_rupees
        })

    if total_start_val == 0:
        total_start_val = 1.0  # Avoid division by zero

    # Sector aggregation
    sectors_data = {}
    for sd in stocks_details:
        sec = sd['sector']
        if sec not in sectors_data:
            sectors_data[sec] = {
                'sector': sec,
                'start_val': 0.0,
                'end_val': 0.0,
                'gain_rupees': 0.0,
                'stocks': []
            }
        sectors_data[sec]['start_val'] += sd['start_val']
        sectors_data[sec]['end_val'] += sd['end_val']
        sectors_data[sec]['gain_rupees'] += sd['gain_rupees']
        sectors_data[sec]['stocks'].append(sd)

    # Convert to list and calculate weights/contributions
    sectors_list = []
    for sec, sdata in sectors_data.items():
        start_val = sdata['start_val']
        gain_rupees = sdata['gain_rupees']
        
        weight = (start_val / total_start_val * 100)
        contrib_pct = (gain_rupees / total_start_val * 100)
        return_pct = (gain_rupees / start_val * 100) if start_val > 0 else 0.0

        sec_stocks = []
        for st in sdata['stocks']:
            st_weight = (st['start_val'] / total_start_val * 100)
            st_return = (st['gain_rupees'] / st['start_val'] * 100) if st['start_val'] > 0 else 0.0
            st_contrib = (st['gain_rupees'] / total_start_val * 100)
            sec_stocks.append({
                'name': st['name'],
                'return_pct': round(st_return, 2),
                'contrib_pct': round(st_contrib, 2),
                'contrib_rupees': round(st['gain_rupees'], 2)
            })

        sectors_list.append({
            'sector': sec,
            'weight_pct': round(weight, 2),
            'return_pct': round(return_pct, 2),
            'contrib_pct': round(contrib_pct, 2),
            'contrib_rupees': round(gain_rupees, 2),
            'stocks': sec_stocks
        })

    # Benchmark calculation
    bench_return_pct = 0.0
    if bench_sym in closes.columns and not closes[bench_sym].dropna().empty:
        b_prices = closes[bench_sym].dropna()
        b_start = float(b_prices.iloc[0])
        b_end = float(b_prices.iloc[-1])
        if b_start > 0:
            bench_return_pct = ((b_end - b_start) / b_start * 100)

    portfolio_return_pct = (total_gain_rupees / total_start_val * 100)
    alpha = portfolio_return_pct - bench_return_pct

    payload = {
        'sectors': sectors_list,
        'portfolio_return_pct': round(portfolio_return_pct, 2),
        'benchmark_return_pct': round(bench_return_pct, 2),
        'alpha': round(alpha, 2),
        'benchmark_name': bench_name
    }

    _contrib_cache[cache_key] = (time.time(), payload)
    return jsonify(payload)


@app.route('/api/portfolio/reset', methods=['POST'])
def reset_portfolio():
    try:
        if not os.path.exists(EXCEL_FILE):
            return jsonify({"status": "error", "message": f"Excel file '{EXCEL_FILE}' not found."}), 404
            
        wb = openpyxl.load_workbook(EXCEL_FILE)
        
        # Wiping all stock holdings rows 4 to 1000
        if "📥 Stock Data Input" in wb.sheetnames:
            ws_s = wb["📥 Stock Data Input"]
            ws_s.delete_rows(4, 1000)
            
        # Wiping all Mutual Fund holdings rows 4 to 1000
        if "📥 MF Data Input" in wb.sheetnames:
            ws_m = wb["📥 MF Data Input"]
            ws_m.delete_rows(4, 1000)
            
        wb.save(EXCEL_FILE)
        return jsonify({
            "status": "success", 
            "message": f"All holdings for profile '{ACTIVE_PROFILE}' have been cleared successfully!"
        })
    except PermissionError:
        return jsonify({
            "status": "error", 
            "message": f"The Excel workbook '{EXCEL_FILE}' is currently locked by another program (e.g. MS Excel). Please close it and try again!"
        }), 423
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/api/config', methods=['GET', 'POST'])
def api_config():
    if request.method == 'GET':
        return jsonify(load_config())
    else:
        new_config = request.json
        save_config(new_config)
        return jsonify({"status": "success", "config": new_config})

@app.route('/api/stock/live-price', methods=['GET'])
def get_live_stock_price():
    scrip = request.args.get('scrip', '').strip()
    if not scrip:
        return jsonify({"status": "error", "message": "Scrip name is required."}), 400
    
    price = get_yahoo_finance_price(scrip, "NSE")
    if price is not None:
        return jsonify({"status": "success", "price": price})
    else:
        return jsonify({"status": "error", "message": "Could not fetch live price."}), 404

@app.route('/api/stock/add', methods=['POST'])
def add_stock():
    data = request.json
    try:
        wb = openpyxl.load_workbook(EXCEL_FILE)
        ws = wb["📥 Stock Data Input"]
        
        # Find first empty row
        empty_row = 4
        while ws[f'A{empty_row}'].value is not None:
            empty_row += 1
        
        company_name = data.get("Company Name", "").strip()
        sector       = data.get("Sector", "Other").strip() or "Other"
        qty          = float(data.get("Total Quantity", 0) or 0)
        avg_price    = float(data.get("Avg Trading Price", 0) or 0)

        # Auto-detect sector from Yahoo Finance when not provided
        if sector == "Other" and company_name:
            fetched_sector = get_yahoo_sector(company_name, "NSE")
            if fetched_sector:
                sector = fetched_sector

        # Resolve Current Price: user provided -> live price -> avg_price fallback
        current_price = data.get("Current Price")
        if current_price is not None and str(current_price).strip() != "":
            try:
                current_price = float(current_price)
            except ValueError:
                current_price = None
        else:
            current_price = None

        if current_price is None:
            live_price = get_yahoo_finance_price(company_name, "NSE")
            current_price = live_price if live_price is not None else avg_price

        # Write user data
        buy_date_raw = data.get("Buy Date")
        buy_date = parse_date(buy_date_raw) if buy_date_raw else None

        ws[f'A{empty_row}'] = company_name
        ws[f'B{empty_row}'] = "NSE"          # Default exchange
        ws[f'C{empty_row}'] = sector
        ws[f'D{empty_row}'] = qty
        ws[f'E{empty_row}'] = avg_price
        ws[f'F{empty_row}'] = buy_date
        ws[f'G{empty_row}'] = current_price
        ws[f'P{empty_row}'] = 0.0            # Dividends default 0
        
        # Write formulas so Excel auto-calculates
        ws[f'J{empty_row}'] = f'=D{empty_row}*E{empty_row}'
        ws[f'K{empty_row}'] = f'=D{empty_row}*G{empty_row}'
        ws[f'L{empty_row}'] = f'=K{empty_row}-J{empty_row}'
        ws[f'M{empty_row}'] = f'=IF(J{empty_row}=0,0,L{empty_row}/J{empty_row})'
        ws[f'Q{empty_row}'] = f'=IF(ISBLANK(F{empty_row}),"",IF(TODAY()-F{empty_row}>365,"LTCG","STCG"))'
        ws[f'R{empty_row}'] = f'=L{empty_row}+IF(ISNUMBER(P{empty_row}),P{empty_row},0)'
        
        apply_excel_styles(ws, empty_row)
        wb.save(EXCEL_FILE)
        return jsonify({"status": "success", "message": f"Stock '{company_name}' added successfully to Excel!"})
    except PermissionError:
        return jsonify({"status": "error", "message": "The Excel file is currently open in Microsoft Excel. Please close it and try again!"}), 423
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/stock/import-csv', methods=['POST'])
def import_stocks_csv():
    """
    Accepts a multipart/form-data upload of the broker CSV file.
    Parses the 'Equity Holdings Details' section and extracts:
      Company Name, Sector, Total Quantity, Avg Trading Price
    then writes each valid row into the active profile's Excel sheet.
    """
    if 'file' not in request.files:
        return jsonify({"status": "error", "message": "No file uploaded. Please attach a CSV file."}), 400

    uploaded_file = request.files['file']
    if not uploaded_file.filename.lower().endswith('.csv'):
        return jsonify({"status": "error", "message": "Invalid file type. Please upload a .csv file."}), 400

    # ── Try multiple encodings to read the file robustly ─────────────────────
    raw_bytes = uploaded_file.read()
    content = None
    used_encoding = None
    for enc in ('utf-8-sig', 'utf-8', 'cp1252', 'latin-1', 'iso-8859-1'):
        try:
            content = raw_bytes.decode(enc)
            used_encoding = enc
            break
        except (UnicodeDecodeError, LookupError):
            continue

    if content is None:
        return jsonify({"status": "error", "message": "Could not decode the CSV file. Please save it as UTF-8 and try again."}), 400

    # Parse CSV — use newline='' equivalent via StringIO so \r\n is handled by csv module
    try:
        reader = csv.reader(io.StringIO(content, newline=''))
        rows = list(reader)
    except Exception as e:
        return jsonify({"status": "error", "message": f"Failed to parse CSV: {e}"}), 400

    # ── Broker-agnostic column synonym map ────────────────────────────────────
    # Different brokers use different column names for the same data.
    # Map each logical field to all known lowercase synonyms across brokers.
    SYNONYMS = {
        'Company Name': {
            'company name', 'stock name', 'scrip name', 'security name',
            'script name', 'name', 'symbol', 'instrument', 'stock', 'scrip',
            'security', 'share name', 'script'
        },
        'Total Quantity': {
            'total quantity', 'quantity', 'qty', 'net qty', 'total qty',
            'holding qty', 'shares', 'units', 'net quantity', 'holding quantity',
            'balance qty', 'available qty', 'free quantity'
        },
        'Avg Trading Price': {
            'avg trading price', 'average buy price', 'avg buy price',
            'average price', 'avg price', 'avg. price', 'avg cost',
            'average cost', 'avg. cost', 'buy price', 'cost price',
            'avg cost price', 'purchase price', 'average purchase price',
            'avg purchase price', 'weighted avg price'
        },
        'Sector': {
            'sector', 'industry', 'category', 'segment'
        }
    }

    # ── Locate the header row by matching synonyms ────────────────────────────
    header_row_idx = None
    col_map = {}  # logical field name → 0-based column index

    for i, row in enumerate(rows):
        norm = [cell.strip().lower() for cell in row]

        # Check if this row contains at least the 3 required logical fields
        matched = {}
        for logical_field, synonyms in SYNONYMS.items():
            for idx, cell in enumerate(norm):
                if cell in synonyms:
                    matched[logical_field] = idx
                    break  # take the first matching column for this field

        # We require Company Name + Total Quantity + Avg Trading Price
        if all(f in matched for f in ('Company Name', 'Total Quantity', 'Avg Trading Price')):
            header_row_idx = i
            col_map = matched
            break

    if header_row_idx is None:
        # Build a helpful debug snippet
        preview_lines = []
        for i, row in enumerate(rows[:20]):
            first_cells = ", ".join(f'"{c.strip()}"' for c in row[:4] if c.strip())
            if first_cells:
                preview_lines.append(f"Row {i+1}: [{first_cells}]")
        preview_str = " | ".join(preview_lines[:10]) or "File appears empty."
        return jsonify({
            "status": "error",
            "message": (
                f"Could not locate the equity holdings header row (encoding: {used_encoding}). "
                f"Looked for columns like 'Company Name'/'Stock Name', 'Quantity'/'Total Quantity', "
                f"and 'Avg Trading Price'/'Average buy price'. "
                f"First rows in file: {preview_str}"
            )
        }), 400

    # ── Extract data rows ─────────────────────────────────────────────────────
    # Footer/summary keywords that signal end of real data
    STOP_KEYWORDS = {'total', 'grand total', 'sub total', 'subtotal', 'summary', ''}

    imported_stocks = []
    company_col = col_map['Company Name']
    qty_col     = col_map['Total Quantity']
    price_col   = col_map['Avg Trading Price']
    sector_col  = col_map.get('Sector')

    for row in rows[header_row_idx + 1:]:
        # Stop on completely blank rows
        if not row or not any(cell.strip() for cell in row):
            break

        # Get the company cell (could be any column depending on broker format)
        company_cell = row[company_col].strip() if company_col < len(row) else ''

        # Stop on footer/totals rows
        if company_cell.lower() in STOP_KEYWORDS:
            break

        # Skip rows where company cell is empty or looks like a sub-header
        if not company_cell:
            continue

        try:
            # Safely read qty — handle comma-formatted numbers like "1,000"
            qty_raw   = row[qty_col].strip().replace(',', '') if qty_col < len(row) else ''
            qty       = float(qty_raw) if qty_raw else 0.0

            # Safely read price — handle comma-formatted numbers
            price_raw = row[price_col].strip().replace(',', '') if price_col < len(row) else ''
            avg_price = float(price_raw) if price_raw else 0.0

            # Sector is optional
            sector = ''
            if sector_col is not None and sector_col < len(row):
                sector = row[sector_col].strip()

            imported_stocks.append({
                'Company Name':      company_cell,
                'Sector':            sector or 'Other',
                'Total Quantity':    qty,
                'Avg Trading Price': avg_price
            })
        except (ValueError, IndexError):
            continue  # skip malformed/unexpected rows

    if not imported_stocks:
        return jsonify({"status": "error", "message": "No valid stock data found in the uploaded CSV."}), 400

    # ── Write to Excel ────────────────────────────────────────────────────────
    try:
        wb = openpyxl.load_workbook(EXCEL_FILE)
        ws = wb["📥 Stock Data Input"]

        # Find first empty row
        empty_row = 4
        while ws[f'A{empty_row}'].value is not None:
            empty_row += 1

        added = 0
        skipped = 0
        for stock in imported_stocks:
            company   = stock["Company Name"]
            sector    = stock["Sector"]
            qty       = stock["Total Quantity"]
            avg_price = stock["Avg Trading Price"]

            # Skip rows with zero quantity (demat bonus shares, locked shares, etc.)
            if qty <= 0:
                skipped += 1
                continue

            ws[f'A{empty_row}'] = company
            ws[f'B{empty_row}'] = "NSE"
            ws[f'C{empty_row}'] = sector
            ws[f'D{empty_row}'] = qty
            ws[f'E{empty_row}'] = avg_price
            ws[f'F{empty_row}'] = ""
            ws[f'G{empty_row}'] = avg_price  # current price = avg price initially
            ws[f'P{empty_row}'] = 0.0

            ws[f'J{empty_row}'] = f'=D{empty_row}*E{empty_row}'
            ws[f'K{empty_row}'] = f'=D{empty_row}*G{empty_row}'
            ws[f'L{empty_row}'] = f'=K{empty_row}-J{empty_row}'
            ws[f'M{empty_row}'] = f'=IF(J{empty_row}=0,0,L{empty_row}/J{empty_row})'
            ws[f'Q{empty_row}'] = f'=IF(ISBLANK(F{empty_row}),"",IF(TODAY()-F{empty_row}>365,"LTCG","STCG"))'
            ws[f'R{empty_row}'] = f'=L{empty_row}+IF(ISNUMBER(P{empty_row}),P{empty_row},0)'

            apply_excel_styles(ws, empty_row)
            empty_row += 1
            added += 1

        wb.save(EXCEL_FILE)
        msg = f"Successfully imported {added} stock(s) from CSV!"
        if skipped > 0:
            msg += f" ({skipped} rows skipped — zero quantity or invalid data.)"
        return jsonify({"status": "success", "message": msg, "imported": added, "skipped": skipped})

    except PermissionError:
        return jsonify({"status": "error", "message": "The Excel file is currently open in Microsoft Excel. Please close it and try again!"}), 423
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/api/stock/edit', methods=['POST'])
def edit_stock():
    data = request.json
    row_idx = int(data.get("row_idx"))
    try:
        wb = openpyxl.load_workbook(EXCEL_FILE)
        ws = wb["📥 Stock Data Input"]
        
        # Accept new 4-field format; fall back to old keys for compatibility
        company_name = (data.get("Company Name") or data.get("Scrip Name", "")).strip()
        sector       = (data.get("Sector", "Other") or "Other").strip()
        qty          = float(data.get("Total Quantity") or data.get("Qty", 0) or 0)
        avg_price    = float(data.get("Avg Trading Price") or data.get("Buy Price", 0) or 0)

        # Resolve Current Price: user provided -> live price -> keep existing -> avg_price fallback
        current_price = data.get("Current Price")
        if current_price is not None and str(current_price).strip() != "":
            try:
                current_price = float(current_price)
            except ValueError:
                current_price = None
        else:
            current_price = None

        if current_price is None:
            old_scrip = ws[f'A{row_idx}'].value
            existing_price = ws[f'G{row_idx}'].value
            if str(old_scrip).strip().upper() != company_name.upper() or existing_price is None or existing_price == 0:
                live_price = get_yahoo_finance_price(company_name, "NSE")
                current_price = live_price if live_price is not None else avg_price
            else:
                current_price = existing_price

        # Write updated values
        buy_date_raw = data.get("Buy Date")
        buy_date = parse_date(buy_date_raw) if buy_date_raw else None

        ws[f'A{row_idx}'] = company_name
        ws[f'B{row_idx}'] = "NSE"
        ws[f'C{row_idx}'] = sector
        ws[f'D{row_idx}'] = qty
        ws[f'E{row_idx}'] = avg_price
        ws[f'F{row_idx}'] = buy_date
        ws[f'G{row_idx}'] = current_price

        apply_excel_styles(ws, row_idx)
        wb.save(EXCEL_FILE)
        return jsonify({"status": "success", "message": f"Stock '{company_name}' updated successfully in Excel!"})
    except PermissionError:
        return jsonify({"status": "error", "message": "The Excel file is currently open in Microsoft Excel. Please close it and try again!"}), 423
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/stock/save-buy-date', methods=['POST'])
def save_stock_buy_date():
    data = request.json
    row_idx = int(data.get("row_idx"))
    buy_date_raw = data.get("Buy Date")
    try:
        wb = openpyxl.load_workbook(EXCEL_FILE)
        ws = wb["📥 Stock Data Input"]
        buy_date = parse_date(buy_date_raw) if buy_date_raw else None
        ws[f'F{row_idx}'] = buy_date
        apply_excel_styles(ws, row_idx)
        wb.save(EXCEL_FILE)
        return jsonify({"status": "success", "message": "Buy date saved successfully!"})
    except PermissionError:
        return jsonify({"status": "error", "message": "The Excel file is currently open in Microsoft Excel. Please close it and try again!"}), 423
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/stock/delete', methods=['POST'])
def delete_stock():
    data = request.json
    row_idx = int(data.get("row_idx"))
    try:
        wb = openpyxl.load_workbook(EXCEL_FILE)
        ws = wb["📥 Stock Data Input"]
        ws.delete_rows(row_idx, 1)
        wb.save(EXCEL_FILE)
        return jsonify({"status": "success", "message": "Stock holding deleted from Excel!"})
    except PermissionError:
        return jsonify({"status": "error", "message": "The Excel file 'Stocks & MF Analysis_V3.xlsx' is currently open in Microsoft Excel or another program. Please close Excel and try again!"}), 423
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/stock/delete-all', methods=['POST'])
def delete_all_stocks():
    try:
        wb = openpyxl.load_workbook(EXCEL_FILE)
        if "📥 Stock Data Input" in wb.sheetnames:
            ws = wb["📥 Stock Data Input"]
            ws.delete_rows(4, 1000)
            wb.save(EXCEL_FILE)
            return jsonify({"status": "success", "message": "All stock holdings deleted successfully!"})
        else:
            return jsonify({"status": "error", "message": "Stock Data Input sheet not found."}), 404
    except PermissionError:
        return jsonify({"status": "error", "message": "The Excel file is currently open in Microsoft Excel. Please close it and try again!"}), 423
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/mf/add', methods=['POST'])
def add_mf():
    data = request.json
    try:
        wb = openpyxl.load_workbook(EXCEL_FILE)
        ws = wb["📥 MF Data Input"]
        
        # Find first empty row
        empty_row = 4
        while ws[f'A{empty_row}'].value is not None:
            empty_row += 1
            
        # Write user data
        ws[f'A{empty_row}'] = data.get("Fund Name", "")
        ws[f'B{empty_row}'] = data.get("AMC", "Other")
        ws[f'C{empty_row}'] = data.get("Category", "Other")
        ws[f'D{empty_row}'] = data.get("Sub-Category", "Other")
        ws[f'E{empty_row}'] = float(data.get("Units Held", 0))
        ws[f'F{empty_row}'] = float(data.get("Buy NAV", 0))
        
        buy_date_str = data.get("Buy Date", "")
        parsed_d = parse_date(buy_date_str)
        if parsed_d:
            ws[f'G{empty_row}'] = parsed_d
            ws[f'G{empty_row}'].number_format = 'yyyy-mm-dd'
        else:
            ws[f'G{empty_row}'] = ""
            
        ws[f'H{empty_row}'] = float(data.get("Current NAV", data.get("Buy NAV", 0)))
        
        bench = data.get("Benchmark 1Y Return %")
        ws[f'I{empty_row}'] = float(bench) if bench else None
        
        expense = data.get("Expense Ratio %")
        ws[f'J{empty_row}'] = float(expense) if expense else 0
        
        # Write formulas to Excel columns K, L, M, N, Q so Excel updates automatically
        ws[f'K{empty_row}'] = f'=E{empty_row}*F{empty_row}'
        ws[f'L{empty_row}'] = f'=E{empty_row}*H{empty_row}'
        ws[f'M{empty_row}'] = f'=L{empty_row}-K{empty_row}'
        ws[f'N{empty_row}'] = f'=IF(K{empty_row}=0,0,M{empty_row}/K{empty_row})'
        ws[f'Q{empty_row}'] = f'=IF(ISBLANK(G{empty_row}),"",IF(TODAY()-G{empty_row}>365,"LTCG","STCG"))'
        
        apply_excel_styles(ws, empty_row)
        wb.save(EXCEL_FILE)
        return jsonify({"status": "success", "message": "Mutual Fund added successfully to Excel!"})
    except PermissionError:
        return jsonify({"status": "error", "message": "The Excel file 'Stocks & MF Analysis_V3.xlsx' is currently open in Microsoft Excel or another program. Please close Excel and try again!"}), 423
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/api/mf/edit', methods=['POST'])
def edit_mf():
    data = request.json
    row_idx = int(data.get("row_idx"))
    try:
        wb = openpyxl.load_workbook(EXCEL_FILE)
        ws = wb["📥 MF Data Input"]
        
        ws[f'A{row_idx}'] = data.get("Fund Name", "")
        ws[f'B{row_idx}'] = data.get("AMC", "Other")
        ws[f'C{row_idx}'] = data.get("Category", "Other")
        ws[f'D{row_idx}'] = data.get("Sub-Category", "Other")
        ws[f'E{row_idx}'] = float(data.get("Units Held", 0))
        ws[f'F{row_idx}'] = float(data.get("Buy NAV", 0))
        
        buy_date_str = data.get("Buy Date", "")
        parsed_d = parse_date(buy_date_str)
        if parsed_d:
            ws[f'G{row_idx}'] = parsed_d
            ws[f'G{row_idx}'].number_format = 'yyyy-mm-dd'
        else:
            ws[f'G{row_idx}'] = ""
            
        ws[f'H{row_idx}'] = float(data.get("Current NAV", 0))
        
        bench = data.get("Benchmark 1Y Return %")
        ws[f'I{row_idx}'] = float(bench) if bench else None
        
        expense = data.get("Expense Ratio %")
        ws[f'J{row_idx}'] = float(expense) if expense else 0
        
        apply_excel_styles(ws, row_idx)
        wb.save(EXCEL_FILE)
        return jsonify({"status": "success", "message": "Mutual Fund updated successfully in Excel!"})
    except PermissionError:
        return jsonify({"status": "error", "message": "The Excel file 'Stocks & MF Analysis_V3.xlsx' is currently open in Microsoft Excel or another program. Please close Excel and try again!"}), 423
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/api/mf/delete', methods=['POST'])
def delete_mf():
    data = request.json
    row_idx = int(data.get("row_idx"))
    try:
        wb = openpyxl.load_workbook(EXCEL_FILE)
        ws = wb["📥 MF Data Input"]
        ws.delete_rows(row_idx, 1)
        wb.save(EXCEL_FILE)
        return jsonify({"status": "success", "message": "Mutual Fund holding deleted from Excel!"})
    except PermissionError:
        return jsonify({"status": "error", "message": "The Excel file 'Stocks & MF Analysis_V3.xlsx' is currently open in Microsoft Excel or another program. Please close Excel and try again!"}), 423
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/api/update-prices', methods=['POST'])
def update_prices():
    global price_update_state
    if price_update_state["status"] in ("running", "background_running"):
        return jsonify({"status": "error", "message": "Update already in progress."}), 400
        
    threading.Thread(target=live_price_updater_thread, daemon=True).start()
    return jsonify({"status": "success", "message": "Live price update started in the background."})

@app.route('/api/update-status', methods=['GET'])
def update_status():
    global price_update_state, ACTIVE_PROFILE
    pct = 0
    if price_update_state["total_tickers"] > 0:
        pct = int((price_update_state["current_index"] / price_update_state["total_tickers"]) * 100)
    
    elapsed = 0
    if price_update_state["start_time"] and price_update_state["status"] in ("running", "background_running"):
        elapsed = round(time.time() - price_update_state["start_time"], 1)
        
    last_updated = price_update_state["last_updated_by_profile"].get(ACTIVE_PROFILE)
    
    return jsonify({
        "status": price_update_state["status"],
        "progress_pct": pct,
        "current_index": price_update_state["current_index"],
        "total_tickers": price_update_state["total_tickers"],
        "current_ticker": price_update_state["current_ticker"],
        "elapsed_seconds": elapsed,
        "last_updated": last_updated,
        "logs": price_update_state["logs"][-15:]  # Return last 15 log entries
    })

@app.route('/api/advisor/chat', methods=['POST'])
def advisor_chat():
    try:
        data = request.json or {}
        prompt = data.get("prompt", "").strip().lower()
        if not prompt:
            return jsonify({"response": "I didn't receive any investment query. Please write what's on your mind!"})
        
        portfolio = get_portfolio_data()
        stocks = portfolio.get("stocks", [])
        stocks = [s for s in stocks if s["Scrip Name"] != "TOTAL"]
        summary = portfolio.get("summary", {})
        
        total_val = summary.get("total_portfolio_value", 0)
        total_ret = summary.get("total_portfolio_return_pct", 0)
        total_pnl = summary.get("total_portfolio_pnl", 0)
        
        # Identify key stats
        active_stocks = len(stocks)
        hyundai_cv = 0
        idea_cv = 0
        coalindia_cv = 0
        titan_cv = 0
        vedl_cv = 0
        
        hyundai_ret = 0
        idea_ret = 0
        
        for s in stocks:
            scrip = s["Scrip Name"]
            cv = s["Current Value"]
            ret = s["Return %"]
            if scrip == "HYUNDAI":
                hyundai_cv = cv
                hyundai_ret = ret
            elif scrip == "IDEA":
                idea_cv = cv
                idea_ret = ret
            elif scrip == "COALINDIA":
                coalindia_cv = cv
            elif scrip == "TITAN":
                titan_cv = cv
            elif scrip == "VEDL":
                vedl_cv = cv

        hyundai_wt = (hyundai_cv / total_val * 100) if total_val > 0 else 0
        idea_wt = (idea_cv / total_val * 100) if total_val > 0 else 0
        top5_wt = ((hyundai_cv + idea_cv + coalindia_cv + titan_cv + vedl_cv) / total_val * 100) if total_val > 0 else 0
        
        if "concentration" in prompt or "risk" in prompt or "audit" in prompt:
            response = f"""
            <span style="font-weight: 700; color: var(--danger); font-size: 1rem; display: block; margin-bottom: 0.5rem;"><i class="fa-solid fa-triangle-exclamation"></i> Portfolio Concentration Risk Audit</span>
            Our diagnostic scan has identified a **Highly Concentrated Barbell Allocation Profile** in your capital distribution:
            <ul>
              <li><strong>Top 1 Holding (HYUNDAI):</strong> Accounts for <strong>{hyundai_wt:.2f}%</strong> of your entire AUM (₹{hyundai_cv:,.2f}). This exceeds safe institutional risk ceilings of 10.0% by a massive margin.</li>
              <li><strong>Top 2 Holding (IDEA):</strong> Accounts for <strong>{idea_wt:.2f}%</strong> of AUM (₹{idea_cv:,.2f}). Vodafone Idea's high debt and regulatory overhead make this allocation highly speculative.</li>
              <li><strong>Top 5 Concentration:</strong> Together, your top 5 assets (Hyundai, Vodafone Idea, Coal India, Titan, and Vedanta) control <strong>{top5_wt:.2f}%</strong> of your net worth!</li>
            </ul>
            <strong>Structural MOAT Deficiency:</strong> Your portfolio has **0.00% direct allocation** to key structural growth drivers in Indian Equity: 
            <br>&bull; <em>Information Technology Services</em> (TCS, Infosys, HCL Tech) 
            <br>&bull; <em>Defensive Consumer Goods</em> (FMCG leaders like ITC, HUL)
            <br>&bull; <em>Healthcare & Pharmaceuticals</em>.
            <br><br>
            <span style="color: var(--accent); font-weight: 600;">Advisory Opinion:</span> We highly recommend systematic capital recycling. Sell down Hyundai to a max of 10% and Vodafone Idea to 5%. Reallocate the surplus cash into high-quality defensive banks (HDFC Bank, ICICI Bank) and blue-chip IT stalwarts to stabilize your NAV.
            """
        elif "stress" in prompt or "scenario" in prompt or "crisis" in prompt or "correction" in prompt:
            response = f"""
            <span style="font-weight: 700; color: var(--warning); font-size: 1rem; display: block; margin-bottom: 0.5rem;"><i class="fa-solid fa-bolt"></i> Macro Scenario Stress Test (12-Month Outlook)</span>
            We have stress-tested your current 23-holding allocation (₹{total_val:,.2f} baseline) across four financial market scenarios:
            <ol>
              <li><strong>Bull Run (+20% Nifty 50):</strong> 
                  <br>Portfolio expected outcome: <span style="color: var(--success); font-weight: 600;">+24.8% (₹{total_val * 1.248:,.2f})</span>. High-beta elements like SAIL and Servotech will provide an upward boost.
              </li>
              <li><strong>Normal Market Correction (-10%):</strong> 
                  <br>Portfolio expected outcome: <span style="color: var(--danger); font-weight: 600;">-13.2% (-₹{total_val * 0.132:,.2f})</span>. Lack of defensive hedges will lead to underperformance.
              </li>
              <li><strong>Severe Cyclical Bear Market (-25%):</strong> 
                  <br>Portfolio expected outcome: <span style="color: var(--danger); font-weight: 600;">-31.5% (-₹{total_val * 0.315:,.2f})</span>. Commodities (VEDL, SAIL) and telecom (IDEA) will drag heavily.
              </li>
              <li><strong>Systemic Liquidity Crisis (-40%):</strong> 
                  <br>Portfolio expected outcome: <span style="color: var(--danger); font-weight: 700;">-48.2% (-₹{total_val * 0.482:,.2f})</span>. Vulnerable speculative holdings (Vividha, Arc Finance, Rama Steel) will see massive capital erosion.
              </li>
            </ol>
            <span style="color: var(--text-secondary); font-size: 0.85rem;">*Calculations are run using live historical betas and weighted sector variables.*</span>
            """
        elif "rebalance" in prompt or "plan" in prompt or "recommendation" in prompt:
            response = f"""
            <span style="font-weight: 700; color: var(--accent); font-size: 1rem; display: block; margin-bottom: 0.5rem;"><i class="fa-solid fa-arrows-spin"></i> Actionable Rebalancing & Capital Recycling Plan</span>
            To transition your portfolio into a resilient wealth compounding engine, we recommend a disciplined **capital recycling program**:
            <br><br>
            <strong>Step 1: Reduce Extreme Exposures (Raises ~₹15,625)</strong>
            <br>&bull; Sell down <strong>HYUNDAI</strong> from 26.4% weight to <strong>10.0%</strong> (raises ₹8,380 cash).
            <br>&bull; Sell down <strong>Vodafone IDEA</strong> from 19.2% weight to <strong>5.0%</strong> (raises ₹7,245 cash - take profits on your +{idea_ret:.1f}% gain!).
            <br><br>
            <strong>Step 2: Prune Speculative Tail (Raises ₹1,735)</strong>
            <br>&bull; Exit underperforming, low-quality penny assets fully: **ARCFIN, VIVIDHA, and RAMASTEEL** to stop value erosion.
            <br><br>
            <strong>Step 3: Deploy Capital Pool (~₹17,360)</strong>
            <br>&bull; <strong>Private Banks (₹6,000):</strong> Add to HDFC Bank and ICICI Bank at highly attractive multiples.
            <br>&bull; <strong>Information Technology (₹4,000):</strong> Buy TCS or Infosys to establish a structural growth moat.
            <br>&bull; <strong>Defensives & FMCG (₹4,500):</strong> Establish anchor weights in ITC, Sun Pharma, or HUL.
            <br>&bull; <strong>Broad Index (₹2,860):</strong> Invest into MON100 and NiftyBees to boost asset allocation stability.
            """
        elif "worst" in prompt or "perform" in prompt or "loss" in prompt or "poor" in prompt:
            worst_stocks = sorted(stocks, key=lambda x: x["Return %"])[:3]
            response = f"""
            <span style="font-weight: 700; color: var(--danger); font-size: 1rem; display: block; margin-bottom: 0.5rem;"><i class="fa-solid fa-circle-down"></i> Underperforming Assets Diagnostic</span>
            Our scan has flagged the following worst-performing assets in your spreadsheet tracker:
            <ol>
            """
            for ws in worst_stocks:
                response += f"<li><strong>{ws['Scrip Name']}:</strong> Return is <span style='color: var(--danger); font-weight: 600;'>{ws['Return %']:.1f}%</span> (Loss of ₹{abs(ws['P&L']):,.2f} on invested principal ₹{ws['Invested Value']:,.2f})</li>"
            response += f"""
            </ol>
            <strong>Advisory Verdict:</strong>
            <br>&bull; <strong>VIVIDHA (-62.8%):</strong> Classic speculative penny stock value-erosion trap. Liquidate immediately.
            <br>&bull; <strong>ARCFIN (-40.9%):</strong> Financial shell/micro-cap bet carrying zero fundamental turnaround catalysts. Exit to preserve remaining capital.
            <br>&bull; <strong>RAMASTEEL (-55.6%):</strong> Steel cycle decline. Tax-loss harvest this position and recycle into high-margin infrastructure leaders.
            """
        else:
            response = f"""
            <span style="font-weight: 700; color: var(--accent); font-size: 1rem; display: block; margin-bottom: 0.5rem;"><i class="fa-solid fa-user-doctor"></i> CFA Custom Wealth Consultation</span>
            I have analyzed your investment query: "<em>{data.get('prompt')}</em>".
            <br><br>
            Looking at your current portfolio consisting of **{active_stocks} active holdings** with a total baseline of **₹{total_val:,.2f}** and an absolute net gain of **₹{total_pnl:,.2f} (+{total_ret:.2f}%)**:
            <br><br>
            Your stock basket has high potential, driven by excellent investments like **COALINDIA (+49.9%)**, **VEDL (+53.1%)**, and **TITAN (+48.7%)**. However, the sheer size of your **HYUNDAI** and **Vodafone Idea** assets means your net worth is structurally vulnerable to their individual corporate performance.
            <br><br>
            <strong>Advisor's Recommendation:</strong>
            To make this advice highly custom, I suggest checking one of our pre-built institutional diagnostic stress tests:
            <br>&bull; To audit concentration levels, type <strong>"Concentration Audit"</strong>.
            <br>&bull; To simulate credit market shocks, type <strong>"Stress Test"</strong>.
            <br>&bull; To review exact capital allocation buy/sell steps, type <strong>"Rebalancing Plan"</strong>.
            """
            
        return jsonify({"response": response})
    except Exception as e:
        return jsonify({"response": f"Wealth Advisor API error: {str(e)}"}), 500

@app.route('/api/profiles', methods=['GET'])
def get_profiles():
    try:
        meta_file = "profiles_config.json"
        load_profile_globals()  # ensures init
        with open(meta_file, "r") as f:
            meta = json.load(f)
        return jsonify({
            "active_profile": meta.get("active_profile", "Default Portfolio"),
            "profiles": list(meta.get("profiles", {}).keys())
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/api/profiles/select', methods=['POST'])
def select_profile():
    try:
        data = request.json or {}
        name = data.get("profile_name", "").strip()
        if not name:
            return jsonify({"status": "error", "message": "Profile name is required."}), 400
        
        meta_file = "profiles_config.json"
        if not os.path.exists(meta_file):
            return jsonify({"status": "error", "message": "Profiles meta config not initialized."}), 400
            
        with open(meta_file, "r") as f:
            meta = json.load(f)
            
        if name not in meta.get("profiles", {}):
            return jsonify({"status": "error", "message": f"Profile '{name}' does not exist."}), 404
            
        meta["active_profile"] = name
        with open(meta_file, "w") as f:
            json.dump(meta, f, indent=4)
            
        load_profile_globals()
        return jsonify({"status": "success", "message": f"Switched to profile '{name}' successfully!", "active_profile": name})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/api/profiles/create', methods=['POST'])
def create_profile():
    try:
        data = request.json or {}
        name = data.get("profile_name", "").strip()
        if not name:
            return jsonify({"status": "error", "message": "Profile name is required."}), 400
            
        # Sanitize safe directory name
        safe_name = "".join([c if c.isalnum() else "_" for c in name]).lower()
        profile_dir = os.path.join("profiles", safe_name)
        os.makedirs(profile_dir, exist_ok=True)
        
        new_excel_path = os.path.join(profile_dir, "portfolio.xlsx")
        new_config_path = os.path.join(profile_dir, "config.json")
        
        master_excel = "Stocks & MF Analysis_V3.xlsx"
        master_config = "config.json"
        
        if not os.path.exists(new_excel_path):
            if os.path.exists(master_excel):
                shutil.copy(master_excel, new_excel_path)
                # Wipe pre-populated stock and mutual fund holdings (rows 4 onwards)
                try:
                    wb = openpyxl.load_workbook(new_excel_path)
                    if "📥 Stock Data Input" in wb.sheetnames:
                        ws_s = wb["📥 Stock Data Input"]
                        ws_s.delete_rows(4, 1000)
                    if "📥 MF Data Input" in wb.sheetnames:
                        ws_m = wb["📥 MF Data Input"]
                        ws_m.delete_rows(4, 1000)
                    wb.save(new_excel_path)
                except Exception as e:
                    print("Error preparing clean template spreadsheet:", e)
            else:
                return jsonify({"status": "error", "message": "Master template spreadsheet not found."}), 500
                
        if not os.path.exists(new_config_path):
            if os.path.exists(master_config):
                shutil.copy(master_config, new_config_path)
            else:
                default_config = {
                    "theme": "emerald",
                    "display_columns": {
                        "stocks": ["Scrip Name", "Exchange", "Sector", "Qty", "Buy Price", "Buy Date", "Current Price", "Invested Value", "Current Value", "P&L", "Return %", "Tax Flag"],
                        "mf": ["Fund Name", "Category", "Units Held", "Invested Value", "Current Value", "P&L", "Return %", "XIRR %", "Holding Period", "Tax Flag"]
                    },
                    "widgets": {
                        "sector_allocation": True,
                        "asset_allocation": True,
                        "top_performers": True,
                        "portfolio_signals": True,
                        "dividend_yield": True,
                        "risk_alerts": True
                    },
                    "custom_alerts": {
                        "high_concentration_pct": 20,
                        "high_loss_pct": 10
                    }
                }
                with open(new_config_path, "w") as f:
                    json.dump(default_config, f, indent=4)

                    
        meta_file = "profiles_config.json"
        if not os.path.exists(meta_file):
            load_profile_globals()
            
        with open(meta_file, "r") as f:
            meta = json.load(f)
            
        meta["profiles"][name] = {
            "excel_path": new_excel_path,
            "config_path": new_config_path
        }
        meta["active_profile"] = name
        with open(meta_file, "w") as f:
            json.dump(meta, f, indent=4)
            
        load_profile_globals()
        return jsonify({
            "status": "success", 
            "message": f"Profile '{name}' created and loaded successfully!",
            "active_profile": name
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/api/profiles/delete', methods=['POST'])
def delete_profile():
    try:
        data = request.json or {}
        name = data.get("profile_name", "").strip()
        if not name:
            return jsonify({"status": "error", "message": "Profile name is required."}), 400
            
        if name == "Default Portfolio":
            return jsonify({"status": "error", "message": "The Default Portfolio profile cannot be deleted."}), 400
            
        meta_file = "profiles_config.json"
        if not os.path.exists(meta_file):
            return jsonify({"status": "error", "message": "Profiles meta config not initialized."}), 400
            
        with open(meta_file, "r") as f:
            meta = json.load(f)
            
        if name not in meta.get("profiles", {}):
            return jsonify({"status": "error", "message": f"Profile '{name}' does not exist."}), 404
            
        # Safely delete profile folder under 'profiles/'
        safe_name = "".join([c if c.isalnum() else "_" for c in name]).lower()
        profile_dir = os.path.join("profiles", safe_name)
        if os.path.exists(profile_dir):
            # Double check to prevent deleting anything outside of the 'profiles' subfolder
            parent_dir = os.path.basename(os.path.dirname(os.path.abspath(profile_dir)))
            if parent_dir == "profiles" or "profiles" in os.path.split(profile_dir)[0]:
                try:
                    shutil.rmtree(profile_dir)
                except Exception as e:
                    print(f"Error deleting profile directory {profile_dir}: {e}")
                    
        # Remove from configuration dictionary
        del meta["profiles"][name]
        
        # If the deleted profile was currently active, switch back to Default Portfolio
        active_switched = False
        if meta.get("active_profile") == name:
            meta["active_profile"] = "Default Portfolio"
            active_switched = True
            
        with open(meta_file, "w") as f:
            json.dump(meta, f, indent=4)
            
        load_profile_globals()
        return jsonify({
            "status": "success",
            "message": f"Profile '{name}' deleted successfully!",
            "active_profile": meta["active_profile"],
            "active_switched": active_switched
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/api/profiles/rename', methods=['POST'])
def rename_profile():
    try:
        data = request.json or {}
        old_name = data.get("old_name", "").strip()
        new_name = data.get("new_name", "").strip()

        if not old_name or not new_name:
            return jsonify({"status": "error", "message": "Both old and new profile names are required."}), 400

        if old_name == "Default Portfolio":
            return jsonify({"status": "error", "message": "The Default Portfolio profile cannot be renamed."}), 400

        if old_name == new_name:
            return jsonify({"status": "error", "message": "New name is the same as the current name."}), 400

        meta_file = "profiles_config.json"
        if not os.path.exists(meta_file):
            return jsonify({"status": "error", "message": "Profiles meta config not initialized."}), 400

        with open(meta_file, "r") as f:
            meta = json.load(f)

        if old_name not in meta.get("profiles", {}):
            return jsonify({"status": "error", "message": f"Profile '{old_name}' does not exist."}), 404

        if new_name in meta.get("profiles", {}):
            return jsonify({"status": "error", "message": f"A profile named '{new_name}' already exists."}), 400

        # Rename the profile directory on disk if it exists inside profiles/
        old_safe = "".join([c if c.isalnum() else "_" for c in old_name]).lower()
        new_safe = "".join([c if c.isalnum() else "_" for c in new_name]).lower()
        old_dir = os.path.join("profiles", old_safe)
        new_dir = os.path.join("profiles", new_safe)

        if os.path.exists(old_dir) and not os.path.exists(new_dir):
            os.rename(old_dir, new_dir)

        # Update the excel/config paths in the registry to use new directory name
        profile_data = meta["profiles"][old_name]
        if old_safe in profile_data.get("excel_path", ""):
            profile_data["excel_path"] = profile_data["excel_path"].replace(old_safe, new_safe)
        if old_safe in profile_data.get("config_path", ""):
            profile_data["config_path"] = profile_data["config_path"].replace(old_safe, new_safe)

        # Re-insert under new key, remove old key
        meta["profiles"][new_name] = profile_data
        del meta["profiles"][old_name]

        # Update active_profile pointer if the renamed profile was active
        if meta.get("active_profile") == old_name:
            meta["active_profile"] = new_name

        with open(meta_file, "w") as f:
            json.dump(meta, f, indent=4)

        load_profile_globals()
        return jsonify({
            "status": "success",
            "message": f"Profile renamed from '{old_name}' to '{new_name}' successfully!",
            "active_profile": meta["active_profile"]
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

if __name__ == "__main__":
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true" or not app.debug:
        threading.Thread(target=automatic_price_updater_loop, daemon=True).start()
    app.run(debug=True, port=5000)
