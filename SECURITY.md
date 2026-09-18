# Security policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it privately through GitHub: the **Security** tab of this
repository → **Report a vulnerability**. That opens a private advisory
visible only to you and the maintainers.

If GitHub is not an option for you, write to alex@postweb.me.

## What to include

- What the problem is and what an attacker can achieve with it.
- How to reproduce it: steps, a request, a file, a project that triggers
  it. A minimal reproduction is worth more than a long description.
- The affected version or commit, and the browser if it is relevant.
- Whether the issue is already public anywhere.

## What happens next

- We acknowledge the report within 5 working days.
- We tell you whether we consider it a vulnerability, and our assessment
  of its severity, within 10 working days.
- We keep you updated while we work on a fix, and we tell you when it
  ships.
- We credit you in the advisory unless you ask us not to.

Please give us a reasonable window to ship a fix before disclosing the
problem publicly. If a report is not a vulnerability but is a bug, we
will say so and ask you to file it as a normal issue.

## Scope

This policy covers the code in this repository and the service operated
by the project.

Out of scope: reports produced by a scanner with no demonstrated impact,
missing hardening headers with no attack behind them, denial of service
by brute force alone, and social engineering of the project's
maintainers or users.

## No bounty programme

There is no paid bounty programme at the moment. We say this plainly so
nobody spends time expecting one.
