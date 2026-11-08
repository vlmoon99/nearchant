//! Sandbox tests (near-workspaces). `cargo test` builds the escrow and two test-only contracts from
//! tests/fixtures (a NEP-141 token and a mock registry + proof log) with cargo-near, then runs each test on a
//! fresh local sandbox.
use near_workspaces::network::Sandbox;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};
use tokio::sync::OnceCell;

const ONE: u128 = 1_000_000; // 1 token at 6 decimals

static ESCROW: OnceCell<Vec<u8>> = OnceCell::const_new();
static TOKEN: OnceCell<Vec<u8>> = OnceCell::const_new();
static MOCKS: OnceCell<Vec<u8>> = OnceCell::const_new();

async fn wasm(cell: &'static OnceCell<Vec<u8>>, path: &str) -> anyhow::Result<Vec<u8>> {
    let p = format!("{}/{path}", env!("CARGO_MANIFEST_DIR"));
    Ok(cell.get_or_try_init(|| async move { near_workspaces::compile_project(&p).await }).await?.clone())
}

async fn sub(root: &Account, name: &str, near: u128) -> anyhow::Result<Account> {
    Ok(root.create_subaccount(name).initial_balance(NearToken::from_near(near)).transact().await?.into_result()?)
}

async fn deploy(root: &Account, name: &str, code: &[u8]) -> anyhow::Result<Contract> {
    Ok(sub(root, name, 30).await?.deploy(code).await?.into_result()?)
}

struct Shop {
    worker: Worker<Sandbox>,
    root: Account,
    escrow: Contract,
    token: Contract,
    mocks: Contract,
    seller: Account,
    buyer: Account,
    fee: Account,
}

#[derive(Default)]
struct Opts {
    fee_bps: u16,
    registry: bool,
    proof_log: bool,
    release_after_ns: Option<&'static str>,
    delivery_deadline_ns: Option<&'static str>,
}

async fn shop(o: Opts) -> anyhow::Result<Shop> {
    let (escrow_code, token_code, mocks_code) = (
        wasm(&ESCROW, "").await?,
        wasm(&TOKEN, "tests/fixtures/token").await?,
        wasm(&MOCKS, "tests/fixtures/mocks").await?,
    );
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let token = deploy(&root, "token", &token_code).await?;
    token.call("new").transact().await?.into_result()?;
    let mocks = deploy(&root, "mocks", &mocks_code).await?;
    mocks.call("new").transact().await?.into_result()?;
    let escrow = deploy(&root, "escrow", &escrow_code).await?;
    let fee = sub(&root, "fee", 5).await?;
    let seller = sub(&root, "seller", 5).await?;
    let buyer = sub(&root, "buyer", 10).await?;
    escrow.call("new").args_json(json!({
        "owner_id": root.id(), "accepted_tokens": [token.id()], "fee_bps": o.fee_bps, "fee_account_id": fee.id(),
        "registry_id": if o.registry { Some(mocks.id()) } else { None },
        "proof_log_id": if o.proof_log { Some(mocks.id()) } else { None },
        "release_after_ns": o.release_after_ns, "delivery_deadline_ns": o.delivery_deadline_ns,
        "min_amount": "1000",
    })).transact().await?.into_result()?;
    for id in [escrow.id(), seller.id(), fee.id()] {
        root.call(token.id(), "register").args_json(json!({"account_id": id})).transact().await?.into_result()?;
    }
    root.call(token.id(), "mint").args_json(json!({"account_id": buyer.id(), "amount": (100 * ONE).to_string()}))
        .transact().await?.into_result()?;
    Ok(Shop { worker, root, escrow, token, mocks, seller, buyer, fee })
}

/// Pays with `ft_transfer_call`; returns the amount the escrow used ("0" = refunded).
async fn pay_with(s: &Shop, token: &AccountId, order_id: &str, seller: &str, amount: u128) -> anyhow::Result<String> {
    let r = s.buyer.call(token, "ft_transfer_call")
        .args_json(json!({"receiver_id": s.escrow.id(), "amount": amount.to_string(),
            "msg": json!({"order_id": order_id, "seller": seller}).to_string()}))
        .deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?.into_result()?;
    Ok(r.json()?)
}

