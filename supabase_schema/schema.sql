-- Table 1: User profiles
CREATE TABLE profiles (
  id UUID REFERENCES auth.users(id)
     PRIMARY KEY,
  email TEXT NOT NULL,
  full_name TEXT,
  plan TEXT DEFAULT 'free'
     CHECK (plan IN ('free','pro','wealth')),
  plan_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table 2: Stock holdings
CREATE TABLE stock_holdings (
  id UUID DEFAULT gen_random_uuid()
     PRIMARY KEY,
  user_id UUID REFERENCES profiles(id)
     ON DELETE CASCADE NOT NULL,
  scrip_name TEXT NOT NULL,
  exchange TEXT DEFAULT 'NSE',
  sector TEXT,
  industry TEXT,
  quantity INTEGER NOT NULL,
  buy_price DECIMAL(10,2) NOT NULL,
  buy_date DATE,
  current_price DECIMAL(10,2),
  last_price_update TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table 3: Mutual fund holdings
CREATE TABLE mf_holdings (
  id UUID DEFAULT gen_random_uuid()
     PRIMARY KEY,
  user_id UUID REFERENCES profiles(id)
     ON DELETE CASCADE NOT NULL,
  fund_name TEXT NOT NULL,
  amc TEXT,
  category TEXT,
  sub_category TEXT,
  units_held DECIMAL(10,4) NOT NULL,
  buy_nav DECIMAL(10,4) NOT NULL,
  current_nav DECIMAL(10,4),
  purchase_date DATE,
  last_nav_update TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table 4: Transactions
CREATE TABLE transactions (
  id UUID DEFAULT gen_random_uuid()
     PRIMARY KEY,
  user_id UUID REFERENCES profiles(id)
     ON DELETE CASCADE NOT NULL,
  type TEXT NOT NULL
     CHECK (type IN ('buy','sell',
     'dividend','mf_buy','mf_sell')),
  scrip_name TEXT,
  quantity INTEGER,
  price DECIMAL(10,2),
  total_amount DECIMAL(12,2),
  transaction_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table 5: Subscriptions
CREATE TABLE subscriptions (
  id UUID DEFAULT gen_random_uuid()
     PRIMARY KEY,
  user_id UUID REFERENCES profiles(id)
     ON DELETE CASCADE NOT NULL,
  razorpay_subscription_id TEXT,
  razorpay_payment_id TEXT,
  plan TEXT NOT NULL,
  status TEXT DEFAULT 'active'
     CHECK (status IN ('active',
     'cancelled','expired','trial')),
  started_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS on all tables
ALTER TABLE profiles
   ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_holdings
   ENABLE ROW LEVEL SECURITY;
ALTER TABLE mf_holdings
   ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions
   ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions
   ENABLE ROW LEVEL SECURITY;

-- Profiles policies
CREATE POLICY "Users view own profile"
  ON profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users update own profile"
  ON profiles FOR UPDATE
  USING (auth.uid() = id);

-- Stock holdings policies
CREATE POLICY "Users view own stocks"
  ON stock_holdings FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own stocks"
  ON stock_holdings FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own stocks"
  ON stock_holdings FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users delete own stocks"
  ON stock_holdings FOR DELETE
  USING (auth.uid() = user_id);

-- MF holdings policies
CREATE POLICY "Users view own mf"
  ON mf_holdings FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own mf"
  ON mf_holdings FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own mf"
  ON mf_holdings FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users delete own mf"
  ON mf_holdings FOR DELETE
  USING (auth.uid() = user_id);

-- Transactions policies
CREATE POLICY "Users view own transactions"
  ON transactions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own transactions"
  ON transactions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Subscriptions policies
CREATE POLICY "Users view own subscription"
  ON subscriptions FOR SELECT
  USING (auth.uid() = user_id);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION
public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles
    (id, email, full_name)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'full_name'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION
  public.handle_new_user();
