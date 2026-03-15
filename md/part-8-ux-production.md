# P2P from Scratch — Part 8: Building for Humans

> "The purpose of computing is insight, not numbers."
> — Richard Hamming

**Excerpt:** The Holepunch stack gives you cryptographic identity, verified data, and decentralized discovery. But none of that matters if the app feels broken when you're on the subway. This final post covers the hardest part of P2P engineering: making it invisible — offline-first design, managing the consistency spectrum, mobile lifecycle with suspend/resume, availability strategies, and the observability tools that keep a serverless system debuggable.

<!-- Series Navigation -->
> **Series: P2P from Scratch — Building on the Holepunch Stack**
> [Part 1: The Internet is Hostile](part-1-nat-holepunching.md) | [Part 2: Encrypted Pipes](part-2-encrypted-pipes.md) | [Part 3: Append-Only Truth](part-3-hypercore-merkle.md) | [Part 4: From Logs to Databases](part-4-hyperbee-hyperdrive.md) | [Part 5: Finding Peers](part-5-dht-discovery.md) | [Part 6: Many Writers, One Truth](part-6-autobase-consensus.md) | [Part 7: Trust No One](part-7-security-trust.md) | **Part 8: Building for Humans (You are here)**

---

## Quick Recap

Parts <a href="part-1-nat-holepunching.md">1</a>–<a href="part-6-autobase-consensus.md">6</a> built the technical stack: connectivity, encryption, data structures, discovery, and consensus. <a href="part-7-security-trust.md">Part 7</a> mapped the security model. The engineering is sound — now we need to make it feel invisible to users.

---

## The Problem: Technology Isn't the Hard Part

We've spent seven posts building an extraordinary stack. Encrypted pipes. Merkle-verified data. Distributed discovery. Multi-writer consensus. Six layers of security. Every component is cryptographically sound, mathematically correct, and elegantly designed.

And none of your users will care.

They'll care that a message they sent appears instantly — even with no internet. They'll care that opening the app on Monday shows the same data they saw on Friday. They'll care that syncing with a collaborator doesn't require a computer science degree. They'll care that the app doesn't drain their battery while they sleep.

The gap between "technically correct" and "feels right" is where most P2P applications fail. The cryptography is the easy part. The UX is where you earn trust or lose users.

> **Key Insight:** P2P UX isn't about hiding complexity — it's about being honest with users about what they can expect, then exceeding those expectations. Users can handle "syncing..." as long as they trust it will resolve. They can't handle data that silently rearranges without explanation.

---

## The Mental Model: A Shared Whiteboard in a Café

Imagine a whiteboard in a café where friends collaborate on a drawing. When you're in the café, you draw and see everyone's strokes in real time. When you leave and sketch on your own notepad, your drawings exist — but they're "yours" until you return to the café and transcribe them onto the whiteboard. The café whiteboard is the canonical state; your notepad is local-first.

Now imagine the whiteboard is *everywhere* — not just the café, but wherever any contributor has a copy. There's no single canonical whiteboard. Each copy is equally valid, and they sync when people meet.

> **Feynman Moment:** The analogy hides the hardest part: when two people draw in the same spot independently, someone has to decide which stroke goes on top. In our system, that's Autobase's linearization (from <a href="part-6-autobase-consensus.md">Part 6</a>). But from the *user's* perspective, the question isn't "which algorithm decides" — it's "will I lose my work?" The answer must always be no. Both strokes are preserved; only their ordering might change before confirmation.

---

## Offline-First: The P2P Superpower

The strongest UX advantage of P2P is one that client-server apps struggle to match: **writes never block on connectivity.** When a user creates, edits, or deletes data, it appends to their local Hypercore instantly. No server round-trip. No spinner. No "please check your connection."

```js title="offline-write.js"
// This works with zero peers connected
await base.append({ type: 'put', key: 'meeting-notes', value: { text: 'Draft agenda...' } })
// The entry is in the local Hypercore immediately
// It will sync to peers whenever they connect
```

