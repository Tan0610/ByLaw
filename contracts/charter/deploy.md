# Deploying Charter to testnet (human-run)

Every command below signs a transaction and must be run by a human. No keys or secrets belong in
this repo. Replace `YOU` with your testnet account (e.g. `alice.testnet`) and `DAO` with your
Sputnik DAO (e.g. `charter-dao.sputnikv2.testnet`). Commands use `near-cli-rs` (`near`).

## 0. Prerequisites
- Rust stable + `rustup target add wasm32-unknown-unknown`
- `near` CLI (near-cli-rs) logged in as `YOU`
- A Sputnik DAO you control (see `scripts/` from Lane C, or create one at `sputnikv2.testnet`)

## 1. Build the wasm (use cargo-near)
A plain `cargo build --target wasm32-unknown-unknown` with current Rust emits post-MVP wasm
features. We checked the `target_features` section of our local build: `+bulk-memory +sign-ext
+reference-types +multivalue +nontrapping-fptoint`. The NEAR VM may reject these. `-C target-cpu=mvp`
alone does not fix it (the prebuilt std is unchanged), and Rust 1.82+ enables these by default.

**Recommended:** build with the official `cargo-near`, which post-processes the wasm for the NEAR VM:
```bash
cd contracts/charter && cargo near build non-reproducible-wasm --no-abi && cd ../..
cd contracts/mock-ft && cargo near build non-reproducible-wasm --no-abi && cd ../..
find target/near -name "*.wasm"   # exact sub-path under target/near/ depends on the cargo-near version
```
Easiest path (no local install, avoids Windows Application Control issues): push the repo to GitHub;
`.github/workflows/ci.yml` builds both with cargo-near on Linux and uploads them as the `wasm`
artifact. Download it and use those files in the deploy commands below (replace the
`target/wasm32-unknown-unknown/release/...` paths with the downloaded files).

Local plain build (for tests only, may not deploy):
```bash
cargo build --target wasm32-unknown-unknown --release -p charter -p mock-ft
```

## 2. Create sub-accounts
```bash
near account create-account fund-myself charter.YOU.testnet '15 NEAR' autogenerate-new-keypair save-to-keychain sign-as YOU.testnet network-config testnet sign-with-keychain send
near account create-account fund-myself tusd.YOU.testnet '5 NEAR' autogenerate-new-keypair save-to-keychain sign-as YOU.testnet network-config testnet sign-with-keychain send
```
The charter account pays storage for jobs/spends and creates agent sub-accounts
(`<name>.charter.YOU.testnet`), so keep a few NEAR on it.

## 3. Deploy and init the token (mock-ft, 6 decimals)
```bash
near contract deploy tusd.YOU.testnet use-file target/wasm32-unknown-unknown/release/mock_ft.wasm with-init-call new json-args '{}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
```

## 4. Deploy and init Charter (owner = the DAO)
`params` must contain `text_hash = "0x" + sha256(text)`. Compute it with
`printf '%s' "$TEXT" | sha256sum`. Example params are in `ABI.md` section 0.
```bash
near contract deploy charter.YOU.testnet use-file target/wasm32-unknown-unknown/release/charter.wasm with-init-call new json-args '{"owner":"DAO","token":"tusd.YOU.testnet","params":{"text":"Charter v1: agents run the business within these rules.","text_hash":"0x4491b3b77977cd3f31bc8993cee81df8ec25b9360bb998c7f8ff3a57af6c696f","min_price":"1000000","max_price":"1000000000","bid_window_ns":"600000000000","submit_window_ns":"3600000000000","review_window_ns":"3600000000000","max_bid_bps":10000,"split":{"reviewer":800,"producer":5500,"sales":700,"treasury":1500,"seats":1500},"rep_start":100,"rep_gain":10,"rep_loss":30,"rep_expire_loss":20,"rep_freeze_below":50,"base_budget":"20000000","per_rep_budget":"10000000","max_budget":"100000000","budget_window_ns":"3600000000000","per_tx_cap":"25000000","approval_threshold":"15000000"}}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
near contract call-function as-read-only charter.YOU.testnet get_charter json-args '{}' network-config testnet now
```

## 5. Register the charter contract with the token and mint test tokens
The contract must be registered on the token so customers can `ft_transfer_call` into it;
every claimer/vendor must be registered too (`mint` auto-registers; `storage_deposit` also works).
```bash
near contract call-function as-transaction tusd.YOU.testnet mint json-args '{"account_id":"charter.YOU.testnet","amount":"1"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as YOU.testnet network-config testnet sign-with-keychain send
near contract call-function as-transaction tusd.YOU.testnet mint json-args '{"account_id":"customer.YOU.testnet","amount":"1000000000"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as YOU.testnet network-config testnet sign-with-keychain send
```
`mint` is an open faucet capped at 1,000,000 tUSD per call.

## 6. DAO bootstrap (proposals; council votes)
Use the templates in `dao-proposals/`. For each: set `receiver_id` to `charter.YOU.testnet`,
edit `_args_json`, recompute `args = base64(JSON)`, submit with `add_proposal` on the DAO and
the proposal bond, then vote `VoteApprove`. Order:
1. `set_guardians`, `set_vendor`
2. `register_agent` x5 (Sales, Analyst x2 with different owners, Reviewer, Treasurer). Generate
   each agent key pair locally (`near account create-account ... ` is NOT used: the contract
   creates the account). Put only the **public** key in the proposal; keep the private key in a
   git-ignored file read by the agents (`AGENT_<NAME>_PRIVATE_KEY`). Deposit 0.6 NEAR, gas 150 Tgas.
3. `mint_seat` for members.
4. Fund the treasury: `ft_transfer_call` to the charter with `msg = {"action":"fund_treasury"}`.

## 7. Smoke checks
```bash
near contract call-function as-read-only charter.YOU.testnet list_agents json-args '{}' network-config testnet now
near contract call-function as-read-only charter.YOU.testnet get_stats json-args '{}' network-config testnet now
```
`get_stats.solvent` must be `true`.

Role-key check (protocol level): with an analyst key, calling `accept_job` must fail with an
access-key method-name error before reaching the contract.
