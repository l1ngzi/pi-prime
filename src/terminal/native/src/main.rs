mod output;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod win;
#[cfg(windows)]
mod windows_input;

use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
#[cfg(windows)]
use portable_pty::PtySystem;
use portable_pty::{CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
#[cfg(windows)]
use std::ffi::{OsStr, OsString};
use std::fs::File;
#[cfg(windows)]
use std::io::Read;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

const MAX_LOG_BYTES: usize = 16 * 1024 * 1024;

fn emit(value: Value) {
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{value}");
}

#[derive(Default)]
struct State {
    pending: output::Output,
    log: Option<File>,
    log_bytes: usize,
    log_truncated: bool,
    exit_code: Option<i32>,
    failure: Option<String>,
    readers: usize,
}

impl State {
    fn push(state: &Arc<Mutex<Self>>, id: u64, bytes: &[u8]) {
        let notify = {
            let mut state = state.lock().unwrap();
            let notify = state.pending.is_empty();
            let available = MAX_LOG_BYTES - state.log_bytes;
            let to_write = bytes.len().min(available);
            if let Some(log) = &mut state.log {
                if let Err(error) = log.write_all(&bytes[..to_write]) {
                    state.failure = Some(format!("Output log: {error}"));
                    state.log_truncated = true;
                    state.log_bytes = MAX_LOG_BYTES;
                } else {
                    state.log_bytes += to_write;
                    state.log_truncated |= to_write < bytes.len();
                }
            }
            state.pending.push(bytes);
            notify && !bytes.is_empty()
        };
        if notify {
            emit(json!({"event": "output", "session_id": id}));
        }
    }

    fn reader_closed(state: &Arc<Mutex<Self>>, id: u64) {
        state.lock().unwrap().readers -= 1;
        emit(json!({"event": "output", "session_id": id}));
    }

    fn exited(state: &Arc<Mutex<Self>>, id: u64, result: Result<i32>) {
        {
            let mut state = state.lock().unwrap();
            match result {
                Ok(code) => state.exit_code = Some(code),
                Err(error) => {
                    state.exit_code = Some(-1);
                    state.failure = Some(error.to_string());
                }
            }
        }
        emit(
            json!({"event": "output", "session_id": id, "exit_code": state.lock().unwrap().exit_code}),
        );
    }
}

struct Tty {
    _master: Box<dyn MasterPty + Send>,
    writer: mpsc::Sender<Vec<u8>>,
    #[cfg(windows)]
    job: Arc<win::JobObject>,
    #[cfg(unix)]
    group: Arc<unix::ProcessGroup>,
}

enum Backend {
    #[cfg(windows)]
    Pipe(Arc<win::JobObject>),
    #[cfg(unix)]
    Pipe(Arc<unix::ProcessGroup>),
    Tty(Tty),
}

struct Session {
    state: Arc<Mutex<State>>,
    backend: Backend,
    readers: Vec<JoinHandle<()>>,
}

impl Session {
    fn write(&mut self, chars: &str) -> Result<bool> {
        if self.state.lock().unwrap().exit_code.is_some() {
            // A late interrupt is a no-op; the caller can still collect unread output.
            if chars == "\u{3}" {
                return Ok(false);
            }
            bail!("process has already exited");
        }
        match &mut self.backend {
            Backend::Tty(tty) => tty.writer.try_send(chars.as_bytes().to_vec())?,
            Backend::Pipe(job) if chars == "\u{3}" => return Ok(job.terminate()?),
            Backend::Pipe(_) => {
                bail!(
                    "stdin is closed. Use interrupt=true to stop this session, or start with tty=true for interactive input."
                )
            }
        }
        Ok(true)
    }

    fn poll(&self) -> Value {
        let mut state = self.state.lock().unwrap();
        let pending = std::mem::take(&mut state.pending);
        let tail: Vec<u8> = pending.tail.into_iter().collect();
        json!({
            "head": STANDARD.encode(&pending.head),
            "tail": STANDARD.encode(&tail),
            "omitted_bytes": pending.omitted_bytes,
            "original_bytes": pending.head.len() + tail.len() + pending.omitted_bytes,
            "exit_code": state.exit_code,
            "failure": state.failure,
            "output_closed": state.readers == 0,
            "log_available": state.log.is_some(),
            "log_truncated": state.log_truncated,
        })
    }

    fn close(&mut self) -> Result<Value> {
        // Natural root exit preserves intentionally backgrounded descendants,
        // just as Codex does. Explicit close of a live root kills its job.
        let exit_code = self.state.lock().unwrap().exit_code;
        let termination_requested = if exit_code.is_none() {
            match &mut self.backend {
                Backend::Pipe(job) => job.terminate()?,
                #[cfg(windows)]
                Backend::Tty(tty) => tty.job.terminate()?,
                #[cfg(unix)]
                Backend::Tty(tty) => tty
                    .group
                    .terminate_with_foreground(tty._master.process_group_leader())?,
            }
        } else {
            false
        };
        for reader in self.readers.drain(..) {
            reader.abort();
        }
        Ok(json!({"termination_requested": termination_requested, "exit_code": exit_code}))
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if !self.readers.is_empty() {
            let _ = self.close();
        }
    }
}

fn read_pipe<R: AsyncRead + Unpin + Send + 'static>(
    mut reader: R,
    state: Arc<Mutex<State>>,
    id: u64,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) => break,
                Ok(count) => State::push(&state, id, &buffer[..count]),
                Err(_) => break,
            }
        }
        State::reader_closed(&state, id);
    })
}

