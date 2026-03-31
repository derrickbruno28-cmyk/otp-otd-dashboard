create table if not exists shipments (
  id bigserial primary key,
  source_key text unique,
  import_batch_id bigint,
  ls_num text,
  load_id text,
  trip_num text,
  lane_miles numeric,
  truck_num text,
  primary_driver text,
  secondary_driver text,
  run_type text,
  load_type text,
  pu_appt text,
  pu_actual text,
  otp_status text,
  otp_fail_reason text,
  otp_notes text,
  del1_appt text,
  del1_actual text,
  del2_appt text,
  del2_actual text,
  otd_status text,
  otd_fail_reason text,
  otd_notes text,
  week_num integer,
  month text,
  load_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists shipments_month_idx on shipments (month);
create index if not exists shipments_week_num_idx on shipments (week_num);
create index if not exists shipments_ls_num_idx on shipments (ls_num);
create index if not exists shipments_import_batch_idx on shipments (import_batch_id);

create table if not exists import_batches (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  row_count integer not null default 0,
  rolled_back_at timestamptz
);

create table if not exists import_batch_items (
  id bigserial primary key,
  batch_id bigint not null references import_batches(id) on delete cascade,
  shipment_id bigint,
  action text not null,
  previous_data jsonb,
  created_at timestamptz not null default now()
);

alter table shipments add column if not exists import_batch_id bigint;
create index if not exists import_batch_items_batch_idx on import_batch_items (batch_id);
