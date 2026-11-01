//! `escrow-policy` — campaign budgets for agent hires (flow 3). The contract holds the budget and is
//! the payer, so per-payment limits, the daily limit and the payee allowlist are enforced on chain
//! (architecture rule 7). The campaign's agent signs `pay` with a function-call key; anything over
//! the automatic limits waits for the owner's approval. Spec: docs/contracts.md, ADR 0009.

use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};

const DAY_NS: u64 = 24 * 60 * 60 * 1_000_000_000;
const GAS_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(30);
/// Smallest campaign funding (1 nUSD): keeps storage spam expensive (security review M1).
const MIN_FUND: u128 = 1_000_000;
const MAX_ALLOWLIST: usize = 50;

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Policy {
    /// Payments up to this amount go out without approval (if allowlisted and under the daily limit).
    pub auto_limit: U128,
    pub daily_limit: U128,
    pub allowlist: Vec<AccountId>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CampaignStatus {
    Open,
    Closed,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Campaign {
    pub campaign_id: String,
    pub owner_id: AccountId,
    pub agent_id: AccountId,
    pub budget: U128,
    pub spent: U128,
    pub reserved: U128,
    pub policy: Policy,
    pub status: CampaignStatus,
    pub day: U64,
    pub spent_today: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PaymentStatus {
    Pending,
    Sending,
    Paid,
    Rejected,
    Failed,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Payment {
    pub payment_id: U64,
    pub campaign_id: String,
    pub payee_id: AccountId,
    pub amount: U128,
    pub fee: U128,
    pub memo: String,
    pub status: PaymentStatus,
    /// Paid within the automatic limits (counted against today's limit when queued).
    pub auto: bool,
    pub created_at: U64,
}

#[near(serializers = [json])]
struct FundMsg {
    action: String,
    campaign_id: String,
    agent_id: Option<AccountId>,
    policy: Option<Policy>,
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
    token_id: AccountId,
    treasury_id: AccountId,
    /// Payees under `.<handles_root>` are Nearchant seller accounts and pay the agent-economy fee.
    handles_root: AccountId,
    agent_fee_bps: u16,
    campaigns: LookupMap<String, Campaign>,
    payments: LookupMap<u64, Payment>,
    next_payment: u64,
}

fn event(name: &str, data: serde_json::Value) {
    let ev = json!({"standard": "nearchant", "version": "1.0.0", "event": name, "data": [data]});
    env::log_str(&format!("EVENT_JSON:{ev}"));
}

fn check_policy(p: &Policy) {
    require!(p.allowlist.len() <= MAX_ALLOWLIST, "allowlist too long");
    require!(p.auto_limit.0 <= p.daily_limit.0, "auto_limit must not exceed daily_limit");
}

#[near]
impl Contract {
    #[init]
    #[private]
    pub fn new(owner_id: AccountId, token_id: AccountId, treasury_id: AccountId, handles_root: AccountId) -> Self {
        Self {
            owner_id,
            token_id,
            treasury_id,
            handles_root,
            agent_fee_bps: 500,
            campaigns: LookupMap::new(b"c"),
            payments: LookupMap::new(b"p"),
            next_payment: 1,
        }
    }

    /// Called by the campaign's agent. Pays now if within policy, otherwise queues for approval.
    /// Returns the payment record.
    pub fn pay(&mut self, campaign_id: String, payee_id: AccountId, amount: U128, memo: String) -> Payment {
        require!(amount.0 > 0, "amount must be positive");
        require!(memo.len() <= 200, "memo too long");
        let now = env::block_timestamp();
        let c = self.campaigns.get_mut(&campaign_id).expect("no such campaign");
        require!(c.status == CampaignStatus::Open, "campaign closed");
        require!(env::predecessor_account_id() == c.agent_id, "campaign agent only");
        if now / DAY_NS != c.day.0 {
            c.day = U64(now / DAY_NS);
            c.spent_today = U128(0);
        }
        let available = c.budget.0 - c.spent.0 - c.reserved.0;
        require!(amount.0 <= available, "over budget");
        let auto = c.policy.allowlist.contains(&payee_id)
            && amount.0 <= c.policy.auto_limit.0
            && c.spent_today.0 + amount.0 <= c.policy.daily_limit.0;
        c.reserved = U128(c.reserved.0 + amount.0);
        if auto {
            // Count in-flight automatic payments now, so two in one block can't both pass the limit.
            c.spent_today = U128(c.spent_today.0 + amount.0);
        }
        let id = self.next_payment;
        self.next_payment += 1;
        let fee = self.fee_for(&payee_id, amount.0);
        let p = Payment {
            payment_id: U64(id),
            campaign_id: campaign_id.clone(),
            payee_id,
            amount,
            fee: U128(fee),
            memo,
            status: PaymentStatus::Pending,
            auto,
            created_at: U64(now),
        };
        self.payments.insert(id, p.clone());
        if auto {
            self.send(id).detach();
            let mut p = p;
            p.status = PaymentStatus::Sending;
            p
        } else {
            event("payment_pending", json!({"payment_id": U64(id), "campaign_id": campaign_id, "amount": amount}));
            p
        }
    }

    /// The campaign owner approves a queued payment (bypasses the automatic limits, not the budget).
    pub fn approve(&mut self, payment_id: U64) -> Promise {
        let p = self.payments.get(&payment_id.0).expect("no such payment").clone();
        require!(p.status == PaymentStatus::Pending, "payment not pending");
        let c = self.campaigns.get(&p.campaign_id).expect("campaign");
        require!(env::predecessor_account_id() == c.owner_id, "campaign owner only");
        event("payment_approved", json!({"payment_id": payment_id}));
        self.send(payment_id.0)
    }

    pub fn reject(&mut self, payment_id: U64) {
        let p = self.payments.get_mut(&payment_id.0).expect("no such payment");
        require!(p.status == PaymentStatus::Pending, "payment not pending");
        let c = self.campaigns.get_mut(&p.campaign_id).expect("campaign");
        require!(env::predecessor_account_id() == c.owner_id, "campaign owner only");
        c.reserved = U128(c.reserved.0 - p.amount.0);
        p.status = PaymentStatus::Rejected;
        event("payment_rejected", json!({"payment_id": payment_id}));
    }

    pub fn set_policy(&mut self, campaign_id: String, policy: Policy) {
        check_policy(&policy);
        let c = self.campaigns.get_mut(&campaign_id).expect("no such campaign");
        require!(env::predecessor_account_id() == c.owner_id, "campaign owner only");
        c.policy = policy;
        event("policy_set", json!({"campaign_id": campaign_id}));
    }

    /// Owner closes the campaign and gets the unused budget back. Pending payments must be resolved.
    pub fn close(&mut self, campaign_id: String) -> Option<Promise> {
        let c = self.campaigns.get_mut(&campaign_id).expect("no such campaign");
        require!(env::predecessor_account_id() == c.owner_id, "campaign owner only");
        require!(c.status == CampaignStatus::Open, "already closed");
        require!(c.reserved.0 == 0, "resolve pending payments first");
        c.status = CampaignStatus::Closed;
        let left = c.budget.0 - c.spent.0;
        let owner = c.owner_id.clone();
        event("campaign_closed", json!({"campaign_id": campaign_id, "refund": U128(left)}));
        (left > 0).then(|| {
            ext_ft::ext(self.token_id.clone())
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(GAS_TRANSFER)
                .ft_transfer(owner, U128(left), Some(format!("campaign {campaign_id} refund")))
        })
    }

    pub fn get_campaign(&self, campaign_id: String) -> Option<Campaign> {
        self.campaigns.get(&campaign_id).cloned()
    }

    pub fn get_payment(&self, payment_id: U64) -> Option<Payment> {
        self.payments.get(&payment_id.0).cloned()
    }

    pub fn get_agent_fee_bps(&self) -> u16 {
        self.agent_fee_bps
    }

    pub fn set_agent_fee_bps(&mut self, bps: u16) {
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
        require!(bps <= 1000, "fee capped at 10%");
        self.agent_fee_bps = bps;
    }

    #[private]
    pub fn on_sent(&mut self, payment_id: U64, #[callback_result] done: Result<(), PromiseError>) -> bool {
        let p = self.payments.get_mut(&payment_id.0).expect("payment");
        let c = self.campaigns.get_mut(&p.campaign_id).expect("campaign");
        c.reserved = U128(c.reserved.0 - p.amount.0);
        let today = env::block_timestamp() / DAY_NS == c.day.0;
        if done.is_ok() {
            c.spent = U128(c.spent.0 + p.amount.0);
            if !p.auto && today {
                c.spent_today = U128(c.spent_today.0 + p.amount.0);
            }
            p.status = PaymentStatus::Paid;
            if p.fee.0 > 0 {
                ext_ft::ext(self.token_id.clone())
                    .with_attached_deposit(NearToken::from_yoctonear(1))
                    .with_static_gas(GAS_TRANSFER)
                    .ft_transfer(self.treasury_id.clone(), p.fee, Some(format!("agent fee {}", payment_id.0)))
                    .detach();
            }
            event("payment_made", json!({"payment_id": payment_id, "campaign_id": p.campaign_id,
                "payee_id": p.payee_id, "amount": p.amount, "fee": p.fee}));
            true
        } else {
            if p.auto && today {
                c.spent_today = U128(c.spent_today.0.saturating_sub(p.amount.0));
            }
            p.status = PaymentStatus::Failed;
            event("payment_failed", json!({"payment_id": payment_id}));
            false
        }
    }

    fn fee_for(&self, payee: &AccountId, amount: u128) -> u128 {
        let suffix = format!(".{}", self.handles_root);
        if payee.as_str().ends_with(&suffix) {
            amount * self.agent_fee_bps as u128 / 10_000
        } else {
            0
        }
    }

    fn send(&mut self, id: u64) -> Promise {
        let p = self.payments.get_mut(&id).expect("payment");
        p.status = PaymentStatus::Sending;
        let (payee, net) = (p.payee_id.clone(), p.amount.0 - p.fee.0);
        let memo = Some(format!("nearchant hire {}", p.payment_id.0));
        // Net to the payee first; the fee goes to the treasury only after that succeeded (security review H4).
        ext_ft::ext(self.token_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_TRANSFER)
            .ft_transfer(payee, U128(net), memo)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_sent(U64(id)))
    }
}

#[near]
impl FungibleTokenReceiver for Contract {
    /// `msg` = `{"action": "fund", "campaign_id", "agent_id"?, "policy"?}`. A new campaign needs
    /// `agent_id`; a top-up must come from the campaign owner.
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.token_id, "token not accepted");
        let Ok(m) = serde_json::from_str::<FundMsg>(&msg) else {
            return PromiseOrValue::Value(amount);
        };
        if m.action != "fund" || m.campaign_id.is_empty() || m.campaign_id.len() > 128 || amount.0 < MIN_FUND {
            return PromiseOrValue::Value(amount);
        }
        if let Some(c) = self.campaigns.get_mut(&m.campaign_id) {
            if c.owner_id != sender_id || c.status != CampaignStatus::Open {
                return PromiseOrValue::Value(amount);
            }
            c.budget = U128(c.budget.0 + amount.0);
        } else {
            let Some(agent_id) = m.agent_id else {
                return PromiseOrValue::Value(amount);
            };
            let policy = m.policy.unwrap_or(Policy {
                auto_limit: U128(2_000_000),
                daily_limit: U128(20_000_000),
                allowlist: vec![],
            });
            check_policy(&policy);
            self.campaigns.insert(m.campaign_id.clone(), Campaign {
                campaign_id: m.campaign_id.clone(),
                owner_id: sender_id.clone(),
                agent_id,
                budget: amount,
                spent: U128(0),
                reserved: U128(0),
                policy,
                status: CampaignStatus::Open,
                day: U64(env::block_timestamp() / DAY_NS),
                spent_today: U128(0),
            });
        }
        event("campaign_funded", json!({"campaign_id": m.campaign_id, "owner_id": sender_id, "amount": amount}));
        PromiseOrValue::Value(U128(0))
    }
}
