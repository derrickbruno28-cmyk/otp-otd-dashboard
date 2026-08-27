import {
  createContext, useContext, useEffect, useMemo, useState, type ReactNode,
} from "react";
import { collection, doc, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "../lib/firebase";
import { DEFAULT_FLEET } from "../lib/scoring";
import type { AppUser, Customer, Driver, FailReason, FleetSettings } from "../lib/types";

export interface DataState {
  customers: Customer[];
  customersById: Record<string, Customer>;
  reasons: FailReason[];
  reasonsById: Record<string, FailReason>;
  drivers: Driver[];
  driversById: Record<string, Driver>;
  users: AppUser[];
  fleet: FleetSettings;
  ready: boolean;
  error: string | null;
}

const DataContext = createContext<DataState | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [reasons, setReasons] = useState<FailReason[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [fleet, setFleet] = useState<FleetSettings>(DEFAULT_FLEET);
  const [readyCount, setReadyCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const bump = () => setReadyCount((n) => n + 1);
    const fail = (e: unknown) => setError(String((e as Error)?.message ?? e));
    const subs = [
      onSnapshot(query(collection(db, "customers"), orderBy("sortOrder")), (s) => {
        setCustomers(s.docs.map((d) => ({ id: d.id, ...(d.data() as Customer) })));
        bump();
      }, fail),
      onSnapshot(query(collection(db, "failReasons"), orderBy("sortOrder")), (s) => {
        setReasons(s.docs.map((d) => ({ id: d.id, ...(d.data() as FailReason) })));
        bump();
      }, fail),
      onSnapshot(query(collection(db, "drivers"), orderBy("name")), (s) => {
        setDrivers(s.docs.map((d) => ({ id: d.id, ...(d.data() as Driver) })));
        bump();
      }, fail),
      onSnapshot(collection(db, "users"), (s) => {
        setUsers(s.docs.map((d) => ({ id: d.id, ...(d.data() as AppUser) })));
        bump();
      }, fail),
      onSnapshot(doc(db, "settings", "fleet"), (s) => {
        setFleet(s.exists() ? { ...DEFAULT_FLEET, ...(s.data() as FleetSettings) } : DEFAULT_FLEET);
        bump();
      }, fail),
    ];
    return () => subs.forEach((u) => u());
  }, []);

  const value = useMemo<DataState>(() => ({
    customers,
    customersById: Object.fromEntries(customers.map((c) => [c.id!, c])),
    reasons,
    reasonsById: Object.fromEntries(reasons.map((r) => [r.id!, r])),
    drivers,
    driversById: Object.fromEntries(drivers.map((d) => [d.id!, d])),
    users,
    fleet,
    ready: readyCount >= 5,
    error,
  }), [customers, reasons, drivers, users, fleet, readyCount, error]);

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataState {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error("useData outside DataProvider");
  return ctx;
}
