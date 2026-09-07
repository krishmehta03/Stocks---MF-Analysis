from datetime import datetime, timezone
from lib.supabase import get_supabase_admin

def get_user_stock_holdings(user_id: str):
    """Get all stock holdings for a user"""
    try:
        supabase = get_supabase_admin()
        result = supabase.table('stock_holdings')\
            .select('*')\
            .eq('user_id', user_id)\
            .execute()
        return result.data or []
    except Exception as e:
        print(f"Error fetching stocks: {e}")
        return []

def get_user_mf_holdings(user_id: str):
    """Get all MF holdings for a user"""
    try:
        supabase = get_supabase_admin()
        result = supabase.table('mf_holdings')\
            .select('*')\
            .eq('user_id', user_id)\
            .execute()
        return result.data or []
    except Exception as e:
        print(f"Error fetching MFs: {e}")
        return []

def add_stock_holding(user_id: str, data: dict):
    """Add a stock holding to Supabase"""
    try:
        supabase = get_supabase_admin()
        payload = {
            'user_id': user_id,
            'scrip_name': data.get('Scrip Name'),
            'exchange': data.get('Exchange', 'NSE'),
            'sector': data.get('Sector'),
            'industry': data.get('Industry'),
            'quantity': int(data.get('Qty', 0)),
            'buy_price': float(data.get('Buy Price', 0)),
            'buy_date': data.get('Buy Date') or None,
            'current_price': float(data.get('Current Price')) if data.get('Current Price') else None
        }
        result = supabase.table('stock_holdings').insert(payload).execute()
        return result.data[0] if result.data else None
    except Exception as e:
        print(f"Error adding stock holding: {e}")
        return None

def update_stock_holding(user_id: str, holding_id: str, data: dict):
    """Update a stock holding in Supabase"""
    try:
        supabase = get_supabase_admin()
        payload = {}
        if 'Qty' in data:
            payload['quantity'] = int(data['Qty'])
        if 'Buy Price' in data:
            payload['buy_price'] = float(data['Buy Price'])
        if 'Buy Date' in data:
            payload['buy_date'] = data['Buy Date'] or None
        if 'Sector' in data:
            payload['sector'] = data['Sector']
        if 'Industry' in data:
            payload['industry'] = data['Industry']
        if 'Current Price' in data:
            payload['current_price'] = float(data['Current Price']) if data['Current Price'] is not None else None
        
        result = supabase.table('stock_holdings')\
            .update(payload)\
            .eq('id', holding_id)\
            .eq('user_id', user_id)\
            .execute()
        return result.data[0] if result.data else None
    except Exception as e:
        print(f"Error updating stock holding: {e}")
        return None

def delete_stock_holding(user_id: str, holding_id: str):
    """Delete a stock holding from Supabase"""
    try:
        supabase = get_supabase_admin()
        result = supabase.table('stock_holdings')\
            .delete()\
            .eq('id', holding_id)\
            .eq('user_id', user_id)\
            .execute()
        return True
    except Exception as e:
        print(f"Error deleting stock holding: {e}")
        return False

def add_mf_holding(user_id: str, data: dict):
    """Add a MF holding to Supabase"""
    try:
        supabase = get_supabase_admin()
        payload = {
            'user_id': user_id,
            'fund_name': data.get('Fund Name'),
            'amc': data.get('AMC'),
            'category': data.get('Category'),
            'sub_category': data.get('Sub-Category'),
            'units_held': float(data.get('Units Held', 0)),
            'buy_nav': float(data.get('Buy NAV', 0)),
            'current_nav': float(data.get('Current NAV', 0)) if data.get('Current NAV') is not None else None,
            'purchase_date': data.get('Buy Date') or None
        }
        result = supabase.table('mf_holdings').insert(payload).execute()
        return result.data[0] if result.data else None
    except Exception as e:
        print(f"Error adding MF holding: {e}")
        return None

def update_mf_holding(user_id: str, holding_id: str, data: dict):
    """Update a MF holding in Supabase"""
    try:
        supabase = get_supabase_admin()
        payload = {}
        if 'Units Held' in data:
            payload['units_held'] = float(data['Units Held'])
        if 'Buy NAV' in data:
            payload['buy_nav'] = float(data['Buy NAV'])
        if 'Buy Date' in data:
            payload['purchase_date'] = data['Buy Date'] or None
        if 'Category' in data:
            payload['category'] = data['Category']
        if 'Sub-Category' in data:
            payload['sub_category'] = data['Sub-Category']
        if 'AMC' in data:
            payload['amc'] = data['AMC']
        if 'Current NAV' in data:
            payload['current_nav'] = float(data['Current NAV']) if data['Current NAV'] is not None else None
            
        result = supabase.table('mf_holdings')\
            .update(payload)\
            .eq('id', holding_id)\
            .eq('user_id', user_id)\
            .execute()
        return result.data[0] if result.data else None
    except Exception as e:
        print(f"Error updating MF holding: {e}")
        return None

def delete_mf_holding(user_id: str, holding_id: str):
    """Delete a MF holding from Supabase"""
    try:
        supabase = get_supabase_admin()
        result = supabase.table('mf_holdings')\
            .delete()\
            .eq('id', holding_id)\
            .eq('user_id', user_id)\
            .execute()
        return True
    except Exception as e:
        print(f"Error deleting MF: {e}")
        return False

