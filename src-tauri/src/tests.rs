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
