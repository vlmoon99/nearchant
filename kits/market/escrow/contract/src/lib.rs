//! `escrow` — buyer payments for goods and services, held until delivery.
//!
//! An order is created only by `ft_transfer_call` from an allowlisted NEP-141 token, with
//! `msg = {"order_id": "...", "seller": "..."}`. The money is released to the seller when the buyer
//! accepts, or automatically once the release window after delivery has passed. A seller who never
//! delivers is refunded automatically after the delivery window. Amounts are `U128` strings.
//!
//! Two optional add-ons, both set at init (or later by the owner):
//! - `registry_id`: `seller` in the msg is a handle looked up with `get_handle(handle)` on that
//!   contract (returns `{account_id, payout_account_id}`). Without it, `seller` is a NEAR account id
//!   and is paid directly.
//! - `proof_log_id`: `mark_delivered` needs a `proof_id` that `is_passed(proof_id, subject, author_id)`
//!   confirms (subject = order id, author = seller). Without it, the seller just marks delivered.

use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};

const GAS_VIEW: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(15);
const GAS_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_CALLBACK_FEE: Gas = Gas::from_tgas(30);
const DAY_NS: u64 = 24 * 60 * 60 * 1_000_000_000;
/// The platform fee can never exceed 10%.
const MAX_FEE_BPS: u16 = 1000;

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Status {
    /// Waiting for the registry lookup (only with a registry; a few blocks).
    Opening,
    Held,
    Delivered,
    RevisionRequested,
    RefundRequested,
    /// The seller declined the refund: sort it out off chain (no on-chain arbitration). The seller can still refund.
    Disputed,
    /// A payout is in flight; reverted if the transfer fails.
    Releasing,
    Refunding,
    Released,
    Refunded,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Order {
    pub order_id: String,
    pub buyer_id: AccountId,
    /// What the buyer named in the msg: an account id, or a handle when a registry is set.
    pub seller: String,
    /// Who may mark delivered and refund. Set once the order is open.
    pub seller_id: Option<AccountId>,
    /// Who gets the money on release (the seller itself without a registry).
    pub payout_id: Option<AccountId>,
    pub token_id: AccountId,
    pub amount: U128,
    pub status: Status,
    pub created_at: U64,
    pub delivered_at: Option<U64>,
    pub proof_id: Option<U64>,
    pub revisions_used: u8,
    /// Fixed when the order is created: later `set_params` calls never change an open order's terms.
    pub release_after_ns: U64,
    pub deliver_by: U64,
    pub fee_bps: u16,
}

#[near(serializers = [json])]
pub struct Params {
    pub release_after_ns: U64,
    pub delivery_deadline_ns: U64,
    pub max_revisions: u8,
    pub accepted_tokens: Vec<AccountId>,
    pub fee_bps: u16,
    pub fee_account_id: AccountId,
    pub min_amount: U128,
    pub registry_id: Option<AccountId>,
    pub proof_log_id: Option<AccountId>,
}

/// The fields of a registry record the escrow needs (unknown fields are ignored).
#[near(serializers = [json])]
pub struct HandleView {
    pub account_id: AccountId,
    pub payout_account_id: AccountId,
}

#[near(serializers = [json])]
struct OrderMsg {
    order_id: String,
    seller: String,
}

#[allow(dead_code)]
#[ext_contract(ext_registry)]
trait Registry {
    fn get_handle(&self, handle: String) -> Option<HandleView>;
}

#[allow(dead_code)]
#[ext_contract(ext_proofs)]
trait Proofs {
    fn is_passed(&self, proof_id: U64, subject: String, author_id: AccountId) -> bool;
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
    registry_id: Option<AccountId>,
    proof_log_id: Option<AccountId>,
    fee_account_id: AccountId,
    accepted_tokens: Vec<AccountId>,
    release_after_ns: u64,
    delivery_deadline_ns: u64,
    max_revisions: u8,
    fee_bps: u16,
    min_amount: u128,
    orders: LookupMap<String, Order>,
}

/// NEP-297 event log.
fn event(name: &str, data: serde_json::Value) {
    let ev = json!({"standard": "escrow", "version": "1.0.0", "event": name, "data": [data]});
    env::log_str(&format!("EVENT_JSON:{ev}"));
}

fn fee_of(o: &Order) -> u128 {
    o.amount.0 * o.fee_bps as u128 / 10_000
}

#[near]
impl Contract {
    /// Defaults: release 2 days after delivery, deliver within 7 days, 1 revision, no fee, min amount 1,
    /// fee account = owner, no registry, no proof log.
    #[init]
    #[private]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        owner_id: AccountId,
        accepted_tokens: Vec<AccountId>,
        fee_bps: Option<u16>,
        fee_account_id: Option<AccountId>,
        registry_id: Option<AccountId>,
        proof_log_id: Option<AccountId>,
        release_after_ns: Option<U64>,
        delivery_deadline_ns: Option<U64>,
        max_revisions: Option<u8>,
        min_amount: Option<U128>,
    ) -> Self {
        let fee_bps = fee_bps.unwrap_or(0);
        require!(fee_bps <= MAX_FEE_BPS, "fee capped at 10%");
        Self {
            fee_account_id: fee_account_id.unwrap_or_else(|| owner_id.clone()),
            owner_id,
            registry_id,
            proof_log_id,
            accepted_tokens,
            release_after_ns: release_after_ns.map_or(2 * DAY_NS, |v| v.0),
            delivery_deadline_ns: delivery_deadline_ns.map_or(7 * DAY_NS, |v| v.0),
            max_revisions: max_revisions.unwrap_or(1),
            fee_bps,
            min_amount: min_amount.map_or(1, |v| v.0.max(1)),
            orders: LookupMap::new(b"o"),
        }
    }

    // ---- seller ----

    /// The seller marks the order delivered. With a proof log configured, `proof_id` is required and the
    /// order is delivered only if the log confirms it (returns false otherwise); without one it is optional
    /// and just stored as the seller's reference.
    pub fn mark_delivered(&mut self, order_id: String, proof_id: Option<U64>) -> PromiseOrValue<bool> {
        let o = self.order(&order_id);
        let seller = o.seller_id.clone().expect("order not open");
        require!(env::predecessor_account_id() == seller, "seller only");
        require!(matches!(o.status, Status::Held | Status::RevisionRequested), "order not awaiting delivery");
        match &self.proof_log_id {
            Some(log) => {
                let proof_id = proof_id.expect("proof_id required: this escrow checks a proof log");
                PromiseOrValue::Promise(
                    ext_proofs::ext(log.clone())
                        .with_static_gas(GAS_VIEW)
                        .is_passed(proof_id, order_id.clone(), seller)
                        .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_proof_checked(order_id, proof_id)),
                )
            }
            None => {
                self.set_delivered(&order_id, proof_id);
                PromiseOrValue::Value(true)
            }
        }
    }

    /// The seller gives the buyer's money back: after a refund request (or a dispute), or before delivering to
    /// decline the order. Always in the buyer's favour, so a limited seller key may sign it.
    pub fn approve_refund(&mut self, order_id: String) -> Promise {
        let o = self.order(&order_id);
        require!(Some(env::predecessor_account_id()) == o.seller_id, "seller only");
        require!(
            matches!(o.status, Status::RefundRequested | Status::Disputed | Status::Held | Status::RevisionRequested),
            "nothing to refund"
        );
        self.refund(order_id)
    }

    pub fn decline_refund(&mut self, order_id: String) {
        let o = self.order_mut(&order_id);
        require!(Some(env::predecessor_account_id()) == o.seller_id, "seller only");
        require!(o.status == Status::RefundRequested, "no refund requested");
        o.status = Status::Disputed;
        event("order_disputed", json!({"order_id": order_id}));
    }

    // ---- buyer ----

    pub fn accept(&mut self, order_id: String) -> Promise {
        let o = self.order(&order_id);
        require!(env::predecessor_account_id() == o.buyer_id, "buyer only");
        require!(o.status == Status::Delivered, "order not delivered");
        self.release(order_id)
    }

    pub fn request_revision(&mut self, order_id: String) {
        let max = self.max_revisions;
        let deadline = self.delivery_deadline_ns;
        let o = self.order_mut(&order_id);
        require!(env::predecessor_account_id() == o.buyer_id, "buyer only");
        require!(o.status == Status::Delivered, "order not delivered");
        require!(o.revisions_used < max, "no revisions left: request a refund");
        o.revisions_used += 1;
        o.status = Status::RevisionRequested;
        o.delivered_at = None;
        // A fresh delivery window for the revision: otherwise an old deadline could refund the order right after
        // the buyer asks for a fix.
        o.deliver_by = U64(env::block_timestamp() + deadline);
        event("order_revision_requested", json!({"order_id": order_id, "revisions_used": o.revisions_used}));
    }

    pub fn request_refund(&mut self, order_id: String) {
        let max = self.max_revisions;
        let o = self.order_mut(&order_id);
        require!(env::predecessor_account_id() == o.buyer_id, "buyer only");
        require!(o.status == Status::Delivered && o.revisions_used >= max, "use your revision first");
        o.status = Status::RefundRequested;
        event("order_refund_requested", json!({"order_id": order_id}));
    }

    // ---- anyone (run these on a timer) ----

    /// Releases a delivered order whose release window has passed.
    pub fn release_expired(&mut self, order_id: String) -> Promise {
        let o = self.order(&order_id);
        require!(o.status == Status::Delivered, "order not delivered");
        let at = o.delivered_at.expect("delivered_at").0;
        require!(env::block_timestamp() >= at + o.release_after_ns.0, "release timeout not reached");
        self.release(order_id)
    }

    /// Refunds an order the seller did not deliver by its deadline.
    pub fn refund_undelivered(&mut self, order_id: String) -> Promise {
        let o = self.order(&order_id);
        require!(matches!(o.status, Status::Held | Status::RevisionRequested), "order not awaiting delivery");
        require!(env::block_timestamp() >= o.deliver_by.0, "delivery deadline not reached");
        self.refund(order_id)
    }

    // ---- views and admin ----

    pub fn get_order(&self, order_id: String) -> Option<Order> {
        self.orders.get(&order_id).cloned()
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner_id.clone()
    }

    pub fn get_params(&self) -> Params {
        Params {
            release_after_ns: U64(self.release_after_ns),
            delivery_deadline_ns: U64(self.delivery_deadline_ns),
            max_revisions: self.max_revisions,
            accepted_tokens: self.accepted_tokens.clone(),
            fee_bps: self.fee_bps,
            fee_account_id: self.fee_account_id.clone(),
            min_amount: U128(self.min_amount),
            registry_id: self.registry_id.clone(),
            proof_log_id: self.proof_log_id.clone(),
        }
    }

    /// Owner only. Applies to new orders; open orders keep the windows and fee they were created with
    /// (the registry and proof log apply to every later lookup and delivery).
    pub fn set_params(&mut self, params: Params) {
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
        require!(params.fee_bps <= MAX_FEE_BPS, "fee capped at 10%");
        self.release_after_ns = params.release_after_ns.0;
        self.delivery_deadline_ns = params.delivery_deadline_ns.0;
        self.max_revisions = params.max_revisions;
        self.accepted_tokens = params.accepted_tokens;
        self.fee_bps = params.fee_bps;
        self.fee_account_id = params.fee_account_id;
        self.min_amount = params.min_amount.0.max(1);
        self.registry_id = params.registry_id;
        self.proof_log_id = params.proof_log_id;
    }

    // ---- callbacks ----

    #[private]
    pub fn on_handle(
        &mut self,
        order_id: String,
        amount: U128,
        #[callback_result] handle: Result<Option<HandleView>, PromiseError>,
    ) -> U128 {
        match handle {
            Ok(Some(h)) => {
                let o = self.orders.get_mut(&order_id).expect("order");
                o.seller_id = Some(h.account_id);
                o.payout_id = Some(h.payout_account_id);
                o.status = Status::Held;
                let o = o.clone();
                Self::created_event(&o);
                U128(0)
            }
            _ => {
                // Unknown or suspended seller: drop the order, return the money to the buyer.
                self.orders.remove(&order_id);
                amount
            }
        }
    }

    #[private]
    pub fn on_proof_checked(
        &mut self,
        order_id: String,
        proof_id: U64,
        #[callback_result] passed: Result<bool, PromiseError>,
    ) -> bool {
        if passed != Ok(true) {
            return false;
        }
        let o = self.orders.get(&order_id).expect("order");
        if !matches!(o.status, Status::Held | Status::RevisionRequested) {
            return false;
        }
        self.set_delivered(&order_id, Some(proof_id));
        true
    }

    #[private]
    pub fn on_payout(
        &mut self,
        order_id: String,
        released: bool,
        previous: Status,
        #[callback_result] done: Result<(), PromiseError>,
    ) -> bool {
        let fee_account = self.fee_account_id.clone();
        let o = self.orders.get_mut(&order_id).expect("order");
        if done.is_ok() {
            o.status = if released { Status::Released } else { Status::Refunded };
            let name = if released { "order_released" } else { "order_refunded" };
            let fee = if released { fee_of(o) } else { 0 };
            event(name, json!({"order_id": order_id, "amount": o.amount, "fee": U128(fee)}));
            if fee > 0 {
                // The fee goes only after the seller's net transfer succeeded.
                ext_ft::ext(o.token_id.clone())
                    .with_attached_deposit(NearToken::from_yoctonear(1))
                    .with_static_gas(GAS_TRANSFER)
                    .ft_transfer(fee_account, U128(fee), Some(format!("fee {order_id}")))
                    .detach();
            }
            true
        } else {
            // The transfer failed (e.g. receiver not registered on the token): the money is still here.
            o.status = previous;
            false
        }
    }

    // ---- internals ----

    fn created_event(o: &Order) {
        event("order_created", json!({
            "order_id": o.order_id, "buyer_id": o.buyer_id, "seller": o.seller, "seller_id": o.seller_id,
            "token_id": o.token_id, "amount": o.amount,
        }));
    }

    fn set_delivered(&mut self, order_id: &str, proof_id: Option<U64>) {
        let o = self.order_mut(order_id);
        o.status = Status::Delivered;
        o.delivered_at = Some(U64(env::block_timestamp()));
        o.proof_id = proof_id;
        event("order_delivered", json!({"order_id": order_id, "proof_id": proof_id}));
    }

    fn release(&mut self, order_id: String) -> Promise {
        let o = self.order_mut(&order_id);
        let previous = o.status;
        o.status = Status::Releasing;
        let to = o.payout_id.clone().expect("payout account");
        let net = o.amount.0 - fee_of(o);
        let token = o.token_id.clone();
        ext_ft::ext(token)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_TRANSFER)
            .ft_transfer(to, U128(net), Some(format!("order {order_id}")))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK_FEE).on_payout(order_id, true, previous))
    }

    fn refund(&mut self, order_id: String) -> Promise {
        let o = self.order_mut(&order_id);
        let previous = o.status;
        o.status = Status::Refunding;
        ext_ft::ext(o.token_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_TRANSFER)
            .ft_transfer(o.buyer_id.clone(), o.amount, Some(format!("refund {order_id}")))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_payout(order_id, false, previous))
    }

    fn order(&self, order_id: &str) -> &Order {
        self.orders.get(order_id).expect("no such order")
    }

    fn order_mut(&mut self, order_id: &str) -> &mut Order {
        self.orders.get_mut(order_id).expect("no such order")
    }
}

