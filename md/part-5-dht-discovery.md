# P2P from Scratch — Part 5: Peer Discovery with Kademlia DHT

> "The topology has the property that every message exchanged conveys or reinforces useful contact information."
> — Petar Maymounkov & David Mazières, *Kademlia: A Peer-to-Peer Information System Based on the XOR Metric*

**Excerpt:** You have append-only logs, B-tree databases, encrypted pipes, and Merkle proofs. But none of it works if peers can't find each other. This post explains how HyperDHT uses a Kademlia routing table to locate peers across the Internet without a central server, how Hyperswarm manages the full lifecycle from discovery to connection, and why a single connection can serve dozens of Hypercores simultaneously.
<!-- meta-description: How HyperDHT uses Kademlia routing to discover peers without a central server. DHT lookups, topic announcements, and Hyperswarm lifecycle. -->
<!-- meta-labs: p2p-swarm-watch -->

<!-- Series Navigation -->
> **Series: P2P from Scratch — Building on the Holepunch Stack**
> [Part 1: NAT Hole Punching Explained](part-1-nat-holepunching.md) | [Part 2: P2P Encryption with the Noise Protocol](part-2-encrypted-pipes.md) | [Part 3: Merkle Trees and Append-Only Logs](part-3-hypercore-merkle.md) | [Part 4: Building P2P Databases with Hyperbee and Hyperdrive](part-4-hyperbee-hyperdrive.md) | **Part 5: Peer Discovery with Kademlia DHT (You are here)** | [Part 6: Multi-Writer Consensus with Autobase](part-6-autobase-consensus.md) | [Part 7: P2P Security — Threats, Defenses, and Trust](part-7-security-trust.md) | [Part 8: Offline-First UX for P2P Applications](part-8-ux-production.md)

---

