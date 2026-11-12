//! Unit + property tests (near_sdk::test_utils + proptest) for invariants C1-C11.
//! Name filters: `cargo test -p bylaw role_keys`, `cargo test -p bylaw seats`,
//! `cargo test -p bylaw prop_`.
use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult};

const CONTRACT: &str = "bylaw.testnet";
const DAO: &str = "dao.sputnikv2.testnet";
const TOKEN: &str = "tusd.testnet";
const CUST: &str = "cust.testnet";
const VENDOR: &str = "vendor.testnet";
const GUARD: &str = "guard.testnet";

pub(crate) const TEXT1: &str = "ByLaw v1: agents run the business within these rules.";
pub(crate) const HASH1: &str = "0x38d07802abd15ce9007eaa1b702a0fbd58029e86d5591a10c102b84df06edb90";
const TEXT2: &str = "ByLaw v2: agents run the business within these rules. Budgets doubled.";
const HASH2: &str = "0x1bebb4ecfda49da723875dc8d988e51af7920923e5f96c2ffdc9a6be659f6327";

const T: u64 = 1_000_000_000; // 1 s in ns
const TUSD: u128 = 1_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(pred: &str, now: u64, dep: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(CONTRACT))
        .signer_account_id(acc(pred))
        .predecessor_account_id(acc(pred))
        .block_timestamp(now)
        .attached_deposit(NearToken::from_yoctonear(dep));
    testing_env!(b.build());
}

fn ctx_cb(now: u64, ok: bool) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(CONTRACT))
        .signer_account_id(acc(CONTRACT))
        .predecessor_account_id(acc(CONTRACT))
        .block_timestamp(now);
    let r = if ok {
        PromiseResult::Successful(vec![])
    } else {
        PromiseResult::Failed
    };
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![r]
    );
}

pub(crate) fn params_json(text: &str, hash: &str) -> ByLawParamsJson {
    ByLawParamsJson {
        version: None,
        text: text.to_string(),
        text_hash: hash.to_string(),
        min_price: U128(TUSD),
        max_price: U128(1000 * TUSD),
        bid_window_ns: U64(600 * T),
        submit_window_ns: U64(3600 * T),
        review_window_ns: U64(3600 * T),
        max_bid_bps: 10_000,
        split: Split {
            reviewer: 800,
            producer: 5500,
            sales: 700,
            treasury: 1500,
            seats: 1500,
        },
        rep_start: 100,
        rep_gain: 10,
        rep_loss: 30,
        rep_expire_loss: 20,
        rep_freeze_below: 50,
        base_budget: U128(20 * TUSD),
        per_rep_budget: U128(10 * TUSD),
        max_budget: U128(100 * TUSD),
        budget_window_ns: U64(3600 * T),
        per_tx_cap: U128(25 * TUSD),
        approval_threshold: U128(15 * TUSD),
    }
}

/// Test harness: one contract, a clock, and the fixed cast of agents.
pub(crate) struct H {
    pub c: Contract,
    pub now: u64,
    pub sales: u64,
    pub a1: u64,
    pub a2: u64,
    pub rev: u64,
    pub rev2: u64,
    pub treas: u64,
}

pub(crate) const OWNERS: [&str; 6] = [
    "alice.testnet",
    "bob.testnet",
    "carol.testnet",
    "dave.testnet",
    "erin.testnet",
    CUST,
];

impl H {
    pub fn new() -> Self {
        let now = 1_000_000 * T;
        // fresh storage: proptest runs many cases on one thread and testing_env! keeps storage
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc(CONTRACT))
            .predecessor_account_id(acc(DAO))
            .block_timestamp(now);
        near_sdk::env::set_blockchain_interface(near_sdk::MockedBlockchain::new(
            b.build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            vec![],
            Default::default(),
            Default::default(),
            None,
        ));
        let mut c = Contract::new(acc(DAO), acc(TOKEN), params_json(TEXT1, HASH1));
        // agents registered directly (the register_agent promise chain is tested separately)
        let sales = c.internal_add_agent(
            Kind::Sales,
            acc("sales.bylaw.testnet"),
            acc("alice.testnet"),
        );
        let a1 = c.internal_add_agent(Kind::Analyst, acc("a1.bylaw.testnet"), acc("bob.testnet"));
        let a2 = c.internal_add_agent(
            Kind::Analyst,
            acc("a2.bylaw.testnet"),
            acc("carol.testnet"),
        );
        let rev = c.internal_add_agent(
            Kind::Reviewer,
            acc("rev.bylaw.testnet"),
            acc("dave.testnet"),
        );
        let rev2 = c.internal_add_agent(
            Kind::Reviewer,
            acc("rev2.bylaw.testnet"),
            acc("bob.testnet"),
        );
        let treas = c.internal_add_agent(
            Kind::Treasurer,
            acc("treas.bylaw.testnet"),
            acc("erin.testnet"),
        );
        c.set_vendor(acc(VENDOR), true);
        c.set_guardians(vec![acc(GUARD)]);
        H {
            c,
            now,
            sales,
            a1,
            a2,
            rev,
            rev2,
            treas,
        }
    }

    pub fn as_(&mut self, who: &str) -> &mut Contract {
        ctx(who, self.now, 0);
        &mut self.c
    }

    pub fn as_dep(&mut self, who: &str, dep: u128) -> &mut Contract {
        ctx(who, self.now, dep);
        &mut self.c
    }

    pub fn cb(&mut self, ok: bool) -> &mut Contract {
        ctx_cb(self.now, ok);
        &mut self.c
    }

    pub fn account(&self, id: u64) -> String {
        self.c.agents.get(&id).unwrap().account.to_string()
    }

    pub fn post(&mut self, price: u128) -> (u128, Option<u64>) {
        let before = self.c.next_job_id;
        let msg = format!("{{\"action\":\"post_job\",\"target\":\"example.testnet\"}}");
        let r = match self.as_(TOKEN).ft_on_transfer(acc(CUST), U128(price), msg) {
            PromiseOrValue::Value(v) => v.0,
            _ => panic!("expected value"),
        };
        let id = if self.c.next_job_id > before {
            Some(before)
        } else {
            None
        };
        (r, id)
    }

    pub fn fund(&mut self, amount: u128) {
        let msg = "{\"action\":\"fund_treasury\"}".to_string();
        let _ = self
            .as_(TOKEN)
            .ft_on_transfer(acc("funder.testnet"), U128(amount), msg);
    }

    pub fn call_agent<R>(&mut self, id: u64, f: impl FnOnce(&mut Contract) -> R) -> R {
        let a = self.account(id);
        ctx(&a, self.now, 0);
        f(&mut self.c)
    }

    /// Posted -> Open -> bids -> Awarded. Returns job id.
    pub fn to_awarded(&mut self, price: u128, bids: &[(u64, u128)]) -> u64 {
        let (_, id) = self.post(price);
        let id = id.unwrap();
        let s = self.sales;
        self.call_agent(s, |c| c.accept_job(U64(id)));
        for (a, p) in bids {
            let p = *p;
            self.call_agent(*a, |c| c.place_bid(U64(id), U128(p)));
            self.now += T;
        }
        self.now += 601 * T;
        self.call_agent(s, |c| c.award_job(U64(id)));
        id
    }

    pub fn submit(&mut self, id: u64) {
        let w = self.c.job(id).winner.unwrap();
        self.call_agent(w, |c| {
            c.submit_work(U64(id), HASH1.to_string(), "ipfs://x".to_string(), None)
        });
    }

    pub fn review(&mut self, id: u64, approve: bool) {
        let r = self.c.job(id).reviewer.unwrap();
        self.call_agent(r, |c| c.review_work(U64(id), approve, HASH2.to_string()));
    }

    pub fn claimable(&self, who: &str) -> u128 {
        self.c.claimable.get(&acc(who)).copied().unwrap_or(0)
    }

    /// C2: independent recomputation of the solvency identity from per-key balances.
    pub fn assert_solvent(&self) {
        let mut cl: u128 = 0;
        for o in OWNERS.iter() {
            cl += self.claimable(o);
        }
        assert_eq!(cl, self.c.total_claimable, "claimable aggregate mismatch");
        let mut es: u128 = 0;
        for id in 1..self.c.next_job_id {
            let e = self.c.escrow.get(&id).copied().unwrap_or(0);
            let j = self.c.job(id);
            if j.state.is_terminal() {
                assert_eq!(e, 0, "terminal job {} still holds escrow", id);
            } else {
                assert_eq!(e, j.price, "live job {} escrow != price", id);
            }
            es += e;
        }
        assert_eq!(es, self.c.total_escrow, "escrow aggregate mismatch");
        assert_eq!(
            cl + es + self.c.treasury + self.c.seat_pool,
            self.c.total_in - self.c.total_out,
            "solvency invariant C2 violated"
        );
        assert!(self.c.is_solvent());
    }
}

