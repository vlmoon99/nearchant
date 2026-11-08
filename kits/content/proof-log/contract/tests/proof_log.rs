//! Sandbox tests (near-workspaces). `cargo test` builds the contract with cargo-near and runs each test on a
//! fresh local sandbox.
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};
use tokio::sync::OnceCell;

static WASM: OnceCell<Vec<u8>> = OnceCell::const_new();

async fn setup() -> anyhow::Result<(Contract, Account, Account)> {
    let code = WASM.get_or_try_init(|| near_workspaces::compile_project(env!("CARGO_MANIFEST_DIR"))).await?;
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let log = root.create_subaccount("log").initial_balance(NearToken::from_near(10)).transact().await?.into_result()?
        .deploy(code).await?.into_result()?;
    log.call("new").transact().await?.into_result()?;
    let alice = root.create_subaccount("alice").initial_balance(NearToken::from_near(10)).transact().await?.into_result()?;
    let mallory = root.create_subaccount("mallory").initial_balance(NearToken::from_near(10)).transact().await?.into_result()?;
    Ok((log, alice, mallory))
}

fn entry(hash: &str, subject: Option<&str>, passed: Option<bool>) -> Value {
    json!({"entry": {"content_hash": hash, "producer": "model:test", "subject": subject, "passed": passed,
        "metadata": json!({"caption_sha256": "c".repeat(64), "image_sha256": null}).to_string()}})
}

async fn record(log: &Contract, who: &Account, args: Value) -> anyhow::Result<String> {
    Ok(who.call(log.id(), "record").args_json(args).deposit(NearToken::from_millinear(10)).transact().await?.into_result()?.json()?)
}

#[tokio::test]
async fn record_get_and_list_by_author() -> anyhow::Result<()> {
    let (log, alice, mallory) = setup().await?;
    let h1 = "a".repeat(64);
    let id = record(&log, &alice, entry(&h1, Some("post:1"), None)).await?;
    assert_eq!(id, "1");
    record(&log, &alice, entry(&"b".repeat(64), None, None)).await?;
    record(&log, &mallory, entry(&h1, None, None)).await?;
    record(&log, &alice, entry(&"c".repeat(64), None, None)).await?;

    let e: Value = log.view("get").args_json(json!({"id": "1"})).await?.json()?;
    assert_eq!(e["author_id"], alice.id().as_str());
    assert_eq!(e["content_hash"], h1);
    assert_eq!(e["subject"], "post:1");
    assert!(e["created_at"].as_str().unwrap().parse::<u64>()? > 0);
    let meta: Value = serde_json::from_str(e["metadata"].as_str().unwrap())?;
    assert_eq!(meta["caption_sha256"], "c".repeat(64));
    assert!(log.view("get").args_json(json!({"id": "99"})).await?.json::<Value>()?.is_null());

    let count: String = log.view("count_by_author").args_json(json!({"author_id": alice.id()})).await?.json()?;
    assert_eq!(count, "3");
    let all: Vec<Value> = log.view("list_by_author").args_json(json!({"author_id": alice.id()})).await?.json()?;
    assert_eq!(all.iter().map(|e| e["id"].as_str().unwrap()).collect::<Vec<_>>(), ["1", "2", "4"]);
    let page: Vec<Value> = log.view("list_by_author").args_json(json!({"author_id": alice.id(), "from_index": "1", "limit": 1})).await?.json()?;
    assert_eq!(page.len(), 1);
    assert_eq!(page[0]["id"], "2");

    let same: Vec<Value> = log.view("find_by_hash").args_json(json!({"content_hash": h1})).await?.json()?;
    assert_eq!(same.iter().map(|e| e["author_id"].as_str().unwrap()).collect::<Vec<_>>(), [alice.id().as_str(), mallory.id().as_str()]);
    let next: String = log.view("get_next_id").await?.json()?;
    assert_eq!(next, "5");
    Ok(())
}

#[tokio::test]
async fn is_passed_checks_subject_author_and_review() -> anyhow::Result<()> {
    let (log, alice, mallory) = setup().await?;
    let ok = record(&log, &alice, entry("h1", Some("o-1"), Some(true))).await?;
    let unreviewed = record(&log, &alice, entry("h2", Some("o-2"), None)).await?;
    let failed = record(&log, &alice, entry("h3", Some("o-3"), Some(false))).await?;
    let forged = record(&log, &mallory, entry("h4", Some("o-1"), Some(true))).await?;
    let check = |id: &str, subject: &str, author: &Account| json!({"proof_id": id, "subject": subject, "author_id": author.id()});
    let yes = |v: Value| async { log.view("is_passed").args_json(v).await.unwrap().json::<bool>().unwrap() };
    assert!(yes(check(&ok, "o-1", &alice)).await);
    assert!(yes(check(&unreviewed, "o-2", &alice)).await, "no review = not failed");
    assert!(!yes(check(&ok, "o-9", &alice)).await, "wrong subject");
    assert!(!yes(check(&failed, "o-3", &alice)).await, "failed review");
    assert!(!yes(check(&forged, "o-1", &alice)).await, "wrong author");
    assert!(!yes(check("99", "o-1", &alice)).await, "missing entry");
    Ok(())
}

#[tokio::test]
async fn bad_entries_and_missing_deposit_are_refused() -> anyhow::Result<()> {
    let (log, alice, _) = setup().await?;
    let call = |args: Value, deposit: NearToken| {
        let (log, alice) = (log.clone(), alice.clone());
        async move { alice.call(log.id(), "record").args_json(args).deposit(deposit).transact().await.unwrap().is_success() }
    };
    let ten = NearToken::from_millinear(10);
    assert!(!call(entry("", None, None), ten).await, "empty hash");
    assert!(!call(entry(&"x".repeat(129), None, None), ten).await, "hash too long");
    assert!(!call(json!({"entry": {"content_hash": "h", "metadata": "not json"}}), ten).await, "metadata must be JSON");
    assert!(!call(json!({"entry": {"content_hash": "h"}}), NearToken::from_yoctonear(0)).await, "no storage deposit");
    assert!(call(json!({"entry": {"content_hash": "h"}}), ten).await, "minimal entry");
    let next: String = log.view("get_next_id").await?.json()?;
    assert_eq!(next, "2", "failed calls wrote nothing");
    Ok(())
}

#[tokio::test]
async fn writer_pays_only_the_storage_used() -> anyhow::Result<()> {
    let (log, alice, _) = setup().await?;
    let before = alice.view_account().await?.balance;
    alice.call(log.id(), "record").args_json(entry(&"a".repeat(64), Some("post:1"), None))
        .deposit(NearToken::from_near(1)).transact().await?.into_result()?;
    let spent = before.saturating_sub(alice.view_account().await?.balance);
    // Storage (~0.01 NEAR at most) plus gas, never the full 1 NEAR attached.
    assert!(spent < NearToken::from_millinear(20), "spent {spent}");
    Ok(())
}
