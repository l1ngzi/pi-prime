use std::io;
use std::os::unix::process::ExitStatusExt;
use std::sync::Mutex;
use tokio::process::{Child, Command};

/// A child starts in its own process group before executing user code. Killing
/// that group includes ordinary descendants, while deliberately detached
/// processes (setsid/setpgid) manage their own lifetime.
#[derive(Debug)]
pub struct ProcessGroup {
    pid: libc::pid_t,
    preserved: Mutex<bool>,
}

impl ProcessGroup {
    pub fn new(pid: u32) -> io::Result<Self> {
        let pid = i32::try_from(pid).map_err(io::Error::other)?;
        if pid <= 0 {
            return Err(io::Error::other("invalid process group"));
        }
        Ok(Self {
            pid,
            preserved: Mutex::new(false),
        })
    }

    pub fn spawn_contained(command: &mut Command) -> io::Result<(Child, Self)> {
        let child = command.process_group(0).kill_on_drop(true).spawn()?;
        let group = Self::new(
            child
                .id()
                .ok_or_else(|| io::Error::other("missing child pid"))?,
        )?;
        Ok((child, group))
    }

    pub fn preserve_descendants(&self) -> io::Result<()> {
        *self
            .preserved
            .lock()
            .map_err(|_| io::Error::other("process group lock poisoned"))? = true;
        Ok(())
    }

    pub fn terminate(&self) -> io::Result<bool> {
        self.terminate_with_foreground(None)
    }

    pub fn terminate_with_foreground(&self, foreground: Option<libc::pid_t>) -> io::Result<bool> {
        let preserved = self
            .preserved
            .lock()
            .map_err(|_| io::Error::other("process group lock poisoned"))?;
        if *preserved {
            return Ok(false);
        }
        // Pipe Ctrl+C is explicit termination, matching the Windows Job Object
        // contract. Real TTY Ctrl+C travels through the terminal line discipline.
        let mut sent = false;
        if let Some(foreground) = foreground {
            // Interactive shells can put their foreground job into another
            // process group. It still belongs to this PTY's session.
            if foreground > 0
                && foreground != self.pid
                && unsafe { libc::getsid(foreground) } == self.pid
            {
                sent = kill_group(foreground)?;
            }
        }
        Ok(kill_group(self.pid)? || sent)
    }
}

fn kill_group(pid: libc::pid_t) -> io::Result<bool> {
    if unsafe { libc::kill(-pid, libc::SIGKILL) } == -1 {
        let error = io::Error::last_os_error();
        return if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(false)
        } else {
            Err(error)
        };
    }
    Ok(true)
}

impl Drop for ProcessGroup {
    fn drop(&mut self) {
        // Also cover setup failures after spawn, before a Session owns the group.
        let _ = self.terminate();
    }
}

pub fn exit_code(status: std::process::ExitStatus) -> i32 {
    status
        .code()
        .unwrap_or_else(|| 128 + status.signal().unwrap_or(0))
}

pub fn wait_tty(child: &mut (dyn portable_pty::Child + Send + Sync)) -> io::Result<i32> {
    // UnixPtySystem returns std::process::Child. Use its native status because
    // portable-pty's ExitStatus reduces every signal termination to code 1.
    let child: &mut dyn portable_pty::Child = child;
    child
        .downcast_mut::<std::process::Child>()
        .ok_or_else(|| io::Error::other("unexpected Unix PTY child implementation"))?
        .wait()
        .map(exit_code)
}