The data is real the moment it's written. It's signed by the user's Ed25519 key, stored in the local Merkle tree, and will replicate to peers the next time a connection exists. There's no "pending" state at the data layer — only at the *consensus* layer.

This means the UX should reflect two truths simultaneously:

| State | What the User Sees | What It Means |
|-------|-------------------|---------------|
| **Local** | Their data, visible instantly | Written to local Hypercore, not yet seen by peers |
| **Synced** | Data visible to collaborators | Replicated to connected peers |
| **Confirmed** | Permanently ordered | Past `signedLength` — quorum-locked, will never reorder |

> **Gotcha:** "Offline-first" doesn't mean "offline-only." Some operations inherently need peers — discovering new collaborators, joining a group via Blind Pairing, or real-time cursor presence. Design these to degrade gracefully: show what's possible offline, and queue what needs connectivity.

---

## The Consistency Spectrum: signedLength in Practice

From <a href="part-6-autobase-consensus.md">Part 6</a>, we know Autobase exposes two markers: `base.signedLength` (confirmed, quorum-locked) and `base.view.length` (total including provisional). The gap between them is the **consistency spectrum** — data that exists but whose ordering might change.

Your application must make this spectrum visible without overwhelming users:

```js title="consistency-aware-ui.js"
await base.update()

const confirmed = base.signedLength
const total = base.view.length

for (let i = 0; i < total; i++) {
  const entry = await base.view.get(i)
  const isConfirmed = i < confirmed

  renderEntry(entry, {
    confirmed: isConfirmed,
    // Subtle visual: confirmed entries are solid, provisional are slightly faded
    opacity: isConfirmed ? 1.0 : 0.85,
    badge: isConfirmed ? null : 'syncing'
  })
}
```

### Design Patterns for Consistency

| Pattern | When to Use | How It Works |
|---------|-------------|--------------|
| **Fade unconfirmed** | Chat apps, feeds | Provisional messages appear slightly dimmed; they solidify as quorum confirms |
| **"Syncing" badge** | Collaborative docs | A small indicator shows entries are provisional; disappears on confirmation |
| **Optimistic + undo** | Real-time editing | Apply changes immediately; if reordering changes the outcome, show a notification |
| **Confirm before acting** | Financial, permissions | Block irreversible actions until `signedLength` advances past the relevant entry |

Let's visualize the journey every piece of data takes:

```mermaid
graph LR
    W["Local Write<br/>(instant)"]:::local --> S["Synced<br/>(replicated to peers)"]:::synced --> C["Confirmed<br/>(past signedLength)"]:::confirmed

    W -.->|"Append to<br/>local Hypercore"| S
    S -.->|"Quorum of indexers<br/>acknowledge"| C

    classDef local fill:#22272e,stroke:#539bf5,color:#e6edf3
    classDef synced fill:#22272e,stroke:#986ee2,color:#e6edf3
    classDef confirmed fill:#22272e,stroke:#57ab5a,color:#e6edf3
```

*Figure 1: The consistency spectrum. Data moves left-to-right through three states. Only confirmed data (past signedLength) is safe for external side effects.*

The key UX decision is how to represent each state. Most applications can treat local and synced identically (both are "your data") and only distinguish confirmed from unconfirmed.

The golden rule: **never trigger external side effects from provisional data.** Don't send notifications, update external databases, or fire webhooks based on entries beyond `signedLength`. Wait for confirmation.

---

## Sparse Replication: Download Only What You Need

Not every peer needs every block. <a href="https://github.com/holepunchto/hypercore" target="_blank">Hypercore</a>'s sparse replication means `core.get(index)` is a lazy operation — it checks local storage first, and only requests from peers if the block isn't available locally:

```js title="sparse-loading.js"
// Hypercore checks: local storage → bitfield → request from peers
const block = await core.get(42)  // downloads block 42 on demand

// For bulk prefetching, use download ranges
const range = core.download({ start: 0, end: 100, linear: true })
await range.done()  // waits for all 100 blocks

// For UX loading indicators, use the onwait callback
const entry = await core.get(index, {
  onwait (index, core) {
    showLoadingSpinner(index)  // fires only if block needs remote fetch
  },
  timeout: 10000  // fail after 10 seconds if no peer has it
})
```

