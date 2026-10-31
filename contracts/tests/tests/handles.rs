mod common;
use common::*;
use near_workspaces::types::{KeyType, NearToken, SecretKey};
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};

/// Handles factory on a "platform root" account, so handles become `<name>.nearchant.test.near`.
async fn setup() -> anyhow::Result<(Env, Contract, Account)> {
    let env = base().await?;
    let factory = deploy(&env.root, "nearchant", "handles").await?;
    let orders: near_workspaces::AccountId = format!("orders.{}", env.root.id()).parse()?;
    factory
        .call("new")
        .args_json(json!({"owner_id": env.root.id(), "relayer_id": env.relayer.id(), "agent_receivers": [orders]}))
        .transact()
        .await?
        .into_result()?;
    let seller = sub(&env.root, "seller", 10).await?;
    Ok((env, factory, seller))
}

fn card(name: &str) -> Value {
    json!({"name": name, "bio": "Decks in an hour", "avatar_hash": null, "links": ["https://example.com"]})
}

#[tokio::test]
async fn claim_creates_account_owned_by_seller_key() -> anyhow::Result<()> {
    let (env, factory, seller) = setup().await?;
    let sk = SecretKey::from_random(KeyType::ED25519);
    let res = seller
        .call(factory.id(), "claim")
        .args_json(json!({"handle": "alice", "public_key": sk.public_key(), "card": card("Alice")}))
        .deposit(NearToken::from_millinear(500))
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "{res:?}");
    assert!(res.logs().iter().any(|l| l.contains("handle_claimed")));

    let h: Value = factory.view("get_handle").args_json(json!({"handle": "alice"})).await?.json()?;
    let account_id = format!("alice.{}", factory.id());
    assert_eq!(h["account_id"], account_id);
    assert_eq!(h["owner_id"], seller.id().to_string());
    assert_eq!(h["status"], "Active");

    // The new account exists and the seller's key controls it.
    let alice = Account::from_secret_key(account_id.parse()?, sk, &env.worker);
    let details = alice.view_account().await?;
    assert!(details.balance > NearToken::from_millinear(400));
    let keys = alice.view_access_keys().await?;
    assert_eq!(keys.len(), 1);
    Ok(())
}

#[tokio::test]
async fn names_are_validated_reserved_and_unique() -> anyhow::Result<()> {
    let (_env, factory, seller) = setup().await?;
    for bad in ["a", "Alice", "al.ice", "-alice", "alice-", "al--ice", "admin", "orders", "x".repeat(33).as_str()] {
        let pk = SecretKey::from_random(KeyType::ED25519).public_key();
        let r = seller
            .call(factory.id(), "claim")
            .args_json(json!({"handle": bad, "public_key": pk, "card": card("x")}))
            .deposit(NearToken::from_millinear(200))
            .max_gas()
            .transact()
            .await?;
        assert!(r.is_failure(), "{bad} should be refused");
    }
    let pk = SecretKey::from_random(KeyType::ED25519).public_key();
    seller.call(factory.id(), "claim")
        .args_json(json!({"handle": "bob_1", "public_key": pk, "card": card("Bob")}))
        .deposit(NearToken::from_millinear(200)).max_gas().transact().await?.into_result()?;
    let pk = SecretKey::from_random(KeyType::ED25519).public_key();
    let dup = seller.call(factory.id(), "claim")
        .args_json(json!({"handle": "bob_1", "public_key": pk, "card": card("Bob")}))
        .deposit(NearToken::from_millinear(200)).max_gas().transact().await?;
    assert!(dup.is_failure());
    let avail: bool = factory.view("is_available").args_json(json!({"name": "bob_1"})).await?.json()?;
    assert!(!avail);
    Ok(())
}