async fn pay(s: &Shop, order_id: &str, amount: u128) -> anyhow::Result<String> {
    pay_with(s, s.token.id(), order_id, s.seller.id().as_str(), amount).await
}

async fn order(s: &Shop, id: &str) -> anyhow::Result<Value> {
    Ok(s.escrow.view("get_order").args_json(json!({"order_id": id})).await?.json()?)
}

async fn status(s: &Shop, id: &str) -> anyhow::Result<String> {
    Ok(order(s, id).await?["status"].as_str().unwrap_or("none").to_string())
}

async fn balance(s: &Shop, who: &AccountId) -> anyhow::Result<u128> {
    let v: String = s.token.view("ft_balance_of").args_json(json!({"account_id": who})).await?.json()?;
    Ok(v.parse()?)
}

/// Marks delivered; true only if the call succeeded and returned true.
async fn deliver(s: &Shop, who: &Account, order_id: &str, proof_id: Option<&str>) -> anyhow::Result<bool> {
    let r = who.call(s.escrow.id(), "mark_delivered")
        .args_json(json!({"order_id": order_id, "proof_id": proof_id})).max_gas().transact().await?;
    Ok(r.is_success() && r.json::<bool>().unwrap_or(false))
}

async fn act(who: &Account, s: &Shop, method: &str, order_id: &str) -> anyhow::Result<bool> {
    Ok(who.call(s.escrow.id(), method).args_json(json!({"order_id": order_id})).max_gas().transact().await?.is_success())
}

#[tokio::test]
async fn pay_deliver_accept_pays_the_seller() -> anyhow::Result<()> {
    // No registry, no proof log: the seller is the account named in the msg, delivery needs no proof.
    let s = shop(Opts::default()).await?;
    assert_eq!(pay(&s, "o-1", 5 * ONE).await?, (5 * ONE).to_string());
    assert_eq!(status(&s, "o-1").await?, "Held");
    assert_eq!(order(&s, "o-1").await?["amount"], (5 * ONE).to_string(), "amounts are U128 strings");
    assert_eq!(balance(&s, s.escrow.id()).await?, 5 * ONE);

    assert!(!deliver(&s, &s.buyer, "o-1", None).await?, "only the seller marks delivered");
    assert!(!act(&s.buyer, &s, "accept", "o-1").await?, "can't accept before delivery");
    assert!(deliver(&s, &s.seller, "o-1", None).await?);
    assert_eq!(status(&s, "o-1").await?, "Delivered");
    assert!(!act(&s.seller, &s, "accept", "o-1").await?, "only the buyer accepts");
    assert!(act(&s.buyer, &s, "accept", "o-1").await?);
    assert_eq!(status(&s, "o-1").await?, "Released");
    assert_eq!(balance(&s, s.seller.id()).await?, 5 * ONE);
    assert_eq!(balance(&s, s.escrow.id()).await?, 0);
    Ok(())
}

#[tokio::test]
async fn bad_payments_are_returned_in_full() -> anyhow::Result<()> {
    let s = shop(Opts::default()).await?;
    assert_eq!(pay(&s, "o-1", 5 * ONE).await?, (5 * ONE).to_string());
    assert_eq!(pay(&s, "o-1", 3 * ONE).await?, "0", "duplicate order id: nothing used");
    assert_eq!(pay(&s, "o-tiny", 999).await?, "0", "below min_amount: nothing used");
    assert_eq!(pay_with(&s, s.token.id(), "o-bad", "Not An Account!", ONE).await?, "0", "invalid seller id");
    let r = s.buyer.call(s.token.id(), "ft_transfer_call")
        .args_json(json!({"receiver_id": s.escrow.id(), "amount": ONE.to_string(), "msg": "hello"}))
        .deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?.into_result()?;
    assert_eq!(r.json::<String>()?, "0", "unparseable msg");
    assert!(order(&s, "o-tiny").await?.is_null() && order(&s, "o-bad").await?.is_null());
    assert_eq!(balance(&s, s.buyer.id()).await?, 95 * ONE);
    Ok(())
}