> **Verified against:** hyperdht 6.33.2 · dht-rpc 6.27.0 · hyperswarm 4.17.0 · hypercore 11.35.2 — checked 2026-09-03. Every constant, default and byte count in this post is asserted in [`verify/`](https://github.com/heart-IT/p2p-from-scratch-labs/tree/main/verify), which installs whatever Holepunch publishes today and fails if the stack has moved.

## Quick Recap

In Parts <a href="part-1-nat-holepunching.md">1</a>–<a href="part-2-encrypted-pipes.md">2</a>, we established encrypted connections through NATs. In Parts <a href="part-3-hypercore-merkle.md">3</a>–<a href="part-4-hyperbee-hyperdrive.md">4</a>, we built verified data structures on top: append-only logs, B-tree databases, and file systems. But none of it works if peers can't find each other.

---

## The Peer Discovery Problem: Finding Nodes Without a Server

In the client-server world, finding a service is trivial. You type `api.example.com`, DNS resolves it to an IP address, and you connect. The entire Internet is a giant phone book backed by a hierarchical authority.

In a peer-to-peer system, there is no phone book. Alice has a Hypercore she wants to share. Bob wants to replicate it. Neither knows the other's IP address. Neither is running a server with a domain name. Both are behind NATs (from <a href="part-1-nat-holepunching.md">Part 1</a>) and can't receive unsolicited connections.

They need a way to announce "I have this data" and discover "who else has this data" — without any single entity controlling the directory.

This is the peer discovery problem, and it's solved by a **distributed hash table** — a database spread across thousands of nodes where no single node holds the complete picture, but any node can find any record by asking the right neighbors.

---

## The Mental Model: A City Without Street Signs

Imagine a city with no street signs, no addresses, and no map. You need to find a specific house. But every resident knows their immediate neighbors, and every resident can tell you which of their neighbors lives *closest* to the area you're looking for.

You start by asking a random person. They point you to someone closer. That person points you to someone even closer. Within 5-6 hops, you're standing at the right door — even though no one in the chain knew the exact location, and no one had a complete map of the city.

This is how Kademlia works. "Closeness" isn't geographic — it's a mathematical function (XOR distance) over fixed-width identifiers: 160 bits in the original paper, 256 in HyperDHT. The routing is deterministic, logarithmic, and doesn't require any node to know the whole network.

> **Feynman Moment:** The analogy suggests a sequential chain of hops, but that undersells the engineering. In practice, HyperDHT queries up to 10 nodes *in parallel*. A first lookup on a topic draws its starting nodes from the routing table and stays wide open at 10. A *repeat* lookup is different: it starts from the nodes the last query found to be closest, so it fires its first 10 and then throttles to 3 in-flight requests until those first replies land — giving the known-good nodes a chance to answer before flooding the network with second-guesses. Once 10 responses are in, it opens back up. These values reflect the current defaults and may change. It's less like asking for directions one person at a time and more like shouting into a crowd, then focusing on the most promising leads. This parallelism is why lookups converge in seconds, not minutes.

---

## Kademlia: The Algorithm Behind the DHT

<!-- vg:hyperswarm/dht-peer-discovery stepper -->

<a href="https://github.com/holepunchto/hyperdht" target="_blank">HyperDHT</a> implements a Kademlia-based distributed hash table, built on top of <a href="https://github.com/holepunchto/dht-rpc" target="_blank">dht-rpc</a>. Let's break down the core ideas.

### Node IDs and XOR Distance

Every node that routes queries has a 32-byte (256-bit) identifier. As we covered in <a href="part-1-nat-holepunching.md">Part 1</a>, node IDs are derived from network identity: `nodeID = BLAKE2b(publicIP + publicPort)`. You can't choose your position in the keyspace — the DHT validates your claimed ID against your observed address, preventing arbitrary keyspace placement. A node that has just joined has no such ID yet: until it has proven a stable address it stays *ephemeral*, uses the DHT without holding a place in it, and answers no lookups.

> **Key distinction:** HyperDHT separates *routing identity* from *connection identity*. Routing IDs are derived from observed network addresses (for Sybil resistance and deterministic placement), while encrypted connections authenticate peers using Noise keypairs (from <a href="part-2-encrypted-pipes.md">Part 2</a>). The routing ID determines *where* you sit in the DHT; the Noise keypair determines *who* you are.

The "distance" between two IDs is their **XOR** — a bitwise operation that produces a new 256-bit value. Closer IDs share more leading bits. The distance between `1001...` and `1000...` (differing at bit 4) is smaller than between `1001...` and `1100...` (differing at bit 2).

> **Key Insight:** XOR distance is symmetric (`distance(A, B) = distance(B, A)`) and satisfies the triangle inequality. This means if A is close to B and B is close to C, then A and C aren't too far apart. This property is what makes Kademlia's routing work — each hop gets you genuinely closer to the target.

### K-Buckets: The Routing Table

Each node maintains a routing table organized into **buckets** indexed by distance. Bucket `i` holds nodes that share exactly `i` leading bits with your own ID. Since IDs are 256 bits, there are up to 256 possible buckets — though most stay empty in practice.

Each bucket holds up to **k = 20** nodes (the "k" in k-bucket). When a bucket is full and a new node wants to join, the DHT pings the oldest node — if it's still alive, the new node is discarded. This biases toward long-lived nodes, which are more likely to stay online.

```
Your node ID: 1010 0011 ...

Bucket 0: Nodes differing at bit 1 (0xxx xxxx ...) — far away, up to 20 nodes
Bucket 1: Nodes differing at bit 2 (11xx xxxx ...) — closer, up to 20 nodes
Bucket 2: Nodes differing at bit 3 (100x xxxx ...) — closer still
...
Bucket 7: Nodes differing at bit 8 (1010 0010 ...) — very close, up to 20 nodes
```

The key property: every node knows *more* about its neighborhood than about distant parts of the network. Bucket 0 covers half the keyspace but holds just 20 nodes. Bucket 7 covers 1/256th of the keyspace but also holds up to 20 nodes. This logarithmic compression is what makes Kademlia scale — a node with 20 entries per bucket can navigate a network of millions.

### How Lookups Work

When Alice wants to find peers on a topic, HyperDHT performs an **iterative lookup**:

1. Alice picks the `k = 20` closest nodes from her routing table to the topic
2. She sends parallel `LOOKUP` requests to 10 of them simultaneously (the DHT's internal routing queries use `FIND_NODE`; a topic query carries the topic as its target)
3. Each responding node returns its own closest nodes to the topic (from its routing table)
4. Alice merges these results, discovering nodes even closer to the target
5. On a repeat lookup — one that starts from the previous query's closest nodes — concurrency throttles to 3 until those first replies land, then reopens to 10
6. Repeat until no closer nodes are being discovered
7. The query converges on the 20 nodes in the entire network that are closest to the topic

```mermaid
graph TD
    A["Alice's Node"] -->|"Query 10 in parallel"| N1["Node A<br/>distance: 42"]
    A --> N2["Node B<br/>distance: 38"]
    A --> N3["Node C<br/>distance: 51"]

    N1 -->|"Returns closer nodes"| N4["Node D<br/>distance: 12"]
    N2 -->|"Returns closer nodes"| N5["Node E<br/>distance: 8"]
    N3 -->|"Returns closer nodes"| N4

    N4 -->|"Returns closest"| N6["Node F<br/>distance: 3"]
    N5 -->|"Returns closest"| N6
    N6 -->|"Has announcements!"| RESULT["Peer records for topic"]

    style A fill:#22272e,stroke:#539bf5,color:#e6edf3
    style RESULT fill:#22272e,stroke:#57ab5a,color:#e6edf3
    style N6 fill:#22272e,stroke:#986ee2,color:#e6edf3
```
*Figure 1: Iterative Kademlia lookup. Each round discovers closer nodes. Parallel queries accelerate convergence.*

Lookups scale as `O(log n)` — for a network of 10,000 nodes, the theoretical bound is about 13 sequential steps. In practice, because queries run in parallel and the routing table already contains nearby nodes, a lookup settles well short of that bound.

---

## Topics: The DHT's Addressing Scheme

A **topic** is a 32-byte buffer — any 256-bit value. The DHT stores records at the 20 nodes closest to a given topic. Peers who want to find each other choose a shared topic and rendezvous there.

> **Gotcha:** `swarm.join(topic)` expects a `Buffer` of exactly 32 bytes. Pass a string — even a hex one — and `join()` throws, but with an unhelpful `TypeError` about `byteLength` rather than anything naming the topic. Pass a buffer that is *too short* and `join()` still hands you a session, but the announce never lands: the request copies your short buffer into a fixed 32-byte target slot and leaves the rest as whatever that allocation held, so the node asked to store the record verifies the signature against the padded target — which is not what you signed. It drops the request without replying, the announce times out, `flushed()` resolves `false`, and peers never find each other. A buffer *longer* than 32 bytes is worse still: it takes the process down with an uncaught `RangeError` from the query decoder. That `false` is the only clue you get. Derive topics deterministically: `crypto.hash(Buffer.from('my-app:my-room'))` — always 32 bytes — or reuse a Hypercore's `discoveryKey`.

For Hypercore replication, the topic is the **discovery key** — a keyed BLAKE2b hash of the Hypercore's key (from <a href="part-3-hypercore-merkle.md">Part 3</a>):

```
discoveryKey = BLAKE2b-256(data = "hypercore", key = core.key)
```

The core key is the BLAKE2b **key** (the keyed-hash parameter), and the string `"hypercore"` is the **data** being hashed. That is `core.key` — the manifest hash, not the Ed25519 signing key — so hashing the signing key gives you a topic nobody is announcing on. Only someone who already knows the core key can compute the discovery key; the hash is keyed to the identity.

This one-way derivation is critical for privacy. When you join a topic on the DHT, every routing node along the path sees the topic hash. If the topic were the raw core key, observers could learn which Hypercores you're interested in — and since that key is what lets you verify the signatures authenticating the Hypercore, your traffic patterns would reveal your data interests. With the discovery key, observers see only an opaque hash. You must already know the core key to compute the discovery key and find peers.

> **Key Insight:** Discovery keys separate *findability* from *access*. The DHT enables finding peers, but doesn't grant read access to the data. A node routing your lookup query learns *that* you're looking for something, but not *what* that something is. This is a meaningful privacy win over systems where the content hash is the lookup key.

### Announce and Lookup

Two operations make the DHT useful for peer discovery:

**Announce** — "I have this data, and here's how to reach me."

```js
const stream = node.announce(topic, keyPair, relayAddresses)
```

The node performs a lookup to find the 20 closest nodes to the topic, then stores a signed announcement at each of them. The announcement includes:

- The announcer's **public key** (for the Noise handshake)
- Up to **3 relay addresses** (for holepunch signaling — these coordinate the NAT traversal, not data relay)
- A **cryptographic signature** proving keypair ownership (prevents impersonation)

Announcements have a two-phase structure: first find the closest nodes (with round-trip token collection), then commit the announcement with tokens proving you previously contacted each DHT node (preventing forged announcements from spoofed addresses).

**Lookup** — "Who has this data?"

```js
const stream = node.lookup(topic)
for await (const result of stream) {
  // result.peers = [{ publicKey, relayAddresses }]
}
```

The query walks the routing table toward the topic, collecting announcement records from nodes along the way. Each result yields the announcing peer's public key and relay addresses — everything needed to initiate a connection.

---

## Hyperswarm: From DHT to Connections

<!-- vg:hyperswarm/topic-swarms -->

<a href="https://github.com/holepunchto/hyperswarm" target="_blank">Hyperswarm</a> wraps HyperDHT with connection lifecycle management. While HyperDHT handles the raw DHT operations, Hyperswarm handles the orchestration: when to search, when to connect, how to deduplicate, and when to retry.

### Joining a Topic

```js title="hyperswarm-join.js"
const Hyperswarm = require('hyperswarm')
const crypto = require('hypercore-crypto')

const swarm = new Hyperswarm()

// Derive a topic from a Hypercore's core key (core.key, not the signing public key)
const topic = crypto.discoveryKey(someCoreKey)

// Join as both server and client
const discovery = swarm.join(topic, { server: true, client: true })
await discovery.flushed() // Wait for initial announce + lookup to complete
```

The `server` and `client` flags control two independent behaviors:

| Mode | What It Does | DHT Operation | Who Connects |
|---|---|---|---|
| **Server** | Announces your keypair on the topic | `dht.announce()` | Others find and connect *to you* |
| **Client** | Searches the DHT for peers on the topic | `dht.lookup()` | You find and connect *to others* |
| **Both** (default) | Announces and searches simultaneously | Both | Bidirectional discovery |

Server mode creates a persistent presence on the DHT — periodic re-announcements (roughly every 10 minutes with jitter) keep your record fresh as DHT nodes churn. Client mode performs a one-time sweep (plus periodic refreshes) and queues discovered peers for connection.

> **Gotcha:** Server-side connections don't carry topic information. When Bob accepts an incoming connection, he doesn't know *which* topic Alice used to find him. Only client-side connections have the `peerInfo.topics` array. If your application needs to know the topic context, design the application-level handshake to exchange it (via a Protomux channel's handshake data, for example).

### Connection Deduplication

If you join 5 topics and discover the same peer on 3 of them, you don't get 3 connections. Hyperswarm enforces **single-connection-per-peer** semantics.

When a duplicate connection is detected:
1. If the existing connection has already exchanged data in both directions (`rawBytesRead > 0 && rawBytesWritten > 0`), the new connection wins — the peer must have lost the old one and is reconnecting
2. Otherwise, a deterministic tiebreaker — comparing public keys with `Buffer.compare()` — decides which side keeps the connection
3. The loser is destroyed with a `Duplicate connection` error
4. The winning connection's `peerInfo.topics` accumulates all relevant topics

This is why Protomux (from <a href="part-2-encrypted-pipes.md">Part 2</a>) is essential. One encrypted connection carries all protocol channels for all shared topics. Without multiplexing, one connection per peer wouldn't be enough — you'd need one per Hypercore.

### The Connection Event

```js title="hyperswarm-connection.js"
swarm.on('connection', (socket, peerInfo) => {
  // socket: encrypted NoiseSecretStream (Duplex)
  // Already authenticated — Noise handshake completed

  console.log('Peer:', peerInfo.publicKey.toString('hex').slice(0, 8))
  console.log('Topics:', peerInfo.topics.length)   // Client-side only
  console.log('Client?', peerInfo.client)           // true = we initiated

  // Replicate a Corestore over this connection
  store.replicate(socket)
})
```

By the time the `connection` event fires, the full pipeline from <a href="part-1-nat-holepunching.md">Part 1</a> and <a href="part-2-encrypted-pipes.md">Part 2</a> has already executed: the Noise handshake (relayed through DHT nodes, before any direct path exists), NAT traversal, and session key derivation. Because the dialling peer already knows the server's public key — that's what it looked up — HyperDHT uses the **IK** pattern here rather than the XX pattern a stream negotiates when the peers are strangers. The socket is an encrypted Duplex stream ready for application data.

---

## Persistent Peers: joinPeer

Topic-based discovery is great when you don't know who has the data. But sometimes you *do* know — you want to stay connected to a specific peer regardless of topics.

```js title="hyperswarm-joinpeer.js"
// Connect to a specific peer by their Noise public key
swarm.joinPeer(bobPublicKey)

// Stop pursuing this peer
swarm.leavePeer(bobPublicKey)
```

`joinPeer()` marks a peer as **explicit** — Hyperswarm will connect immediately and reconnect automatically if the connection drops. No topic required. This is how applications maintain stable connections to known collaborators (like co-authors in a shared document) even through network disruptions.

Explicit peers are retried with increasing backoff delays on failure, and the swarm continues attempting to connect until `leavePeer()` is called.

---

## The Full Peer Lifecycle

Here's the complete journey from "I want that data" to "I'm replicating it":

```mermaid
sequenceDiagram
    participant App as Application
    participant SW as Hyperswarm
    participant DHT as HyperDHT
    participant Net as Network (NAT)
    participant Peer as Remote Peer

    App->>SW: swarm.join(topic, { server: true, client: true })
    SW->>DHT: announce(topic, keyPair)
    SW->>DHT: lookup(topic)
    DHT-->>SW: Peer records (publicKey + relays)
    SW->>SW: Dedup check + firewall check
    SW->>DHT: connect(remotePublicKey)
    DHT->>Peer: Noise IK handshake (relayed via DHT node)
    Peer-->>DHT: Handshake reply + session keys
    DHT->>Net: Holepunch / direct / relay
    Net-->>DHT: UDP path established, encrypted stream starts
    DHT-->>SW: NoiseSecretStream
    SW-->>App: 'connection' event (socket, peerInfo)
    App->>Peer: store.replicate(socket)
    Note over App,Peer: Protomux channels open per Hypercore
```
*Figure 2: The full peer lifecycle — from topic join to Hypercore replication.*

Each stage can fail independently — the DHT lookup might find no peers, holepunching might fail and fall back to relay, the firewall callback might reject the peer. Hyperswarm handles these failures with retries and fallbacks so the application only sees the final result: a working connection or a timeout.

### Configuration Knobs

```js
const swarm = new Hyperswarm({
  maxPeers: 64,         // Stops *dialling out* past this many connections (default);
                        // inbound connections are still accepted
  maxParallel: 3,       // Concurrent connection attempts (default)
  maxClientConnections: Infinity,
  firewall (remotePublicKey, payload) {
    // Return true to reject, false to accept
    // payload contains the remote handshake data (null for client-side checks)
    return bannedKeys.has(remotePublicKey.toString('hex'))
  }
})
```

The `firewall` callback executes synchronously during connection negotiation — before resources are allocated. It receives the remote peer's Noise public key and handshake payload, letting you implement allowlists, blocklists, or any custom access control logic.

---

## How Discovery Connects to Replication

Discovery and replication are deliberately separate layers. Discovery answers "who's out there?" Replication answers "what data do we exchange?" The connection between them is the Corestore replication call:

```js title="discovery-to-replication.js"
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')

const store = new Corestore('./my-storage')
const swarm = new Hyperswarm()

// Open a Hypercore (from Part 4's Corestore)
const core = store.get({ name: 'my-data' })
await core.ready()

// Join its discovery key as a topic
swarm.join(core.discoveryKey, { server: true, client: true })

swarm.on('connection', (socket) => {
  // Replicate ALL cores in the store over this single connection
  store.replicate(socket)
})

// Wait for the topic to be fully announced
await swarm.flush()
```

When `store.replicate(socket)` is called, Corestore wraps the encrypted socket in a Protomux instance. For each Hypercore currently open in the store, it opens a Protomux channel with protocol `hypercore/alpha` and the Hypercore's discovery key as the channel ID. The remote side's Corestore does the same. Channels pair automatically when both sides know the same Hypercore — and a core that's on disk but not open yet gets opened on demand when the other side asks for it.

This is why a single connection can serve dozens of Hypercores — each gets its own Protomux channel with independent replication state, all multiplexed over the one encrypted stream from <a href="part-2-encrypted-pipes.md">Part 2</a>.

> **Feynman Moment:** There's a subtlety in how existing Hypercores propagate across connections. When Alice replicates a Corestore with Bob, and Bob starts replicating a Hypercore that Alice has in her local storage but hasn't opened yet, Bob opens a Protomux channel for it. Alice's Corestore sees the discovery key, finds the matching core in storage, loads it, and joins the channel. The replication is reactive — neither side needs to coordinate "let's sync core X now." The Protomux channel pairing handles it automatically. Note: Corestore only auto-loads cores it already knows about — it won't create a brand new core just because a peer announced an unknown discovery key. This is what makes multi-core systems like Hyperdrive (Part 4) and Autobase (Part 6) work seamlessly.

---

## Bootstrap and Network Entry

A new node joining the DHT needs at least one known address to start. HyperDHT ships with three public bootstrap nodes:

```
node1.hyperdht.org:49737
node2.hyperdht.org:49737
node3.hyperdht.org:49737
```

The bootstrap process:

1. **Connect** to bootstrap nodes and exchange routing information
2. **Discover** your own public IP and port (bootstrap nodes report how they see you)
3. **Populate** your routing table from bootstrap responses (still ephemeral: you use the DHT but hold no place in it)
4. **Transition** from ephemeral to persistent mode after ~20 minutes on a stable, reachable address
5. **Compute** your node ID at that moment: `BLAKE2b(publicIP + publicPort)` — the address has to be proven before it can decide your position in the keyspace

For private networks (testing, corporate deployments), run your own bootstrap node with `DHT.bootstrapper(port, host)` and point other nodes at its address. The `port` and `host` you pass must be the ones the network can actually reach you on — that pair *is* the node's ID, which is why this shortcut exists: a plain `new DHT({ bootstrap: [] })` node has nobody to learn its own address from, so it stays ephemeral forever and answers no announces or lookups.

---

## The Tradeoffs

| What You Gain | What You Pay |
|---|---|
| Fully decentralized peer discovery — no single point of failure | DHT lookups take seconds, not milliseconds (multiple network round-trips) |
| Topic-based rendezvous without central coordination | 32-byte topic must be shared out-of-band (or derived from a known key) |
| Connection deduplication across topics | Server-side connections lack topic context |
| Automatic reconnection via `joinPeer()` | Reconnection backoff adds latency after disconnection |
| Privacy via discovery keys (observers can't infer content) | DHT routing nodes see *that* you're searching, just not *what* for |
| Single encrypted connection serves all Hypercores | Connection setup cost is amortized — but the first connection is slow |
| 20-minute ephemeral period resists Sybil attacks | New nodes can't serve DHT queries immediately |

---

## Key Takeaways

- **HyperDHT implements Kademlia with k=20 buckets, XOR distance, and iterative parallel lookups.** Queries run 10 requests in parallel; a repeat lookup throttles to 3 while it waits on the nodes that were closest last time, then reopens. A lookup converges in a few round-trips, even in networks of thousands of nodes.

- **Topics are 32-byte buffers — typically Hypercore discovery keys.** `announce(topic)` stores a signed record at the 20 closest nodes. `lookup(topic)` retrieves those records. The discovery key's one-way derivation hides which Hypercore you're interested in.

- **Hyperswarm wraps HyperDHT with connection lifecycle management.** `join(topic)` handles announcement, lookup, connection, deduplication, and retry. A single connection per peer serves all shared topics via Protomux channels.

- **Server mode announces; client mode searches.** Server-side connections don't carry topic information. Client-side connections include the topics array. Most applications use both modes simultaneously.

- **`joinPeer()` provides persistent, topic-independent connections.** Hyperswarm reconnects automatically, backing off through a fixed ladder — roughly 1s, 5s, 15s, then every 10 minutes — until you call `leavePeer()`. Use this for known collaborators who should always be connected.

- **Discovery feeds into replication through Corestore.** `store.replicate(socket)` opens Protomux channels for every Hypercore currently open in the store. Cores a peer asks for that are already in local storage are loaded and joined automatically; an unknown discovery key is ignored.

---

## Frequently Asked Questions

### How does a DHT find peers?
The DHT routes queries through nodes that are progressively closer (in XOR distance) to the target, converging in O(log n) hops. Starting with the closest known nodes, each queried node returns nodes even closer to the target. After a few rounds of parallel queries, the lookup arrives at the nodes responsible for the topic.

### What is the XOR distance in Kademlia?
XOR distance is a bitwise operation that measures how "far apart" two node IDs are in the 256-bit keyspace. It is symmetric (distance A to B equals distance B to A) and satisfies the triangle inequality. Nodes that share more leading bits in their IDs are "closer" in XOR distance.

### What is a discovery key?
A discovery key is a one-way hash of a Hypercore's key (specifically, `BLAKE2b-256(data="hypercore", key=core.key)`, where `core.key` is the manifest hash rather than the Ed25519 signing key) that enables peer discovery without revealing what data you're looking for. Observers on the DHT see the opaque hash but cannot reverse it to determine which Hypercore is being replicated.

---

## What's Next

We can find peers, connect securely, and replicate data. But everything so far has been **single-writer** — one keypair signs one Hypercore, and everyone else is a reader.

In <a href="part-6-autobase-consensus.md">Part 6</a>, we'll tackle the hardest problem in distributed systems: multiple writers. Autobase takes multiple independent Hypercores — each written by a different peer — and linearizes them into a single, consistent view using causal ordering and quorum consensus. This is where P2P applications go from "read-only mirrors" to "collaborative systems."

[heartit_lab title="p2p-swarm-watch" cmd="npx @heart-it/p2p-swarm-watch swordfish" desc="A swarm observatory: announcing, dialing, churn, reconnects — leave it open and watch other readers come and go." repo="https://github.com/heart-IT/p2p-from-scratch-labs" note="needs Node.js 18+ · every reader on this phrase shows up"]

---

## References & Further Reading

1. <a href="https://github.com/holepunchto/hyperdht" target="_blank">holepunchto/hyperdht — DHT with keypair-authenticated connections and NAT traversal</a>
2. <a href="https://github.com/holepunchto/hyperswarm" target="_blank">holepunchto/hyperswarm — High-level peer discovery and connection management</a>
3. <a href="https://github.com/holepunchto/dht-rpc" target="_blank">holepunchto/dht-rpc — Low-level Kademlia DHT with Sybil-resistant node IDs</a>
4. <a href="https://pdos.csail.mit.edu/~petar/papers/maymounkov-kademlia-lncs.pdf" target="_blank">Kademlia: A Peer-to-Peer Information System Based on the XOR Metric (2002)</a>
5. <a href="https://github.com/holepunchto/hypercore-crypto" target="_blank">holepunchto/hypercore-crypto — Discovery key generation (BLAKE2b)</a>
6. <a href="https://github.com/holepunchto/corestore" target="_blank">holepunchto/corestore — Multi-Hypercore management (from Part 4)</a>
7. <a href="https://github.com/holepunchto/protomux" target="_blank">holepunchto/protomux — Protocol multiplexing (from Part 2)</a>
8. <a href="https://en.wikipedia.org/wiki/Kademlia" target="_blank">Wikipedia — Kademlia</a>
9. <a href="https://docs.pears.com/" target="_blank">Pear Runtime Documentation</a>

---

> **Series: P2P from Scratch — Building on the Holepunch Stack**
> [Part 1: NAT Hole Punching Explained](part-1-nat-holepunching.md) | [Part 2: P2P Encryption with the Noise Protocol](part-2-encrypted-pipes.md) | [Part 3: Merkle Trees and Append-Only Logs](part-3-hypercore-merkle.md) | [Part 4: Building P2P Databases with Hyperbee and Hyperdrive](part-4-hyperbee-hyperdrive.md) | **Part 5: Peer Discovery with Kademlia DHT (You are here)** | [Part 6: Multi-Writer Consensus with Autobase](part-6-autobase-consensus.md) | [Part 7: P2P Security — Threats, Defenses, and Trust](part-7-security-trust.md) | [Part 8: Offline-First UX for P2P Applications](part-8-ux-production.md)