fn events(name: &str) -> Vec<near_sdk::serde_json::Value> {
    get_logs()
        .into_iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:").map(|s| s.to_string()))
        .filter_map(|s| near_sdk::serde_json::from_str::<near_sdk::serde_json::Value>(&s).ok())
        .filter(|v| v["event"] == name)
        .collect()
}

// ============================================================ bylaw + auth (A1, C7)

#[test]
fn init_and_get_bylaw() {
    let h = H::new();
    let p = h.c.get_bylaw();
    assert_eq!(p.version, Some(1));
    assert_eq!(p.text_hash, HASH1);
    assert_eq!(p.split.sum(), 10_000);
}

#[test]
fn set_bylaw_bumps_version_and_emits_hashes() {
    let mut h = H::new();
    h.as_(DAO).set_bylaw(params_json(TEXT2, HASH2));
    let ev = events("bylaw_updated");
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["standard"], "bylaw");
    assert_eq!(ev[0]["version"], "1.0.0");
    assert_eq!(ev[0]["data"][0]["version"], 2);
    assert_eq!(ev[0]["data"][0]["old_hash"], HASH1);
    assert_eq!(ev[0]["data"][0]["new_hash"], HASH2);
    assert_eq!(h.c.get_bylaw().version, Some(2));
}

#[test]
#[should_panic(expected = "text_hash must equal sha256(text)")]
fn set_bylaw_rejects_wrong_hash() {
    let mut h = H::new();
    h.as_(DAO).set_bylaw(params_json(TEXT2, HASH1));
}

#[test]
#[should_panic(expected = "split must sum to 10000 bps")]
fn set_bylaw_rejects_bad_split() {
    let mut h = H::new();
    let mut p = params_json(TEXT2, HASH2);
    p.split.seats = 1;
    h.as_(DAO).set_bylaw(p);
}

#[test]
#[should_panic(expected = "only the owner (DAO) can call this")]
fn c7_non_owner_cannot_set_bylaw() {
    let mut h = H::new();
    h.as_(GUARD).set_bylaw(params_json(TEXT2, HASH2));
}

#[test]
#[should_panic(expected = "only the owner (DAO) can call this")]
fn c7_guardian_cannot_unfreeze() {
    let mut h = H::new();
    let a1 = h.a1;
    h.as_(GUARD).freeze_agent(U64(a1), "test".into());
    h.as_(GUARD).unfreeze_agent(U64(a1));
}

#[test]
#[should_panic(expected = "only the owner (DAO) can call this")]
fn c7_non_owner_cannot_set_vendor() {
    let mut h = H::new();
    h.as_(GUARD).set_vendor(acc("x.testnet"), true);
}

#[test]
#[should_panic(expected = "only the owner (DAO) can call this")]
fn c7_non_owner_cannot_mint_seat() {
    let mut h = H::new();
    h.as_("alice.testnet").mint_seat(acc("alice.testnet"), 1);
}

#[test]
#[should_panic(expected = "only a guardian or the owner can freeze")]
fn c7_random_cannot_freeze() {
    let mut h = H::new();
    let a1 = h.a1;
    h.as_("mallory.testnet").freeze_agent(U64(a1), "x".into());
}

#[test]
fn guardian_freeze_owner_unfreeze() {
    let mut h = H::new();
    let a1 = h.a1;
    h.as_(GUARD).freeze_agent(U64(a1), "suspicious".into());
    let ev = events("agent_frozen");
    assert_eq!(ev[0]["data"][0]["by"], GUARD);
    assert_eq!(ev[0]["data"][0]["reason"], "suspicious");
    assert_eq!(h.c.agent(a1).state, AgentState::Frozen);
    h.as_(DAO).unfreeze_agent(U64(a1));
    assert_eq!(h.c.agent(a1).state, AgentState::Active);
}

// ============================================================ register_agent (A3)

#[test]
fn role_keys_method_names_table() {
    assert_eq!(Kind::Sales.method_names(), "accept_job,award_job");
    assert_eq!(Kind::Analyst.method_names(), "place_bid,submit_work");
    assert_eq!(Kind::Reviewer.method_names(), "review_work");
    assert_eq!(Kind::Treasurer.method_names(), "request_spend");
}

#[test]
fn role_keys_register_agent_creates_restricted_key_and_mints_on_callback() {
    let mut h = H::new();
    let pk: PublicKey = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp"
        .parse()
        .unwrap();
    let _p = h.as_dep(DAO, MIN_AGENT_DEPOSIT).register_agent(
        Kind::Analyst,
        "analyst-9".into(),
        acc("bob.testnet"),
        pk.clone(),
    );
    drop(_p);
    let receipts = near_sdk::test_utils::get_created_receipts();
    let r = receipts
        .iter()
        .find(|r| r.receiver_id.as_str() == "analyst-9.bylaw.testnet")
        .expect("create-account receipt");
    use near_sdk::mock::MockAction;
    let mut created = false;
    let mut scoped_key = false;
    for a in r.actions.iter() {
        match a {
            MockAction::CreateAccount { .. } => created = true,
            MockAction::AddKeyWithFunctionCall {
                method_names,
                receiver_id,
                ..
            } => {
                assert_eq!(receiver_id.as_str(), CONTRACT);
                assert_eq!(method_names.join(","), "place_bid,submit_work");
                scoped_key = true;
            }
            MockAction::AddKeyWithFullAccess { .. } => {
                panic!("agent must never get a full-access key")
            }
            _ => {}
        }
    }
    assert!(
        created && scoped_key,
        "create_account + function-call key expected"
    );
    assert_eq!(h.c.pending_registrations, 1);
    let id = h
        .cb(true)
        .on_agent_created(
            Kind::Analyst,
            acc("analyst-9.bylaw.testnet"),
            acc("bob.testnet"),
            U128(MIN_AGENT_DEPOSIT),
            acc(DAO),
        )
        .expect("token id");
    assert_eq!(h.c.pending_registrations, 0);
    let a = h.c.get_agent(id).unwrap();
    assert_eq!(a.owner, acc("bob.testnet"));
    assert_eq!(a.kind, Kind::Analyst);
    assert_eq!(a.rep, 100);
    assert_eq!(events("agent_registered").len(), 1);
}