fn spawn(
    shell: &Path,
    log_dir: &Path,
    id: u64,
    cmd: &str,
    cwd: &Path,
    tty: bool,
) -> Result<Session> {
    anyhow::ensure!(
        cwd.is_dir(),
        "workdir is not a directory: {}",
        cwd.display()
    );
    let state = Arc::new(Mutex::new(State {
        log: Some(File::create(log_dir.join(format!("{id}.log")))?),
        readers: if tty { 1 } else { 2 },
        ..State::default()
    }));
    if tty {
        #[cfg(windows)]
        anyhow::ensure!(win::conpty_supported(), "Windows ConPTY is unavailable");
        let size = PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        };
        #[cfg(windows)]
        let pair = win::ConPtySystem::default().openpty(size)?;
        #[cfg(unix)]
        let pair = portable_pty::native_pty_system().openpty(size)?;
        let mut command = CommandBuilder::new(
            #[cfg(windows)]
            std::env::current_exe().context("missing current executable path")?,
            #[cfg(unix)]
            shell,
        );
        #[cfg(windows)]
        {
            command.arg("--conpty-utf8-exec");
            command.arg(shell);
            command.args(["-NoLogo", "-NoProfile", "-Command", cmd]);
        }
        #[cfg(unix)]
        {
            command.args(["--noprofile", "--norc", "-c", cmd]);
            command.env_remove("BASH_ENV");
        }
        command.cwd(cwd);
        command.env("TERM", "dumb");
        command.env("NO_COLOR", "1");
        let mut child = pair.slave.spawn_command(command)?;
        #[cfg(windows)]
        let job = {
            let child: &dyn portable_pty::Child = child.as_ref();
            let conpty = child
                .downcast_ref::<win::WinChild>()
                .context("unexpected ConPTY child")?;
            Arc::clone(&conpty.job)
        };
        #[cfg(unix)]
        let group = Arc::new(unix::ProcessGroup::new(
            child.process_id().context("missing PTY child pid")?,
        )?);
        let (writer_tx, mut writer_rx) = mpsc::channel::<Vec<u8>>(128);
        #[cfg(windows)]
        let (reader, writer_task) = {
            let mut reader = pair.master.try_clone_reader()?;
            let mut writer = pair.master.take_writer()?;
            let writer_task = tokio::task::spawn_blocking(move || {
                let mut normalizer = windows_input::WindowsTtyInputNormalizer::default();
                while let Some(bytes) = writer_rx.blocking_recv() {
                    let bytes = normalizer.normalize(&bytes);
                    if writer.write_all(&bytes).is_err() || writer.flush().is_err() {
                        break;
                    }
                }
            });
            let reader_state = Arc::clone(&state);
            let reader = tokio::task::spawn_blocking(move || {
                let mut buffer = [0u8; 8192];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(count) => State::push(&reader_state, id, &buffer[..count]),
                        Err(_) => break,
                    }
                }
                State::reader_closed(&reader_state, id);
            });
            (reader, writer_task)
        };
        #[cfg(unix)]
        let (reader, writer_task) = {
            use std::os::fd::BorrowedFd;
            use tokio::io::AsyncWriteExt;
            use tokio::process::{ChildStdin, ChildStdout};
            // Both duplicates share O_NONBLOCK. Let Tokio drive both directions so
            // close can cancel them even while a descendant holds the slave open.
            let raw = pair.master.as_raw_fd().context("missing PTY master fd")?;
            let fd = unsafe { BorrowedFd::borrow_raw(raw) }; // pair.master owns it
            let reader = ChildStdout::from_std(fd.try_clone_to_owned()?.into())?;
            let mut writer = ChildStdin::from_std(fd.try_clone_to_owned()?.into())?;
            let writer_task = tokio::spawn(async move {
                while let Some(bytes) = writer_rx.recv().await {
                    if writer.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
            });
            (read_pipe(reader, Arc::clone(&state), id), writer_task)
        };
        drop(pair.slave);
        let wait_state = Arc::clone(&state);
        #[cfg(unix)]
        let wait_group = Arc::clone(&group);
        tokio::task::spawn_blocking(move || {
            #[cfg(windows)]
            let result = child
                .wait()
                .map(|status| status.exit_code() as i32)
                .map_err(Into::into);
            #[cfg(unix)]
            let result = (|| -> Result<i32> {
                let code = unix::wait_tty(child.as_mut())?;
                wait_group.preserve_descendants()?;
                Ok(code)
            })();
            State::exited(&wait_state, id, result);
        });
        Ok(Session {
            state,
            backend: Backend::Tty(Tty {
                _master: pair.master,
                writer: writer_tx,
                #[cfg(windows)]
                job,
                #[cfg(unix)]
                group,
            }),
            readers: vec![reader, writer_task],
        })
    } else {
        #[cfg(windows)]
        let mut command = {
            let mut command = tokio::process::Command::new(
                std::env::current_exe().context("missing current executable path")?,
            );
            command.args([
                OsStr::new("--conpty-utf8-exec"),
                shell.as_os_str(),
                OsStr::new("-NoLogo"),
                OsStr::new("-NoProfile"),
                OsStr::new("-NonInteractive"),
                OsStr::new("-Command"),
                OsStr::new(cmd),
            ]);
            command
        };
        #[cfg(unix)]
        let mut command = {
            let mut command = tokio::process::Command::new(shell);
            command
                .args(["--noprofile", "--norc", "-c", cmd])
                .env_remove("BASH_ENV");
            command
        };
        command
            .current_dir(cwd)
            .env("TERM", "dumb")
            .env("NO_COLOR", "1");
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        let job = Arc::new(win::JobObject::create()?);
        // Unlike post-spawn assignment, suspended launch cannot miss a child
        // created immediately by pwsh. Failure is explicit, never uncontained.
        #[cfg(windows)]
        let mut child = job.spawn_contained(&mut command)?;
        #[cfg(unix)]
        let (mut child, job) = unix::ProcessGroup::spawn_contained(&mut command)?;
        #[cfg(unix)]
        let job = Arc::new(job);
        let stdout = child.stdout.take().context("missing stdout")?;
        let stderr = child.stderr.take().context("missing stderr")?;
        let readers = vec![
            read_pipe(stdout, Arc::clone(&state), id),
            read_pipe(stderr, Arc::clone(&state), id),
        ];
        let wait_state = Arc::clone(&state);
        let wait_job = Arc::clone(&job);
        tokio::spawn(async move {
            let result = async {
                let status = child.wait().await?;
                wait_job.preserve_descendants()?;
                #[cfg(windows)]
                let code = status.code().unwrap_or(-1);
                #[cfg(unix)]
                let code = unix::exit_code(status);
                Ok(code)
            }
            .await;
            State::exited(&wait_state, id, result);
        });
        Ok(Session {
            state,
            backend: Backend::Pipe(job),
            readers,
        })
    }
}

