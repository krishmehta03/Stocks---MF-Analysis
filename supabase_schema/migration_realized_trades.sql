-- Migration script: Create realized_trades table and RLS policies

CREATE TABLE IF NOT EXISTS realized_trades (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  holding_type TEXT NOT NULL CHECK (holding_type IN ('stock', 'mf')),
  scrip_name TEXT NOT NULL,
  sold_qty DECIMAL(12,4) NOT NULL,
  sell_price DECIMAL(10,4) NOT NULL,
  sell_date DATE NOT NULL,
  buy_price DECIMAL(10,4) NOT NULL,
  buy_date DATE,
  realized_pnl DECIMAL(12,2) NOT NULL,
  sector TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE realized_trades ENABLE ROW LEVEL SECURITY;

-- Policies for user isolation
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'realized_trades' AND policyname = 'Users view own realized trades'
  ) THEN
    CREATE POLICY "Users view own realized trades" ON realized_trades FOR SELECT USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'realized_trades' AND policyname = 'Users insert own realized trades'
  ) THEN
    CREATE POLICY "Users insert own realized trades" ON realized_trades FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'realized_trades' AND policyname = 'Users update own realized trades'
  ) THEN
    CREATE POLICY "Users update own realized trades" ON realized_trades FOR UPDATE USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'realized_trades' AND policyname = 'Users delete own realized trades'
  ) THEN
    CREATE POLICY "Users delete own realized trades" ON realized_trades FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;
