//! The durable write path of the document store (`records` + `kv`).
//!
//! tauri-plugin-sql runs every `execute` call on any connection of a sqlx
//! pool (up to ten) and hands each connection back from a spawned task. A
//! "BEGIN" sent as its own call can land on one connection and the statements
//! after it on others. The connection left inside the open transaction keeps
//! SQLite's write lock, so every write on another connection waits out the
//! five-second busy timeout and fails with "database is locked" (SQLITE_BUSY,
//! code 5), and whatever ran on the stranded connection is never committed.
//! The renderer therefore sends every write here: one batch is one
//! transaction on one connection, taking the write lock up front, rolled back
//! if any statement fails.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sqlx::{Row, Sqlite, SqlitePool, Transaction};
use tauri::State;
use tauri_plugin_sql::{DbInstances, DbPool};

/// One change to the document store, in the order the renderer queued it.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StorageWrite {
    /// Replace every row of a collection with these documents.
    ReplaceCollection {
        collection: String,
        records: Vec<StoredRecord>,
    },
    /// Set a scalar key (preferences, meta, view settings).
    SetKv { key: String, value: String },
    /// Remove a key from both tables: retired collections still have rows in
    /// `records`, scalar keys live in `kv`.
    Remove { key: String },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredRecord {
    pub id: String,
    /// The validated JSON document, already serialized by the renderer.
    pub data: String,
}

/// Applies `writes` as one transaction. Nothing is kept if any write fails.
pub async fn apply_writes(
    pool: &SqlitePool,
    writes: &[StorageWrite],
    now_ms: i64,
) -> Result<(), sqlx::Error> {
    // IMMEDIATE takes the write lock now, so two batches queue on the busy
    // timeout instead of failing on a read-to-write lock upgrade.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    for write in writes {
        apply_one(&mut tx, write, now_ms).await?;
    }
    // Dropping `tx` on an early return above rolls the batch back.
    tx.commit().await
}

async fn apply_one(
    tx: &mut Transaction<'static, Sqlite>,
    write: &StorageWrite,
    now_ms: i64,
) -> Result<(), sqlx::Error> {
    match write {
        StorageWrite::ReplaceCollection {
            collection,
            records,
        } => {
            sqlx::query("DELETE FROM records WHERE collection = ?1")
                .bind(collection)
                .execute(&mut **tx)
                .await?;
            for record in records {
                sqlx::query(
                    "INSERT INTO records (collection, id, data, updated_at) VALUES (?1, ?2, ?3, ?4)",
                )
                .bind(collection)
                .bind(&record.id)
                .bind(&record.data)
                .bind(now_ms)
                .execute(&mut **tx)
                .await?;
            }
        }
        StorageWrite::SetKv { key, value } => {
            sqlx::query(
                "INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )
            .bind(key)
            .bind(value)
            .execute(&mut **tx)
            .await?;
        }
        StorageWrite::Remove { key } => {
            sqlx::query("DELETE FROM records WHERE collection = ?1")
                .bind(key)
                .execute(&mut **tx)
                .await?;
            sqlx::query("DELETE FROM kv WHERE key = ?1")
                .bind(key)
                .execute(&mut **tx)
                .await?;
        }
    }
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// One document of the store, as the renderer mirrors it at boot.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct LoadedRecord {
    pub collection: String,
    pub id: String,
    pub data: String,
}

/// One scalar key of the store.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct LoadedKv {
    pub key: String,
    pub value: String,
}

/// Everything the renderer mirrors at boot: the two reads it used to send as
/// SQL, fixed here so the window needs no permission to run a query.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct StorageSnapshot {
    pub records: Vec<LoadedRecord>,
    pub kv: Vec<LoadedKv>,
}

/// Reads every record and every scalar key.
pub async fn load_all(pool: &SqlitePool) -> Result<StorageSnapshot, sqlx::Error> {
    let records =
        sqlx::query("SELECT collection, id, data FROM records ORDER BY collection, updated_at")
            .fetch_all(pool)
            .await?
            .iter()
            .map(|row| LoadedRecord {
                collection: row.get("collection"),
                id: row.get("id"),
                data: row.get("data"),
            })
            .collect();
    let kv = sqlx::query("SELECT key, value FROM kv")
        .fetch_all(pool)
        .await?
        .iter()
        .map(|row| LoadedKv {
            key: row.get("key"),
            value: row.get("value"),
        })
        .collect();
    Ok(StorageSnapshot { records, kv })
}