#[derive(Deserialize)]
struct Request {
    id: u64,
    #[serde(flatten)]
    operation: Operation,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Operation {
    Spawn {
        session_id: u64,
        cmd: String,
        cwd: PathBuf,
        tty: bool,
    },
    Write {
        session_id: u64,
        chars: String,
    },
    Poll {
        session_id: u64,
    },
    Close {
        session_id: u64,
    },
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn SetConsoleCtrlHandler(
        handler: Option<unsafe extern "system" fn(u32) -> i32>,
        add: i32,
    ) -> i32;
}

#[cfg(windows)]
unsafe extern "system" fn ignore_console_interrupt(ctrl_type: u32) -> i32 {
    if ctrl_type == winapi::um::wincon::CTRL_C_EVENT
        || ctrl_type == winapi::um::wincon::CTRL_BREAK_EVENT
    {
        1
    } else {
        0
    }
}

#[cfg(windows)]
fn clear_std_handle_inherit() -> Result<()> {
    for stream in [
        winapi::um::winbase::STD_INPUT_HANDLE,
        winapi::um::winbase::STD_OUTPUT_HANDLE,
        winapi::um::winbase::STD_ERROR_HANDLE,
    ] {
        let handle = unsafe { winapi::um::processenv::GetStdHandle(stream) };
        if handle.is_null() || handle == winapi::um::handleapi::INVALID_HANDLE_VALUE {
            continue;
        }
        if unsafe {
            winapi::um::handleapi::SetHandleInformation(
                handle,
                winapi::um::winbase::HANDLE_FLAG_INHERIT,
                0,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    Ok(())
}

#[cfg(windows)]
fn run_conpty_utf8_exec(shell: &OsStr, args: &[OsString]) -> ! {
    const CP_UTF8: u32 = 65001;
    // Both ConPTY and CREATE_NO_WINDOW consoles initialize their code page from the host system
    // OEMCP (e.g. 437 on English Windows, 936 on Chinese Windows). Switch the attached console
    // to UTF-8 before launching pwsh so native tools and Console encodings stay UTF-8 without
    // touching script line numbers.
    // A custom handler (unlike NULL, TRUE) is not inherited by pwsh or interactive children.
    // Also clear inheritability on this shim's own stdio handles before Rust duplicates them for
    // the child: otherwise the original handles leak as extra inheritable duplicates into
    // detached grandchildren and keep the parent's output pipes open past exit.
    unsafe {
        winapi::um::wincon::SetConsoleCP(CP_UTF8);
        winapi::um::wincon::SetConsoleOutputCP(CP_UTF8);
        SetConsoleCtrlHandler(Some(ignore_console_interrupt), 1);
    }
    let _ = clear_std_handle_inherit();
    match std::process::Command::new(shell).args(args).status() {
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(error) => {
            let _ = writeln!(std::io::stderr(), "Failed to launch shell: {error}");
            std::process::exit(1);
        }
    }
}

fn main() -> Result<()> {
    #[cfg(windows)]
    {
        let raw_args: Vec<OsString> = std::env::args_os().collect();
        if raw_args.get(1).and_then(|arg| arg.to_str()) == Some("--conpty-utf8-exec") {
            let shell = raw_args.get(2).context("missing shell executable")?;
            run_conpty_utf8_exec(shell, &raw_args[3..]);
        }
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    let result = runtime.block_on(bridge_main());
    // Release any Windows blocking pipe readers that a preserved detached descendant still holds
    // open so bridge shutdown does not stall waiting for background jobs.
    runtime.shutdown_background();
    result
}

async fn bridge_main() -> Result<()> {
    let shell = PathBuf::from(std::env::args_os().nth(1).context("missing shell path")?);
    let log_dir = PathBuf::from(
        std::env::args_os()
            .nth(2)
            .context("missing output directory")?,
    );
    anyhow::ensure!(
        shell.is_absolute() && shell.is_file(),
        "invalid shell executable"
    );
    // CreateProcess used for pipe commands inherits handles. The bridge's own
    // stdio must never reach pwsh or its background descendants: otherwise they
    // can keep the JSON channel open after this helper exits.
    #[cfg(windows)]
    clear_std_handle_inherit()?;
    let mut sessions = HashMap::<u64, Session>::new();
    emit(json!({"event": "ready"}));
    for line in std::io::stdin().lock().lines() {
        let request: Request = serde_json::from_str(&line?)?;
        let result: Result<Value> = (|| match request.operation {
            Operation::Spawn {
                session_id: id,
                cmd,
                cwd,
                tty,
            } => {
                let session = spawn(&shell, &log_dir, id, &cmd, &cwd, tty)?;
                sessions.insert(id, session);
                Ok(Value::Null)
            }
            Operation::Write { session_id, chars } => sessions
                .get_mut(&session_id)
                .context("unknown session_id")?
                .write(&chars)
                .map(Value::Bool),
            Operation::Poll { session_id } => Ok(sessions
                .get(&session_id)
                .context("unknown session_id")?
                .poll()),
            Operation::Close { session_id } => {
                if let Some(session) = sessions.get_mut(&session_id) {
                    let outcome = session.close()?;
                    sessions.remove(&session_id);
                    return Ok(outcome);
                }
                Ok(Value::Null)
            }
        })();
        match result {
            Ok(value) => emit(json!({"id": request.id, "result": value})),
            Err(error) => emit(json!({"id": request.id, "error": format!("{error:#}")})),
        }
    }
    for session in sessions.values_mut() {
        let _ = session.close();
    }
    drop(sessions);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserved_tree_rejects_termination_before_exit_code_is_published() -> Result<()> {
        #[cfg(windows)]
        let tree = Arc::new(win::JobObject::create()?);
        #[cfg(unix)]
        let tree = Arc::new(unix::ProcessGroup::new(i32::MAX as u32)?);
        tree.preserve_descendants()?;
        let mut session = Session {
            state: Arc::new(Mutex::new(State::default())),
            backend: Backend::Pipe(tree.clone()),
            readers: vec![],
        };
        assert!(!session.write("\u{3}")?);
        assert_eq!(session.close()?["termination_requested"], false);

        let pair = portable_pty::native_pty_system().openpty(PtySize::default())?;
        session.backend = Backend::Tty(Tty {
            _master: pair.master,
            writer: mpsc::channel(1).0,
            #[cfg(windows)]
            job: tree,
            #[cfg(unix)]
            group: tree,
        });
        assert_eq!(session.close()?["termination_requested"], false);
        Ok(())
    }
}
