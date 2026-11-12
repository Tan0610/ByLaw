# Day-0 spikes

Append-only. One section per lane. Record what was actually observed; write "not run" when a spike has not been run.

## Lane C (S1, S2)

S1 and S2 need testnet accounts, faucet funds and signatures, so a human runs them. Nothing below has been run yet. Fill in the results.

### S1: faucet and Sputnik DAO creation
Runbook: `docs/demo/TESTNET_RUNBOOK.md` steps 0 and 1. `npm run bootstrap -w scripts` prints the exact `sputnikv2.testnet create` call (6 NEAR attached, council as the default policy).

| Question | Result | Date / tx link |
|---|---|---|
| Faucet amount per request | not run | |
| DAO creation deposit actually charged | not run | |
| Proposal bond (`get_policy().proposal_bond`) | not run (Sputnik default 0.1 NEAR, assumed in `apps/web/src/lib/config.ts` `PROPOSAL_BOND`) | |
| Who may propose (council only, or anyone) | not run | |
| Fallback used (`dao.globals.primitives.testnet` or minimal council) | not run | |

### S2: FunctionCall proposal into the Charter contract
Runbook step 3. The scripts attach 150 Tgas to the inner call and 300 Tgas to `act_proposal`.

| Question | Result | Date / tx link |
|---|---|---|
| Proposal executed on the final vote | not run | |
| Gas needed by `act_proposal` | not run | |
| Deposit needed for `register_agent` through the DAO (DAO balance) | not run (ABI: at least 0.5 NEAR per agent) | |
| `act_proposal` requires the `proposal` kind argument | not run (web app and scripts send it) | |

### Local environment finding (2026-11-11)
- Windows Application Control blocked rollup's native binary once (`ERR_DLOPEN_FAILED` on `rollup.win32-x64-msvc.node`) during `vitest`. After reinstalling rollup it loaded. `npm run fix-rollup -w scripts` swaps in `@rollup/wasm-node` if it happens again.
