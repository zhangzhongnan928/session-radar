# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's security
advisory feature for this repository. Do not open a public issue containing an
exploit, credential, private session title, transcript, database, log, or local
filesystem path.

Include the affected commit, platform, reproduction steps, and the smallest
redacted evidence that demonstrates the issue.

## Security boundary

session-radar is designed for one user on one Mac:

- the HTTP service binds to loopback only;
- local state is stored with owner-only permissions;
- collection is read-only except for explicit, dry-run-first hook and
  LaunchAgent installation commands;
- connectors must not bypass encryption, authentication, or operating-system
  security controls; and
- incomplete visibility must be reported as degraded or unsupported coverage.

Running the daemon on an untrusted multi-user machine, forwarding its port, or
publishing its local data directory is outside the supported threat model.