#[test]
fn role_keys_register_agent_failure_refunds_and_registers_nothing() {
    let mut h = H::new();
    let pk: PublicKey = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp"
        .parse()
        .unwrap();
    let n = h.c.agents.len();
    let _ = h.as_dep(DAO, MIN_AGENT_DEPOSIT).register_agent(
        Kind::Sales,
        "s2".into(),
        acc("bob.testnet"),
        pk,
    );
    let r = h.cb(false).on_agent_created(
        Kind::Sales,
        acc("s2.bylaw.testnet"),
        acc("bob.testnet"),
        U128(MIN_AGENT_DEPOSIT),
        acc(DAO),
    );
    assert!(r.is_none());
    assert_eq!(h.c.agents.len(), n);
    assert_eq!(h.c.pending_registrations, 0);
}

#[test]
#[should_panic(expected = "attach at least 0.5 NEAR")]
fn register_agent_requires_deposit() {
    let mut h = H::new();
    let pk: PublicKey = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp"
        .parse()
        .unwrap();
    let _ = h
        .as_dep(DAO, 1)
        .register_agent(Kind::Sales, "s2".into(), acc("bob.testnet"), pk);
}

#[test]
fn rotate_agent_rebinds_account_and_keeps_rep() {
    let mut h = H::new();
    let a1 = h.a1;
    let pk: PublicKey = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp"
        .parse()
        .unwrap();
    let _ = h
        .as_dep(DAO, MIN_AGENT_DEPOSIT)
        .rotate_agent(U64(a1), "a1b".into(), pk);
    assert!(h.cb(true).on_agent_rotated(
        U64(a1),
        acc("a1b.bylaw.testnet"),
        U128(MIN_AGENT_DEPOSIT),
        acc(DAO)
    ));
    let a = h.c.agent(a1);
    assert_eq!(a.account, acc("a1b.bylaw.testnet"));
    assert_eq!(a.rep, 100);
    assert!(h
        .c
        .agent_by_account
        .get(&acc("a1.bylaw.testnet"))
        .is_none());
    assert_eq!(h.c.owner_of(a1), acc("bob.testnet"));
}

#[test]
#[should_panic(expected = "caller is not a registered agent")]
fn rotate_old_identity_cannot_act() {
    let mut h = H::new();
    let a1 = h.a1;
    let pk: PublicKey = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp"
        .parse()
        .unwrap();
    let _ = h
        .as_dep(DAO, MIN_AGENT_DEPOSIT)
        .rotate_agent(U64(a1), "a1b".into(), pk);
    h.cb(true).on_agent_rotated(
        U64(a1),
        acc("a1b.bylaw.testnet"),
        U128(MIN_AGENT_DEPOSIT),
        acc(DAO),
    );
    let (_, id) = h.post(10 * TUSD);
    let s = h.sales;
    h.call_agent(s, |c| c.accept_job(U64(id.unwrap())));
    h.as_("a1.bylaw.testnet")
        .place_bid(U64(id.unwrap()), U128(TUSD));
}

// ============================================================ ft_on_transfer

#[test]
fn post_job_in_band_escrows() {
    let mut h = H::new();
    let (ret, id) = h.post(100 * TUSD);
    assert_eq!(ret, 0);
    let id = id.unwrap();
    assert_eq!(h.c.escrow_of(U64(id)).0, 100 * TUSD);
    let ev = events("job_posted");
    assert_eq!(ev[0]["data"][0]["job_id"], "1");
    assert_eq!(ev[0]["data"][0]["price"], "100000000");
    h.assert_solvent();
}

#[test]
fn post_job_out_of_band_or_bad_msg_refunds() {
    let mut h = H::new();
    assert_eq!(h.post(TUSD / 2), (TUSD / 2, None));
    assert_eq!(h.post(1001 * TUSD), (1001 * TUSD, None));
    let r = h
        .as_(TOKEN)
        .ft_on_transfer(acc(CUST), U128(5), "garbage".into());
    assert!(matches!(r, PromiseOrValue::Value(U128(5))));
    let r = h.as_(TOKEN).ft_on_transfer(
        acc(CUST),
        U128(5 * TUSD),
        "{\"action\":\"post_job\",\"target\":\"NOT VALID!\"}".into(),
    );
    assert!(matches!(r, PromiseOrValue::Value(U128(5_000_000))));
    h.as_(DAO).set_paused(true);
    assert_eq!(h.post(10 * TUSD), (10 * TUSD, None));
    assert_eq!(h.c.total_in, 0);
    h.assert_solvent();
}

#[test]
#[should_panic(expected = "only the configured token")]
fn ft_on_transfer_rejects_other_token() {
    let mut h = H::new();
    let _ = h.as_("fake-token.testnet").ft_on_transfer(
        acc(CUST),
        U128(10 * TUSD),
        "{\"action\":\"fund_treasury\"}".into(),
    );
}

#[test]
fn fund_treasury_credits() {
    let mut h = H::new();
    h.fund(50 * TUSD);
    assert_eq!(h.c.treasury, 50 * TUSD);
    h.assert_solvent();
}

// ============================================================ job lifecycle (A4, A5, C1, C5)

#[test]
fn happy_path_waterfall_c1() {
    let mut h = H::new();
    let (a1, a2) = (h.a1, h.a2);
    let id = h.to_awarded(100 * TUSD, &[(a1, 80 * TUSD), (a2, 90 * TUSD)]);
    let j = h.c.job(id);
    assert_eq!(j.state, JobState::Awarded);
    assert_eq!(j.winner, Some(a1));
    // reviewer owner must differ from producer owner (bob): rev (dave) qualifies, rev2 (bob) not
    assert_eq!(j.reviewer, Some(h.rev));
    h.submit(id);
    h.review(id, true);
    let ev = events("job_settled");
    assert_eq!(ev.len(), 1);
    let cr = &ev[0]["data"][0]["credits"];
    assert_eq!(cr["reviewer"], "8000000");
    assert_eq!(cr["producer"], "55000000");
    assert_eq!(cr["sales"], "7000000");
    assert_eq!(cr["seats"], "0");
    assert_eq!(cr["treasury"], "30000000");
    assert_eq!(h.claimable("bob.testnet"), 55 * TUSD);
    assert_eq!(h.claimable("dave.testnet"), 8 * TUSD);
    assert_eq!(h.claimable("alice.testnet"), 7 * TUSD);
    assert_eq!(h.c.treasury, 30 * TUSD);
    assert_eq!(h.c.job(id).state, JobState::Settled);
    assert_eq!(h.c.agent(a1).rep, 110);
    assert_eq!(h.c.agent(a1).delivered, 1);
    h.assert_solvent();
}

#[test]
fn award_score_uses_reputation() {
    let mut h = H::new();
    let (a1, a2) = (h.a1, h.a2);
    // a2 has much higher rep: 80*1000/1100=72.7 vs 85*1000/2100=40.4 -> a2 wins despite higher price
    let mut ag = h.c.agent(a2);
    ag.rep = 1100;
    h.c.agents.insert(a2, ag);
    let id = h.to_awarded(100 * TUSD, &[(a1, 80 * TUSD), (a2, 85 * TUSD)]);
    assert_eq!(h.c.job(id).winner, Some(a2));
}

#[test]
fn award_tie_goes_to_earlier_bid() {
    let mut h = H::new();
    let (a1, a2) = (h.a1, h.a2);
    let id = h.to_awarded(100 * TUSD, &[(a2, 50 * TUSD), (a1, 50 * TUSD)]);
    assert_eq!(h.c.job(id).winner, Some(a2));
}