#[tokio::test]
async fn claim_for_is_relayer_only_and_adds_scoped_agent_keys() -> anyhow::Result<()> {
    let (env, factory, seller) = setup().await?;
    let owner_sk = SecretKey::from_random(KeyType::ED25519);
    let agent_sk = SecretKey::from_random(KeyType::ED25519);
    let orders = format!("orders.{}", env.root.id());
    let args = json!({
        "handle": "judge",
        "public_key": owner_sk.public_key(),
        "card": card("Judge"),
        "agent_keys": [{"public_key": agent_sk.public_key(), "receiver_id": orders, "method_names": ["mark_delivered"]}],
    });
    let bad = seller.call(factory.id(), "claim_for").args_json(args.clone()).max_gas().transact().await?;
    assert!(bad.is_failure());

    env.relayer.call(factory.id(), "claim_for").args_json(args).max_gas().transact().await?.into_result()?;
    let h: Value = factory.view("get_handle").args_json(json!({"handle": "judge"})).await?.json()?;
    let account_id = format!("judge.{}", factory.id());
    assert_eq!(h["owner_id"], account_id, "sponsored account owns itself");

    let judge = Account::from_secret_key(account_id.parse()?, owner_sk, &env.worker);
    assert_eq!(judge.view_access_keys().await?.len(), 2);

    // An agent key to a contract outside the allowlist is refused.
    let evil = json!({
        "handle": "judge2",
        "public_key": SecretKey::from_random(KeyType::ED25519).public_key(),
        "card": card("J2"),
        "agent_keys": [{"public_key": agent_sk.public_key(), "receiver_id": "nusd.test.near", "method_names": ["ft_transfer"]}],
    });
    let r = env.relayer.call(factory.id(), "claim_for").args_json(evil).max_gas().transact().await?;
    assert!(r.is_failure());
    Ok(())
}

#[tokio::test]
async fn failed_creation_rolls_back_and_refunds() -> anyhow::Result<()> {
    let (env, factory, seller) = setup().await?;
    // Pre-create the subaccount so the factory's create_account fails.
    factory.as_account().create_subaccount("taken").initial_balance(NearToken::from_millinear(100))
        .transact().await?.into_result()?;
    let before = seller.view_account().await?.balance;
    let pk = SecretKey::from_random(KeyType::ED25519).public_key();
    let res = seller.call(factory.id(), "claim")
        .args_json(json!({"handle": "taken", "public_key": pk, "card": card("T")}))
        .deposit(NearToken::from_near(2)).max_gas().transact().await?;
    let ok: bool = res.json().unwrap_or(true);
    assert!(!ok, "callback should report failure");
    let h: Option<Value> = factory.view("get_handle_any").args_json(json!({"handle": "taken"})).await?.json()?;
    assert!(h.is_none(), "pending record removed");
    let after = seller.view_account().await?.balance;
    assert!(before.as_yoctonear() - after.as_yoctonear() < NearToken::from_millinear(50).as_yoctonear(), "deposit refunded");
    let _ = env;
    Ok(())
}

#[tokio::test]
async fn only_owner_updates_and_suspend_hides() -> anyhow::Result<()> {
    let (env, factory, seller) = setup().await?;
    let pk = SecretKey::from_random(KeyType::ED25519).public_key();
    seller.call(factory.id(), "claim")
        .args_json(json!({"handle": "carol", "public_key": pk, "card": card("Carol")}))
        .deposit(NearToken::from_millinear(200)).max_gas().transact().await?.into_result()?;
    let mallory = sub(&env.root, "mallory", 5).await?;
    let r = mallory.call(factory.id(), "set_card").args_json(json!({"handle": "carol", "card": card("pwned")})).transact().await?;
    assert!(r.is_failure());

    seller.call(factory.id(), "set_embed_origins")
        .args_json(json!({"handle": "carol", "origins": ["https://carol.example", "http://localhost:5173"]}))
        .transact().await?.into_result()?;
    let r = seller.call(factory.id(), "set_embed_origins")
        .args_json(json!({"handle": "carol", "origins": ["*"]})).transact().await?;
    assert!(r.is_failure(), "wildcard origin refused");

    env.root.call(factory.id(), "suspend").args_json(json!({"handle": "carol", "reason": "impersonation"}))
        .transact().await?.into_result()?;
    let h: Option<Value> = factory.view("get_handle").args_json(json!({"handle": "carol"})).await?.json()?;
    assert!(h.is_none(), "suspended handle reads as missing");
    Ok(())
}

#[tokio::test]
async fn link_existing_account() -> anyhow::Result<()> {
    let (_env, factory, seller) = setup().await?;
    seller.call(factory.id(), "link").args_json(json!({"handle": "dave", "card": card("Dave")}))
        .transact().await?.into_result()?;
    let h: Value = factory.view("get_handle").args_json(json!({"handle": "dave"})).await?.json()?;
    assert_eq!(h["account_id"], seller.id().to_string());
    Ok(())
}
