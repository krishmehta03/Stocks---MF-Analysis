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
            'current_price': float(data.get('Current Price', 0)) if data.get('Current Price') is not None else None
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
    """Bulk update stock prices in Supabase"""
    try:
        supabase = get_supabase_admin()
        for update in price_updates:
            scrip = update.get('scrip_name')
            price = update.get('current_price')
            if scrip and price is not None:
                supabase.table('stock_holdings')\
                    .update({
                        'current_price': float(price), 
                        'last_price_update': datetime.now(timezone.utc).isoformat()
                    }) \
                    .eq('user_id', user_id)\
                    .eq('scrip_name', scrip)\
                    .execute()
        return True
    except Exception as e:
        print(f"Error bulk updating prices: {e}")
        return False
