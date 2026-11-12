import { FakeContract } from './fake.ts';

export const DEMO_ACCOUNTS = {
  sales: 'sales.charter.fake.testnet',
  analyst1: 'analyst1.charter.fake.testnet',
  analyst2: 'analyst2.charter.fake.testnet',
  reviewer: 'reviewer.charter.fake.testnet',
  treasurer: 'treasurer.charter.fake.testnet',
  customer: 'customer.fake.testnet',
  vendor: 'rpc-vendor.fake.testnet',
  owners: { sales: 'alice.fake.testnet', analyst1: 'bob.fake.testnet', analyst2: 'carol.fake.testnet', reviewer: 'dave.fake.testnet', treasurer: 'alice.fake.testnet' },
};

/**
 * Registers the five demo agents (reviewer has a different owner than the analysts), allowlists one
 * vendor, funds the treasury and mints seats. Used by the indexer in INDEXER_MODE=fake, the demo
 * stack and tests.
 */
export function seedDemoWorld(fake: FakeContract): void {
  const a = DEMO_ACCOUNTS;
  fake.registerAgent('Sales', 'sales', a.owners.sales, a.sales);
  fake.registerAgent('Analyst', 'analyst1', a.owners.analyst1, a.analyst1);
  fake.registerAgent('Analyst', 'analyst2', a.owners.analyst2, a.analyst2);
  fake.registerAgent('Reviewer', 'reviewer', a.owners.reviewer, a.reviewer);
  fake.registerAgent('Treasurer', 'treasurer', a.owners.treasurer, a.treasurer);
  fake.setVendor(a.vendor, true);
  fake.fundTreasury('100000000');
  fake.mintSeat('alice.fake.testnet', 60);
  fake.mintSeat('erin.fake.testnet', 40);
}