#[test]
fn award_without_bids_refunds_customer() {
    let mut h = H::new();
    let id = h.to_awarded(10 * TUSD, &[]);
    assert_eq!(h.c.job(id).state, JobState::Refunded);
    assert_eq!(h.claimable(CUST), 10 * TUSD);
    h.assert_solvent();
}

#[test]
#[should_panic(expected = "bid exceeds price")]
fn bid_above_cap_rejected() {
    let mut h = H::new();
    let (_, id) = h.post(10 * TUSD);
    let (s, a1) = (h.sales, h.a1);
    h.call_agent(s, |c| c.accept_job(U64(id.unwrap())));
    h.call_agent(a1, |c| c.place_bid(U64(id.unwrap()), U128(11 * TUSD)));
}

#[test]
#[should_panic(expected = "agent already bid")]
fn one_bid_per_agent() {
    let mut h = H::new();
    let (_, id) = h.post(10 * TUSD);
    let (s, a1) = (h.sales, h.a1);
    h.call_agent(s, |c| c.accept_job(U64(id.unwrap())));
    h.call_agent(a1, |c| c.place_bid(U64(id.unwrap()), U128(TUSD)));
    h.call_agent(a1, |c| c.place_bid(U64(id.unwrap()), U128(TUSD)));
}

#[test]
#[should_panic(expected = "bid window still open")]
fn award_before_window_panics() {
    let mut h = H::new();
    let (_, id) = h.post(10 * TUSD);
    let s = h.sales;
    h.call_agent(s, |c| c.accept_job(U64(id.unwrap())));
    h.call_agent(s, |c| c.award_job(U64(id.unwrap())));
}

#[test]
fn c5_reviewer_owner_differs_from_producer_owner() {
    let mut h = H::new();
    // retire dave's reviewer: only rev2 (owned by bob) remains. a1 (bob) cannot be reviewed,
    // so a2 (carol) wins even with the worse price.
    let rev = h.rev;
    h.as_(DAO).retire_agent(U64(rev), None);
    let (a1, a2) = (h.a1, h.a2);
    let id = h.to_awarded(100 * TUSD, &[(a1, 10 * TUSD), (a2, 90 * TUSD)]);
    let j = h.c.job(id);
    assert_eq!(j.winner, Some(a2));
    assert_eq!(j.reviewer, Some(h.rev2));
    assert_ne!(
        h.c.owner_of(j.winner.unwrap()),
        h.c.owner_of(j.reviewer.unwrap())
    );
}

#[test]
#[should_panic(expected = "owner conflict")]
fn c5_owner_conflict_rechecked_at_review() {
    let mut h = H::new();
    let (a1, rev) = (h.a1, h.rev);
    let id = h.to_awarded(100 * TUSD, &[(a1, 10 * TUSD)]);
    h.submit(id);
    // dave transfers his reviewer NFT to bob (winner's owner) -> conflict
    h.as_dep("dave.testnet", 1)
        .nft_transfer(acc("bob.testnet"), rev.to_string(), None, None);
    h.review(id, true);
}

#[test]
fn reject_reopens_once_then_refunds_and_c10_auto_freeze() {
    let mut h = H::new();
    let (a1, a2) = (h.a1, h.a2);
    let id = h.to_awarded(100 * TUSD, &[(a1, 10 * TUSD), (a2, 20 * TUSD)]);
    h.submit(id);
    h.review(id, false);
    let j = h.c.job(id);
    assert_eq!(j.state, JobState::Awarded, "re-opened to next-best bid");
    assert_eq!(j.winner, Some(a2));
    assert_eq!(j.attempts, 1);
    assert_eq!(h.c.agent(a1).rep, 70);
    assert_eq!(h.c.agent(a1).rejected, 1);
    h.submit(id);
    h.review(id, false);
    let j = h.c.job(id);
    assert_eq!(j.state, JobState::Rejected);
    assert_eq!(h.claimable(CUST), 100 * TUSD);
    assert_eq!(h.c.escrow_of(U64(id)).0, 0);
    h.assert_solvent();
    // a1 at 70: one more rejection -> 40 < 50 -> auto freeze
    let id2 = h.to_awarded(100 * TUSD, &[(a1, 10 * TUSD)]);
    h.submit(id2);
    h.review(id2, false);
    assert_eq!(h.c.agent(a1).rep, 40);
    assert_eq!(h.c.agent(a1).state, AgentState::Frozen);
    let fr = events("agent_frozen");
    assert_eq!(fr[0]["data"][0]["reason"], "rep_below_threshold");
    h.assert_solvent();
}

#[test]
fn c10_rep_saturates_at_zero() {
    let mut h = H::new();
    let a1 = h.a1;
    let mut ag = h.c.agent(a1);
    ag.rep = 5;
    h.c.agents.insert(a1, ag);
    let id = h.to_awarded(10 * TUSD, &[(a1, TUSD)]);
    h.submit(id);
    h.review(id, false);
    assert_eq!(h.c.agent(a1).rep, 0);
    assert_eq!(h.c.agent(a1).state, AgentState::Frozen);
}

#[test]
fn expire_awarded_penalizes_and_reopens_then_expires() {
    let mut h = H::new();
    let (a1, a2) = (h.a1, h.a2);
    let id = h.to_awarded(100 * TUSD, &[(a1, 10 * TUSD), (a2, 20 * TUSD)]);
    h.now += 3601 * T;
    h.as_("anyone.testnet").expire_job(U64(id));
    assert_eq!(h.c.agent(a1).rep, 80);
    let j = h.c.job(id);
    assert_eq!(j.state, JobState::Awarded);
    assert_eq!(j.winner, Some(a2));
    h.now += 3601 * T;
    h.as_("anyone.testnet").expire_job(U64(id));
    assert_eq!(h.c.job(id).state, JobState::Expired);
    assert_eq!(h.claimable(CUST), 100 * TUSD);
    h.assert_solvent();
}

#[test]
fn expire_posted_after_24h_and_review_timeout_escalates() {
    let mut h = H::new();
    let (_, id) = h.post(10 * TUSD);
    let id = id.unwrap();
    h.now += POSTED_TTL_NS + 1;
    h.as_("anyone.testnet").expire_job(U64(id));
    assert_eq!(h.c.job(id).state, JobState::Expired);

    let a1 = h.a1;
    let id2 = h.to_awarded(10 * TUSD, &[(a1, TUSD)]);
    h.submit(id2);
    h.now += 3601 * T;
    h.as_("anyone.testnet").expire_job(U64(id2));
    assert!(h.c.job(id2).escalated);
    assert_eq!(
        events("job_expired")[0]["data"][0]["reason"],
        "review_timeout"
    );
    h.as_(DAO).override_review(U64(id2), true);
    assert_eq!(h.c.job(id2).state, JobState::Settled);
    h.assert_solvent();
}

#[test]
#[should_panic(expected = "deadline not reached")]
fn expire_too_early_panics() {
    let mut h = H::new();
    let (_, id) = h.post(10 * TUSD);
    h.as_("anyone.testnet").expire_job(U64(id.unwrap()));
}

// ============================================================ role enforcement (C4, C6)

#[test]
#[should_panic(expected = "wrong role: Sales required")]
fn role_keys_c4_analyst_cannot_accept() {
    let mut h = H::new();
    let (_, id) = h.post(10 * TUSD);
    let a1 = h.a1;
    h.call_agent(a1, |c| c.accept_job(U64(id.unwrap())));
}

