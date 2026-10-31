mod common;
use common::*;
use serde_json::json;

#[tokio::test]
async fn record_and_check_passed() -> anyhow::Result<()> {
    let env = base().await?;
    let proofs = deploy(&env.root, "proofs", "proof-log").await?;
    proofs.call("new").transact().await?.into_result()?;
    let seller = sub(&env.root, "alice", 5).await?;
    let other = sub(&env.root, "mallory", 5).await?;

    let entry = |order: &str, passed: bool| json!({"entry": {
        "task_id": "t1", "order_id": order, "brief_hash": "b".repeat(64), "producer": "model:qwen3.6-35b-a3b",
        "output_hash": "o".repeat(64), "attestation_ref": null, "review": {"passed": passed, "reviewer_hash": "r1"}
    }});
    let id: String = seller.call(proofs.id(), "record").args_json(entry("o-1", true)).transact().await?.into_result()?.json()?;
    let bad: String = seller.call(proofs.id(), "record").args_json(entry("o-2", false)).transact().await?.into_result()?.json()?;
    let forged: String = other.call(proofs.id(), "record").args_json(entry("o-1", true)).transact().await?.into_result()?.json()?;

    let check = |pid: &str, order: &str, author: &near_workspaces::AccountId| json!({"proof_id": pid, "order_id": order, "author_id": author});
    let yes: bool = proofs.view("is_passed").args_json(check(&id, "o-1", seller.id())).await?.json()?;
    let wrong_order: bool = proofs.view("is_passed").args_json(check(&id, "o-9", seller.id())).await?.json()?;
    let failed_review: bool = proofs.view("is_passed").args_json(check(&bad, "o-2", seller.id())).await?.json()?;
    let wrong_author: bool = proofs.view("is_passed").args_json(check(&forged, "o-1", seller.id())).await?.json()?;
    assert!(yes && !wrong_order && !failed_review && !wrong_author);

    let empty = json!({"entry": {"task_id": "", "order_id": null, "brief_hash": "b", "producer": "p",
        "output_hash": "o", "attestation_ref": null, "review": {"passed": true, "reviewer_hash": "r"}}});
    assert!(seller.call(proofs.id(), "record").args_json(empty).transact().await?.is_failure());
    Ok(())
}
