-- ============================================================
-- MasterInvoice - Migration v2
-- Run this in Supabase SQL Editor AFTER the original schema
-- Adds: PO number, internal notes, multiple taxes, expenses
-- ============================================================

-- Add new columns to invoices table
alter table invoices
  add column if not exists po_number text,
  add column if not exists internal_notes text,
  add column if not exists tax_label text default 'Tax',
  add column if not exists tax2_rate numeric(5,2) default 0,
  add column if not exists tax2_label text default 'Tax 2',
  add column if not exists tax2_amount numeric(12,2) default 0;

-- Add default_tax_label to companies
alter table companies
  add column if not exists default_tax_label text default 'Tax';

-- ============================================================
-- EXPENSES TABLE
-- ============================================================
create table if not exists expenses (
  id uuid default gen_random_uuid() primary key,
  company_id uuid references companies(id) on delete cascade not null,
  date date not null default current_date,
  description text not null,
  category text default 'other',
  amount numeric(12,2) not null default 0,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- RLS for expenses
alter table expenses enable row level security;

create policy "Users manage own expenses"
  on expenses for all
  using (company_id in (select id from companies where user_id = auth.uid()))
  with check (company_id in (select id from companies where user_id = auth.uid()));

-- Updated_at trigger for expenses
create trigger expenses_updated_at before update on expenses
  for each row execute function update_updated_at();

-- Add default_discount to clients
ALTER TABLE clients ADD COLUMN IF NOT EXISTS default_discount numeric DEFAULT 0;