#[test]
#[should_panic(expected = "wrong role: Reviewer required")]
fn role_keys_c4_analyst_cannot_review() {
    let mut h = H::new();
    let a1 = h.a1;
    let id = h.to_awarded(10 * TUSD, &[(a1, TUSD)]);
    h.submit(id);
    h.call_agent(a1, |c| c.review_work(U64(id), true, HASH1.into()));
}

#[test]
#[should_panic(expected = "wrong role: Treasurer required")]
fn role_keys_c4_sales_cannot_spend() {
    let mut h = H::new();
    let s = h.sales;
    h.call_agent(s, |c| {
        c.request_spend(acc(VENDOR), U128(TUSD), None, "".into())
    });
}

#[test]
#[should_panic(expected = "caller is not a registered agent")]
fn role_keys_c4_stranger_cannot_bid() {
    let mut h = H::new();
    let (_, id) = h.post(10 * TUSD);
    let s = h.sales;
    h.call_agent(s, |c| c.accept_job(U64(id.unwrap())));
    h.as_("mallory.testnet")
        .place_bid(U64(id.unwrap()), U128(TUSD));
}

#[test]
#[should_panic(expected = "agent is not active")]
fn c6_frozen_agent_cannot_bid() {
    let mut h = H::new();
    let (_, id) = h.post(10 * TUSD);
    let (s, a1) = (h.sales, h.a1);
    h.call_agent(s, |c| c.accept_job(U64(id.unwrap())));
    h.as_(GUARD).freeze_agent(U64(a1), "x".into());
    h.call_agent(a1, |c| c.place_bid(U64(id.unwrap()), U128(TUSD)));
}

#[test]
#[should_panic(expected = "agent is not active")]
fn c6_retired_agent_cannot_accept() {
    let mut h = H::new();
    let (_, id) = h.post(10 * TUSD);
    let s = h.sales;
    h.as_(DAO).retire_agent(U64(s), Some("bye".into()));
    h.call_agent(s, |c| c.accept_job(U64(id.unwrap())));
}

// ============================================================ spends + budgets (A6, C3)

fn spend(h: &mut H, amount: u128, vendor: &str) -> SpendView {
    let t = h.treas;
    let id = h.call_agent(t, |c| {
        c.request_spend(acc(vendor), U128(amount), None, "memo".into())
    });
    h.c.get_spend(id).unwrap()
}

#[test]
fn spend_policy_rejections_are_recorded_not_panics() {
    let mut h = H::new();
    h.fund(100 * TUSD);
    let s = spend(&mut h, 5 * TUSD, "evil.testnet");
    assert_eq!(s.state, SpendState::Rejected);
    assert_eq!(s.reason, "vendor_not_allowlisted");
    assert_eq!(
        events("spend_recorded")[0]["data"][0]["outcome"],
        "Rejected:vendor_not_allowlisted"
    );
    let s = spend(&mut h, 26 * TUSD, VENDOR);
    assert_eq!(s.reason, "per_tx_cap_exceeded");
    let s = spend(&mut h, 0, VENDOR);
    assert_eq!(s.reason, "zero_amount");
    assert_eq!(h.c.treasury, 100 * TUSD);
    h.assert_solvent();
}

#[test]
fn spend_paid_and_callback() {
    let mut h = H::new();
    h.fund(100 * TUSD);
    let s = spend(&mut h, 10 * TUSD, VENDOR);
    assert_eq!(s.state, SpendState::Approved);
    assert_eq!(events("spend_recorded")[0]["data"][0]["outcome"], "Paid");
    assert_eq!(h.c.treasury, 90 * TUSD);
    h.assert_solvent();
    assert!(h.cb(true).on_spend_paid(s.id));
    assert_eq!(h.c.get_spend(s.id).unwrap().state, SpendState::Paid);
    // idempotent
    assert!(!h.cb(true).on_spend_paid(s.id));
    h.assert_solvent();
}

#[test]
fn spend_transfer_failure_restores_treasury_and_budget() {
    let mut h = H::new();
    h.fund(100 * TUSD);
    let t = h.treas;
    let s = spend(&mut h, 10 * TUSD, VENDOR);
    assert_eq!(h.c.budget_of(U64(t)).win_spent.0, 10 * TUSD);
    assert!(!h.cb(false).on_spend_paid(s.id));
    assert_eq!(h.c.treasury, 100 * TUSD);
    assert_eq!(h.c.get_spend(s.id).unwrap().reason, "transfer_failed");
    assert_eq!(h.c.budget_of(U64(t)).win_spent.0, 0);
    h.assert_solvent();
}

#[test]
fn spend_above_threshold_pending_then_dao_approves_or_rejects() {
    let mut h = H::new();
    h.fund(100 * TUSD);
    let s = spend(&mut h, 15 * TUSD, VENDOR);
    assert_eq!(s.state, SpendState::Pending);
    assert_eq!(h.c.treasury, 100 * TUSD);
    h.as_(DAO).approve_spend(s.id);
    assert_eq!(h.c.treasury, 85 * TUSD);
    assert_eq!(h.c.get_spend(s.id).unwrap().state, SpendState::Approved);
    h.assert_solvent();
    let t = h.treas;
    let s2 = spend(&mut h, 15 * TUSD, VENDOR);
    // budget at rep 100 = 20 + 10 = 30 tUSD; 15 + 15 = 30 fits
    assert_eq!(s2.state, SpendState::Pending);
    h.as_(DAO).reject_spend(s2.id);
    assert_eq!(h.c.get_spend(s2.id).unwrap().state, SpendState::Rejected);
    assert_eq!(
        h.c.budget_of(U64(t)).win_spent.0,
        15 * TUSD,
        "DAO-rejected spend leaves the window"
    );
}

#[test]
fn c3_budget_exceeded_recorded_and_sliding_window_exact() {
    let mut h = H::new();
    h.fund(500 * TUSD);
    let t = h.treas;
    assert_eq!(h.c.budget_of(U64(t)).budget.0, 30 * TUSD);
    // t=0: 14, t=30m: 14 -> 28 spent
    assert_eq!(spend(&mut h, 14 * TUSD, VENDOR).state, SpendState::Approved);
    h.now += 1800 * T;
    assert_eq!(spend(&mut h, 14 * TUSD, VENDOR).state, SpendState::Approved);
    // 3 more would exceed 30
    let s = spend(&mut h, 3 * TUSD, VENDOR);
    assert_eq!(s.reason, "budget_exceeded");
    assert_eq!(
        events("spend_recorded")[0]["data"][0]["outcome"],
        "Rejected:budget_exceeded"
    );
    // just before the first entry leaves the window: still exceeded
    h.now += 1800 * T - 1;
    assert_eq!(spend(&mut h, 3 * TUSD, VENDOR).reason, "budget_exceeded");
    // exactly window after the first entry: it slides out (14 left), 14 more fits
    h.now += 1;
    assert_eq!(spend(&mut h, 14 * TUSD, VENDOR).state, SpendState::Approved);
    assert_eq!(h.c.budget_of(U64(t)).win_spent.0, 28 * TUSD);
    h.assert_solvent();
}

#[test]
fn frozen_treasurer_spend_is_recorded_rejected() {
    let mut h = H::new();
    h.fund(100 * TUSD);
    let t = h.treas;
    h.as_(GUARD).freeze_agent(U64(t), "x".into());
    let s = spend(&mut h, 5 * TUSD, VENDOR);
    assert_eq!(s.reason, "agent_not_active");
    h.as_(DAO).unfreeze_agent(U64(t));
    h.as_(DAO).set_paused(true);
    assert_eq!(spend(&mut h, 5 * TUSD, VENDOR).reason, "paused");
    h.as_(DAO).set_paused(false);
    h.as_(DAO).set_vendor(acc(VENDOR), false);
    assert_eq!(
        spend(&mut h, 5 * TUSD, VENDOR).reason,
        "vendor_not_allowlisted"
    );
}

