//! `billing` — prepaid balances for metered inference (flow 2). Users top up with `ft_transfer_call`;
//! the gateway's relayer settles usage in batches, each carrying the Merkle root of the signed usage
//! records so any single charge can be proven. Caps are enforced here, not only in the gateway.

use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};

const DAY_NS: u64 = 24 * 60 * 60 * 1_000_000_000;
const MONTH_NS: u64 = 30 * DAY_NS;
const MAX_ENTRIES: usize = 100;
const GAS_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);

#[near(serializers = [borsh])]
#[derive(Default, Clone)]
struct Acct {
    balance: u128,
    daily_cap: u128,
    monthly_cap: u128,
    day: u64,
    spent_today: u128,
    month: u64,
    spent_month: u128,
}

#[near(serializers = [json])]
pub struct AccountView {
    pub balance: U128,
    pub daily_cap: U128,
    pub monthly_cap: U128,
    pub spent_today: U128,
    pub spent_month: U128,
}

#[near(serializers = [json])]
pub struct UsageEntry {
    pub account_id: AccountId,
    pub amount: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Batch {
    pub merkle_root: String,
    pub settled_at: U64,
    pub charged: U128,
}

#[near(serializers = [json])]
struct TopUpMsg {
    action: String,
    account_id: Option<AccountId>,
}

#[allow(dead_code)]
#[ext_contract(ext_ft)]
trait Ft {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    relayer_id: AccountId,
    token_id: AccountId,
    treasury_id: AccountId,
    accounts: LookupMap<AccountId, Acct>,
    batches: LookupMap<String, Batch>,
    treasury_owed: u128,
}

fn event(name: &str, data: serde_json::Value) {
    let ev = json!({"standard": "nearchant", "version": "1.0.0", "event": name, "data": [data]});
    env::log_str(&format!("EVENT_JSON:{ev}"));
}

impl Acct {
    fn roll(&mut self, now: u64) {
        if now / DAY_NS != self.day {
            self.day = now / DAY_NS;
            self.spent_today = 0;
        }
        if now / MONTH_NS != self.month {
            self.month = now / MONTH_NS;
            self.spent_month = 0;
        }
    }

    /// How much of `amount` can be charged now under balance and caps (0 cap = no cap).
    fn chargeable(&self, amount: u128) -> u128 {
        let mut c = amount.min(self.balance);
        if self.daily_cap > 0 {
            c = c.min(self.daily_cap.saturating_sub(self.spent_today));
        }
        if self.monthly_cap > 0 {
            c = c.min(self.monthly_cap.saturating_sub(self.spent_month));
        }
        c
    }
}

#[near]
impl Contract {
    #[init]
    #[private]
    pub fn new(owner_id: AccountId, relayer_id: AccountId, token_id: AccountId, treasury_id: AccountId) -> Self {
        Self {
            owner_id,
            relayer_id,
            token_id,
            treasury_id,
            accounts: LookupMap::new(b"a"),
            batches: LookupMap::new(b"b"),
            treasury_owed: 0,
        }
    }

    pub fn set_caps(&mut self, daily: U128, monthly: U128) {
        let id = env::predecessor_account_id();
        let a = self.accounts.get_mut(&id).expect("no billing account: top up first");
        a.daily_cap = daily.0;
        a.monthly_cap = monthly.0;
        event("caps_set", json!({"account_id": id, "daily": daily, "monthly": monthly}));
    }

