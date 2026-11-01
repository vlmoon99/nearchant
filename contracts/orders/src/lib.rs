//! `orders` — buyer payments for a seller's goods and services, held until delivery.
//! Created only by `ft_transfer_call` from an accepted token. Released to the seller's payout
//! account when the buyer accepts, or when the release timeout passes after delivery. Delivery
//! needs a passed `proof-log` entry written by the seller's account. Spec: docs/contracts.md.

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
/// Smallest order (0.1 nUSD at 6 decimals): keeps storage spam expensive (security review M1).
const MIN_ORDER: u128 = 100_000;

fn fee_bps_of(c: &Contract) -> u128 {
    c.commerce_fee_bps as u128
}
const DAY_NS: u64 = 24 * 60 * 60 * 1_000_000_000;

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Status {
    /// Waiting for the handle lookup (internal, a few blocks).
    Opening,
    Held,
    Delivered,
    RevisionRequested,
    RefundRequested,
    /// Seller declined the refund: needs a manual dispute (no on-chain arbitration in M0).
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
    pub seller_handle: String,
    pub seller_account_id: Option<AccountId>,
    pub payout_account_id: Option<AccountId>,
    pub token_id: AccountId,
    pub amount: U128,
    pub status: Status,
    pub created_at: U64,
    pub delivered_at: Option<U64>,
    pub proof_id: Option<U64>,
    pub revisions_used: u8,
    pub release_after_ns: U64,
    pub deliver_by: U64,
}

#[near(serializers = [json])]
pub struct Params {
    pub release_after_ns: U64,
    pub delivery_deadline_ns: U64,
    pub max_revisions: u8,
    pub accepted_tokens: Vec<AccountId>,
    pub commerce_fee_bps: u16,
    pub treasury_id: AccountId,
}

/// The fields of a `handles` record that orders needs (unknown fields are ignored).
#[near(serializers = [json])]
pub struct HandleView {
    pub account_id: AccountId,
    pub payout_account_id: AccountId,
}

#[near(serializers = [json])]
struct OrderMsg {
    order_id: String,
    seller_handle: String,
}

#[allow(dead_code)]
#[ext_contract(ext_handles)]
trait Handles {
    fn get_handle(&self, handle: String) -> Option<HandleView>;
}

#[allow(dead_code)]
#[ext_contract(ext_proofs)]
trait Proofs {
    fn is_passed(&self, proof_id: U64, order_id: String, author_id: AccountId) -> bool;
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
    handles_id: AccountId,
    proofs_id: AccountId,
    treasury_id: AccountId,
    accepted_tokens: Vec<AccountId>,
    release_after_ns: u64,
    delivery_deadline_ns: u64,
    max_revisions: u8,
    commerce_fee_bps: u16,
    orders: LookupMap<String, Order>,
}

fn event(name: &str, data: serde_json::Value) {
    let ev = json!({"standard": "nearchant", "version": "1.0.0", "event": name, "data": [data]});
    env::log_str(&format!("EVENT_JSON:{ev}"));
}

#[near]
impl Contract {
    #[init]
    #[private]
    pub fn new(
        owner_id: AccountId,
        handles_id: AccountId,
        proofs_id: AccountId,
        treasury_id: AccountId,
        accepted_tokens: Vec<AccountId>,
    ) -> Self {
        Self {
            owner_id,
            handles_id,
            proofs_id,
            treasury_id,
            accepted_tokens,
            release_after_ns: 2 * DAY_NS,
            delivery_deadline_ns: 7 * DAY_NS,
            max_revisions: 1,
            commerce_fee_bps: 0,
            orders: LookupMap::new(b"o"),
        }
    }

    // ---- seller ----

