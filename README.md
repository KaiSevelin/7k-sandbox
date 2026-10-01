# 7K Sandbox

A deterministic in-process runtime for [7K](https://github.com/KaiSevelin/7k) models. It runs a scenario
file against a model on a **virtual clock**, so `advance 30d` finishes in microseconds, and from a **seed**,
so a failure is a model plus a number rather than a story about a flaky test.

```
7k-sandbox run examples/soldout.scenario.7k
```

```
examples/soldout.scenario.7k  (acme.retail.sales)
ok   scenario SeatsSoldOut                     (seed 42, 1s virtual)
ok   scenario ReserveRecoversAfterTwoFailures  (seed 42, 10s virtual)
ok   scenario ReserveNeverAnswers              (seed 42, 1m virtual)
ok   scenario ReserveRepliesThenFails          (seed 42, 10s virtual)
ok   scenario ReserveWithoutScope              (seed 42, 0ms virtual)
ok   scenario ReserveWithBadPayload            (seed 42, 1s virtual)
ok   soak     ReserveUnderLoad                 (seed 7, 1.0h virtual)

7 passed
```

That last line is an hour of simulated load — eighteen thousand messages, their replies, and nine hundred
retries — in about two seconds of wall clock.

## Why

The hard parts of a message-driven system are all about time and failure: a retry storm, a dead letter, a
saga that never completes, a duplicate that was supposed to be idempotent, a compensation that ran when it
should not have. None of them are observable at the speed a real broker runs at, and most of them need
hours of elapsed time to reach.

A virtual clock removes the waiting, and a seed removes the mystery. What is left is the part worth
arguing about: what the system is supposed to do.

## What it does

Everything the language *means* comes from [`@sevenk/core`](https://github.com/KaiSevelin/7k) — the parser,
the IR, the analyses, and the lowering of scenario files. This package decides only what **happens**. That
split is deliberate: two runtimes disagreeing about what a filter or a mock denotes would make a
conformance suite worthless, so there is exactly one place that decides.

| It models | Because |
|---|---|
| `queue` point-to-point, `topic` and `stream` fan-out | a queue's message is consumed once, so two subscriptions compete for it |
| `at-least-once` retry then dead-letter; `at-most-once` loss | the delivery guarantee is what decides a failure's fate |
| `once per <path>`, defaulting to `@role(businessKey)` | a duplicate has to be absorbed somewhere, and the model says where |
| `where` filters before delivery | a filtered message is never retried and never dead-lettered |
| `requires` before the handler | a failed claim check cannot succeed on a second attempt |
| validation and `normalize` on receipt | normalization is what makes equality well-defined across a pipe |
| envelope propagation and `@derive(inbound.id)` | a correlation chain has to survive a hop |
| `retry n after d linear max d` | the declared policy, read from the IR rather than re-parsed |
| an acknowledgement deadline | a handler that never answers has not acknowledged, so a broker redelivers |

It does **not** yet run sagas or fire schedules. A scenario that asserts about one is reported as *not
fully checked* rather than passed or failed — an assertion that silently passes is worse than a red one.

## Running real handlers

A service can run for real while everything it talks to stays mocked:

```
7k-sandbox run checkout.scenario.7k --live PaymentService --handlers ./handlers.js
```

```js
// handlers.js
export function PaymentService(message) {
  return Number(message.body.amount) > 100
    ? { reply: "Declined", body: { reason: "OverLimit" } }
    : { reply: "Charged" };
}
```

The handler receives what a generated wrapper would hand it — validated, normalized, deduplicated — and
names one of its declared `replies`. It cannot tell which transport delivered the message, which is the
property worth protecting: a test that ran the handler through a different code path would not be testing
the handler you deploy.

**Liveness is a flag, not something written in the scenario.** A scenario is a falsifiable claim about the
system; whether a given service is a real handler is not part of the claim, it is the *fidelity* at which
the claim is being checked. So one suite runs fully mocked in CI, with one service live in development, and
against a real deployment in the conformance pass — rather than three suites that drift apart.

What this cannot virtualize is a live handler's own I/O. The sandbox has no idea the handler opens a
database — that is exactly what "interfaces, not internals" forbids it from knowing — so a real query takes
real time. Faking a live handler's dependencies is yours; everything *outside* the handler is free.

## Commands

```
7k-sandbox run <scenario.7k>...     run the scenarios in each file
7k-sandbox trace <scenario.7k>...   run and print the trace
```

| Option | |
|---|---|
| `--scenario <Name>` | run only this one |
| `--live <Service>` | run this service's real handler; repeatable |
| `--handlers <module>` | where to import them from (default `./handlers.js`) |
| `--seed <n>` | override every scenario's seed |
| `--ack-timeout <ms>` | how long an unacknowledged delivery waits (default 5000) |
| `--soaks` | run `soak` declarations too; off by default so a commit-time suite stays fast |
| `--chaos` | inject the loss and reordering each pipe's guarantee permits |
| `--ndjson` | print the trace as NDJSON rather than as a table |
| `--verbose` | print passing assertions as well |

A failing scenario prints its trace automatically. The model's own diagnostics come first, since a warning
about the model is the most likely explanation for a surprising run — and a model with *errors* is not run
at all, because failures about unresolved names say nothing about the system.

## The trace

The trace is a [published interchange artifact](https://github.com/KaiSevelin/7k/blob/main/docs/spec/30-scenarios.md),
not this runtime's private business. Every expectation is evaluated against it, which is what makes an
assertion here an assertion another runtime could also satisfy.

```
7k-sandbox trace checkout.scenario.7k --ndjson > trace.ndjson
```

```
       0  published     shop.Charge shop.commands
       0  delivered     shop.Charge attempt 1 shop.commands -> Payments
       0  failed        shop.Charge attempt 1 failed the database deadlocked
       0  retrying      shop.Charge attempt 2 in 1000ms
    1000  delivered     shop.Charge attempt 2 shop.commands -> Payments
    1000  handled       shop.Charge shop.commands -> Payments
    1000  published     shop.Charged shop.events
```

One event per line: `published`, `delivered`, `filtered`, `deduplicated`, `handled`, `rejected`, `failed`,
`retrying`, `dead-lettered`, `dropped`, `advanced`. Each `reason` is a code rather than prose, so
`expect rejected M at S reason unauthorized` can match one; the prose is in `detail`.

## As a library

```ts
import { run } from "@sevenk/sandbox";

const report = await run(["checkout.scenario.7k"], { soaks: true });
for (const file of report.files) {
  for (const scenario of file.scenarios) {
    console.log(scenario.name, scenario.status, scenario.trace.toNdjson());
  }
}
```

`Engine` is also usable directly, with `publish`, `advance`, `step` and `runToQuiescence` — `step` is what a
debugger or a graph view needs to watch one message move at a time.

## Development

```
npm install
npm test        # 73 tests
npm run build
npx tsx src/cli.ts run ../7K/examples/soldout.scenario.7k
```

The dependency on Core is a sibling checkout (`file:../7K/packages/core`), so the two repositories live
beside each other:

```
somewhere/
  7K/            the language, Core and the CLI
  7k-sandbox/    this
  7k-vscode/     the editor extension
```

The test suite runs the 7K repository's own examples and skips them when it is not there. That corpus test
is the reason the examples are trustworthy at all: `7k check` proves they parse and resolve, and only
running them proves the behaviour they assert is the behaviour they get. Every defect found while building
this runtime was an example that checked out and was still wrong.

## Licence

Apache 2.0. See [LICENSE](LICENSE).
