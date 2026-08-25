# Security policy

Chardb is an experimental database prototype, not a production-ready service. It has incomplete end-to-end authentication, authorization, query execution, migration, backup, and recovery paths. Do not use it with production data, live credentials, or systems that require tenant isolation or durability guarantees. See [STATUS.md](STATUS.md) for the current limits.

## Reporting a vulnerability

Report a suspected vulnerability through [GitHub private vulnerability reporting](https://github.com/zpg6/chardb/security/advisories/new). If that form is unavailable, contact the [repository maintainer through GitHub](https://github.com/zpg6) to arrange a private reporting channel.

Do not open a public issue for an unpatched vulnerability. Do not include real customer data, access tokens, private keys, or production database contents in a report.

Include enough information to reproduce and assess the problem with synthetic data:

- the affected commit or package version;
- the affected component and runtime path;
- the security impact and required attacker access;
- a minimal reproduction or test case;
- relevant Bun, Wrangler, workerd, or Cloudflare configuration;
- any known workaround or mitigation.

Issues involving tenant-boundary bypass, authorization policy bypass, JWT verification, mutation replay, SQL injection, cross-shard routing, data corruption, migration, resharding, snapshot integrity, or secret exposure should be reported privately.

Ordinary bugs without a security impact belong in the [public issue tracker](https://github.com/zpg6/chardb/issues).

CI checks out complete Git history and runs `bun run security:history`. The scanner reads every reachable text blob and reports the object id, path, and rule for high-confidence private-key and provider-token formats. It does not print the matched value. This check complements provider-side secret scanning; it is not a substitute for credential rotation after an exposure.
