create table if not exists shipments (
  id bigserial primary key,
  source_key text unique,
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
