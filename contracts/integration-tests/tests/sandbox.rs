//! near-workspaces sandbox: full lifecycle with mock-ft, a mock DAO owner account, and the
//! role-key restriction test (a call outside `method_names` fails at protocol level).
//! WRITTEN BUT NOT RUN on the authoring machine (see contracts/NOTES.md).
use near_workspaces::types::{KeyType, NearToken, SecretKey};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};

const TEXT1: &str = "ByLaw v1: agents run the business within these rules.";
const HASH1: &str = "0x38d07802abd15ce9007eaa1b702a0fbd58029e86d5591a10c102b84df06edb90";
const TUSD: u128 = 1_000_000;

fn wasm(name: &str) -> Vec<u8> {
    let p = format!("../../target/wasm32-unknown-unknown/release/{}.wasm", name);
    std::fs::read(&p).unwrap_or_else(|_| panic!("build {} first: {}", name, p))
}

fn params() -> Value {
    json!({
        "text": TEXT1, "text_hash": HASH1,
        "min_price": "1000000", "max_price": "1000000000",
        "bid_window_ns": "5000000000", "submit_window_ns": "3600000000000", "review_window_ns": "3600000000000",
        "max_bid_bps": 10000,
        "split": {"reviewer": 800, "producer": 5500, "sales": 700, "treasury": 1500, "seats": 1500},
        "rep_start": 100, "rep_gain": 10, "rep_loss": 30, "rep_expire_loss": 20, "rep_freeze_below": 50,
        "base_budget": "20000000", "per_rep_budget": "10000000", "max_budget": "100000000",
        "budget_window_ns": "3600000000000", "per_tx_cap": "25000000", "approval_threshold": "15000000"
    })
}

struct Env {
    worker: Worker<near_workspaces::network::Sandbox>,
    bylaw: Contract,
    ft: Contract,
    dao: Account,
}

async fn setup() -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let ft = worker.dev_deploy(&wasm("mock_ft")).await?;
    ft.call("new").transact().await?.into_result()?;
    let bylaw = worker.dev_deploy(&wasm("bylaw")).await?;
    let root = worker.root_account()?;
    let dao = root
        .create_subaccount("dao")
        .initial_balance(NearToken::from_near(50))
        .transact()
        .await?
        .into_result()?;
    bylaw
        .call("new")
        .args_json(json!({"owner": dao.id(), "token": ft.id(), "params": params()}))
        .transact()
        .await?
        .into_result()?;
    Ok(Env {
        worker,
        bylaw,
        ft,
        dao,
    })
}

/// Registers an agent through the real register_agent promise chain and returns an Account
/// that signs with the agent's function-call key.
async fn register(
    env: &Env,
    kind: &str,
    name: &str,
    owner: &Account,
) -> anyhow::Result<(Account, String)> {
    let sk = SecretKey::from_random(KeyType::ED25519);
    let res = env
        .dao
        .call(env.bylaw.id(), "register_agent")
        .args_json(json!({"kind": kind, "name": name, "owner_account": owner.id(), "pubkey": sk.public_key()}))
        .deposit(NearToken::from_millinear(600))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "register_agent failed: {:?}", res);
    let token_id: Option<String> = res.json()?;
    let token_id = token_id.expect("agent token id");
    let id: near_workspaces::AccountId = format!("{}.{}", name, env.bylaw.id()).parse()?;
    Ok((Account::from_secret_key(id, sk, &env.worker), token_id))
}

