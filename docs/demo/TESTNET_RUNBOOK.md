# Testnet runbook (human-run)

Every step that creates an account, deploys, or signs is done by a human. The scripts only print commands (near-cli-rs syntax) and JSON. Record each transaction link in `docs/TRACKS.md` as you go.

Tools: `near` (near-cli-rs), Rust toolchain for the contract (see `contracts/charter/deploy.md` when Lane A publishes it), Node 24+.

## 0. Accounts and faucet (S1)
1. Create testnet accounts in a wallet or with `near account create-account sponsor-by-faucet-service <name>.testnet ...`: owner/deployer, three council members, one guardian, a customer, and analyst/reviewer owners (the reviewer owner must differ from both analyst owners).
2. Fund the DAO creator with about 10 NEAR (the Sputnik factory takes about 6 NEAR). Note the faucet amount you received in `docs/SPIKES.md` (S1).
3. Put the ids into `.env` (copy `.env.example`): `CHARTER_CONTRACT_ID`, `TOKEN_ID`, `DAO_ID`, `COUNCIL`, `PROPOSER`, `GUARDIANS`, `VENDORS`, `OWNERS`, `SEATS`.

## 1. DAO
```
npm run bootstrap -w scripts
```
Run step 2 of the output (create the DAO). Check with the printed `get_policy` view that the council is right. Record: DAO creation cost, proposal bond from `get_policy`, who may propose (S1).

## 2. Deploy token and contract with owner = DAO
Follow `contracts/charter/deploy.md`. `new` takes `{"owner":"<DAO_ID>","token":"<TOKEN_ID>","params":{...}}` (`contracts/charter/ABI.md`). Then:
```
near contract call-function as-read-only $CHARTER_CONTRACT_ID get_charter json-args '{}' network-config testnet now
```

## 3. First FunctionCall proposal (S2)
Run the "Set guardians" proposal from step 1's output, then vote with two council members. Record in `docs/SPIKES.md` (S2): the gas you attached to `act_proposal` (the script uses 300 Tgas because the inner call takes 150 Tgas), the bond, and whether the call executed (check `get_guardians`).

## 4. Agents
```
npm run register-agents -w scripts
```
This writes `secrets/agent-keys.json` and `secrets/agents.env` (git-ignored) and prints five `register_agent` proposals with 0.5 NEAR each. Send about 3 NEAR to the DAO first. Approve all five. Copy `secrets/agents.env` into `.env`.

## 5. Seats, vendors, treasury, customer tokens
```
npm run mint-seats -w scripts
npm run fund-treasury -w scripts
```

## 6. Prove role-scoped keys (security track)
```
near account list-keys analyst1.$CHARTER_CONTRACT_ID network-config testnet now
```
Expect exactly one key: function-call, receiver = the Charter contract, methods `place_bid, submit_work`. Then try a method outside the role with that key (for example `request_spend`) using `sign-with-plaintext-private-key` and the key from `secrets/agents.env`: it must fail with a protocol error (`MethodNameMismatch`) before the contract runs. Paste both outputs into `docs/SPIKES.md`.

## 7. Run the stack
```
INDEXER_MODE=near npm run dev -w services/indexer
AGENTS_MODE=near npm run dev -w services/agents
npm run dev -w apps/web     # with VITE_CONTRACT_ID, VITE_DAO_ID, VITE_TOKEN_ID in .env
```
In the browser: connect the customer wallet, Jobs → "Pay and post job". Watch the job settle. Then Seats → claim as an owner.

## 8. Attack, freeze, amendment
- `ATTACK_CONFIRM=yes AGENTS_MODE=near npm run attack -w services/agents` (Lane B; signs with the treasurer key). Treasury page shows the rejected attempts.
- As the guardian, Agents → "Freeze agent".
- DAO page → "Amend the charter" template; fill in the full `CharterParams` with the new text and its `text_hash` (`0x` + sha256); vote twice. Charter page shows the diff.

## 9. Verify
```
CHARTER_CONTRACT_ID=... TOKEN_ID=... npm run e2e -w scripts -- --check
```
Read-only: prints charter, agents, jobs, spends and checks the solvency invariant. Update `docs/TRACKS.md` statuses with explorer links.