    /// Relayer only. Charges each entry up to balance and caps; the rest is reported as `unpaid` so
    /// the gateway stops hosted calls. Re-sending a settled `batch_id` is a no-op.
    pub fn settle_batch(&mut self, batch_id: String, merkle_root: String, entries: Vec<UsageEntry>) -> U128 {
        require!(env::predecessor_account_id() == self.relayer_id, "relayer only");
        require!(!batch_id.is_empty() && batch_id.len() <= 128, "bad batch_id");
        require!(merkle_root.len() == 64 && merkle_root.bytes().all(|c| c.is_ascii_hexdigit()), "merkle_root must be 32-byte hex");
        require!(entries.len() <= MAX_ENTRIES, "too many entries");
        if let Some(b) = self.batches.get(&batch_id) {
            return b.charged;
        }
        let now = env::block_timestamp();
        let mut total = 0u128;
        for e in entries {
            let mut a = self.accounts.get(&e.account_id).cloned().unwrap_or_default();
            a.roll(now);
            let charged = a.chargeable(e.amount.0);
            a.balance -= charged;
            a.spent_today += charged;
            a.spent_month += charged;
            total += charged;
            self.accounts.insert(e.account_id.clone(), a);
            event("usage_settled", json!({
                "batch_id": batch_id, "merkle_root": merkle_root, "account_id": e.account_id,
                "charged": U128(charged), "unpaid": U128(e.amount.0 - charged),
            }));
        }
        self.treasury_owed += total;
        self.batches.insert(batch_id, Batch { merkle_root, settled_at: U64(now), charged: U128(total) });
        U128(total)
    }

    /// Sends settled charges to the treasury. Anyone may call it.
    pub fn sweep(&mut self) -> Option<Promise> {
        let amount = std::mem::take(&mut self.treasury_owed);
        if amount == 0 {
            return None;
        }
        Some(self.transfer(self.treasury_id.clone(), amount, true))
    }

    /// Withdraws unused balance back to the caller.
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        let id = env::predecessor_account_id();
        let a = self.accounts.get_mut(&id).expect("no billing account");
        require!(amount.0 > 0 && amount.0 <= a.balance, "not enough balance");
        a.balance -= amount.0;
        event("balance_withdrawn", json!({"account_id": id, "amount": amount}));
        self.transfer(id, amount.0, false)
    }

    pub fn get_account(&self, account_id: AccountId) -> Option<AccountView> {
        self.accounts.get(&account_id).map(|a| {
            let mut a = a.clone();
            a.roll(env::block_timestamp());
            AccountView {
                balance: U128(a.balance),
                daily_cap: U128(a.daily_cap),
                monthly_cap: U128(a.monthly_cap),
                spent_today: U128(a.spent_today),
                spent_month: U128(a.spent_month),
            }
        })
    }

    pub fn get_batch(&self, batch_id: String) -> Option<Batch> {
        self.batches.get(&batch_id).cloned()
    }

    pub fn treasury_owed(&self) -> U128 {
        U128(self.treasury_owed)
    }

    pub fn set_relayer(&mut self, relayer_id: AccountId) {
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
        self.relayer_id = relayer_id;
    }

    #[private]
    pub fn on_transfer(
        &mut self,
        to: AccountId,
        amount: U128,
        to_treasury: bool,
        #[callback_result] done: Result<(), PromiseError>,
    ) -> bool {
        if done.is_ok() {
            return true;
        }
        if to_treasury {
            self.treasury_owed += amount.0;
        } else if let Some(a) = self.accounts.get_mut(&to) {
            a.balance += amount.0;
        }
        false
    }

    fn transfer(&self, to: AccountId, amount: u128, to_treasury: bool) -> Promise {
        ext_ft::ext(self.token_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_TRANSFER)
            .ft_transfer(to.clone(), U128(amount), Some("nearchant billing".into()))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_transfer(to, U128(amount), to_treasury))
    }
}

#[near]
impl FungibleTokenReceiver for Contract {
    /// `msg` = `{"action": "top_up", "account_id"?: "..."}` (default: the sender).
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.token_id, "token not accepted");
        let Ok(m) = serde_json::from_str::<TopUpMsg>(&msg) else {
            return PromiseOrValue::Value(amount);
        };
        if m.action != "top_up" {
            return PromiseOrValue::Value(amount);
        }
        let id = m.account_id.unwrap_or(sender_id.clone());
        let mut a = self.accounts.get(&id).cloned().unwrap_or_default();
        a.balance += amount.0;
        self.accounts.insert(id.clone(), a);
        event("balance_topped_up", json!({"account_id": id, "from": sender_id, "amount": amount}));
        PromiseOrValue::Value(U128(0))
    }
}
