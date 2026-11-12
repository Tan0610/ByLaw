import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { mockStore } from "../mocks/store";
import { renderApp } from "./render";

const CUSTOMER = "customer.demo.testnet";
const COUNCIL_A = "ana.demo.testnet";
const GUARDIAN = "guardian.demo.testnet";

describe("customer flow", () => {
  it("pays via ft_transfer_call, then the mock agents settle the job", async () => {
    const user = userEvent.setup();
    renderApp("/jobs", CUSTOMER);
    await screen.findByText("All jobs");
    const target = screen.getByLabelText(/NEAR contract to analyse/i);
    await user.clear(target);
    await user.type(target, "vault2.demo.testnet");
    await user.click(screen.getByRole("button", { name: /pay and post job/i }));
    await screen.findByText(/paid into escrow/i);
    expect(mockStore.job("3")?.state).toBe("Posted");
    expect(mockStore.job("3")?.price).toBe("100000000");
    await screen.findByText("vault2.demo.testnet");

    for (let i = 0; i < 5; i++) mockStore.advanceJob("3");
    const j = mockStore.job("3")!;
    expect(j.state).toBe("Settled");
    expect(Object.values(j.credits!).reduce((s, v) => s + BigInt(v), 0n)).toBe(BigInt(j.price));
  });

  it("shows the job detail with bids, waterfall and report", async () => {
    renderApp("/jobs/1", CUSTOMER);
    await screen.findByRole("heading", { name: "Job #1" });
    await screen.findByText(/conserved to the unit/i);
    const bids = await screen.findByRole("region", { name: "Bids" });
    expect(within(bids).getAllByRole("row").length).toBe(3);
    expect(within(bids).getByText("Winner")).toBeInTheDocument();
    expect((await screen.findAllByText(/no full-access keys/i)).length).toBeGreaterThan(0);
    expect(screen.getByRole("list", { name: /job timeline/i })).toBeInTheDocument();
  });

  it("rejects a price outside the bylaw band before sending anything", async () => {
    const user = userEvent.setup();
    renderApp("/jobs", CUSTOMER);
    await screen.findByText("All jobs");
    const price = screen.getByLabelText(/price \(tusd\)/i);
    await user.clear(price);
    await user.type(price, "5");
    await user.click(screen.getByRole("button", { name: /pay and post job/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/price band/i);
    expect(mockStore.jobs.length).toBe(2);
  });
});

describe("DAO flow", () => {
  it("council member votes and the proposal executes at threshold", async () => {
    const user = userEvent.setup();
    renderApp("/dao", COUNCIL_A);
    const item = (await screen.findByText(/Approve the 15 tUSD data subscription/)).closest("li")!;
    expect(within(item).getByText("1 approve")).toBeInTheDocument();
    await user.click(await waitFor(() => {
      const b = within(item).getByRole("button", { name: "Approve" });
      expect(b).toBeEnabled();
      return b;
    }));
    await waitFor(() => expect(within(item).getByText("2 approve")).toBeInTheDocument());
    expect(mockStore.proposals.find((p) => p.id === 5)?.status).toBe("Approved");
    expect(mockStore.spends.find((s) => s.id === "3")?.state).toBe("Paid");
  });

  it("creates a bylaw amendment proposal from a template", async () => {
    const user = userEvent.setup();
    renderApp("/dao", COUNCIL_A);
    await screen.findByText("Create a proposal");
    await user.selectOptions(screen.getByLabelText("Template"), screen.getByRole("option", { name: /amend the bylaw/i }));
    await user.type(screen.getByLabelText(/description/i), "Add reputation rule");
    await waitFor(() => expect(screen.getByRole("button", { name: /create proposal/i })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /create proposal/i }));
    await screen.findByText(/proposal created\. council/i);
    const p = mockStore.proposals[0];
    expect(p.description).toBe("Add reputation rule");
    expect(p.status).toBe("InProgress");
  });

  it("does not let a non-member vote", async () => {
    renderApp("/dao", CUSTOMER);
    const item = (await screen.findByText(/Approve the 15 tUSD data subscription/)).closest("li")!;
    expect(within(item).getByRole("button", { name: "Approve" })).toBeDisabled();
  });
});

describe("bylaw page", () => {
  it("shows version history with a diff between versions", async () => {
    renderApp("/", null);
    await screen.findByText(/Text, version 2/);
    const diff = await screen.findByRole("group", { name: /text diff/i });
    expect(within(diff).getByText(/Procurement\. Vendors must be on the DAO allowlist/)).toBeInTheDocument();
    expect(screen.getByText("1 added, 0 removed")).toBeInTheDocument();
  });
});

describe("treasury page", () => {
  it("lists rejected attempts", async () => {
    renderApp("/treasury", null);
    expect(await screen.findByText(/window budget exceeded/)).toBeInTheDocument();
    expect(screen.getByText(/vendor not allowlisted/)).toBeInTheDocument();
  });
});

describe("guardian flow", () => {
  beforeEach(() => { vi.spyOn(window, "confirm").mockReturnValue(true); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("a guardian freezes an agent", async () => {
    const user = userEvent.setup();
    renderApp("/agents", GUARDIAN);
    const name = "Freeze analyst-1.bylaw.demo.testnet";
    await waitFor(async () => expect(await screen.findByRole("button", { name })).toBeEnabled());
    await user.click(screen.getByRole("button", { name }));
    await screen.findByText(/Froze analyst-1/);
    expect(mockStore.agent("2")?.state).toBe("Frozen");
    await waitFor(() => expect(screen.getByText(/Frozen: Frozen by guardian/)).toBeInTheDocument());
  });

  it("a non-guardian cannot freeze", async () => {
    renderApp("/agents", CUSTOMER);
    const btn = await screen.findByRole("button", { name: "Freeze analyst-1.bylaw.demo.testnet" });
    expect(btn).toBeDisabled();
  });
});

describe("seats and claims", () => {
  it("a seat holder credits dividends and claims", async () => {
    const user = userEvent.setup();
    renderApp("/seats", COUNCIL_A);
    await screen.findByText(/Your claimable balance/);
    const credit = await screen.findByRole("button", { name: /credit pending dividends of seat 101/i });
    await user.click(credit);
    await screen.findByText(/pending dividends credited/i);
    expect(mockStore.claimable[COUNCIL_A]).toBe("14500000");
    await waitFor(() => expect(screen.getByRole("button", { name: "Claim tUSD" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Claim tUSD" }));
    await screen.findByText(/claim sent/i);
    expect(mockStore.claimable[COUNCIL_A]).toBe("0");
  });
});
