mod common;
use common::*;
use near_workspaces::types::{KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract};
use serde_json::{json, Value};

struct Shop {
    env: Env,
    orders: Contract,
    proofs: Contract,
    alice: Account,
    buyer: Account,
}

async fn claim(env: &Env, factory: &Contract, payer: &Account, name: &str) -> anyhow::Result<Account> {
    let sk = SecretKey::from_random(KeyType::ED25519);
    payer.call(factory.id(), "claim")
        .args_json(json!({"handle": name, "public_key": sk.public_key(),
            "card": {"name": name, "bio": "", "avatar_hash": null, "links": []}}))
        .deposit(NearToken::from_near(5)).max_gas().transact().await?.into_result()?;
    Ok(Account::from_secret_key(format!("{name}.{}", factory.id()).parse()?, sk, &env.worker))
}

async fn shop() -> anyhow::Result<Shop> {
    let env = base().await?;
    let factory = deploy(&env.root, "nearchant", "handles").await?;
    let proofs = deploy(&env.root, "proofs", "proof-log").await?;
    let orders = deploy(&env.root, "orders", "orders").await?;
    let treasury = sub(&env.root, "treasury", 5).await?;
    factory.call("new").args_json(json!({"owner_id": env.root.id(), "relayer_id": env.relayer.id(),
        "agent_receivers": [orders.id()]})).transact().await?.into_result()?;
    proofs.call("new").transact().await?.into_result()?;
    orders.call("new").args_json(json!({"owner_id": env.root.id(), "handles_id": factory.id(),
        "proofs_id": proofs.id(), "treasury_id": treasury.id(), "accepted_tokens": [env.nusd.id()]}))
        .transact().await?.into_result()?;
    for id in [orders.id(), treasury.id()] {
        env.relayer.call(env.nusd.id(), "register").args_json(json!({"account_id": id})).transact().await?.into_result()?;
    }
    let seller_owner = sub(&env.root, "sellerowner", 20).await?;
    let alice = claim(&env, &factory, &seller_owner, "alice").await?;
    env.relayer.call(env.nusd.id(), "register").args_json(json!({"account_id": alice.id()})).transact().await?.into_result()?;
    // An unregistered seller, to exercise a failing payout.
    let _ghost = claim(&env, &factory, &seller_owner, "ghost").await?;
    let buyer = sub(&env.root, "buyer", 10).await?;
    fund(&env, &buyer).await?;
    Ok(Shop { env, orders, proofs, alice, buyer })
}

async fn pay(s: &Shop, order_id: &str, seller: &str, amount: u128) -> anyhow::Result<String> {
    let used: String = s.buyer.call(s.env.nusd.id(), "ft_transfer_call")
        .args_json(json!({"receiver_id": s.orders.id(), "amount": amount.to_string(),
            "msg": json!({"order_id": order_id, "seller_handle": seller}).to_string()}))
        .deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?.into_result()?.json()?;
    Ok(used)
}

async fn order(s: &Shop, id: &str) -> anyhow::Result<Value> {
    Ok(s.orders.view("get_order").args_json(json!({"order_id": id})).await?.json()?)
}

async fn prove(s: &Shop, author: &Account, order_id: &str, passed: bool) -> anyhow::Result<String> {
    Ok(author.call(s.proofs.id(), "record").args_json(json!({"entry": {
        "task_id": format!("task-{order_id}"), "order_id": order_id, "brief_hash": "b", "producer": "model:test",
        "output_hash": "o", "attestation_ref": null, "review": {"passed": passed, "reviewer_hash": "r"}}}))
        .transact().await?.into_result()?.json()?)
}

async fn deliver(s: &Shop, who: &Account, order_id: &str, proof_id: &str) -> anyhow::Result<bool> {
    let r = who.call(s.orders.id(), "mark_delivered")
        .args_json(json!({"order_id": order_id, "proof_id": proof_id})).max_gas().transact().await?;
    Ok(r.is_success() && r.json::<bool>().unwrap_or(false))
}

