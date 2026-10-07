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
| no key at all for a `@query` | answering a question twice is correct, and the default key would otherwise collapse a second identical read into silence |
| `where` filters before delivery | a filtered message is never retried and never dead-lettered |
| `requires` before the handler | a failed claim check cannot succeed on a second attempt |
| validation and `normalize` on receipt | normalization is what makes equality well-defined across a pipe |
| `invariant`, per record and per element | a rule relating two fields is a contract rule, and nothing else can check it |
| envelope propagation and `@derive(inbound.id)` | a correlation chain has to survive a hop |
| `retry n after d linear max d` | the declared policy, read from the IR rather than re-parsed |
| an acknowledgement deadline | a handler that never answers has not acknowledged, so a broker redelivers |
| a `best-effort` publication lost, under `chaos` | a message that was never published leaves no dead letter and no redelivery, so it is the one loss nothing else in a trace would show |

And the Process layer:

| It models | Because |
|---|---|
| a `send`'s payload, from `state`, `occurrence` and `terminal` | a step that cannot say the charge is for the order total cannot describe a correct saga |
| `upcast`, chained and applied on receipt | an older producer is the case versioning exists for, and a scenario pins the version to arrange it |
| saga instances keyed by business key | two messages with the same key reach the same instance, which is what makes a duplicate start idempotent |
| steps, their `on` actions and their state | the checker can prove `chargeId` is set before an `undo` reads it, and so can a run |
| step timeouts and the saga `deadline` | one bounds a wait, the other bounds the process; a saga with neither is unbounded |
| compensation in reverse, for completed steps only | a step that never succeeded has nothing to reverse, and that asymmetry is the bug worth testing |
| `schedule` on an anchored civil calendar | a cron expression needs a day of the week, so the clock is a calendar rather than a counter |
| `onMissed`, via the no-overlap rule | an occurrence due while the last is still retrying is a missed occurrence, so all three policies are observable |

A saga **observes its hosting service** rather than subscribing in its own right — the service
consumes the start message and the replies, and the saga is that service's process. Giving it its own
subscription would make it compete with the service for every message on a queue. It also means a
service that hosts a saga needs no mock: the saga *is* its behaviour.

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

### A handler in another process, in another language

`overProcess` makes a child process a live handler, so the service running for real can be written in a
language this runtime has never heard of — and can sit under its own debugger while everything it talks to
stays mocked.

```ts
import { overProcess } from "@sevenk/sandbox";

const payments = await overProcess("dotnet", ["run", "--project", "./src/Payments"], {
  expect: "Payments",
});

await runScenario(model, file, scenario, { live: new Map([["Payments", payments]]) });
await payments.close();
```

**The clock is why this is worth doing rather than publishing to a real broker.** No wall-clock time
passes while the engine awaits a reply, so stopping on a breakpoint for five minutes does not trip a
step's `timeout 30s` — as far as the model is concerned, no time has gone by. Against a real broker the
visibility timeout expires and the message is redelivered while you are still reading a local, which is
why debugging a saga against one is an exercise in frustration rather than an exercise in debugging.

**Line-framed JSON over stdio.** No port to choose, no firewall to placate, no authentication to get
wrong, and the process is one you launched — so your debugger is already attached to it. A host writes one
line to introduce itself, then answers one line per line it is given:

```
<- {"ready":"Payments"}
-> {"id":1,"type":"shop.Charge","version":"v1.0","body":{...},"envelope":{...}}
<- {"id":1,"handled":true,"reply":"Charged","body":{}}
<- {"id":1,"failed":"the gateway timed out"}
```

**A delivery carries exactly the handler's parameters.** A generated handler is handed the message, its
envelope fields and a cancellation token, so that is what crosses — and the things a message also carries
deliberately do not. No claims, because `requires` was decided before dispatch and sending them would
invite a handler to decide authorization a second time and differently. No sender and no pipe, because the
subscription already decided and a handler that could read either could branch on something the model does
not say. The rule is the whole of the design: anything added is something a handler could branch on that
the model does not authorize.

**A failure carries only that it failed.** "The gateway timed out" and "the database deadlocked" are the
same observable to everything downstream, and an exception must never arrive as a reply the model does not
declare. The engine retries it under the subscription's own policy, exactly as it does for an in-process
handler that threw.

**A host's standard output is the protocol channel**, which is a real hazard rather than a theoretical
one: a `println` in a handler would corrupt the stream. A host should redirect its standard output to
standard error on the way up; a line that is not a frame is reported as the child's own output rather than
treated as a protocol fault, so the mistake is visible instead of fatal.

The protocol lives here and not in a provider, because it is `Handler` serialised and the `Handler`
contract is this package's. A language's adapter implements the other end of this one; it does not invent
an end. `test/process.test.ts` drives it from a twenty-line Node host, which is how it stays honest about
not being shaped around any particular language.

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

The trace is a [published interchange artifact](https://github.com/KaiSevelin/7k/blob/main/docs/spec/30-scenarios.md#7-traces),
not this runtime's private business. Every expectation is evaluated against it, which is what makes an
assertion here an assertion another runtime could also satisfy.

The **format** is not this runtime's business either. It is specified in section 7 of that document and defined
in `@sevenk/core`, so a writer and a reader import one contract rather than agreeing twice, and
`test/trace-format.test.ts` validates every trace this runtime produces against it. That matters because the
format lived here first, and drifted while it did: `service` was written bare while every other name was
qualified, `seq` restarted per run so a file of two runs had two events numbered 0, and the field order was
whichever branch happened to build the object. Spider found all of it on its first day as a consumer.

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
`retrying`, `dead-lettered`, `dropped`, `advanced`, plus the Process layer's `saga-started`,
`saga-advanced`, `saga-timeout`, `saga-completed`, `saga-rejected`, `saga-abandoned`,
`saga-compensating`, `saga-irreversible`, `schedule-fired`, `schedule-overrun` and `schedule-missed`.
Each `reason` is a code rather than prose, so `expect rejected M at S reason unauthorized` can match
one; the prose is in `detail`. A saga event names its step in `step` — data, because `detail` is for a
reader and a consumer that parsed it would break when the wording improved.

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
npm test        # 183 tests
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

## What it cannot do yet

**Projections.** `02-contract.md` section 6 specifies a lossy export into JSON Schema, Avro, protobuf or
OpenAPI, each with a documented loss profile. Nothing emits one.

**Two checks that are not checks.** `external-bound` asks whether an implementation was told to generate
an `@external` service, and the language has no binding construct for it to be told in; `schedule-overrun`
is a runtime observation, which this runtime reports as a trace event rather than the checker reporting it
statically.

## Licence

Apache 2.0. See [LICENSE](LICENSE).
