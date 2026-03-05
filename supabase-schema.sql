-- ============================================================
-- MasterInvoice - Supabase Schema
-- Run this in your Supabase SQL Editor
-- ============================================================

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ============================================================
-- COMPANIES TABLE (one per user account)
-- ============================================================
create table if not exists companies (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade unique not null,
  name text not null,
  phone text,
  address text,
  city text,
  state text,
  zip text,
  email text,
  website text,
  logo_url text,
  industry text default 'general',
  license_number text,
  tax_id text,
  default_tax_rate numeric(5,2) default 0,
  default_payment_terms text default 'Net 30',
  currency text default 'USD',
  -- Claim/Complaint Policies
  show_policies boolean default true,
  policy_text text default 'POLITICAS DE RECLAMACION:
1. Toda reclamacion debe presentarse por escrito dentro de los 30 dias siguientes a la fecha de la factura o finalizacion del trabajo.
2. El trabajo realizado tiene garantia de mano de obra por 1 ano desde la fecha de finalizacion.
3. Los materiales estan cubiertos bajo la garantia del fabricante. No incluye danos por mal uso, desastres naturales o modificaciones por terceros.
4. La garantia queda anulada si el trabajo es modificado por personas no autorizadas sin previo consentimiento por escrito.
5. Los pagos deben realizarse segun los terminos acordados. Cuentas con mas de 30 dias de mora generan un cargo del 1.5% mensual.
6. Disputas no resueltas seran sometidas a mediacion antes de cualquier accion legal.
7. Este contratista no se responsabiliza por danos preexistentes no reportados antes del inicio del trabajo.
Para reclamaciones contacte: info@suempresa.com o llame a nuestro numero de atencion al cliente.',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- CLIENTS TABLE
-- ============================================================
create table if not exists clients (
  id uuid default gen_random_uuid() primary key,
  company_id uuid references companies(id) on delete cascade not null,
  name text not null,
  email text,
  phone text,
  address text,
  city text,
  state text,
  zip text,
  notes text,
  created_at timestamptz default now()
);

-- ============================================================
-- INVOICES TABLE (invoices + quotes)
-- ============================================================
create table if not exists invoices (
  id uuid default gen_random_uuid() primary key,
  company_id uuid references companies(id) on delete cascade not null,
  client_id uuid references clients(id) on delete set null,
  type text not null default 'invoice',    -- 'invoice' | 'quote'
  number text not null,
  status text not null default 'draft',    -- invoice: 'draft'|'sent'|'paid'|'cancelled'
                                           -- quote:   'draft'|'sent'|'accepted'|'rejected'
  issue_date date not null default current_date,
  due_date date,
  valid_until date,
  subtotal numeric(12,2) default 0,
  tax_rate numeric(5,2) default 0,
  tax_amount numeric(12,2) default 0,
  discount numeric(12,2) default 0,
  total numeric(12,2) default 0,
  notes text,
  terms text,
  include_policies boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- INVOICE ITEMS TABLE
-- ============================================================
create table if not exists invoice_items (
  id uuid default gen_random_uuid() primary key,
  invoice_id uuid references invoices(id) on delete cascade not null,
  description text not null,
  quantity numeric(10,2) not null default 1,
  unit_price numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  sort_order int default 0
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table companies enable row level security;
alter table clients enable row level security;
alter table invoices enable row level security;
alter table invoice_items enable row level security;

-- Companies: each user manages their own
create policy "Users manage own company"
  on companies for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Clients: only from your company
create policy "Users manage own clients"
  on clients for all
  using (company_id in (select id from companies where user_id = auth.uid()))
  with check (company_id in (select id from companies where user_id = auth.uid()));

-- Invoices: only from your company
create policy "Users manage own invoices"
  on invoices for all
  using (company_id in (select id from companies where user_id = auth.uid()))
  with check (company_id in (select id from companies where user_id = auth.uid()));

-- Invoice items: through invoices
create policy "Users manage own invoice items"
  on invoice_items for all
  using (
    invoice_id in (
      select i.id from invoices i
      join companies c on c.id = i.company_id
      where c.user_id = auth.uid()
    )
  )
  with check (
    invoice_id in (
      select i.id from invoices i
      join companies c on c.id = i.company_id
      where c.user_id = auth.uid()
    )
  );

-- ============================================================
-- AUTO-NUMBER FUNCTION
-- ============================================================
create or replace function get_next_invoice_number(p_company_id uuid, p_type text)
returns text
language plpgsql security definer
as $$
declare
  v_count int;
  v_prefix text;
begin
  select count(*) + 1 into v_count
  from invoices
  where company_id = p_company_id and type = p_type;

  if p_type = 'invoice' then
    v_prefix := 'INV-';
  else
    v_prefix := 'QT-';
  end if;

  return v_prefix || lpad(v_count::text, 4, '0');
end;
$$;

-- ============================================================
-- UPDATED_AT TRIGGER
-- ============================================================
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger companies_updated_at before update on companies
  for each row execute function update_updated_at();

create trigger invoices_updated_at before update on invoices
  for each row execute function update_updated_at();

-- ============================================================
-- STORAGE BUCKET for logos (optional)
-- ============================================================
-- Run in Storage section of Supabase dashboard:
-- Create bucket named "logos" with public access
-- insert into storage.buckets (id, name, public) values ('logos', 'logos', true);