The `onwait` callback is a UX goldmine — it fires *only when a block needs to be fetched from a peer*, letting you show a loading indicator exactly when there's actually a wait, and skip it when the data is local.

### Storage Management: clear() and truncate()

Long-lived applications accumulate data. Two APIs manage storage:

**`core.clear(start, end)`** — removes block *data* from local storage while preserving the Merkle tree. The blocks can be re-fetched from peers later. Use this for cache-like behavior:

```js title="storage-pruning.js"
// Clear old blocks to free disk space (Merkle proofs still valid)
const result = await core.clear(0, 1000, { diff: true })
console.log(`Freed ${result.blocks} blocks from storage`)
// Blocks 0-999 can still be fetched on demand from peers
```

**`core.truncate(newLength)`** — permanently shortens the core's logical length. This requires write access and increments the fork counter. Use this for hard pruning, not cache management.

| Operation | Preserves Merkle Tree | Requires Write | Recoverable |
|-----------|:---:|:---:|:---:|
| `clear(start, end)` | Partially (retains what's needed) | No | Yes (re-fetch from peers) |
| `truncate(length)` | No (rewrites) | Yes | No (permanent) |

> **Key Insight:** Sparse replication and `clear()` together enable a powerful pattern: download what you need, verify it once, use it, then clear it to free space. The verification metadata needed for remaining data stays intact, so re-verification on re-download is automatic. This is how mobile apps can handle large datasets without exhausting storage.

---

## Mobile Lifecycle: Suspend and Resume

Mobile platforms aggressively manage background apps. An app that maintains active network connections while backgrounded will drain the battery and get killed by the OS. Hyperswarm and Corestore both support **suspend/resume** for mobile lifecycle management.

### Hyperswarm Suspend

```js title="mobile-lifecycle.js"
// When the app goes to background
async function onBackground () {
  await swarm.suspend()
  // All connections are destroyed
  // Retry queue is reset
  // No network activity until resume()
}

// When the app comes to foreground
async function onForeground () {
  await swarm.resume()
  // DHT re-initializes
  // Server restarts
  // Discovery resumes
  // Outbound connections re-attempted
}
```

`swarm.suspend()` is aggressive — it **destroys all connections**, suspends the server and DHT, suspends all discovery sessions, and resets the retry queue. This is not a gentle pause; it's a full shutdown of networking. When `resume()` is called, the swarm reinitializes networking — resuming the DHT, server, and discovery sessions (which are preserved, not recreated) — then re-attempts outbound connections.

### Corestore Suspend

```js title="corestore-suspend.js"
// Flush and release storage resources
await store.suspend()

// Re-open storage
await store.resume()
```

Corestore's `suspend()` flushes the database before releasing resources — no data loss even during abrupt backgrounding. On Android, suspend is disabled by default (requires explicit `{ suspend: true }` opt-in); on all other platforms, it's enabled by default.

> **Gotcha:** There is no auto-resume. If your app doesn't call `swarm.resume()` on foreground, networking stays dead. Wire suspend/resume to your platform's lifecycle events (e.g., `visibilitychange` on web, `AppState` on React Native, `onPause`/`onResume` on Android).

---

## Availability Strategies: Who Holds Your Data?

The fundamental tension of P2P: when all peers are offline, data is unavailable. Unlike a server that runs 24/7, a P2P mesh depends on *someone* being online. The availability strategy you choose defines your application's reliability profile.

| Strategy | How It Works | Availability | Sovereignty |
|----------|-------------|:---:|:---:|
| **Pure mesh** | Data lives only on user devices | Low — requires overlap | Maximum |
| **Seeded mesh** | Dedicated always-on peers seed popular data | Medium — baseline guaranteed | High |
| **Personal node** | User runs their own always-on device (NAS, VPS) | High — user-controlled uptime | Maximum |
| **Hybrid assist** | Optional infrastructure accelerates sync | Highest — infrastructure + mesh | High (infrastructure is optional) |

### Seeded Mesh in Practice

The most common pattern for production apps. A set of "seed" nodes run Hyperswarm and replicate all shared data, providing baseline availability without becoming a central server:

```js title="seed-node.js"
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')

const store = new Corestore('./seed-storage')
const swarm = new Hyperswarm()

// Replicate with every peer that connects
swarm.on('connection', (socket) => store.replicate(socket))

// Join the topics this seed node should keep alive
for (const topic of topics) {
  swarm.join(topic, { server: true, client: true })
}

// The seed node holds data so it's available even when users are offline
```

The seed node is *not* a server. It doesn't control access, validate data, or enforce business logic. It's a mirror — it holds copies so that data is available when the original authors are offline. Users who distrust the seed node lose nothing; their data is still verified by Merkle proofs and Ed25519 signatures regardless of who served it.

> **Key Insight:** Availability and sovereignty are not opposites. A seed node improves availability without compromising sovereignty because the verification chain (from <a href="part-7-security-trust.md">Part 7</a>) ensures data integrity regardless of the source. The seed could be malicious — it doesn't matter, because it can't forge signatures or alter verified data.

---

## Fast-Forward: Catching Up Efficiently

When a peer has been offline for days, replaying the entire DAG history through Autobase's `apply` function would be painfully slow. **Fast-forward** skips directly to the latest confirmed checkpoint.

The trigger is automatic: when the gap between local state and the confirmed remote state reaches 16 or more blocks, Autobase fast-forwards — downloading the checkpoint state and all view cores at their target lengths, then atomically jumping to that point. No replay of intermediate history needed.

```js title="fast-forward-monitoring.js"
// Check if we're fast-forwarding (useful for UX)
if (base.isFastForwarding()) {
  showProgress('Catching up with latest state...')
}

// After update, check how far behind we are
await base.update()
const behind = base.view.length - base.signedLength
if (behind > 0) {
  showStatus(`${behind} entries pending confirmation`)
}

// Manual recovery if state is corrupted
await base.repair()  // forces fast-forward regardless of threshold
```

If fast-forward fails (network issues, corrupted state), a 5-minute cooldown prevents retry storms. The `repair()` method bypasses this cooldown and the minimum threshold — use it for manual recovery when automatic mechanisms fail.

---

## Observability: Debugging Without a Server

You can't `ssh` into a P2P network. There's no centralized log aggregator, no request trace, no database dashboard. Observability must be built into the application itself.

### Connection Health

```js title="observability.js"
// Live connection count
console.log(`Connected peers: ${swarm.connections.size}`)

// Connection statistics
console.log(swarm.stats)
// {
//   updates: 142,
//   connects: {
//     client: { opened: 12, closed: 8, attempted: 23 },
//     server: { opened: 5, closed: 3 }
//   },
//   bannedPeers: 0
// }

// React to connection changes
swarm.on('update', () => {
  updateConnectionIndicator(swarm.connections.size)
})

// Monitor individual peers
for (const [key, peerInfo] of swarm.peers) {
  console.log({
    peer: key.slice(0, 8),
    connected: peerInfo.connectedTime > -1,
    attempts: peerInfo.attempts,
    explicit: peerInfo.explicit,
    banned: peerInfo.banned
  })
}
```

### Replication Progress

```js title="replication-progress.js"
// For each core, compare local length to remote
for (const peer of core.peers) {
  console.log({
    remoteLength: peer.remoteLength,
    localLength: core.length,
    behind: peer.remoteLength - core.length
  })
}
```

### Key Metrics to Track

| Metric | What It Tells You | Warning Threshold |
|--------|-------------------|-------------------|
| `swarm.connections.size` | Network health | 0 for > 30 seconds |
| `swarm.stats.connects.client.attempted` vs `opened` | Connection success rate | < 50% success |
| `base.signedLength` vs `base.view.length` | Consensus health | Gap growing over time |
| `core.length` vs peer `remoteLength` | Replication progress | Falling behind |
| `base.isFastForwarding()` | Catch-up status | Extended fast-forward |

---

## Distributing with Pear Runtime

<a href="https://docs.pears.com/" target="_blank">Pear Runtime</a> packages the entire Holepunch stack for end-user distribution. Applications are distributed as Hyperdrives, identified by their public key, and updated via standard Hypercore replication.

The deployment workflow:

```
pear stage        →  Sync local code to application Hyperdrive
pear release      →  Mark a version as the production release
pear seed         →  Announce to DHT and serve to peers
```

Users access apps via `pear://` links — the Hyperdrive public key becomes the app's permanent, unforgeable identifier. Updates propagate through the same replication mechanism as any other Hypercore data: peers discover, connect, and sync automatically.

For persistent state across restarts, Pear provides `Pear.checkpoint(value)` — a simple key-value store that survives app restarts and is available as `Pear.app.checkpoint` on next launch. For clean shutdown, `Pear.teardown(fn)` registers handlers that run in order, with promises awaited between them.

> **Gotcha:** `Pear.updates()` is deprecated. Use the `pear-updates` module instead for handling application update notifications.

---

## The Tradeoffs

| What You Gain | What You Pay |
|---|---|
| Writes never block on connectivity | Consistency is eventual, not immediate |
| Sparse replication saves bandwidth and storage | Cold starts are slower (data fetched on demand) |
| Suspend/resume saves battery on mobile | All connections destroyed — resume reinitializes networking |
| Seed nodes provide baseline availability | Seed nodes must be operated and maintained |
| Fast-forward catches up efficiently | 16-block threshold before triggering; 5-min cooldown on failure |
| Pear distributes apps without app stores | Users need Pear Runtime installed |
| Full observability via local metrics | No centralized dashboard — each peer monitors itself |

---

## Key Takeaways

- **Offline-first is the P2P superpower.** Writes happen instantly to the local Hypercore. Sync happens when peers connect. Design UX around three states: local, synced, and confirmed (`signedLength`).

- **Never trigger side effects from provisional data.** Everything between `signedLength` and `view.length` might reorder. Wait for confirmation before sending notifications, updating external systems, or making irreversible changes.

- **Use sparse replication and `clear()` for storage management.** Download on demand, verify once, clear when done. Verification metadata stays intact for re-verification. This is essential for mobile.

- **Wire suspend/resume to your platform's lifecycle.** `swarm.suspend()` destroys all connections and stops networking; `swarm.resume()` rebuilds. There's no auto-resume — forgetting to wire this means battery drain or dead networking.

- **Choose an availability strategy explicitly.** Pure mesh, seeded mesh, personal node, or hybrid. Seed nodes improve availability without compromising sovereignty because the verification chain ensures data integrity regardless of the source.

- **Build observability from day one.** `swarm.connections.size`, `swarm.stats`, `swarm.on('update')`, and `base.signedLength` vs `base.view.length` are your core health indicators. Every peer must be its own monitoring system.

---

## Putting It All Together

Here's the complete picture — a collaborative key-value store that combines every layer we've built across this series. One file, ~50 lines, the full Holepunch stack:

```js title="p2p-collaborative-kv.js"
const Corestore = require('corestore')       // Part 4: Multi-core management
const Autobase = require('autobase')          // Part 6: Multi-writer consensus
const Hyperbee = require('hyperbee')          // Part 4: Sorted key-value store
const Hyperswarm = require('hyperswarm')      // Part 5: Peer discovery

// --- Autobase handlers (Part 6) ---

function open (store) {
  return new Hyperbee(store.get('view'), {
    keyEncoding: 'utf-8',
    valueEncoding: 'json'
  })
}

async function apply (nodes, view, host) {
  const batch = view.batch()
  for (const node of nodes) {
    if (node.value === null) continue          // Skip ack-only nodes
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

const store = new Corestore('./p2p-storage')  // Part 4: Deterministic key derivation
const base = new Autobase(store, null, { open, apply, valueEncoding: 'json', ackInterval: 1000 })
await base.ready()

// --- Networking (Parts 1, 2, 5) ---

const swarm = new Hyperswarm()                // Part 1: NAT traversal, Part 2: Encrypted pipes
swarm.on('connection', (socket) => base.replicate(socket))  // Part 3: Merkle-verified replication
swarm.join(base.discoveryKey, { server: true, client: true })
await swarm.flush()

// --- Use it ---

await base.append({ type: 'put', key: 'hello', value: { from: 'Part 8', msg: 'The full stack in 45 lines' } })
await base.update()

const entry = await base.view.get('hello')
console.log(entry.value)  // { from: 'Part 8', msg: 'The full stack in 45 lines' }

// --- Observability (Part 8) ---
console.log(`Peers: ${swarm.connections.size}, Confirmed: ${base.signedLength}/${base.view.length}`)
```

Every part of this series is represented in those 45 lines. NAT traversal and encrypted pipes (Parts 1–2) happen inside `Hyperswarm`. Merkle-verified append-only logs (Part 3) power every `Hypercore` underneath. `Hyperbee` and `Corestore` (Part 4) provide the database and key management. `Hyperswarm` (Part 5) handles discovery. `Autobase` (Part 6) linearizes multiple writers. The security model (Part 7) is enforced at every layer — from the Noise XX handshake to the Ed25519 signatures. And the observability line at the bottom is where Part 8 begins.

A second peer joins by passing the first peer's bootstrap key — the same pattern from Part 6. From there, both peers write to their own Hypercores, Autobase linearizes everything, and the Hyperbee view stays consistent across the network.

---

## Series Wrap-Up

Eight posts ago, we started with a simple question: *why can't two computers just talk to each other?* The answer turned out to be a journey through NAT traversal, encrypted transport, append-only logs, B-trees, distributed hash tables, causal DAGs, quorum consensus, six layers of security, and finally — making it all feel invisible to users.

The Holepunch stack is not simple. But the complexity serves a purpose: giving individuals sovereignty over their data without sacrificing the collaborative features we've come to expect from centralized services. Every layer we've explored exists to solve a specific problem that P2P uniquely faces — and together, they form a system where trust is cryptographic, identity is self-sovereign, and no single point of failure can take the network down.

The technology is ready. The question now is what you'll build with it.

---

## References & Further Reading

1. <a href="https://github.com/holepunchto/hyperswarm" target="_blank">holepunchto/hyperswarm — Peer discovery with suspend/resume lifecycle management</a>
2. <a href="https://github.com/holepunchto/hypercore" target="_blank">holepunchto/hypercore — Sparse replication, on-demand download, clear/truncate APIs</a>
3. <a href="https://github.com/holepunchto/corestore" target="_blank">holepunchto/corestore — Multi-core management with suspend/resume and GC</a>
4. <a href="https://github.com/holepunchto/autobase" target="_blank">holepunchto/autobase — Fast-forward, signedLength, and repair APIs</a>
5. <a href="https://docs.pears.com/" target="_blank">Pear Runtime Documentation — Application distribution and lifecycle APIs</a>
6. <a href="https://github.com/nicolo-ribaudo/pear-docs" target="_blank">Pear Documentation Source — Configuration reference and API details</a>
7. <a href="https://github.com/nicolo-ribaudo/pear-updates" target="_blank">pear-updates — Application update notifications (replaces deprecated Pear.updates())</a>
8. <a href="https://github.com/holepunchto/hyperdrive" target="_blank">holepunchto/hyperdrive — Application distribution via pear:// links</a>

---

> **Series: P2P from Scratch — Building on the Holepunch Stack**
> [Part 1: The Internet is Hostile](part-1-nat-holepunching.md) | [Part 2: Encrypted Pipes](part-2-encrypted-pipes.md) | [Part 3: Append-Only Truth](part-3-hypercore-merkle.md) | [Part 4: From Logs to Databases](part-4-hyperbee-hyperdrive.md) | [Part 5: Finding Peers](part-5-dht-discovery.md) | [Part 6: Many Writers, One Truth](part-6-autobase-consensus.md) | [Part 7: Trust No One](part-7-security-trust.md) | **Part 8: Building for Humans (You are here)**
