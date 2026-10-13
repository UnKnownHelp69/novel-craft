// Unit tests for the file-access allowlist and the write helpers in lib.rs.
use super::*;

/// A fresh scratch directory under the system temp dir.
fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("novelcraft-test-{}-{}", name, std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn granted_path_is_allowed_and_others_are_not() {
    let dir = scratch("grant");
    let novel = dir.join("book.novel");
    fs::write(&novel, "{}").unwrap();
    let granted = GrantedPaths::default();
    granted.grant(&novel);

    assert!(is_allowed(&granted, &path_key(&novel), &[]));
    assert!(!is_allowed(
        &granted,
        &path_key(&dir.join("other.novel")),
        &[]
    ));
    assert!(!is_allowed(
        &granted,
        &path_key(Path::new("/etc/passwd")),
        &[]
    ));
}

#[test]
fn dot_dot_segments_resolve_to_the_real_file() {
    let dir = scratch("dotdot");
    fs::create_dir_all(dir.join("sub")).unwrap();
    let novel = dir.join("book.novel");
    fs::write(&novel, "{}").unwrap();
    let granted = GrantedPaths::default();
    granted.grant(&novel);

    // the same file spelled differently is the same file
    assert!(is_allowed(
        &granted,
        &path_key(&dir.join("sub/../book.novel")),
        &[]
    ));
    // a granted path cannot be used as a stepping stone to a sibling
    assert!(!is_allowed(
        &granted,
        &path_key(&dir.join("book.novel/../secret.txt")),
        &[]
    ));
}

#[test]
fn a_save_as_target_stays_granted_once_it_exists() {
    let dir = scratch("saveas");
    let target = dir.join("new.novel");
    let granted = GrantedPaths::default();
    granted.grant(&target); // granted before the file exists, as pick_save does
    fs::write(&target, "{}").unwrap();
    assert!(is_allowed(&granted, &path_key(&target), &[]));
}

#[test]
fn remembered_paths_are_allowed() {
    let dir = scratch("remembered");
    let novel = dir.join("old.novel");
    fs::write(&novel, "{}").unwrap();
    let granted = GrantedPaths::default();
    let remembered = vec![novel.to_string_lossy().into_owned()];
    assert!(is_allowed(&granted, &path_key(&novel), &remembered));
    assert!(!is_allowed(
        &granted,
        &path_key(&dir.join("x.novel")),
        &remembered
    ));
}

#[test]
fn atomic_write_replaces_the_file_and_leaves_no_temp_files() {
    let dir = scratch("atomic");
    let target = dir.join("book.novel");
    atomic_write(&target, "first").unwrap();
    atomic_write(&target, "second").unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), "second");
    let leftovers: Vec<_> = fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with(".~tmp_"))
        .collect();
    assert!(leftovers.is_empty(), "temporary files left behind");
}

#[test]
fn atomic_write_cleans_up_when_the_rename_fails() {
    let dir = scratch("atomic-fail");
    let target = dir.join("is-a-dir");
    fs::create_dir_all(target.join("child")).unwrap(); // renaming a file over a non-empty dir fails
    assert!(atomic_write(&target, "data").is_err());
    let leftovers = fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with(".~tmp_"))
        .count();
    assert_eq!(
        leftovers, 0,
        "temporary file left behind after a failed rename"
    );
}

#[test]
fn b64_decode_round_trips_standard_base64() {
    assert_eq!(b64_decode("aGVsbG8gd29ybGQ=").unwrap(), b"hello world");
    assert_eq!(
        b64_decode("0JrQuNGA0LjQu9C70LjRhtCw").unwrap(),
        "Кириллица".as_bytes()
    );
    assert_eq!(b64_decode("").unwrap(), b"");
    assert!(b64_decode("not*base64").is_none());
}