/// Reads the whole document store of a database the SQL plugin has loaded
/// (`db` is its connection string). The window is granted no SQL permission,
/// so this and `storage_apply_writes` are its only way to the database.
#[tauri::command]
pub async fn storage_load(
    instances: State<'_, DbInstances>,
    db: String,
) -> Result<StorageSnapshot, String> {
    let pools = instances.0.read().await;
    let pool = match pools.get(&db) {
        Some(DbPool::Sqlite(pool)) => pool,
        None => return Err(format!("database {db} is not loaded")),
    };
    load_all(pool).await.map_err(|error| error.to_string())
}

/// Writes one batch to a database the SQL plugin has loaded (`db` is the
/// connection string the page uses for it).
#[tauri::command]
pub async fn storage_apply_writes(
    instances: State<'_, DbInstances>,
    db: String,
    writes: Vec<StorageWrite>,
) -> Result<(), String> {
    let pools = instances.0.read().await;
    let pool = match pools.get(&db) {
        Some(DbPool::Sqlite(pool)) => pool,
        None => return Err(format!("database {db} is not loaded")),
    };
    apply_writes(pool, &writes, now_ms())
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    /// A file database with the app's real migrations, behind a ten-connection
    /// pool like the plugin's. In-memory databases are per connection, so a
    /// pool test needs a file.
    async fn app_database() -> (SqlitePool, PathBuf) {
        let path = std::env::temp_dir().join(format!("qutra-storage-{}.db", uuid::Uuid::new_v4()));
        let pool = SqlitePoolOptions::new()
            .max_connections(10)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true),
            )
            .await
            .expect("open test database");
        for migration in crate::migrations() {
            sqlx::raw_sql(migration.sql)
                .execute(&pool)
                .await
                .unwrap_or_else(|error| panic!("migration {}: {error}", migration.version));
        }
        (pool, path)
    }

    async fn close(pool: SqlitePool, path: PathBuf) {
        pool.close().await;
        let _ = std::fs::remove_file(path);
    }

    fn record(id: &str, title: &str) -> StoredRecord {
        StoredRecord {
            id: id.into(),
            data: format!(r#"{{"id":"{id}","title":"{title}"}}"#),
        }
    }

    async fn ids(pool: &SqlitePool, collection: &str) -> Vec<String> {
        sqlx::query("SELECT id FROM records WHERE collection = ?1 ORDER BY id")
            .bind(collection)
            .fetch_all(pool)
            .await
            .unwrap()
            .iter()
            .map(|row| row.get::<String, _>("id"))
            .collect()
    }

    async fn kv(pool: &SqlitePool, key: &str) -> Option<String> {
        sqlx::query("SELECT value FROM kv WHERE key = ?1")
            .bind(key)
            .fetch_optional(pool)
            .await
            .unwrap()
            .map(|row| row.get::<String, _>("value"))
    }

    #[tokio::test]
    async fn replaces_a_collection_and_sets_keys_in_one_batch() {
        let (pool, path) = app_database().await;
        apply_writes(
            &pool,
            &[
                StorageWrite::ReplaceCollection {
                    collection: "tasks".into(),
                    records: vec![record("a", "A"), record("b", "B")],
                },
                StorageWrite::SetKv {
                    key: "preferences".into(),
                    value: r#"{"locale":"en"}"#.into(),
                },
            ],
            1,
        )
        .await
        .unwrap();
        apply_writes(
            &pool,
            &[StorageWrite::ReplaceCollection {
                collection: "tasks".into(),
                records: vec![record("b", "B2"), record("c", "C")],
            }],
            2,
        )
        .await
        .unwrap();

        assert_eq!(ids(&pool, "tasks").await, ["b", "c"]);
        assert_eq!(
            kv(&pool, "preferences").await.as_deref(),
            Some(r#"{"locale":"en"}"#)
        );
        close(pool, path).await;
    }

    #[tokio::test]
    async fn load_all_returns_what_was_written_in_boot_order() {
        let (pool, path) = app_database().await;
        let empty = load_all(&pool).await.unwrap();
        assert!(empty.records.is_empty() && empty.kv.is_empty());

        apply_writes(
            &pool,
            &[
                StorageWrite::ReplaceCollection {
                    collection: "tasks".into(),
                    records: vec![record("a", "A")],
                },
                StorageWrite::ReplaceCollection {
                    collection: "notes".into(),
                    records: vec![record("n", "N")],
                },
                StorageWrite::SetKv {
                    key: "preferences".into(),
                    value: r#"{"locale":"tr"}"#.into(),
                },
            ],
            1,
        )
        .await
        .unwrap();

        let loaded = load_all(&pool).await.unwrap();
        assert_eq!(
            loaded.records,
            vec![
                LoadedRecord {
                    collection: "notes".into(),
                    id: "n".into(),
                    data: r#"{"id":"n","title":"N"}"#.into(),
                },
                LoadedRecord {
                    collection: "tasks".into(),
                    id: "a".into(),
                    data: r#"{"id":"a","title":"A"}"#.into(),
                },
            ]
        );
        assert_eq!(
            loaded.kv,
            vec![LoadedKv {
                key: "preferences".into(),
                value: r#"{"locale":"tr"}"#.into(),
            }]
        );
        close(pool, path).await;
    }

    #[tokio::test]
    async fn remove_clears_both_tables() {
        let (pool, path) = app_database().await;
        apply_writes(
            &pool,
            &[
                StorageWrite::ReplaceCollection {
                    collection: "notes".into(),
                    records: vec![record("n1", "Old note")],
                },
                StorageWrite::SetKv {
                    key: "notes".into(),
                    value: "[]".into(),
                },
            ],
            1,
        )
        .await
        .unwrap();

        apply_writes(
            &pool,
            &[StorageWrite::Remove {
                key: "notes".into(),
            }],
            2,
        )
        .await
        .unwrap();

        assert!(ids(&pool, "notes").await.is_empty());
        assert_eq!(kv(&pool, "notes").await, None);
        let fts: i64 = sqlx::query("SELECT count(*) AS n FROM notes_fts")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get("n");
        assert_eq!(fts, 0, "the notes FTS triggers ran inside the transaction");
        close(pool, path).await;
    }

    #[tokio::test]
    async fn a_failing_write_keeps_nothing_and_leaves_no_lock_behind() {
        let (pool, path) = app_database().await;
        apply_writes(
            &pool,
            &[StorageWrite::SetKv {
                key: "preferences".into(),
                value: "v1".into(),
            }],
            1,
        )
        .await
        .unwrap();

        // The duplicate id breaks the (collection, id) key after the kv write.
        let failed = apply_writes(
            &pool,
            &[
                StorageWrite::SetKv {
                    key: "preferences".into(),
                    value: "v2".into(),
                },
                StorageWrite::ReplaceCollection {
                    collection: "tasks".into(),
                    records: vec![record("x", "X"), record("x", "X again")],
                },
            ],
            2,
        )
        .await;
        assert!(failed.is_err());
        assert_eq!(kv(&pool, "preferences").await.as_deref(), Some("v1"));
        assert!(ids(&pool, "tasks").await.is_empty());

        // Well inside the five-second busy timeout: nothing holds the lock.
        let started = Instant::now();
        apply_writes(
            &pool,
            &[StorageWrite::SetKv {
                key: "preferences".into(),
                value: "v3".into(),
            }],
            3,
        )
        .await
        .unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(kv(&pool, "preferences").await.as_deref(), Some("v3"));
        close(pool, path).await;
    }

    /// One batch per pool connection, all at once: every connection waits for
    /// the write lock together. More batches than connections only lengthen
    /// the queue, and SQLite's busy handler is not first-come-first-served,
    /// so on a slow CI runner one waiter could starve past the five-second
    /// busy timeout (seen once with 40 batches; the run was about eight
    /// times slower than a desktop). That tests the runner's disk, not the
    /// write path.
    const CONCURRENT_BATCHES: i64 = 10;

    #[tokio::test]
    async fn concurrent_batches_on_the_pool_never_report_a_locked_database() {
        let (pool, path) = app_database().await;
        let mut tasks = Vec::new();
        for n in 0..CONCURRENT_BATCHES {
            let pool = pool.clone();
            tasks.push(tokio::spawn(async move {
                apply_writes(
                    &pool,
                    &[
                        StorageWrite::SetKv {
                            key: format!("key-{n}"),
                            value: n.to_string(),
                        },
                        StorageWrite::ReplaceCollection {
                            collection: format!("collection-{}", n % 4),
                            records: vec![record(&format!("r{n}"), "R")],
                        },
                    ],
                    n,
                )
                .await
            }));
        }
        for task in tasks {
            task.await.unwrap().unwrap();
        }

        let keys: i64 = sqlx::query("SELECT count(*) AS n FROM kv WHERE key LIKE 'key-%'")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get("n");
        assert_eq!(keys, CONCURRENT_BATCHES);
        for c in 0..4 {
            assert_eq!(ids(&pool, &format!("collection-{c}")).await.len(), 1);
        }
        close(pool, path).await;
    }

    #[test]
    fn refuses_unknown_fields_in_a_record() {
        let parsed: Result<StorageWrite, _> = serde_json::from_str(
            r#"{"kind":"replaceCollection","collection":"tasks","records":[{"id":"a","data":"{}","path":"C:\\x"}]}"#,
        );
        assert!(parsed.is_err());
    }
}