    /// The seller's account (an agent key scoped to this contract can sign it) marks the order
    /// delivered. Only takes effect if `proofs.is_passed(proof_id, order_id, seller)`.
    pub fn mark_delivered(&mut self, order_id: String, proof_id: U64) -> Promise {
        let o = self.order(&order_id);
        let seller = o.seller_account_id.clone().expect("order not open");
        require!(env::predecessor_account_id() == seller, "seller only");
        require!(matches!(o.status, Status::Held | Status::RevisionRequested), "order not awaiting delivery");
        ext_proofs::ext(self.proofs_id.clone())
            .with_static_gas(GAS_VIEW)
            .is_passed(proof_id, order_id.clone(), seller)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_proof_checked(order_id, proof_id))
    }

    pub fn approve_refund(&mut self, order_id: String) -> Promise {
        let o = self.order(&order_id);
        require!(Some(env::predecessor_account_id()) == o.seller_account_id, "seller only");
        require!(matches!(o.status, Status::RefundRequested | Status::Disputed), "no refund requested");
        self.refund(order_id)
    }

    pub fn decline_refund(&mut self, order_id: String) {
        let o = self.order_mut(&order_id);
        require!(Some(env::predecessor_account_id()) == o.seller_account_id, "seller only");
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
        // The seller gets a fresh delivery window for the revision; otherwise an old deadline could refund a
        // delivered order right after the buyer asks for a revision (security review H2).
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

    // ---- anyone (the gateway runs these on a timer) ----

    /// Releases a delivered order whose release timeout has passed.
    pub fn release_expired(&mut self, order_id: String) -> Promise {
        let o = self.order(&order_id);
        require!(o.status == Status::Delivered, "order not delivered");
        let at = o.delivered_at.expect("delivered_at").0;
        require!(env::block_timestamp() >= at + o.release_after_ns.0, "release timeout not reached");
        self.release(order_id)
    }

    /// Refunds an order the seller never delivered by its deadline.
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

    pub fn get_params(&self) -> Params {
        Params {
            release_after_ns: U64(self.release_after_ns),
            delivery_deadline_ns: U64(self.delivery_deadline_ns),
            max_revisions: self.max_revisions,
            accepted_tokens: self.accepted_tokens.clone(),
            commerce_fee_bps: self.commerce_fee_bps,
            treasury_id: self.treasury_id.clone(),
        }
    }

    /// Applies to new orders only; open orders keep the timeouts they were created with.
    pub fn set_params(&mut self, params: Params) {
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
        require!(params.commerce_fee_bps <= 1000, "fee capped at 10%");
        self.release_after_ns = params.release_after_ns.0;
        self.delivery_deadline_ns = params.delivery_deadline_ns.0;
        self.max_revisions = params.max_revisions;
        self.accepted_tokens = params.accepted_tokens;
        self.commerce_fee_bps = params.commerce_fee_bps;
        self.treasury_id = params.treasury_id;
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
                o.seller_account_id = Some(h.account_id);
                o.payout_account_id = Some(h.payout_account_id);
                o.status = Status::Held;
                event("order_created", json!({
                    "order_id": order_id, "buyer_id": o.buyer_id, "seller_handle": o.seller_handle,
                    "token_id": o.token_id, "amount": o.amount,
                }));
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
        let o = self.orders.get_mut(&order_id).expect("order");
        if !matches!(o.status, Status::Held | Status::RevisionRequested) {
            return false;
        }
        o.status = Status::Delivered;
        o.delivered_at = Some(U64(env::block_timestamp()));
        o.proof_id = Some(proof_id);
        event("order_delivered", json!({"order_id": order_id, "proof_id": proof_id}));
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
        let o = self.orders.get_mut(&order_id).expect("order");
        if done.is_ok() {
            o.status = if released { Status::Released } else { Status::Refunded };
            let name = if released { "order_released" } else { "order_refunded" };
            event(name, json!({"order_id": order_id, "amount": o.amount}));
            let fee = if released { o.amount.0 * self.commerce_fee_bps as u128 / 10_000 } else { 0 };
            if fee > 0 {
                let token = o.token_id.clone();
                ext_ft::ext(token)
                    .with_attached_deposit(NearToken::from_yoctonear(1))
                    .with_static_gas(GAS_TRANSFER)
                    .ft_transfer(self.treasury_id.clone(), U128(fee), Some(format!("fee {order_id}")))
                    .detach();
            }
            true
        } else {
            o.status = previous;
            false
        }
    }

    // ---- internals ----

    fn release(&mut self, order_id: String) -> Promise {
        let o = self.order_mut(&order_id);
        let previous = o.status;
        o.status = Status::Releasing;
        let to = o.payout_account_id.clone().expect("payout account");
        let net = o.amount.0 - o.amount.0 * fee_bps_of(self) / 10_000;
        // Net to the seller first; the fee is sent only after that succeeded (security review H4).
        ext_ft::ext(self.orders_token(&order_id))
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_TRANSFER)
            .ft_transfer(to, U128(net), Some(format!("nearchant order {order_id}")))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK_FEE).on_payout(order_id, true, previous))
    }

    fn refund(&mut self, order_id: String) -> Promise {
        let o = self.order_mut(&order_id);
        let previous = o.status;
        o.status = Status::Refunding;
        ext_ft::ext(o.token_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_TRANSFER)
            .ft_transfer(o.buyer_id.clone(), o.amount, Some(format!("nearchant refund {order_id}")))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_payout(order_id, false, previous))
    }

    fn orders_token(&self, order_id: &str) -> AccountId {
        self.order(order_id).token_id.clone()
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
    /// `msg` = `{"order_id": "...", "seller_handle": "alice"}`. A repeated `order_id` or an unknown
    /// seller returns the full amount, so checkout retries are safe.
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        require!(self.accepted_tokens.contains(&token), "token not accepted");
        let Ok(m) = serde_json::from_str::<OrderMsg>(&msg) else {
            return PromiseOrValue::Value(amount);
        };
        if m.order_id.is_empty() || m.order_id.len() > 128 || amount.0 < MIN_ORDER || self.orders.contains_key(&m.order_id) {
            return PromiseOrValue::Value(amount);
        }
        let now = env::block_timestamp();
        self.orders.insert(m.order_id.clone(), Order {
            order_id: m.order_id.clone(),
            buyer_id: sender_id,
            seller_handle: m.seller_handle.clone(),
            seller_account_id: None,
            payout_account_id: None,
            token_id: token,
            amount,
            status: Status::Opening,
            created_at: U64(now),
            delivered_at: None,
            proof_id: None,
            revisions_used: 0,
            release_after_ns: U64(self.release_after_ns),
            deliver_by: U64(now + self.delivery_deadline_ns),
        });
        PromiseOrValue::Promise(
            ext_handles::ext(self.handles_id.clone())
                .with_static_gas(GAS_VIEW)
                .get_handle(m.seller_handle)
                .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_handle(m.order_id, amount)),
        )
    }
}
