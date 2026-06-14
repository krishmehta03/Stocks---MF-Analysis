import openpyxl
import requests
import time

def get_yahoo_finance_price(ticker, exchange):
    # Yahoo Finance format for Indian markets: TICKER.NS (NSE) or TICKER.BO (BSE)
    ex = ".BO" if "BSE" in str(exchange).upper() else ".NS"
    symbol = f"{ticker}{ex}"
    
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    
    try:
        response = requests.get(url, headers=headers)
        if response.status_code == 200:
            data = response.json()
            # Parse the JSON response to get the regularMarketPrice
            price = data['chart']['result'][0]['meta']['regularMarketPrice']
            return round(price, 2)
    except Exception:
        return None
    return None

def fetch_live_prices():
    file_name = "Stocks & MF Analysis_V3.xlsx"
    print(f"Loading {file_name}...")
    
    try:
        wb = openpyxl.load_workbook(file_name)
    except FileNotFoundError:
        print(f"Error: {file_name} not found. Please ensure it exists in this folder.")
        return

    if "📥 Stock Data Input" not in wb.sheetnames:
        print("Error: Could not find '📥 Stock Data Input' sheet.")
        return
        
    ws_stock = wb["📥 Stock Data Input"]
    print("Fetching live prices from Yahoo Finance API...\n")
    
    updated_count = 0
    
    # Iterate through rows starting from row 4 (where data begins)
    for row in range(4, 100):
        scrip = ws_stock[f'A{row}'].value
        exchange = ws_stock[f'B{row}'].value
        
        # Stop if we hit an empty row
        if not scrip:
            continue
            
        ticker = str(scrip).strip()
        
        try:
            print(f"Fetching {ticker}...")
            current_price = get_yahoo_finance_price(ticker, exchange)
            
            if current_price is not None:
                ws_stock[f'G{row}'].value = current_price
                print(f"  -> Updated price: ₹{current_price}")
                updated_count += 1
            else:
                print(f"  -> Failed to find valid price for {ticker}")
                
        except Exception as e:
            print(f"  -> Error fetching {ticker}: {e}")
            
        # Small delay to prevent rate limiting
        time.sleep(0.3)

    print(f"\nSuccessfully updated {updated_count} stock prices.")
    print("Saving Excel file...")
    wb.save(file_name)
    print("Done! Open your V3 Excel file to see the live prices.")

if __name__ == "__main__":
    fetch_live_prices()