#[cfg(unix)]
#[test]
fn writing_through_a_granted_symlink_keeps_the_link_and_the_grant() {
    let dir = scratch("symlink");
    fs::create_dir_all(dir.join("real")).unwrap();
    let target = dir.join("real/book.novel");
    let link = dir.join("book.novel");
    fs::write(&target, "old").unwrap();
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let granted = GrantedPaths::default();
    granted.grant(&link); // pick_save returned the link path

    // check_path hands the commands the authorised (canonical) path
    let key = path_key(&link);
    assert!(is_allowed(&granted, &key, &[]));
    atomic_write(&key, "new").unwrap();

    assert!(
        fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink(),
        "the link must survive"
    );
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        "new",
        "the target gets the data"
    );
    assert!(
        is_allowed(&granted, &path_key(&link), &[]),
        "the link stays granted for the next save"
    );
}

/* ---------------- backups ---------------- */

const DAY: u64 = 86_400;

#[test]
fn backup_names_are_unix_seconds_and_nothing_else() {
    assert_eq!(backup_time("1760348465.novel"), Some(1_760_348_465));
    for bad in [
        "",
        ".novel",
        "../1.novel",
        "1.novel/../x",
        "1.txt",
        "-1.novel",
        "1 .novel",
        "source.txt",
        "１２.novel",
    ] {
        assert_eq!(backup_time(bad), None, "{bad:?} must not be accepted");
    }
}

#[test]
fn backup_dirs_are_stable_per_file() {
    let a = backup_dir(Path::new("/root"), Path::new("/novels/a.novel"));
    assert_eq!(
        a,
        backup_dir(Path::new("/root"), Path::new("/novels/a.novel"))
    );
    assert_ne!(
        a,
        backup_dir(Path::new("/root"), Path::new("/novels/b.novel"))
    );
    assert_eq!(fnv1a64(""), 0xcbf2_9ce4_8422_2325);
}

#[test]
fn pruning_keeps_the_newest_twenty_and_one_per_day_for_a_month() {
    let now = 100 * DAY + DAY / 2; // midday, so the offsets below stay inside their day
                                   // 30 backups today, newest first, ten minutes apart
    let today: Vec<u64> = (0..30).map(|i| now - i * 600).collect();
    let doomed = backups_to_prune(&today, now);
    assert_eq!(
        doomed,
        today[20..].to_vec(),
        "only the 20 newest of today survive"
    );

    // one backup a day for 60 days: the newest 20 plus every day within 30 days survive
    let daily: Vec<u64> = (0..60).map(|d| now - d * DAY).collect();
    let doomed = backups_to_prune(&daily, now);
    assert!(
        doomed.iter().all(|&t| t < now - BACKUP_KEEP_DAYS * DAY),
        "nothing from the last 30 days goes"
    );
    assert_eq!(doomed.len(), 60 - 31);

    // several on an old day within the window: only that day's newest is kept
    let mut mixed: Vec<u64> = (0..20).map(|i| now - i * 60).collect();
    mixed.extend([now - 5 * DAY, now - 5 * DAY - 60, now - 5 * DAY - 120]);
    assert_eq!(
        backups_to_prune(&mixed, now),
        vec![now - 5 * DAY - 60, now - 5 * DAY - 120]
    );
}

#[test]
fn backup_file_copies_the_previous_version_and_respects_the_interval() {
    let dir = scratch("backup");
    let root = dir.join("backups");
    let novel = dir.join("book.novel");
    let t0 = 1_000 * DAY;

    assert!(
        !backup_file(&root, &novel, t0, 600, false).unwrap(),
        "nothing to back up yet"
    );
    fs::write(&novel, "v1").unwrap();
    assert!(backup_file(&root, &novel, t0, 600, false).unwrap());
    fs::write(&novel, "v2").unwrap();
    assert!(
        !backup_file(&root, &novel, t0 + 60, 600, false).unwrap(),
        "inside the interval"
    );
    assert!(
        backup_file(&root, &novel, t0 + 60, 600, true).unwrap(),
        "forced"
    );
    assert!(
        !backup_file(&root, &novel, t0 + 700, 600, false).unwrap(),
        "same bytes as the newest backup"
    );
    fs::write(&novel, "v3").unwrap();
    assert!(backup_file(&root, &novel, t0 + 1300, 600, false).unwrap());

    let bdir = backup_dir(&root, &novel);
    assert_eq!(backup_times(&bdir), vec![t0 + 1300, t0 + 60, t0]);
    assert_eq!(
        fs::read_to_string(bdir.join(format!("{t0}.novel"))).unwrap(),
        "v1"
    );
    assert_eq!(
        fs::read_to_string(bdir.join(format!("{}.novel", t0 + 60))).unwrap(),
        "v2"
    );
    assert_eq!(
        fs::read_to_string(bdir.join(format!("{}.novel", t0 + 1300))).unwrap(),
        "v3"
    );
    assert_eq!(
        fs::read_to_string(bdir.join("source.txt")).unwrap(),
        novel.to_string_lossy()
    );
}