#[near]
impl FungibleTokenReceiver for Contract {
    /// `msg` = `{"order_id": "...", "seller": "alice.near"}` (or a handle when a registry is set). A bad msg,
    /// a repeated `order_id`, an amount below the minimum or an unknown seller returns the full amount, so
    /// checkout retries are safe. A token that is not accepted panics, which also returns the full amount.
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        require!(self.accepted_tokens.contains(&token), "token not accepted");
        let Ok(m) = serde_json::from_str::<OrderMsg>(&msg) else {
            return PromiseOrValue::Value(amount);
        };
        if m.order_id.is_empty() || m.order_id.len() > 128 || m.seller.is_empty() || m.seller.len() > 64
            || amount.0 < self.min_amount || self.orders.contains_key(&m.order_id)
        {
            return PromiseOrValue::Value(amount);
        }
        // Without a registry the seller must be a valid account id; it is paid directly.
        let direct: Option<AccountId> = if self.registry_id.is_none() {
            match m.seller.parse::<AccountId>() {
                Ok(a) => Some(a),
                Err(_) => return PromiseOrValue::Value(amount),
            }
        } else {
            None
        };
        let now = env::block_timestamp();
        let order = Order {
            order_id: m.order_id.clone(),
            buyer_id: sender_id,
            seller: m.seller.clone(),
            seller_id: direct.clone(),
            payout_id: direct.clone(),
            token_id: token,
            amount,
            status: if direct.is_some() { Status::Held } else { Status::Opening },
            created_at: U64(now),
            delivered_at: None,
            proof_id: None,
            revisions_used: 0,
            release_after_ns: U64(self.release_after_ns),
            deliver_by: U64(now + self.delivery_deadline_ns),
            fee_bps: self.fee_bps,
        };
        if direct.is_some() {
            Self::created_event(&order);
            self.orders.insert(m.order_id, order);
            return PromiseOrValue::Value(U128(0));
        }
        self.orders.insert(m.order_id.clone(), order);
        let registry = self.registry_id.clone().expect("registry");
        PromiseOrValue::Promise(
            ext_registry::ext(registry)
                .with_static_gas(GAS_VIEW)
                .get_handle(m.seller)
                .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_handle(m.order_id, amount)),
        )
    }
}