#[tokio::test]
async fn wrong_token_is_rejected() -> anyhow::Result<()> {
    let s = shop(Opts::default()).await?;
    let other = deploy(&s.root, "other", &wasm(&TOKEN, "tests/fixtures/token").await?).await?;
    other.call("new").transact().await?.into_result()?;
    s.root.call(other.id(), "register").args_json(json!({"account_id": s.escrow.id()})).transact().await?.into_result()?;
    s.root.call(other.id(), "mint").args_json(json!({"account_id": s.buyer.id(), "amount": (10 * ONE).to_string()}))
        .transact().await?.into_result()?;
    assert_eq!(pay_with(&s, other.id(), "o-x", s.seller.id().as_str(), 5 * ONE).await?, "0");
    assert!(order(&s, "o-x").await?.is_null());
    let bal: String = other.view("ft_balance_of").args_json(json!({"account_id": s.buyer.id()})).await?.json()?;
    assert_eq!(bal, (10 * ONE).to_string(), "buyer kept the money");
    Ok(())
}

#[tokio::test]
async fn revision_then_refund_with_seller_approval() -> anyhow::Result<()> {
    let s = shop(Opts::default()).await?;
    pay(&s, "o-1", 5 * ONE).await?;
    assert!(deliver(&s, &s.seller, "o-1", None).await?);
    assert!(!act(&s.buyer, &s, "request_refund", "o-1").await?, "revision comes first");
    assert!(act(&s.buyer, &s, "request_revision", "o-1").await?);
    assert_eq!(status(&s, "o-1").await?, "RevisionRequested");
    assert!(deliver(&s, &s.seller, "o-1", None).await?);
    assert!(!act(&s.buyer, &s, "request_revision", "o-1").await?, "only one revision");
    assert!(act(&s.buyer, &s, "request_refund", "o-1").await?);
    assert_eq!(status(&s, "o-1").await?, "RefundRequested");
    assert!(!act(&s.buyer, &s, "approve_refund", "o-1").await?, "buyer can't approve own refund");
    assert!(act(&s.seller, &s, "approve_refund", "o-1").await?);
    assert_eq!(status(&s, "o-1").await?, "Refunded");
    assert_eq!(balance(&s, s.buyer.id()).await?, 100 * ONE);
    Ok(())
}

#[tokio::test]
async fn seller_declines_order_or_refund() -> anyhow::Result<()> {
    let s = shop(Opts::default()).await?;
    // Declining a paid, undelivered order: the buyer gets it all back.
    pay(&s, "o-1", 5 * ONE).await?;
    assert!(!act(&s.buyer, &s, "approve_refund", "o-1").await?, "only the seller declines");
    assert!(act(&s.seller, &s, "approve_refund", "o-1").await?);
    assert_eq!(status(&s, "o-1").await?, "Refunded");
    assert_eq!(balance(&s, s.buyer.id()).await?, 100 * ONE);

    // Declining a refund request: Disputed, and the seller can still refund later.
    pay(&s, "o-2", 5 * ONE).await?;
    assert!(deliver(&s, &s.seller, "o-2", None).await?);
    assert!(!act(&s.seller, &s, "approve_refund", "o-2").await?, "delivered: nothing to refund unasked");
    assert!(act(&s.buyer, &s, "request_revision", "o-2").await?);
    assert!(deliver(&s, &s.seller, "o-2", None).await?);
    assert!(act(&s.buyer, &s, "request_refund", "o-2").await?);
    assert!(!act(&s.buyer, &s, "decline_refund", "o-2").await?, "seller only");
    assert!(act(&s.seller, &s, "decline_refund", "o-2").await?);
    assert_eq!(status(&s, "o-2").await?, "Disputed");
    assert!(!act(&s.buyer, &s, "accept", "o-2").await?, "disputed is not delivered");
    assert!(act(&s.seller, &s, "approve_refund", "o-2").await?);
    assert_eq!(status(&s, "o-2").await?, "Refunded");
    Ok(())
}