#[test]
fn backup_file_prunes_old_copies() {
    let dir = scratch("backup-prune");
    let root = dir.join("backups");
    let novel = dir.join("book.novel");
    let t0 = 1_000 * DAY;
    for i in 0..25u64 {
        fs::write(&novel, format!("v{i}")).unwrap();
        backup_file(&root, &novel, t0 + i * 700, 600, false).unwrap();
    }
    let times = backup_times(&backup_dir(&root, &novel));
    assert_eq!(
        times.len(),
        BACKUP_KEEP_RECENT,
        "same-day copies beyond the newest 20 are pruned"
    );
    assert_eq!(times[0], t0 + 24 * 700);
}

#[test]
fn backup_file_never_overwrites_a_kept_version() {
    let dir = scratch("backup-same-second");
    let root = dir.join("backups");
    let novel = dir.join("book.novel");
    let t0 = 1_000 * DAY;
    fs::write(&novel, "v1").unwrap();
    assert!(backup_file(&root, &novel, t0, 600, false).unwrap());
    fs::write(&novel, "v2").unwrap();
    // a restore right after a save, within the same second: both versions are kept
    assert!(backup_file(&root, &novel, t0, 600, true).unwrap());
    let bdir = backup_dir(&root, &novel);
    assert_eq!(backup_times(&bdir), vec![t0 + 1, t0]);
    assert_eq!(
        fs::read_to_string(bdir.join(format!("{t0}.novel"))).unwrap(),
        "v1"
    );
    assert_eq!(
        fs::read_to_string(bdir.join(format!("{}.novel", t0 + 1))).unwrap(),
        "v2"
    );
}

#[test]
fn backups_dated_in_the_future_do_not_hold_off_new_ones() {
    let dir = scratch("backup-clock");
    let root = dir.join("backups");
    let novel = dir.join("book.novel");
    let t0 = 1_000 * DAY;
    fs::write(&novel, "ahead").unwrap();
    assert!(backup_file(&root, &novel, t0 + 365 * DAY, 600, false).unwrap()); // clock a year ahead
    fs::write(&novel, "v1").unwrap();
    assert!(
        backup_file(&root, &novel, t0, 600, false).unwrap(),
        "the clock was set back"
    );
    fs::write(&novel, "v2").unwrap();
    assert!(
        !backup_file(&root, &novel, t0 + 60, 600, false).unwrap(),
        "the interval still holds"
    );
    assert_eq!(
        backup_times(&backup_dir(&root, &novel)),
        vec![t0 + 365 * DAY, t0]
    );
}

#[test]
fn a_version_already_kept_is_not_copied_again() {
    let dir = scratch("backup-dedupe");
    let root = dir.join("backups");
    let novel = dir.join("book.novel");
    let t0 = 1_000 * DAY;
    fs::write(&novel, "old").unwrap();
    assert!(backup_file(&root, &novel, t0, 600, false).unwrap());
    fs::write(&novel, "latest").unwrap();
    assert!(backup_file(&root, &novel, t0 + 700, 600, true).unwrap());
    // "old" was restored and saved: backing it up again would only push real versions out
    fs::write(&novel, "old").unwrap();
    assert!(!backup_file(&root, &novel, t0 + 800, 600, true).unwrap());
    assert!(!backup_file(&root, &novel, t0 + 2000, 600, false).unwrap());
    assert_eq!(backup_times(&backup_dir(&root, &novel)), vec![t0 + 700, t0]);
}
