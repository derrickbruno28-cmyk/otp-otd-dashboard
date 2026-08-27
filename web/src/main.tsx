import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./theme.css";
import { AuthProvider } from "./state/AuthContext";
import { DataProvider } from "./state/DataContext";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <DataProvider>
        <App />
      </DataProvider>
    </AuthProvider>
  </StrictMode>,
);