#[tokio::test]
async fn role_keys_and_full_lifecycle() -> anyhow::Result<()> {
    let env = setup().await?;
    let root = env.worker.root_account()?;
    let mk = |n: &'static str| {
        root.create_subaccount(n)
            .initial_balance(NearToken::from_near(5))
            .transact()
    };
    let alice = mk("alice").await?.into_result()?;
    let bob = mk("bob").await?.into_result()?;
    let dave = mk("dave").await?.into_result()?;
    let cust = mk("cust").await?.into_result()?;

    let (sales, _) = register(&env, "Sales", "sales", &alice).await?;
    let (analyst, analyst_id) = register(&env, "Analyst", "analyst", &bob).await?;
    let (reviewer, _) = register(&env, "Reviewer", "reviewer", &dave).await?;

    // --- role_keys: the analyst key may call place_bid/submit_work only. A call to a method
    // outside method_names is rejected by the protocol (no receipt reaches the contract).
    let bad = analyst
        .call(env.bylaw.id(), "accept_job")
        .args_json(json!({"job": "1"}))
        .transact()
        .await;
    match bad {
        Err(_) => {}
        Ok(r) => assert!(r.is_failure(), "accept_job via analyst key must fail"),
    }
    // the key is also unusable against any other receiver
    let bad2 = analyst
        .call(env.ft.id(), "mint")
        .args_json(json!({"account_id": analyst.id(), "amount": "1"}))
        .transact()
        .await;
    match bad2 {
        Err(_) => {}
        Ok(r) => assert!(
            r.is_failure(),
            "agent key must be scoped to the bylaw contract"
        ),
    }

    // --- customer posts a job via ft_transfer_call
    cust.call(env.ft.id(), "mint")
        .args_json(json!({"account_id": cust.id(), "amount": (200 * TUSD).to_string()}))
        .transact()
        .await?
        .into_result()?;
    env.ft
        .as_account()
        .call(env.ft.id(), "mint")
        .args_json(json!({"account_id": env.bylaw.id(), "amount": "1"}))
        .transact()
        .await?
        .into_result()?;
    for a in [&bob, &alice, &dave] {
        a.call(env.ft.id(), "mint")
            .args_json(json!({"account_id": a.id(), "amount": "1"}))
            .transact()
            .await?
            .into_result()?;
    }
    cust.call(env.ft.id(), "ft_transfer_call")
        .args_json(
            json!({"receiver_id": env.bylaw.id(), "amount": (100 * TUSD).to_string(),
                          "msg": "{\"action\":\"post_job\",\"target\":\"example.testnet\"}"}),
        )
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let job: Value = env
        .bylaw
        .view("get_job")
        .args_json(json!({"id": "1"}))
        .await?
        .json()?;
    assert_eq!(job["state"], "Posted");

    sales
        .call(env.bylaw.id(), "accept_job")
        .args_json(json!({"job": "1"}))
        .transact()
        .await?
        .into_result()?;
    analyst
        .call(env.bylaw.id(), "place_bid")
        .args_json(json!({"job": "1", "price": (80 * TUSD).to_string()}))
        .transact()
        .await?
        .into_result()?;
    env.worker.fast_forward(20).await?;
    sales
        .call(env.bylaw.id(), "award_job")
        .args_json(json!({"job": "1"}))
        .transact()
        .await?
        .into_result()?;
    analyst
        .call(env.bylaw.id(), "submit_work")
        .args_json(json!({"job": "1", "hash": HASH1, "uri": "ipfs://x", "attestation": null}))
        .transact()
        .await?
        .into_result()?;
    reviewer
        .call(env.bylaw.id(), "review_work")
        .args_json(json!({"job": "1", "approve": true, "reason_hash": HASH1}))
        .transact()
        .await?
        .into_result()?;
    let job: Value = env
        .bylaw
        .view("get_job")
        .args_json(json!({"id": "1"}))
        .await?
        .json()?;
    assert_eq!(job["state"], "Settled");
    let stats: Value = env.bylaw.view("get_stats").await?.json()?;
    assert_eq!(stats["solvent"], true);

    // --- bob (owner of the analyst NFT) claims 55 tUSD
    bob.call(env.bylaw.id(), "claim")
        .args_json(json!({}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let bal: String = env
        .ft
        .view("ft_balance_of")
        .args_json(json!({"account_id": bob.id()}))
        .await?
        .json()?;
    assert_eq!(bal, (55 * TUSD + 1).to_string());

    // --- reputation increased by rep_gain
    let agent: Value = env
        .bylaw
        .view("get_agent")
        .args_json(json!({"token_id": analyst_id}))
        .await?
        .json()?;
    assert_eq!(agent["rep"], 110);

    // --- owner is the DAO: anyone else cannot change the bylaw
    let r = alice
        .call(env.bylaw.id(), "set_paused")
        .args_json(json!({"paused": true}))
        .transact()
        .await?;
    assert!(r.is_failure());
    Ok(())
}
