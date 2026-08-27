import { useEffect, useMemo, useState } from "react";
import { useAuth } from "./state/AuthContext";
import { useData } from "./state/DataContext";
import {
  filterLoads, subscribeLoads, withLocalGrades, EMPTY_FILTERS, type LoadFilters,
} from "./lib/loads";
import type { Load } from "./lib/types";
import { Header, type Tab } from "./components/Header";
import { SignIn } from "./components/SignIn";
import { Spinner, ErrorNote } from "./components/ui";
import { ToastProvider } from "./components/Toast";
import { LoadsScreen } from "./screens/LoadsScreen";
import { ScorecardsScreen } from "./screens/ScorecardsScreen";
import { AuditScreen } from "./screens/AuditScreen";
import { DriversScreen } from "./screens/DriversScreen";
import { AdminScreen } from "./screens/AdminScreen";

export default function App() {
  const { fbUser, profile, loading, error: authError } = useAuth();
  const data = useData();
  const [tab, setTab] = useState<Tab>("loads");
  const [rawLoads, setRawLoads] = useState<Load[] | null>(null);
  const [loadsError, setLoadsError] = useState<string | null>(null);
  const [filters, setFilters] = useState<LoadFilters>(EMPTY_FILTERS);

  useEffect(() => {
    if (!fbUser) { setRawLoads(null); return; }
    return subscribeLoads(setRawLoads, setLoadsError);
  }, [fbUser]);

  // Local grading gives instant feedback; the Cloud Function result is canonical and
  // arrives through the same subscription.
  const loads = useMemo(
    () => withLocalGrades(rawLoads ?? [], data.customersById, data.fleet),
    [rawLoads, data.customersById, data.fleet],
  );
  const reasonCategoryByCode = useMemo(
    () => Object.fromEntries(data.reasons.map((r) => [r.id!, r.category as string])),
    [data.reasons],
  );
  const filtered = useMemo(
    () => filterLoads(loads, filters, data.customersById, data.fleet.timeZone, reasonCategoryByCode),
    [loads, filters, data.customersById, data.fleet.timeZone, reasonCategoryByCode],
  );

  if (loading) {
    return <div className="min-h-screen grid place-items-center"><Spinner label="Signing in…" /></div>;
  }
  if (!fbUser || !profile) return <SignIn />;

  return (
    <ToastProvider>
      <div className="min-h-screen flex flex-col">
        <Header tab={tab} onTab={setTab} />
        <main className="flex-1 w-full max-w-[1600px] mx-auto px-3 sm:px-5 py-4">
          {authError && <ErrorNote message={authError} />}
          {loadsError && <ErrorNote message={`Loads failed to load: ${loadsError}`} />}
          {data.error && <ErrorNote message={`Reference data failed: ${data.error}`} />}
          {!data.ready || rawLoads === null ? (
            <Spinner label="Loading data…" />
          ) : tab === "loads" ? (
            <LoadsScreen loads={loads} filtered={filtered} filters={filters} onFilters={setFilters} />
          ) : tab === "scorecards" ? (
            <ScorecardsScreen loads={loads} filtered={filtered} filters={filters} onFilters={setFilters} />
          ) : tab === "audit" ? (
            <AuditScreen loads={loads} />
          ) : tab === "drivers" ? (
            <DriversScreen loads={loads} />
          ) : (
            <AdminScreen />
          )}
        </main>
      </div>
    </ToastProvider>
  );
}
