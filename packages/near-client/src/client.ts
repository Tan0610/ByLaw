import type { Agent, ByLawParams, Job, JobListOpts, JobState, Seat, SpendRequest, Stats } from './types.ts';

/**
 * Typed contract client. One instance == one signer (accountId), or null for read-only.
 * Implemented by NearContractClient (real) and FakeContract.as(account) (in-memory).
 * Amounts/ids are decimal strings. Contract panics surface as thrown errors (ContractError in the fake).
 */
export interface ContractClient {
  readonly accountId: string | null;
  // chain context
  nowNs(): Promise<bigint>;
  blockHeight(): Promise<number>;
  // views (CONTRACT_SPEC 4.12)
  getByLaw(): Promise<ByLawParams>;
  getGuardians(): Promise<string[]>;
  getAgent(tokenId: string): Promise<Agent | null>;
  listAgents(): Promise<Agent[]>;
  getJob(id: string): Promise<Job | null>;
  listJobs(opts?: JobListOpts): Promise<Job[]>;
  getSpend(id: string): Promise<SpendRequest | null>;
  listSpends(): Promise<SpendRequest[]>;
  listSeats(): Promise<Seat[]>;
  claimableOf(account: string): Promise<string>;
  budgetOf(tokenId: string): Promise<string>;
  seatPending(tokenId: string): Promise<string>;
  getStats(): Promise<Stats>;
  // change calls
  /** Customer: ft_transfer_call(post_job). Returns the new job id, or null if the price band refunded it. */
  postJob(target: string, amount: string): Promise<string | null>;
  acceptJob(jobId: string): Promise<void>;
  awardJob(jobId: string): Promise<void>;
  placeBid(jobId: string, price: string): Promise<void>;
  submitWork(jobId: string, deliverableHash: string, uri: string, attestation?: string | null): Promise<void>;
  reviewWork(jobId: string, approve: boolean, reasonHash: string): Promise<void>;
  /** Never panics on policy failures; returns the spend id (check getSpend for Rejected). */
  requestSpend(vendor: string, amount: string, jobId: string | null, memo: string): Promise<string>;
  expireJob(jobId: string): Promise<void>;
  claim(): Promise<string>;
  checkpointSeat(tokenId: string): Promise<void>;
  freezeAgent(tokenId: string, reason: string): Promise<void>;
}

/** Paginate list_jobs fully. */
export async function listAllJobs(c: ContractClient, state?: JobState): Promise<Job[]> {
  const out: Job[] = [];
  const page = 50;
  for (let from = 0; ; from += page) {
    const batch = await c.listJobs({ from, limit: page, state });
    out.push(...batch);
    if (batch.length < page) break;
  }
  return out;
}
