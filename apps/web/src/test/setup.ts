import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { handlers } from "../mocks/handlers";
import { mockStore } from "../mocks/store";

export const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  mockStore.reset();
  mockStore.autoAdvance = false; // tests step the mock agents by hand
});
afterEach(() => { cleanup(); server.resetHandlers(); });
afterAll(() => server.close());