#[tokio::test]
async fn release_after_the_window_by_anyone() -> anyhow::Result<()> {
    let s = shop(Opts { release_after_ns: Some("30000000000"), ..Default::default() }).await?; // 30 s
    pay(&s, "o-1", 5 * ONE).await?;
    assert!(deliver(&s, &s.seller, "o-1", None).await?);
    let stranger = sub(&s.root, "stranger", 5).await?;
    assert!(!act(&stranger, &s, "release_expired", "o-1").await?, "too early");
    s.worker.fast_forward(200).await?;
    assert!(act(&stranger, &s, "release_expired", "o-1").await?);
    assert_eq!(status(&s, "o-1").await?, "Released");
    assert_eq!(balance(&s, s.seller.id()).await?, 5 * ONE);
    Ok(())
}

#[tokio::test]
async fn undelivered_order_refunds_after_the_deadline() -> anyhow::Result<()> {
    let s = shop(Opts { delivery_deadline_ns: Some("30000000000"), ..Default::default() }).await?;
    pay(&s, "o-1", 5 * ONE).await?;
    assert!(!act(&s.buyer, &s, "refund_undelivered", "o-1").await?, "too early");
    s.worker.fast_forward(200).await?;
    assert!(act(&s.buyer, &s, "refund_undelivered", "o-1").await?);
    assert_eq!(status(&s, "o-1").await?, "Refunded");
    assert_eq!(balance(&s, s.buyer.id()).await?, 100 * ONE);
    Ok(())
}

#[tokio::test]
async fn revision_restarts_the_delivery_window() -> anyhow::Result<()> {
    let s = shop(Opts { delivery_deadline_ns: Some("60000000000"), ..Default::default() }).await?;
    pay(&s, "o-1", 5 * ONE).await?;
    s.worker.fast_forward(150).await?; // past the original deadline
    assert!(deliver(&s, &s.seller, "o-1", None).await?, "late delivery still allowed while Held");
    assert!(act(&s.buyer, &s, "request_revision", "o-1").await?);
    assert!(!act(&s.buyer, &s, "refund_undelivered", "o-1").await?, "new window: no instant refund");
    Ok(())
}

#[tokio::test]
async fn fee_is_split_to_the_fee_account() -> anyhow::Result<()> {
    let s = shop(Opts { fee_bps: 250, ..Default::default() }).await?; // 2.5%
    pay(&s, "o-1", 10 * ONE).await?;
    assert!(deliver(&s, &s.seller, "o-1", None).await?);
    assert!(act(&s.buyer, &s, "accept", "o-1").await?);
    assert_eq!(balance(&s, s.seller.id()).await?, 9_750_000);
    assert_eq!(balance(&s, s.fee.id()).await?, 250_000);
    assert_eq!(balance(&s, s.escrow.id()).await?, 0);
    // A refund never takes a fee.
    pay(&s, "o-2", 10 * ONE).await?;
    assert!(act(&s.seller, &s, "approve_refund", "o-2").await?);
    assert_eq!(balance(&s, s.fee.id()).await?, 250_000);
    assert_eq!(balance(&s, s.buyer.id()).await?, 90 * ONE);
    Ok(())
}

#[tokio::test]
async fn failed_payout_reverts_status_and_keeps_the_money() -> anyhow::Result<()> {
    let s = shop(Opts::default()).await?;
    let ghost = sub(&s.root, "ghost", 5).await?; // not registered on the token: the transfer fails
    pay_with(&s, s.token.id(), "o-g", ghost.id().as_str(), 5 * ONE).await?;
    assert!(deliver(&s, &ghost, "o-g", None).await?);
    let r = s.buyer.call(s.escrow.id(), "accept").args_json(json!({"order_id": "o-g"})).max_gas().transact().await?;
    assert!(r.is_success());
    assert!(!r.json::<bool>()?, "payout reported as failed");
    assert_eq!(status(&s, "o-g").await?, "Delivered", "status reverted");
    assert_eq!(balance(&s, s.escrow.id()).await?, 5 * ONE, "money still held");
    Ok(())
}