def update_stock_prices(user_id: str, price_updates: list):
    """Bulk update stock prices in Supabase.
    Accepts list of dicts with either:
      - {'id': holding_id, 'current_price': price}   ← preferred (matches by row id)
      - {'scrip_name': name, 'current_price': price}  ← legacy fallback
    """
    try:
        supabase = get_supabase_admin()
        now_ts = datetime.now(timezone.utc).isoformat()
        for update in price_updates:
            price = update.get('current_price')
            if price is None:
                continue
            payload = {
                'current_price': float(price),
                'last_price_update': now_ts
            }
            holding_id = update.get('id')
            if holding_id:
                # Preferred: match by unique row id
                supabase.table('stock_holdings')\
                    .update(payload)\
                    .eq('id', holding_id)\
                    .eq('user_id', user_id)\
                    .execute()
            else:
                # Legacy fallback: match by scrip_name
                scrip = update.get('scrip_name')
                if scrip:
                    supabase.table('stock_holdings')\
                        .update(payload)\
                        .eq('user_id', user_id)\
                        .eq('scrip_name', scrip)\
                        .execute()
        return True
    except Exception as e:
        print(f"Error bulk updating prices: {e}")
        return False


def sell_stock_holding(user_id: str, holding_id: str, sold_qty: float, sell_price: float, sell_date: str):
    """Process a stock sale (full or partial) and log to realized_trades."""
    try:
        supabase = get_supabase_admin()
        res = supabase.table('stock_holdings').select('*').eq('id', holding_id).eq('user_id', user_id).execute()
        if not res.data:
            return {"success": False, "error": "Stock holding not found"}
        
        holding = res.data[0]
        curr_qty = float(holding.get('quantity', 0))
        sold_qty = float(sold_qty)
        
        if sold_qty <= 0 or sold_qty > curr_qty:
            return {"success": False, "error": f"Invalid sold quantity ({sold_qty}). Current quantity is {curr_qty}"}
        
        buy_price = float(holding.get('buy_price', 0))
        sell_price = float(sell_price)
        realized_pnl = round((sell_price - buy_price) * sold_qty, 2)
        
        trade_payload = {
            'user_id': user_id,
            'holding_type': 'stock',
            'scrip_name': holding.get('scrip_name'),
            'sold_qty': sold_qty,
            'sell_price': sell_price,
            'sell_date': sell_date,
            'buy_price': buy_price,
            'buy_date': holding.get('buy_date'),
            'realized_pnl': realized_pnl,
            'sector': holding.get('sector')
        }
        
        supabase.table('realized_trades').insert(trade_payload).execute()
        
        if abs(curr_qty - sold_qty) < 1e-4 or sold_qty >= curr_qty:
            deleted = delete_stock_holding(user_id, holding_id)
            if not deleted:
                return {"success": False, "error": "Sale was recorded but failed to remove the original holding. Please contact support before selling this position again."}
        else:
            new_qty = int(curr_qty - sold_qty)
            supabase.table('stock_holdings').update({'quantity': new_qty}).eq('id', holding_id).eq('user_id', user_id).execute()
            
        return {"success": True, "realized_pnl": realized_pnl}
    except Exception as e:
        print(f"Error selling stock holding: {e}")
        return {"success": False, "error": str(e)}


def sell_mf_holding(user_id: str, holding_id: str, sold_units: float, sell_nav: float, sell_date: str):
    """Process a mutual fund sale (full or partial) and log to realized_trades."""
    try:
        supabase = get_supabase_admin()
        res = supabase.table('mf_holdings').select('*').eq('id', holding_id).eq('user_id', user_id).execute()
        if not res.data:
            return {"success": False, "error": "Mutual fund holding not found"}
        
        holding = res.data[0]
        curr_units = float(holding.get('units_held', 0))
        sold_units = float(sold_units)
        
        if sold_units <= 0 or sold_units > curr_units:
            return {"success": False, "error": f"Invalid sold units ({sold_units}). Current units held: {curr_units}"}
        
        buy_nav = float(holding.get('buy_nav', 0))
        sell_nav = float(sell_nav)
        realized_pnl = round((sell_nav - buy_nav) * sold_units, 2)
        
        trade_payload = {
            'user_id': user_id,
            'holding_type': 'mf',
            'scrip_name': holding.get('fund_name'),
            'sold_qty': sold_units,
            'sell_price': sell_nav,
            'sell_date': sell_date,
            'buy_price': buy_nav,
            'buy_date': holding.get('purchase_date'),
            'realized_pnl': realized_pnl,
            'sector': holding.get('category')
        }
        
        supabase.table('realized_trades').insert(trade_payload).execute()
        
        if abs(curr_units - sold_units) < 1e-4 or sold_units >= curr_units:
            deleted = delete_mf_holding(user_id, holding_id)
            if not deleted:
                return {"success": False, "error": "Sale was recorded but failed to remove the original holding. Please contact support before selling this position again."}
        else:
            new_units = round(curr_units - sold_units, 4)
            supabase.table('mf_holdings').update({'units_held': new_units}).eq('id', holding_id).eq('user_id', user_id).execute()
            
        return {"success": True, "realized_pnl": realized_pnl}
    except Exception as e:
        print(f"Error selling MF holding: {e}")
        return {"success": False, "error": str(e)}



def get_user_realized_trades(user_id: str):
    """Fetch all realized trades for a user sorted by sell_date desc."""
    try:
        supabase = get_supabase_admin()
        result = supabase.table('realized_trades')\
            .select('*')\
            .eq('user_id', user_id)\
            .order('sell_date', desc=True)\
            .order('created_at', desc=True)\
            .execute()
        return result.data or []
    except Exception as e:
        print(f"Error fetching realized trades: {e}")
        return []


def delete_realized_trade(user_id: str, trade_id: str):
    """Delete a trade record from realized_trades."""
    try:
        supabase = get_supabase_admin()
        supabase.table('realized_trades')\
            .delete()\
            .eq('id', trade_id)\
            .eq('user_id', user_id)\
            .execute()
        return True
    except Exception as e:
        print(f"Error deleting trade record: {e}")
        return False


