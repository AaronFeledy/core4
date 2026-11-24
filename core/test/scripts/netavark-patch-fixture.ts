// Synthetic aardvark.rs context the checked-in Netavark user-bus patch applies to with zero fuzz.
export const upstreamSource = `use std::io::Write;
use std::net::Ipv4Addr;
use std::net::{IpAddr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

impl Aardvark {
    fn is_executable_in_path(program: &str) -> bool {
        if let Ok(path) = std::env::var("PATH") {
            for p in path.split(':') {
                let p_str = format!("{p}/{program}");
                if fs::metadata(p_str).is_ok() {
                    return true;
                }
            }
        }
        false
    }

    pub fn start_aardvark_server(&self) -> NetavarkResult<()> {
        log::debug!("Spawning aardvark server");

        let mut aardvark_args = vec![];
        // only use systemd when it is booted
        if is_using_systemd() && Aardvark::is_executable_in_path(SYSTEMD_RUN) {
            // TODO: This could be replaced by systemd-api.
            aardvark_args = vec![
                OsStr::new(SYSTEMD_RUN),
            ];
        }
    }
}
`;

export const patchedSource = upstreamSource
  .replace(
    "use std::path::{Path, PathBuf};",
    "use std::os::unix::net::UnixStream;\nuse std::path::{Path, PathBuf};",
  )
  .replace(
    "    pub fn start_aardvark_server(&self) -> NetavarkResult<()> {",
    `    fn has_usable_systemd_user_bus() -> bool {
        let Ok(runtime_dir) = std::env::var("XDG_RUNTIME_DIR") else {
            return false;
        };
        UnixStream::connect(Path::new(&runtime_dir).join("bus")).is_ok()
    }

    pub fn start_aardvark_server(&self) -> NetavarkResult<()> {`,
  )
  .replace(
    "        if is_using_systemd() && Aardvark::is_executable_in_path(SYSTEMD_RUN) {",
    `        if is_using_systemd()
            && Aardvark::is_executable_in_path(SYSTEMD_RUN)
            && (!self.rootless || Aardvark::has_usable_systemd_user_bus())
        {`,
  );