#[tokio::test]
async fn optional_registry_resolves_handles() -> anyhow::Result<()> {
    let s = shop(Opts { registry: true, ..Default::default() }).await?;
    let payout = sub(&s.root, "payout", 5).await?;
    s.root.call(s.token.id(), "register").args_json(json!({"account_id": payout.id()})).transact().await?.into_result()?;
    s.root.call(s.mocks.id(), "set_handle")
        .args_json(json!({"handle": "alice", "account_id": s.seller.id(), "payout_account_id": payout.id()}))
        .transact().await?.into_result()?;
    assert_eq!(pay_with(&s, s.token.id(), "o-1", "alice", 5 * ONE).await?, (5 * ONE).to_string());
    let o = order(&s, "o-1").await?;
    assert_eq!(o["status"], "Held");
    assert_eq!(o["seller_id"], s.seller.id().as_str());
    assert_eq!(pay_with(&s, s.token.id(), "o-2", "nobody", 5 * ONE).await?, "0", "unknown handle: refunded");
    assert!(order(&s, "o-2").await?.is_null());
    assert!(deliver(&s, &s.seller, "o-1", None).await?);
    assert!(act(&s.buyer, &s, "accept", "o-1").await?);
    assert_eq!(balance(&s, payout.id()).await?, 5 * ONE, "paid to the payout account");
    Ok(())
}

#[tokio::test]
async fn optional_proof_log_gates_delivery() -> anyhow::Result<()> {
    let s = shop(Opts { proof_log: true, ..Default::default() }).await?;
    pay(&s, "o-1", 5 * ONE).await?;
    let set = |id: &str, subject: &str, author: &AccountId, passed: bool| {
        json!({"proof_id": id, "subject": subject, "author_id": author, "passed": passed})
    };
    for args in [
        set("1", "o-1", s.seller.id(), false), // failed review
        set("2", "o-1", s.buyer.id(), true),   // someone else's proof
        set("3", "o-9", s.seller.id(), true),  // another order
        set("4", "o-1", s.seller.id(), true),  // good
    ] {
        s.root.call(s.mocks.id(), "set_proof").args_json(args).transact().await?.into_result()?;
    }
    assert!(!deliver(&s, &s.seller, "o-1", None).await?, "proof required");
    for bad in ["1", "2", "3", "99"] {
        assert!(!deliver(&s, &s.seller, "o-1", Some(bad)).await?, "proof {bad} must not pass");
    }
    assert_eq!(status(&s, "o-1").await?, "Held");
    assert!(deliver(&s, &s.seller, "o-1", Some("4")).await?);
    let o = order(&s, "o-1").await?;
    assert_eq!(o["status"], "Delivered");
    assert_eq!(o["proof_id"], "4");
    Ok(())
}

#[tokio::test]
async fn params_are_owner_only_and_fee_is_capped() -> anyhow::Result<()> {
    let s = shop(Opts::default()).await?;
    let mut p: Value = s.escrow.view("get_params").await?.json()?;
    assert_eq!(p["registry_id"], Value::Null);
    assert_eq!(p["proof_log_id"], Value::Null);
    p["fee_bps"] = json!(100);
    assert!(s.buyer.call(s.escrow.id(), "set_params").args_json(json!({"params": p})).transact().await?.is_failure());
    p["fee_bps"] = json!(1001);
    assert!(s.root.call(s.escrow.id(), "set_params").args_json(json!({"params": p})).transact().await?.is_failure());
    p["fee_bps"] = json!(100);
    s.root.call(s.escrow.id(), "set_params").args_json(json!({"params": p})).transact().await?.into_result()?;
    let after: Value = s.escrow.view("get_params").await?.json()?;
    assert_eq!(after["fee_bps"], 100);
    Ok(())
}
