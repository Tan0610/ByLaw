import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import App from "../App";
import { WalletProvider } from "../lib/wallet";

export function renderApp(route: string, account: string | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <WalletProvider initialMockAccount={account}>
        <MemoryRouter initialEntries={[route]}>
          <App />
        </MemoryRouter>
      </WalletProvider>
    </QueryClientProvider>,
  );
}
