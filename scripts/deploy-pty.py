#!/usr/bin/env python3
"""Run one command under a PTY while forwarding piped stdin/stdout."""

import errno
import os
import select
import signal
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: deploy-pty.py command [args...]", file=sys.stderr)
        return 2

    pid, master = os.forkpty()
    if pid == 0:
        os.execvp(sys.argv[1], sys.argv[1:])

    def terminate(_signal: int, _frame: object) -> None:
        os.killpg(pid, signal.SIGTERM)

    signal.signal(signal.SIGTERM, terminate)
    input_open = True
    try:
        while True:
            readable, _, _ = select.select([master, *([sys.stdin.fileno()] if input_open else [])], [], [])
            if sys.stdin.fileno() in readable:
                data = os.read(sys.stdin.fileno(), 4096)
                if data:
                    os.write(master, data)
                else:
                    input_open = False
            if master in readable:
                try:
                    data = os.read(master, 4096)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    break
                if not data:
                    break
                os.write(sys.stdout.fileno(), data)
    finally:
        os.close(master)
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status)


if __name__ == "__main__":
    sys.exit(main())