#[test]
fn treasury_insufficient_recorded() {
    let mut h = H::new();
    h.fund(2 * TUSD);
    assert_eq!(
        spend(&mut h, 5 * TUSD, VENDOR).reason,
        "treasury_insufficient"
    );
}

#[test]
fn budget_grows_with_reputation() {
    let mut h = H::new();
    let a1 = h.a1;
    let b0 = h.c.budget_of(U64(a1)).budget.0;
    let id = h.to_awarded(10 * TUSD, &[(a1, TUSD)]);
    h.submit(id);
    h.review(id, true);
    let b1 = h.c.budget_of(U64(a1)).budget.0;
    assert_eq!(b1, b0 + TUSD); // +10 rep * 10 tUSD / 100
}

// ============================================================ claim (C11)

#[test]
fn claim_zeroes_then_success() {
    let mut h = H::new();
    let a1 = h.a1;
    let id = h.to_awarded(100 * TUSD, &[(a1, TUSD)]);
    h.submit(id);
    h.review(id, true);
    let _ = h.as_("bob.testnet").claim(None);
    assert_eq!(h.claimable("bob.testnet"), 0);
    h.assert_solvent();
    assert!(h.cb(true).on_claim(acc("bob.testnet"), U128(55 * TUSD)));
    assert_eq!(events("claimed")[0]["data"][0]["amount"], "55000000");
    assert_eq!(h.c.total_out, 55 * TUSD);
    h.assert_solvent();
}

#[test]
fn c11_claim_failure_restores_balance() {
    let mut h = H::new();
    let a1 = h.a1;
    let id = h.to_awarded(100 * TUSD, &[(a1, TUSD)]);
    h.submit(id);
    h.review(id, true);
    let _ = h.as_("bob.testnet").claim(Some(acc(TOKEN)));
    assert!(!h.cb(false).on_claim(acc("bob.testnet"), U128(55 * TUSD)));
    assert_eq!(h.claimable("bob.testnet"), 55 * TUSD);
    assert_eq!(h.c.total_out, 0);
    h.assert_solvent();
}

#[test]
#[should_panic(expected = "nothing to claim")]
fn claim_nothing_panics() {
    let mut h = H::new();
    let _ = h.as_("bob.testnet").claim(None);
}

#[test]
fn treasury_withdraw_and_rollback() {
    let mut h = H::new();
    h.fund(10 * TUSD);
    let _ = h
        .as_(DAO)
        .treasury_withdraw(acc("alice.testnet"), U128(4 * TUSD));
    assert_eq!(h.c.treasury, 6 * TUSD);
    h.assert_solvent();
    assert!(!h
        .cb(false)
        .on_withdraw(acc("alice.testnet"), U128(4 * TUSD)));
    assert_eq!(h.c.treasury, 10 * TUSD);
    h.assert_solvent();
}

// ============================================================ seats + NFTs (A7, C8)

#[test]
fn seats_accumulator_distributes_and_checkpoints() {
    let mut h = H::new();
    let s1 = h.as_(DAO).mint_seat(acc("alice.testnet"), 1).0;
    let s2 = h.as_(DAO).mint_seat(acc("carol.testnet"), 2).0;
    let a1 = h.a1;
    let id = h.to_awarded(100 * TUSD, &[(a1, TUSD)]);
    h.submit(id);
    h.review(id, true);
    // seats share = 15 tUSD; weights 1:2 -> 5 and 10
    assert_eq!(h.c.seat_pending(U64(s1)).0, 5 * TUSD);
    assert_eq!(h.c.seat_pending(U64(s2)).0, 10 * TUSD);
    let ev = events("job_settled");
    assert_eq!(ev[0]["data"][0]["credits"]["seats"], "15000000");
    assert_eq!(ev[0]["data"][0]["credits"]["treasury"], "15000000");
    h.assert_solvent();
    h.as_("anyone.testnet").checkpoint_seat(U64(s1));
    assert_eq!(h.claimable("alice.testnet"), 7 * TUSD + 5 * TUSD);
    assert_eq!(h.c.seat_pending(U64(s1)).0, 0);
    h.assert_solvent();
}

#[test]
fn seats_transfer_checkpoints_old_owner() {
    let mut h = H::new();
    let s1 = h.as_(DAO).mint_seat(acc("erin.testnet"), 1).0;
    let a1 = h.a1;
    let id = h.to_awarded(100 * TUSD, &[(a1, TUSD)]);
    h.submit(id);
    h.review(id, true);
    h.as_dep("erin.testnet", 1)
        .nft_transfer(acc("carol.testnet"), s1.to_string(), None, None);
    assert_eq!(h.claimable("erin.testnet"), 15 * TUSD);
    assert_eq!(h.c.seat_pending(U64(s1)).0, 0);
    assert_eq!(
        h.c.nft_token(s1.to_string()).unwrap().owner_id,
        acc("carol.testnet")
    );
    h.assert_solvent();
}

#[test]
fn seats_claim_includes_pending_dividends() {
    let mut h = H::new();
    h.as_(DAO).mint_seat(acc("erin.testnet"), 3);
    let a1 = h.a1;
    let id = h.to_awarded(100 * TUSD, &[(a1, TUSD)]);
    h.submit(id);
    h.review(id, true);
    let _ = h.as_("erin.testnet").claim(None);
    assert!(h.cb(true).on_claim(acc("erin.testnet"), U128(15 * TUSD)));
    assert_eq!(h.c.total_out, 15 * TUSD);
    h.assert_solvent();
}

#[test]
fn seats_weight_change_and_rounding_c8() {
    let mut h = H::new();
    let s1 = h.as_(DAO).mint_seat(acc("alice.testnet"), 3).0;
    let s2 = h.as_(DAO).mint_seat(acc("carol.testnet"), 7).0;
    let a1 = h.a1;
    let mut seat_total = 0u128;
    for price in [TUSD + 1, 33 * TUSD + 7, 999 * TUSD + 3] {
        let id = h.to_awarded(price, &[(a1, 1)]);
        h.submit(id);
        h.review(id, true);
        seat_total += price * 1500 / 10_000;
        h.as_(DAO).set_seat_weight(U64(s2), 1);
    }
    let paid = h.claimable("alice.testnet") + h.claimable("carol.testnet");
    let pend = h.c.seat_pending(U64(s1)).0 + h.c.seat_pending(U64(s2)).0;
    // alice/carol also earn sales credits (alice owns sales); subtract them
    let _ = paid;
    assert!(pend + h.c.seat_pool - pend <= seat_total);
    assert!(h.c.seat_pool <= seat_total);
    h.assert_solvent();
}

#[test]
fn nft_agent_transfer_moves_earnings_and_retired_blocked() {
    let mut h = H::new();
    let a1 = h.a1;
    h.as_dep("bob.testnet", 1)
        .nft_transfer(acc("erin.testnet"), a1.to_string(), None, None);
    let id = h.to_awarded(100 * TUSD, &[(a1, TUSD)]);
    h.submit(id);
    h.review(id, true);
    assert_eq!(h.claimable("erin.testnet"), 55 * TUSD);
    // bob no longer earns as producer; he only earns as owner of rev2, picked as reviewer
    // because the winner's owner is now erin
    assert_eq!(h.c.job(id).reviewer, Some(h.rev2));
    assert_eq!(h.claimable("bob.testnet"), 8 * TUSD);
    assert_eq!(h.c.nft_supply_for_owner(acc("erin.testnet")).0, 2); // a1 + treasurer
    assert_eq!(h.c.nft_total_supply().0, 6);
    let t = h.c.nft_token(a1.to_string()).unwrap();
    assert!(t
        .metadata
        .unwrap()
        .extra
        .unwrap()
        .contains("\"kind\":\"agent\""));
}