async fn act(who: &Account, s: &Shop, method: &str, order_id: &str) -> anyhow::Result<bool> {
    let r = who.call(s.orders.id(), method).args_json(json!({"order_id": order_id})).max_gas().transact().await?;
    Ok(r.is_success())
}

#[tokio::test]
async fn pay_deliver_with_proof_accept_releases_to_seller() -> anyhow::Result<()> {
    let s = shop().await?;
    pay(&s, "o-1", "alice", 5 * ONE_NUSD).await?;
    assert_eq!(order(&s, "o-1").await?["status"], "Held");
    assert_eq!(balance(&s.env.nusd, s.orders.id()).await?, 5 * ONE_NUSD);

    // No proof, a failed review, or someone else's proof: not delivered.
    let failed = prove(&s, &s.alice, "o-1", false).await?;
    assert!(!deliver(&s, &s.alice, "o-1", &failed).await?);
    let forged = prove(&s, &s.buyer, "o-1", true).await?;
    assert!(!deliver(&s, &s.alice, "o-1", &forged).await?);
    let good = prove(&s, &s.alice, "o-1", true).await?;
    assert!(!deliver(&s, &s.buyer, "o-1", &good).await?, "only the seller marks delivered");
    assert_eq!(order(&s, "o-1").await?["status"], "Held");

    assert!(deliver(&s, &s.alice, "o-1", &good).await?);
    assert_eq!(order(&s, "o-1").await?["status"], "Delivered");
    assert!(!act(&s.alice, &s, "accept", "o-1").await?, "only the buyer accepts");
    assert!(act(&s.buyer, &s, "accept", "o-1").await?);
    assert_eq!(order(&s, "o-1").await?["status"], "Released");
    assert_eq!(balance(&s.env.nusd, s.alice.id()).await?, 5 * ONE_NUSD);
    assert_eq!(balance(&s.env.nusd, s.orders.id()).await?, 0);
    Ok(())
}

#[tokio::test]
async fn duplicate_order_and_unknown_seller_are_refunded() -> anyhow::Result<()> {
    let s = shop().await?;
    assert_eq!(pay(&s, "o-1", "alice", 5 * ONE_NUSD).await?, (5 * ONE_NUSD).to_string());
    assert_eq!(pay(&s, "o-1", "alice", 3 * ONE_NUSD).await?, "0", "duplicate id: nothing used");
    assert_eq!(pay(&s, "o-2", "nobody", 3 * ONE_NUSD).await?, "0", "unknown seller: nothing used");
    assert!(order(&s, "o-2").await?.is_null());
    assert_eq!(balance(&s.env.nusd, s.buyer.id()).await?, 95 * ONE_NUSD);
    Ok(())
}

#[tokio::test]
async fn revision_then_refund_with_seller_approval() -> anyhow::Result<()> {
    let s = shop().await?;
    pay(&s, "o-1", "alice", 5 * ONE_NUSD).await?;
    let p1 = prove(&s, &s.alice, "o-1", true).await?;
    assert!(deliver(&s, &s.alice, "o-1", &p1).await?);
    assert!(!act(&s.buyer, &s, "request_refund", "o-1").await?, "revision comes first");
    assert!(act(&s.buyer, &s, "request_revision", "o-1").await?);
    assert_eq!(order(&s, "o-1").await?["status"], "RevisionRequested");

    let p2 = prove(&s, &s.alice, "o-1", true).await?;
    assert!(deliver(&s, &s.alice, "o-1", &p2).await?);
    assert!(!act(&s.buyer, &s, "request_revision", "o-1").await?, "only one revision");
    assert!(act(&s.buyer, &s, "request_refund", "o-1").await?);
    assert!(!act(&s.buyer, &s, "approve_refund", "o-1").await?, "buyer can't approve own refund");
    assert!(act(&s.alice, &s, "approve_refund", "o-1").await?);
    assert_eq!(order(&s, "o-1").await?["status"], "Refunded");
    assert_eq!(balance(&s.env.nusd, s.buyer.id()).await?, 100 * ONE_NUSD);
    Ok(())
}

