//! mock-ft: minimal NEP-141 "tUSD" (6 decimals) with an open, capped `mint` faucet.
//! NEP-145 style registration: `storage_deposit` registers an account; `mint` auto-registers
//! the receiver (open faucet). `ft_transfer` to an unregistered account panics, which lets
//! tests exercise the Charter `claim` rollback path (invariant C11).
use near_sdk::borsh::BorshSerialize;
use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseOrValue,
};

/// Max mint per call: 1,000,000 tUSD (6 decimals).
pub const MAX_MINT_PER_CALL: u128 = 1_000_000_000_000;
pub const STORAGE_MIN: u128 = 1_250_000_000_000_000_000_000; // 0.00125 NEAR

#[derive(BorshStorageKey, BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
enum Sk {
    Balances,
}

#[ext_contract(ext_receiver)]
pub trait Receiver {
    fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128>;
}

#[ext_contract(ext_self)]
pub trait SelfCb {
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128;
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct FungibleTokenMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
    pub decimals: u8,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct StorageBalanceBounds {
    pub min: U128,
    pub max: Option<U128>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockFt {
    balances: LookupMap<AccountId, u128>,
    total_supply: u128,
}

#[near]
impl MockFt {
    #[init]
    pub fn new() -> Self {
        Self {
            balances: LookupMap::new(Sk::Balances),
            total_supply: 0,
        }
    }

    /// Open faucet: anyone may mint up to MAX_MINT_PER_CALL to any account (registers it).
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(
            amount.0 > 0 && amount.0 <= MAX_MINT_PER_CALL,
            "amount must be in 1..=1_000_000 tUSD per call"
        );
        let bal = self.balances.get(&account_id).copied().unwrap_or(0);
        self.balances.insert(account_id, bal + amount.0);
        self.total_supply += amount.0;
    }

    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        let _ = registration_only;
        let id = account_id.unwrap_or_else(env::predecessor_account_id);
        let dep = env::attached_deposit().as_yoctonear();
        if self.balances.contains_key(&id) {
            if dep > 0 {
                let _ = Promise::new(env::predecessor_account_id())
                    .transfer(NearToken::from_yoctonear(dep));
            }
        } else {
            require!(dep >= STORAGE_MIN, "attach at least 0.00125 NEAR");
            self.balances.insert(id, 0);
            if dep > STORAGE_MIN {
                let _ = Promise::new(env::predecessor_account_id())
                    .transfer(NearToken::from_yoctonear(dep - STORAGE_MIN));
            }
        }
        StorageBalance {
            total: U128(STORAGE_MIN),
            available: U128(0),
        }
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.balances
            .contains_key(&account_id)
            .then(|| StorageBalance {
                total: U128(STORAGE_MIN),
                available: U128(0),
            })
    }

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds {
            min: U128(STORAGE_MIN),
            max: Some(U128(STORAGE_MIN)),
        }
    }

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        near_sdk::assert_one_yocto();
        let _ = memo;
        let sender = env::predecessor_account_id();
        self.internal_transfer(&sender, &receiver_id, amount.0);
    }

    #[payable]
    pub fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        near_sdk::assert_one_yocto();
        let _ = memo;
        let sender = env::predecessor_account_id();
        self.internal_transfer(&sender, &receiver_id, amount.0);
        ext_receiver::ext(receiver_id.clone())
            .with_static_gas(Gas::from_tgas(60))
            .ft_on_transfer(sender.clone(), amount, msg)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(10))
                    .ft_resolve_transfer(sender, receiver_id, amount),
            )
            .into()
    }

    #[private]
    pub fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let unused = match env::promise_result_checked(0, 128) {
            Ok(v) => near_sdk::serde_json::from_slice::<U128>(&v)
                .map(|x| x.0.min(amount.0))
                .unwrap_or(amount.0),
            Err(_) => amount.0,
        };
        if unused > 0 {
            let rb = self.balances.get(&receiver_id).copied().unwrap_or(0);
            let refund = unused.min(rb);
            if refund > 0 {
                self.balances.insert(receiver_id, rb - refund);
                let sb = self.balances.get(&sender_id).copied().unwrap_or(0);
                self.balances.insert(sender_id, sb + refund);
            }
            return U128(amount.0 - refund);
        }
        amount
    }

    pub fn ft_total_supply(&self) -> U128 {
        U128(self.total_supply)
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balances.get(&account_id).copied().unwrap_or(0))
    }

    pub fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: "ft-1.0.0".into(),
            name: "Charter test USD".into(),
            symbol: "tUSD".into(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        }
    }
}

impl MockFt {
    fn internal_transfer(&mut self, from: &AccountId, to: &AccountId, amount: u128) {
        require!(amount > 0, "amount must be positive");
        require!(from != to, "sender and receiver must differ");
        let fb = self.balances.get(from).copied().unwrap_or(0);
        require!(fb >= amount, "insufficient balance");
        require!(
            self.balances.contains_key(to),
            "receiver is not registered (storage_deposit first)"
        );
        let tb = self.balances.get(to).copied().unwrap_or(0);
        self.balances.insert(from.clone(), fb - amount);
        self.balances.insert(to.clone(), tb + amount);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn ctx(pred: &str, dep: u128) {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(acc(pred))
            .attached_deposit(NearToken::from_yoctonear(dep));
        testing_env!(b.build());
    }

    #[test]
    fn mint_transfer_and_metadata() {
        ctx("alice.testnet", 0);
        let mut c = MockFt::new();
        c.mint(acc("alice.testnet"), U128(5_000_000));
        c.mint(acc("bob.testnet"), U128(1));
        ctx("alice.testnet", 1);
        c.ft_transfer(acc("bob.testnet"), U128(2_000_000), None);
        assert_eq!(c.ft_balance_of(acc("alice.testnet")).0, 3_000_000);
        assert_eq!(c.ft_balance_of(acc("bob.testnet")).0, 2_000_001);
        assert_eq!(c.ft_total_supply().0, 5_000_001);
        assert_eq!(c.ft_metadata().decimals, 6);
    }

    #[test]
    #[should_panic(expected = "amount must be in")]
    fn mint_cap() {
        ctx("alice.testnet", 0);
        let mut c = MockFt::new();
        c.mint(acc("alice.testnet"), U128(MAX_MINT_PER_CALL + 1));
    }

    #[test]
    #[should_panic(expected = "not registered")]
    fn unregistered_receiver_fails() {
        ctx("alice.testnet", 0);
        let mut c = MockFt::new();
        c.mint(acc("alice.testnet"), U128(10));
        ctx("alice.testnet", 1);
        c.ft_transfer(acc("nobody.testnet"), U128(5), None);
    }

    #[test]
    fn storage_deposit_registers() {
        ctx("alice.testnet", STORAGE_MIN);
        let mut c = MockFt::new();
        c.storage_deposit(Some(acc("bob.testnet")), None);
        assert!(c.storage_balance_of(acc("bob.testnet")).is_some());
    }
}