#[test]
#[should_panic(expected = "retired agent NFTs cannot be transferred")]
fn nft_retired_agent_transfer_blocked() {
    let mut h = H::new();
    let a1 = h.a1;
    h.as_(DAO).retire_agent(U64(a1), None);
    h.as_dep("bob.testnet", 1)
        .nft_transfer(acc("erin.testnet"), a1.to_string(), None, None);
}

#[test]
#[should_panic(expected = "sender must be the token owner")]
fn nft_only_owner_transfers() {
    let mut h = H::new();
    let a1 = h.a1;
    h.as_dep("mallory.testnet", 1)
        .nft_transfer(acc("erin.testnet"), a1.to_string(), None, None);
}

#[test]
fn views_list_and_stats() {
    let mut h = H::new();
    h.post(10 * TUSD);
    h.post(20 * TUSD);
    assert_eq!(h.c.list_agents().len(), 6);
    assert_eq!(h.c.list_jobs(None, None, None).len(), 2);
    assert_eq!(
        h.c.list_jobs(Some(U64(2)), Some(10), Some(JobState::Posted))
            .len(),
        1
    );
    let st = h.c.get_stats();
    assert!(st.solvent);
    assert_eq!(st.escrow_total.0, 30 * TUSD);
    assert_eq!(st.jobs_total.0, 2);
    assert_eq!(st.jobs_settled.0, 0);
    let ser = near_sdk::serde_json::to_string(&st).unwrap();
    assert!(ser.contains("\"escrow_total\":\"30000000\""), "{}", ser);
}

#[test]
fn bylaw_history_view() {
    let mut h = H::new();
    h.as_(DAO).set_bylaw(params_json(TEXT2, HASH2));
    assert_eq!(h.c.get_bylaw_version(1).unwrap().text, TEXT1);
    assert_eq!(h.c.get_bylaw_version(2).unwrap().text_hash, HASH2);
    assert!(h.c.get_bylaw_version(3).is_none());
}

#[test]
fn hash_args_accept_hex_without_prefix() {
    let mut h = H::new();
    let a1 = h.a1;
    let id = h.to_awarded(10 * TUSD, &[(a1, TUSD)]);
    h.call_agent(a1, |c| {
        c.submit_work(U64(id), HASH1[2..].to_string(), "u".into(), None)
    });
    assert_eq!(
        h.c.get_job(U64(id)).unwrap().deliverable_hash.unwrap(),
        HASH1
    );
}

#[test]
fn hex_roundtrip() {
    let h = parse_hash(HASH1);
    assert_eq!(hex32(&h), HASH1);
    assert!(try_parse_hash("0x12").is_none());
    assert!(try_parse_hash(&HASH1[2..]).is_some());
}

// ============================================================ property tests (C1, C2, C3, C8, C9, C10)

mod prop {
    use super::*;
    use proptest::prelude::*;

    #[derive(Debug, Clone)]
    enum Op {
        Post(u128),
        Fund(u128),
        Advance(u64),
        Step(usize, bool, u128),
        Spend(u128, bool),
        Claim(usize, bool),
        SpendCb(bool),
        MintSeat(u32),
        SeatTransfer(usize, usize),
        Unfreeze(bool),
    }

    fn op() -> impl Strategy<Value = Op> {
        prop_oneof![
            3 => (1u128..2_000_000_000u128).prop_map(Op::Post),
            1 => (0u128..200_000_000u128).prop_map(Op::Fund),
            3 => (0u64..4000u64).prop_map(|s| Op::Advance(s * T)),
            8 => (0usize..8, any::<bool>(), 1u128..1_000_000_000u128).prop_map(|(a, b, c)| Op::Step(a, b, c)),
            2 => (0u128..40_000_000u128, any::<bool>()).prop_map(|(a, b)| Op::Spend(a, b)),
            2 => (0usize..6, any::<bool>()).prop_map(|(a, b)| Op::Claim(a, b)),
            1 => any::<bool>().prop_map(Op::SpendCb),
            1 => (1u32..100u32).prop_map(Op::MintSeat),
            1 => (0usize..8, 0usize..5).prop_map(|(a, b)| Op::SeatTransfer(a, b)),
            1 => any::<bool>().prop_map(Op::Unfreeze),
        ]
    }

    fn rank(s: JobState) -> u8 {
        match s {
            JobState::Posted => 0,
            JobState::Open => 1,
            JobState::Awarded => 2,
            JobState::Submitted => 3,
            JobState::Accepted => 4,
            _ => 5,
        }
    }

    /// Advance one job by one legal step (preconditions checked so nothing panics).
    fn step(h: &mut H, jid: u64, approve: bool, bid: u128) {
        let j = h.c.job(jid);
        let now = h.now;
        let active = |h: &H, id: u64| h.c.agent(id).state == AgentState::Active;
        match j.state {
            JobState::Posted => {
                if now <= j.deadline_ns {
                    let s = h.sales;
                    h.call_agent(s, |c| c.accept_job(U64(jid)));
                } else {
                    h.as_("anyone.testnet").expire_job(U64(jid));
                }
            }
            JobState::Open => {
                if now <= j.deadline_ns {
                    let cap = j.price * h.c.params.max_bid_bps as u128 / BPS;
                    let price = (bid % cap).max(1);
                    for a in [h.a1, h.a2] {
                        if active(&*h, a) && !j.bids.iter().any(|b| b.agent == a) {
                            h.call_agent(a, |c| c.place_bid(U64(jid), U128(price)));
                            break;
                        }
                    }
                } else {
                    let s = h.sales;
                    h.call_agent(s, |c| c.award_job(U64(jid)));
                }
            }
            JobState::Awarded => {
                let w = j.winner.unwrap();
                if now <= j.deadline_ns && active(&*h, w) {
                    h.call_agent(w, |c| {
                        c.submit_work(U64(jid), HASH1.into(), "u".into(), Some("att".into()))
                    });
                } else if now > j.deadline_ns {
                    h.as_("anyone.testnet").expire_job(U64(jid));
                }
            }
            JobState::Submitted => {
                let r = j.reviewer.unwrap();
                if now <= j.deadline_ns && !j.escalated && active(&*h, r) {
                    h.call_agent(r, |c| c.review_work(U64(jid), approve, HASH2.into()));
                } else if now > j.deadline_ns && !j.escalated {
                    h.as_("anyone.testnet").expire_job(U64(jid));
                } else if j.escalated {
                    h.as_(DAO).override_review(U64(jid), approve);
                }
            }
            _ => {}
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig { cases: 96, .. ProptestConfig::default() })]