#[tokio::test]
async fn release_after_timeout_by_anyone() -> anyhow::Result<()> {
    let s = shop().await?;
    let params: Value = s.orders.view("get_params").await?.json()?;
    let mut p = params.clone();
    p["release_after_ns"] = json!("30000000000"); // 30 s
    s.env.root.call(s.orders.id(), "set_params").args_json(json!({"params": p})).transact().await?.into_result()?;

    pay(&s, "o-1", "alice", 5 * ONE_NUSD).await?;
    let pr = prove(&s, &s.alice, "o-1", true).await?;
    assert!(deliver(&s, &s.alice, "o-1", &pr).await?);
    let stranger = sub(&s.env.root, "stranger", 5).await?;
    assert!(!act(&stranger, &s, "release_expired", "o-1").await?, "too early");
    s.env.worker.fast_forward(200).await?;
    assert!(act(&stranger, &s, "release_expired", "o-1").await?);
    assert_eq!(order(&s, "o-1").await?["status"], "Released");
    assert_eq!(balance(&s.env.nusd, s.alice.id()).await?, 5 * ONE_NUSD);
    Ok(())
}

#[tokio::test]
async fn undelivered_order_refunds_after_deadline() -> anyhow::Result<()> {
    let s = shop().await?;
    let mut p: Value = s.orders.view("get_params").await?.json()?;
    p["delivery_deadline_ns"] = json!("30000000000");
    s.env.root.call(s.orders.id(), "set_params").args_json(json!({"params": p})).transact().await?.into_result()?;
    pay(&s, "o-1", "alice", 5 * ONE_NUSD).await?;
    assert!(!act(&s.buyer, &s, "refund_undelivered", "o-1").await?);
    s.env.worker.fast_forward(200).await?;
    assert!(act(&s.buyer, &s, "refund_undelivered", "o-1").await?);
    assert_eq!(balance(&s.env.nusd, s.buyer.id()).await?, 100 * ONE_NUSD);
    Ok(())
}

#[tokio::test]
async fn failed_payout_reverts_status() -> anyhow::Result<()> {
    // A buyer that unregisters from nUSD after paying: the refund transfer fails and the order
    // must go back to its previous state instead of being lost in `Refunding`.
    let s = shop().await?;
    let mut p: Value = s.orders.view("get_params").await?.json()?;
    p["delivery_deadline_ns"] = json!("30000000000");
    s.env.root.call(s.orders.id(), "set_params").args_json(json!({"params": p})).transact().await?.into_result()?;
    pay(&s, "o-1", "alice", 5 * ONE_NUSD).await?;
    // Empty the buyer's balance, then unregister.
    s.buyer.call(s.env.nusd.id(), "ft_transfer")
        .args_json(json!({"receiver_id": s.alice.id(), "amount": (95 * ONE_NUSD).to_string()}))
        .deposit(NearToken::from_yoctonear(1)).transact().await?.into_result()?;
    s.buyer.call(s.env.nusd.id(), "storage_unregister").args_json(json!({"force": false}))
        .deposit(NearToken::from_yoctonear(1)).transact().await?.into_result()?;
    s.env.worker.fast_forward(200).await?;
    let r = s.buyer.call(s.orders.id(), "refund_undelivered").args_json(json!({"order_id": "o-1"}))
        .max_gas().transact().await?;
    assert!(r.is_success());
    assert_eq!(r.json::<bool>()?, false, "payout reported as failed");
    assert_eq!(order(&s, "o-1").await?["status"], "Held", "status reverted");
    assert_eq!(balance(&s.env.nusd, s.orders.id()).await?, 5 * ONE_NUSD, "money still held");
    Ok(())
}
