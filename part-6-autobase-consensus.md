# P2P from Scratch — Part 6: Many Writers, One Truth

> "A distributed system is one in which the failure of a computer you didn't even know existed can render your own computer unusable."
> — Leslie Lamport

**Excerpt:** Everything in the series so far has been single-writer: one keypair signs one Hypercore, and everyone else is a reader. But real collaboration requires multiple writers — and the moment two people can write concurrently, you face the hardest problem in distributed systems: ordering. Autobase takes independent Hypercores from different writers and linearizes them into a single, deterministic view using causal DAGs and quorum consensus. This post explains how.

<!-- Series Navigation -->
> **Series: P2P from Scratch — Building on the Holepunch Stack**
> [Part 1: The Internet is Hostile](part-1-nat-holepunching.md) | [Part 2: Encrypted Pipes](part-2-encrypted-pipes.md) | [Part 3: Append-Only Truth](part-3-hypercore-merkle.md) | [Part 4: From Logs to Databases](part-4-hyperbee-hyperdrive.md) | [Part 5: Finding Peers](part-5-dht-discovery.md) | **Part 6: Many Writers, One Truth (You are here)** | [Part 7: Trust No One](part-7-security-trust.md) | [Part 8: Building for Humans](part-8-ux-production.md)

---

## The Problem: Single-Writer Isn't Enough

A Hypercore is powerful, but it has a fundamental constraint: one keypair, one writer. The owner of the Ed25519 secret key is the only person who can append blocks. Everyone else is a verifier.

This works for publishing — one author, many readers. But think about a shared document, a group chat, or a collaborative database. Alice, Bob, and Carol each need to write. They're on different continents, behind different NATs, often offline. When they reconnect, their independent histories need to merge into a coherent whole.

You can't just throw three Hypercores at the problem. Each core has its own ordering, its own signature chain, its own Merkle tree. If Alice writes "set salary to 50k" and Bob writes "set salary to 60k" at the same time, which one wins? Both are cryptographically valid. Neither references the other. Without a server to timestamp them, there's no natural ordering.

This is the multi-writer problem. And the naive solutions all fail:

