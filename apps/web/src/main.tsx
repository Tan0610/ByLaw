import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { USE_MOCKS } from "./lib/config";
import { WalletProvider } from "./lib/wallet";
import "./styles.css";

async function boot() {
  if (USE_MOCKS) {
    const { worker } = await import("./mocks/browser");
    await worker.start({ onUnhandledRequest: "bypass", quiet: true });
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 2000, refetchOnWindowFocus: false } } });
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={qc}>
        <WalletProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </WalletProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
void boot();
