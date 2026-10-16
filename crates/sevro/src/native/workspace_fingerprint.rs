use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Read};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

const MAX_ENTRIES: usize = 10_000;
const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024;

struct Fingerprint {
    identity: Sha256,
    entries: usize,
    file_bytes: u64,
}

pub(super) fn fingerprint(root: &Path) -> Option<String> {
    let mut fingerprint = Fingerprint {
        identity: Sha256::new(),
        entries: 0,
        file_bytes: 0,
    };
    for path in children(root).ok()? {
        if path.file_name()? != ".git" {
            fingerprint.visit(root, &path).ok()?;
        }
    }
    Some(format!("{:x}", fingerprint.identity.finalize()))
}

fn children(directory: &Path) -> io::Result<Vec<PathBuf>> {
    let mut paths = fs::read_dir(directory)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<io::Result<Vec<_>>>()?;
    paths.sort();
    Ok(paths)
}

impl Fingerprint {
    fn visit(&mut self, root: &Path, path: &Path) -> io::Result<()> {
        self.entries += 1;
        if self.entries > MAX_ENTRIES {
            return Err(io::Error::other("workspace entry limit"));
        }
        let name = path.strip_prefix(root).map_err(io::Error::other)?;
        let info = fs::symlink_metadata(path)?;
        if info.is_dir() {
            self.identity.update(b"dir\0");
            self.name(name);
            for child in children(path)? {
                self.visit(root, &child)?;
            }
        } else if info.is_symlink() {
            self.identity.update(b"link\0");
            self.name(name);
            self.name(&fs::read_link(path)?);
        } else {
            if !info.is_file() || info.len() > MAX_FILE_BYTES - self.file_bytes {
                return Err(io::Error::other(
                    "unsupported workspace entry or byte limit",
                ));
            }
            let digest = self.file_hash(path)?;
            self.identity.update(b"file\0");
            self.name(name);
            self.identity
                .update(if info.permissions().mode() & 0o111 != 0 {
                    b"x\0"
                } else {
                    b"-\0"
                });
            self.identity.update(digest.as_bytes());
            self.identity.update(b"\0");
        }
        Ok(())
    }

    fn name(&mut self, path: &Path) {
        self.identity.update(path.as_os_str().as_encoded_bytes());
        self.identity.update(b"\0");
    }

    fn file_hash(&mut self, path: &Path) -> io::Result<String> {
        let mut file = File::open(path)?;
        let mut hash = Sha256::new();
        let mut buffer = [0; 64 * 1024];
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            self.file_bytes += count as u64;
            if self.file_bytes > MAX_FILE_BYTES {
                return Err(io::Error::other("workspace byte limit"));
            }
            hash.update(&buffer[..count]);
        }
        Ok(format!("{:x}", hash.finalize()))
    }
}