- **Last-write-wins** — requires synchronized clocks (which P2P doesn't have)
- **Lock-based coordination** — requires always-on connectivity (which P2P doesn't guarantee)
- **Leader election** — requires a majority to be online (which P2P apps shouldn't assume)

> **Key Insight:** The multi-writer problem isn't about resolving conflicts — it's about *ordering*. Once you have a deterministic total order over all events from all writers, conflict resolution becomes application logic. The hard part is getting every peer to agree on the same order, despite seeing events arrive in different sequences.

---

## The Mental Model: Many Streams, One River

Imagine three tributaries flowing into a single river. Each tributary carries water (events) from a different mountain (writer). Where two tributaries meet, the water merges. Downstream, a single river flows — and everyone standing at the river sees the same water in the same order.

The tributaries are independent Hypercores. The merge points are the places where one writer references another's work. The river is the linearized view — a single ordered sequence that every peer computes identically.

> **Feynman Moment:** The analogy hides the hardest part: in a real river, physics determines the merge. In a distributed system, *consensus* determines it. Two peers who have seen different subsets of the tributaries might temporarily disagree about the river's ordering. Autobase solves this with a quorum mechanism — once a majority of designated writers have acknowledged a merge point, the ordering at that point becomes permanent. Before the quorum confirms it, the ordering is provisional and may change as new information arrives.

---

## Autobase: Architecture Overview

<a href="https://github.com/holepunchto/autobase" target="_blank">Autobase</a> is the Holepunch stack's answer to multi-writer collaboration. It takes multiple independent Hypercores — each written by a different peer — and produces a single, deterministic, linearized view.

The core components:

```
┌──────────────────────────────────────────────────────────┐
│                      Autobase                             │
│                                                           │
│  Writer Hypercores (inputs)         Linearized View       │
│  ┌──────────┐                      ┌─────────────────┐   │
│  │ Alice's   │──┐                  │ View Hypercore   │   │
│  │ core      │  │   ┌──────────┐   │ (output)         │   │
│  └──────────┘  ├──▶│ Causal   │──▶│                  │   │
│  ┌──────────┐  │   │ DAG +    │   │ Deterministic    │   │
│  │ Bob's     │──┤   │ Quorum   │   │ total ordering   │   │
│  │ core      │  │   │ Consensus│   │ of all events    │   │
│  └──────────┘  │   └──────────┘   │                  │   │
│  ┌──────────┐  │                   │ apply() builds   │   │
│  │ Carol's   │──┘                  │ state from this  │   │
│  │ core      │                     └─────────────────┘   │
│  └──────────┘                                            │
│                                                           │
│  All managed by a single Corestore                       │
└──────────────────────────────────────────────────────────┘
```

Each writer appends to their own Hypercore — they never write to anyone else's. Autobase reads all writer cores, arranges their entries into a causal DAG, linearizes the DAG into a total order, and feeds the ordered entries through a user-defined `apply` function that builds the view.

---

## The Causal DAG: Tracking What Happened Before What

When Alice appends an entry to her Hypercore, she doesn't just write her data — she also records which entries from other writers she has seen. These references create a **directed acyclic graph** where edges represent the "happens-before" relationship.

### How It Works

Every entry (node) in the DAG carries:

| Field | Description |
|-------|-------------|
| **value** | The user's data (encoded via `valueEncoding`) |
| **heads** | References to the current DAG heads at the time of writing |
| **clock** | A vector clock computed from the node's dependencies |
| **writer** | Which writer produced this node |
| **length** | Sequence number within that writer's core |

The `heads` field is the causal link. When Alice writes her third entry, she records whatever DAG heads she currently knows about — perhaps Bob's second entry and her own previous entry. This means Alice's third entry *causally depends on* (happens after) Bob's second entry.

```
Alice:   [A1] ─────────── [A2] ─────────── [A3]
              \                             /
Bob:           └─── [B1] ─── [B2] ────────┘
                             /
Carol:              [C1] ───┘
```

In this DAG, `A3` references `B2` as a head, so `A3` happens-after `B2`. And `B2` references `C1`, so `B2` happens-after `C1`. The transitive chain gives us: `C1 → B2 → A3`.

But `A2` and `B1` might not reference each other at all — they were written concurrently by peers who hadn't yet seen each other's work. These are **causally concurrent** events, and ordering them is where linearization comes in.

### Vector Clocks

Each node carries a **vector clock** — a map from writer public keys to sequence numbers. The clock is computed by merging the clocks of all referenced heads:

```
Node A3's clock:
  Alice:  3  (A3 is Alice's 3rd entry)
  Bob:    2  (A3 has transitively seen up to Bob's 2nd entry)
  Carol:  1  (A3 has transitively seen up to Carol's 1st entry)
```

The clock answers a key question: `clock.includes(writerKey, seq)` — "has this node (directly or transitively) seen the given writer's entry at sequence `seq`?" This is how Autobase determines causal ordering without synchronized timestamps.

> **Terminology:** The **happens-before** relationship (written `a → b`) means event `a` is in event `b`'s causal history. If `a → b`, then `b` has seen `a` (directly or transitively). If neither `a → b` nor `b → a`, the events are **concurrent** — they were produced independently without knowledge of each other.

---

## Linearization: From DAG to Total Order

A causal DAG gives you a *partial* order — you know that `C1` comes before `B2`, and `B2` comes before `A3`. But concurrent events like `A2` and `B1` have no causal ordering. To build a useful view (like a Hyperbee key-value store), you need a **total order** — every event has a definite position.

Autobase linearizes the DAG using two rules:

1. **Causal ordering is preserved.** If `a → b`, then `a` appears before `b` in the linearized output. This is non-negotiable — the laws of causality are respected.

2. **Concurrent events are ordered by writer key.** When two events are causally concurrent, Autobase breaks the tie with a deterministic comparison: `Buffer.compare(writerA.key, writerB.key)`. Lexicographically smaller keys go first.

The result is a single ordered sequence that every peer computes identically — regardless of the order in which they received the events. Two peers who have seen the same set of events will always produce the same linearization.

```
DAG:                     Linearized:
  A1 ─── A2              1. A1
  B1 ─── B2              2. B1  (concurrent with A2, key tiebreak)
  C1                      3. C1  (concurrent with A2/B1, key tiebreak)
                          4. A2  (depends on A1)
A3 ─┐ depends on         5. B2  (depends on B1, C1)
    │ B2 and A2           6. A3  (depends on A2, B2)
```

> **Key Insight:** The tiebreaker being the public key means the ordering is deterministic and verifiable — no randomness, no timestamps, no coordination. Any peer who knows the same set of events will produce the exact same sequence. The choice of lexicographic key comparison is arbitrary but consistent, which is all that matters.

---

## The Apply Function: Building State from History

Autobase doesn't just order events — it builds a *view* from them. The view is typically a Hyperbee (from <a href="part-4-hyperbee-hyperdrive.md">Part 4</a>) that represents the current application state.

Two user-defined functions control this:

### open(store, host)

Creates the view data structure. Called once during initialization.

```js
function open (store, host) {
  // Return a view backed by a named Hypercore
  return store.get('my-view', { valueEncoding: 'json' })
}
```

The `store` is an `AutoStore` that provides `store.get(name)` to create named Hypercores for the view. The `host` argument provides access to the Autobase instance. The returned object becomes `base.view`.

### apply(nodes, view, host)

Processes linearized events and updates the view. Called repeatedly as new events are linearized.

```js
async function apply (nodes, view, host) {
  for (const node of nodes) {
    if (node.value === null) continue  // Skip ack-only nodes

    const { value } = node

    // Handle writer management
    if (value.addWriter) {
      await host.addWriter(Buffer.from(value.addWriter, 'hex'), { indexer: true })
      continue
    }

    // Handle application data
    await view.append(value)
  }
}
```

The `host` argument provides side-effect methods:
- `host.addWriter(key, { indexer })` — add a new writer
- `host.removeWriter(key)` — remove a writer

> **Gotcha:** The `apply` function must be **pure and deterministic**. It must only modify the `view` argument — no external state, no network calls, no `Date.now()`, no `Math.random()`. Why? Because Autobase may *undo and replay* the apply function during reordering. If apply wrote to an external database, the undo wouldn't roll back that write. If apply used `Date.now()`, two replays would produce different results. Purity is a design contract, not runtime-enforced — Autobase won't throw if you break it, but your application state will silently diverge between peers.

---

## Writer Roles: Not Everyone Votes

Autobase defines three roles for writers, each with different consensus participation:

### Indexing Writers (Indexers)

Their references count toward quorum. Only indexers can advance the consensus frontier. When an indexer appends a node that references other nodes, that reference is a **vote** — it signals "I have seen these events."

Indexers are the consensus participants. Use odd numbers (3, 5, 7) to prevent quorum ties.

### Non-Indexing Writers

Submit entries that are included in the DAG and the linearized view, but don't count toward quorum. Their references don't advance consensus.

Use this for client-server patterns: servers are indexers (they determine ordering), clients are non-indexing writers (they submit data but don't vote). This keeps the quorum small and fast while allowing many contributors.

### Relayed Writers

Entries appear only when referenced by a confirmed node from another writer. Relayed writers can never be the "head" of the DAG — their entries are only visible after an indexer or non-indexer includes them.

Use this for untrusted submitters: their data enters the system only if a trusted writer vouches for it.

```js title="writer-roles.js"
async function apply (nodes, view, host) {
  for (const { value } of nodes) {
    if (value.type === 'add-indexer') {
      // Full consensus participant
      await host.addWriter(Buffer.from(value.key, 'hex'), { indexer: true })
    }
    if (value.type === 'add-contributor') {
      // Writes data but doesn't vote
      await host.addWriter(Buffer.from(value.key, 'hex'), { indexer: false })
    }
    // ... handle application data ...
  }
}
```

> **Key Insight:** Writer roles separate *write access* from *consensus participation*. A chat app might have hundreds of users (non-indexing writers) but only 3-5 server nodes as indexers. The ordering converges quickly because the quorum is small, while all users can still contribute messages.

---

## Quorum Consensus: When Does Ordering Become Permanent?

This is the hardest part of Autobase — and the part that makes it fundamentally different from simpler multi-writer systems like CRDTs.

### The Problem

The linearized order of concurrent events depends on which events you've seen. If Alice has seen events `{A1, B1}` and Bob has seen events `{A1, B1, C1}`, they might compute different orderings for the concurrent events. As more information arrives, the ordering can change — events that were in position 3 might shift to position 5.

This is fine for unconfirmed data. But at some point, the ordering needs to become permanent — otherwise applications can never safely act on it.

### Votes and Quorum

A **vote** is a reference from an indexer to a node. When indexer Alice appends an entry that references Bob's entry, Alice has voted for Bob's entry — she's saying "I've seen this."

**Single quorum:** A node achieves single quorum when a majority of indexers have (directly or transitively) referenced it. With 3 indexers, that's 2 out of 3.

**Double quorum:** A node achieves double quorum when a majority of indexers are aware of the single quorum — meaning a majority have seen that a majority has voted.

**Why double?** A single quorum isn't enough. Consider 3 indexers: Alice, Bob, Carol. Alice and Bob might form a quorum around one ordering, while Bob and Carol form a quorum around a different ordering. Bob is in both quorums — a single quorum doesn't guarantee consistency.

Double quorum solves this: if a majority know that a majority has voted, then any future majority must include someone who knows about the earlier quorum. This creates a chain of awareness that forces convergence.

> **Feynman Moment:** Think of it like a jury. Single quorum is "7 out of 12 jurors agree." But what if there was a communication breakdown and two groups of 7 formed with only 2 overlapping members? Double quorum is "7 jurors agree, and 7 jurors know that 7 jurors agree." Now any future group of 7 must include someone who knows the earlier verdict. The information can't be lost.

### The Confirmation Rule

A node's ordering becomes immutable once it achieves a quorum degree **2 higher** than any competing quorum. In the common case with no competing quorums, this means double quorum is sufficient. But if two concurrent branches both achieve single quorum independently, each needs to reach triple quorum (degree 3) to resolve the race.

In practice, with 3 indexers actively acknowledging each other, confirmation happens within a few round-trips after all indexers have seen the events.

### ack() — The Consensus Engine

If indexers only write when they have application data, consensus stalls — there's no mechanism for indexers to signal "I've seen your work." The `ack()` method solves this by appending a null entry that carries only causal references:

```js
const base = new Autobase(store, bootstrap, {
  open,
  apply,
  ackInterval: 1000  // Auto-ack every 1 second
})
```

Each `ack()` call:
1. Appends a `null` value to the local writer's core
2. The null node records the current DAG heads as dependencies
3. This reference serves as a vote, advancing the quorum

The `ackInterval` option (default: 10 seconds) configures automatic periodic acks. Without acks, the quorum never advances and ordering never stabilizes.

> **Gotcha:** Your `apply` function will receive nodes with `null` values — these are ack-only nodes. Always check for null: `if (node.value === null) continue`. They carry no application data, but their causal references are critical for consensus.

---

## Reordering: The Price of Decentralization

Here's the uncomfortable truth about multi-writer P2P: ordering can change. Before quorum confirmation, the linearized order of events is provisional. When new causal information arrives — a previously unseen writer's entries, or a new reference chain — Autobase may need to reorder events.

### What Happens During a Reorder

1. New events arrive (via replication) that reveal a previously unknown causal dependency
2. Autobase computes the new correct linearization
3. Events that were already applied may need to move to different positions
4. Autobase **truncates** the view back to the divergence point
5. Autobase **re-applies** events in the new correct order through the `apply` function

This is why `apply` must be pure and deterministic — it might be called multiple times with different orderings of the same events. And this is why `open` must return a view derived solely from its `store` argument — the view must be reconstructable from the apply history alone.

### signedLength vs. length

Autobase exposes two length markers on the view:

| Property | Meaning |
|----------|---------|
| `base.view.length` | Total entries including unconfirmed tip |
| `base.signedLength` | Confirmed entries (quorum-locked, will never reorder) |

Everything between `signedLength` and `length` is provisional — it represents the best current guess at the ordering, but it may change. Everything before `signedLength` is permanent.

```js title="ordering-awareness.js"
await base.update()

const confirmed = base.signedLength
const total = base.view.length
const provisional = total - confirmed

console.log(`${confirmed} confirmed, ${provisional} provisional entries`)

// Safe to act on confirmed data
for (let i = 0; i < confirmed; i++) {
  const entry = await base.view.get(i)
  // This entry's position will never change
}

// Provisional data may reorder
for (let i = confirmed; i < total; i++) {
  const entry = await base.view.get(i)
  // This entry's position is tentative
}
```

### UX Implications

Reordering is invisible at the data layer — Autobase handles it automatically. But the *application* must be reordering-aware:

- **Don't show sequence numbers to users.** Position 42 today might be position 44 tomorrow. Use content-derived identifiers instead.
- **Show provisional data differently.** Entries before `signedLength` are settled. Entries after are tentative. A subtle visual indicator (like a "pending" badge) prevents user confusion when entries shuffle.
- **Never send external side effects from provisional data.** Don't send emails, trigger webhooks, or update external systems based on unconfirmed ordering. Wait for `signedLength` to advance.

---

## In Practice: Building a Multi-Writer App

Here's a complete example of a collaborative key-value store using Autobase with Hyperbee:

```js title="multi-writer-kv.js"
const Corestore = require('corestore')
const Autobase = require('autobase')
const Hyperbee = require('hyperbee')
const Hyperswarm = require('hyperswarm')

// --- Handlers ---

function open (store, host) {
  // The view is a Hyperbee for sorted key-value access
  return new Hyperbee(store.get('view'), {
    keyEncoding: 'utf-8',
    valueEncoding: 'json'
  })
}

async function apply (nodes, view, host) {
  // Process linearized nodes in order
  const batch = view.batch()

  for (const node of nodes) {
    if (node.value === null) continue  // Ack-only node

    const { type, key, value } = node.value

    if (type === 'add-writer') {
      await host.addWriter(Buffer.from(key, 'hex'), { indexer: value.indexer })
      continue
    }

    if (type === 'put') await batch.put(key, value)
    if (type === 'del') await batch.del(key)
  }

  await batch.flush()
}

// --- Setup ---

const store = new Corestore('./my-storage')
const base = new Autobase(store, null, {
  open,
  apply,
  valueEncoding: 'json',
  ackInterval: 1000
})
await base.ready()

// Join the network
const swarm = new Hyperswarm()
swarm.on('connection', (socket) => base.replicate(socket))
swarm.join(base.discoveryKey, { server: true, client: true })
await swarm.flush()

// --- Write data ---

await base.append({ type: 'put', key: 'alice', value: { role: 'admin' } })
await base.append({ type: 'put', key: 'bob', value: { role: 'editor' } })

// --- Read from the linearized view ---

await base.update()
const entry = await base.view.get('alice')
console.log(entry.value)  // { role: 'admin' }
```

A second peer joins by passing the first peer's key as the bootstrap:

```js title="multi-writer-peer-b.js"
const base = new Autobase(store, peerAKey, {
  open,
  apply,
  valueEncoding: 'json',
  ackInterval: 1000
})
await base.ready()

// Peer A must add Peer B as a writer (via apply)
// Peer A appends: { type: 'add-writer', key: base.local.key.toString('hex'), value: { indexer: true } }
```

Writer addition happens *through* the `apply` function — the first writer appends a message that the `apply` handler interprets as an `addWriter` call. This makes writer management itself part of the causal history, which means it's ordered and consistent with everything else.

---

## Fast-Forward: Catching Up Efficiently

When a peer has been offline for a long time, replaying the entire DAG history through `apply` would be expensive. Autobase supports **fast-forward**: if the confirmed checkpoint has advanced significantly, a behind peer can jump directly to the checkpoint state without replaying intermediate history.

This works because confirmed data (before `signedLength`) is immutable — the view at that point has been signed by a quorum of indexers. A behind peer can trust the signed view state and start processing only from the checkpoint forward.

Fast-forward is enabled by default (`fastForward: true` in the constructor). It triggers automatically when the gap between the local state and the remote checkpoint is large enough.

---

## The Tradeoffs

| What You Gain | What You Pay |
|---|---|
| Multiple independent writers — no single bottleneck | Ordering is provisional until quorum confirms it |
| Deterministic linearization — every peer computes the same order | Concurrent events are ordered by key comparison (arbitrary but consistent) |
| Causal ordering preserved — events never precede their dependencies | Vector clocks add metadata overhead to every entry |
| Quorum-confirmed checkpoints — ordering becomes permanent | Requires a majority of indexers to be active for progress |
| Apply function builds rich views (Hyperbee, custom stores) | Apply must be pure — no side effects, no non-determinism |
| Fast-forward for catching up after long offline periods | Behind peers must trust the quorum-signed checkpoint |
| Writer roles separate contributions from consensus | More indexers = more reliable consensus but slower confirmation |

---

## Key Takeaways

- **Autobase linearizes multiple independent Hypercores into a single deterministic view.** Each writer appends to their own core. Autobase arranges all entries into a causal DAG, respects happens-before relationships, and breaks ties between concurrent events using lexicographic key comparison.

- **The causal DAG tracks "happens-before" via head references.** Every entry records the current DAG heads at the time of writing. Vector clocks computed from these references tell you exactly what each entry has seen.

- **Quorum consensus makes ordering permanent.** A vote = an indexer referencing a node. Single quorum = a majority have voted. Double quorum = a majority know about the single quorum. Once achieved, the ordering at that point will never change.

- **Three writer roles: indexer, non-indexer, relayed.** Indexers vote and advance consensus. Non-indexers contribute data without voting. Relayed writers' entries only appear if referenced by a confirmed writer. Use odd numbers of indexers (3, 5, 7) to avoid ties.

- **The apply function must be pure and deterministic.** It may be called multiple times during reordering. Only modify the view argument. No external state, no `Date.now()`, no network calls. This is a design contract, not runtime-enforced.

- **Design for reordering.** Everything before `signedLength` is confirmed and permanent. Everything after is provisional. Don't trigger external side effects from provisional data. Show tentative entries differently in the UI.

---

## What's Next

We've built the full collaboration stack: encrypted connections, verified data, peer discovery, and multi-writer consensus. But we've been trusting the *people* at each end. What if a peer is malicious? What if they flood the DHT with fake nodes? What if they try to impersonate someone else?

In <a href="part-7-security-trust.md">Part 7</a>, we'll examine the security model of the entire Holepunch stack — from Sybil resistance in the DHT, to Eclipse attack prevention, to the complete Merkle verification chain that makes data poisoning detectable. We'll also look at how identity works without a central authority, including blind pairing for safe peer introduction.

---

## References & Further Reading

1. <a href="https://github.com/holepunchto/autobase" target="_blank">holepunchto/autobase — Multi-writer DAG linearization with quorum consensus</a>
2. <a href="https://github.com/holepunchto/autobase/blob/main/DESIGN.md" target="_blank">Autobase DESIGN.md — Authoritative design rationale for the quorum mechanism</a>
3. <a href="https://github.com/holepunchto/hypercore" target="_blank">holepunchto/hypercore — Append-only log (from Part 3)</a>
4. <a href="https://github.com/holepunchto/hyperbee" target="_blank">holepunchto/hyperbee — Sorted key-value store (from Part 4)</a>
5. <a href="https://github.com/holepunchto/corestore" target="_blank">holepunchto/corestore — Multi-Hypercore management (from Part 4)</a>
6. <a href="https://en.wikipedia.org/wiki/Vector_clock" target="_blank">Wikipedia — Vector clock</a>
7. <a href="https://en.wikipedia.org/wiki/Happened-before" target="_blank">Wikipedia — Happened-before relation</a>
8. <a href="https://en.wikipedia.org/wiki/Directed_acyclic_graph" target="_blank">Wikipedia — Directed acyclic graph</a>
9. <a href="https://docs.pears.com/" target="_blank">Pear Runtime Documentation</a>

---

> **Series: P2P from Scratch — Building on the Holepunch Stack**
> [Part 1: The Internet is Hostile](part-1-nat-holepunching.md) | [Part 2: Encrypted Pipes](part-2-encrypted-pipes.md) | [Part 3: Append-Only Truth](part-3-hypercore-merkle.md) | [Part 4: From Logs to Databases](part-4-hyperbee-hyperdrive.md) | [Part 5: Finding Peers](part-5-dht-discovery.md) | **Part 6: Many Writers, One Truth (You are here)** | [Part 7: Trust No One](part-7-security-trust.md) | [Part 8: Building for Humans](part-8-ux-production.md)