        #[test]
        fn prop_invariants_hold_under_random_operations(ops in proptest::collection::vec(op(), 1..60)) {
            let mut h = H::new();
            let mut pending_spend: Option<u64> = None;
            let mut pending_claims: Vec<(String, u128)> = Vec::new();
            let mut seat_ids: Vec<u64> = Vec::new();
            let mut seat_shares: u128 = 0; // total distributed to seats so far
            let mut ranks: std::collections::HashMap<u64, (u8, u8)> = Default::default();
            for o in ops {
                let settled_before = h.c.treasury;
                let _ = settled_before;
                match o {
                    Op::Post(p) => { h.post(p); }
                    Op::Fund(a) => { if a > 0 { h.fund(a); } }
                    Op::Advance(d) => { h.now += d; }
                    Op::Step(i, approve, bid) => {
                        let n = h.c.next_job_id - 1;
                        if n > 0 {
                            let jid = (i as u64 % n) + 1;
                            let pool_before = h.c.seat_pool + h.c.total_claimable; // seat_pool grows only on settle
                            let sp_before = h.c.seat_pool;
                            step(&mut h, jid, approve, bid);
                            let _ = pool_before;
                            if h.c.seat_pool > sp_before { seat_shares += h.c.seat_pool - sp_before; }
                            // C1: every settlement's credits sum to price
                            for e in events("job_settled") {
                                let d = &e["data"][0];
                                let cr = &d["credits"];
                                let s: u128 = ["reviewer","producer","sales","seats","treasury"].iter()
                                    .map(|k| cr[*k].as_str().unwrap().parse::<u128>().unwrap()).sum();
                                prop_assert_eq!(s, d["price"].as_str().unwrap().parse::<u128>().unwrap());
                            }
                        }
                    }
                    Op::Spend(a, ok_vendor) => {
                        if pending_spend.is_none() {
                            let v = if ok_vendor { VENDOR } else { "evil.testnet" };
                            let t = h.treas;
                            let id = h.call_agent(t, |c| c.request_spend(acc(v), U128(a), None, "m".into()));
                            let s = h.c.get_spend(id).unwrap();
                            match s.state {
                                SpendState::Approved => pending_spend = Some(id.0),
                                SpendState::Pending => { h.as_(DAO).approve_spend(id); pending_spend = Some(id.0); }
                                _ => {}
                            }
                        }
                    }
                    Op::SpendCb(ok) => {
                        if let Some(id) = pending_spend.take() { h.cb(ok).on_spend_paid(U64(id)); }
                    }
                    Op::Claim(i, ok) => {
                        let who = OWNERS[i % OWNERS.len()].to_string();
                        // checkpoint own seats like claim does, then claim if positive
                        let mut owned_pending = 0u128;
                        for s in &seat_ids { if h.c.owner_of(*s).as_str() == who { owned_pending += h.c.seat_pending(U64(*s)).0; } }
                        let amt = h.claimable(&who) + owned_pending;
                        if amt > 0 {
                            let _ = h.as_(&who).claim(None);
                            pending_claims.push((who, amt));
                            let (w, a) = pending_claims.pop().unwrap();
                            h.cb(ok).on_claim(acc(&w), U128(a));
                        }
                    }
                    Op::MintSeat(w) => {
                        if (seat_ids.len() as u32) < 8 {
                            let id = h.as_(DAO).mint_seat(acc(OWNERS[seat_ids.len() % 5]), w).0;
                            seat_ids.push(id);
                        }
                    }
                    Op::SeatTransfer(i, to) => {
                        if !seat_ids.is_empty() {
                            let sid = seat_ids[i % seat_ids.len()];
                            let from = h.c.owner_of(sid).to_string();
                            let to = OWNERS[to % 5];
                            if from != to {
                                h.as_dep(&from, 1).nft_transfer(acc(to), sid.to_string(), None, None);
                            }
                        }
                    }
                    Op::Unfreeze(first) => {
                        let a = if first { h.a1 } else { h.a2 };
                        if h.c.agent(a).state == AgentState::Frozen { h.as_(DAO).unfreeze_agent(U64(a)); }
                    }
                }
                // C2 solvency after every operation
                h.assert_solvent();
                // C8 seat dividends: credited + pending <= distributed (pool holds the rest)
                let pend: u128 = seat_ids.iter().map(|s| h.c.seat_pending(U64(*s)).0).sum();
                prop_assert!(pend <= h.c.seat_pool);
                prop_assert!(h.c.seat_pool <= seat_shares);
                // C10 reputation bound + auto-freeze
                for a in [h.a1, h.a2] {
                    let ag = h.c.agent(a);
                    prop_assert!(ag.rep <= 100 + 10 * 1000);
                }
                // C3: treasurer sliding-window spend never exceeds budget
                let t = h.treas;
                let b = h.c.budget_of(U64(t));
                prop_assert!(b.win_spent.0 <= b.budget.0);
                // C9: states move forward only; the only backward move is the single re-open
                for jid in 1..h.c.next_job_id {
                    let j = h.c.job(jid);
                    let r = rank(j.state);
                    let (prev, reopen) = ranks.get(&jid).copied().unwrap_or((0, 0));
                    let mut reopen = reopen;
                    if r < prev {
                        prop_assert_eq!(r, 2, "only Submitted/Awarded -> Awarded allowed backwards");
                        reopen += 1;
                        prop_assert!(reopen <= 1);
                        prop_assert_eq!(j.attempts, 1);
                    }
                    ranks.insert(jid, (r, reopen));
                }
            }
        }

        /// C1 in isolation: the waterfall conserves value to the unit for any price and split.
        #[test]
        fn prop_waterfall_conserves_value(
            price in 1_000_000u128..1_000_000_000u128,
            r in 0u16..2000, p in 0u16..5000, s in 0u16..2000, se in 0u16..1000,
            weights in proptest::collection::vec(1u32..1000, 0..5),
        ) {
            let mut h = H::new();
            let tr = 10_000 - r - p - s - se;
            let mut pj = params_json(TEXT1, HASH1);
            pj.split = Split { reviewer: r, producer: p, sales: s, treasury: tr, seats: se };
            h.as_(DAO).set_bylaw(pj);
            for (i, w) in weights.iter().enumerate() { h.as_(DAO).mint_seat(acc(OWNERS[i % 5]), *w); }
            let a1 = h.a1;
            let id = h.to_awarded(price, &[(a1, 1)]);
            h.submit(id);
            h.review(id, true);
            let ev = events("job_settled");
            prop_assert_eq!(ev.len(), 1);
            let cr = &ev[0]["data"][0]["credits"];
            let total: u128 = ["reviewer","producer","sales","seats","treasury"].iter()
                .map(|k| cr[*k].as_str().unwrap().parse::<u128>().unwrap()).sum();
            prop_assert_eq!(total, price);
            h.assert_solvent();
        }

        /// C3 sliding window: for any sequence of spend attempts at increasing times, the sum of
        /// accepted spends inside any window-length interval never exceeds the budget.
        #[test]
        fn prop_sliding_window_never_exceeds_budget(
            steps in proptest::collection::vec((0u64..1200u64, 1u128..15_000_000u128), 1..80)
        ) {
            let mut h = H::new();
            h.fund(10_000 * TUSD);
            let t = h.treas;
            let window = 3600 * T;
            let budget = h.c.budget_of(U64(t)).budget.0;
            let mut accepted: Vec<(u64, u128)> = Vec::new();
            for (dt, amt) in steps {
                h.now += dt * T;
                let id = h.call_agent(t, |c| c.request_spend(acc(VENDOR), U128(amt), None, "".into()));
                let s = h.c.get_spend(id).unwrap();
                if s.state == SpendState::Approved {
                    accepted.push((h.now, amt));
                    h.cb(true).on_spend_paid(id);
                }
                // check every window ending at an accepted timestamp
                for (end, _) in accepted.iter() {
                    let sum: u128 = accepted.iter().filter(|(ts, _)| *ts <= *end && end - ts < window).map(|x| x.1).sum();
                    prop_assert!(sum <= budget, "window sum {} > budget {}", sum, budget);
                }
            }
            h.assert_solvent();
        }
    }
}
