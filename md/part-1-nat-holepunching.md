# P2P from Scratch — Part 1: NAT Hole Punching Explained

> "The Internet was done so well that most people think of it as a natural resource like the Pacific Ocean, rather than something that was man-made. When was the last time a technology with a scale like that was so error-free?"
> — Alan Kay

**Excerpt:** You want two computers to talk directly to each other. No server in the middle, no middleman, no monthly bill. Sounds simple — the Internet is a network, after all. But the moment you try it, you discover something uncomfortable: the Internet was never designed for this. Here's why, and how Hyperswarm punches through anyway.
<!-- meta-description: Learn how NAT hole punching works and how Hyperswarm establishes direct P2P connections through firewalls. Step-by-step with code examples. -->
<!-- meta-labs: p2p-hello p2p-path -->

<!-- Series Navigation -->
> **Series: P2P from Scratch — Building on the Holepunch Stack**
> **Part 1: NAT Hole Punching Explained (You are here)** | [Part 2: P2P Encryption with the Noise Protocol](part-2-encrypted-pipes.md) | [Part 3: Merkle Trees and Append-Only Logs](part-3-hypercore-merkle.md) | [Part 4: Building P2P Databases with Hyperbee and Hyperdrive](part-4-hyperbee-hyperdrive.md) | [Part 5: Peer Discovery with Kademlia DHT](part-5-dht-discovery.md) | [Part 6: Multi-Writer Consensus with Autobase](part-6-autobase-consensus.md) | [Part 7: P2P Security — Threats, Defenses, and Trust](part-7-security-trust.md) | [Part 8: Offline-First UX for P2P Applications](part-8-ux-production.md)

---

> **Verified against:** hyperdht 6.33.2 · dht-rpc 6.27.0 · hyperswarm 4.17.0 — checked 2026-09-03. Every constant, default and byte count in this post is asserted in [`verify/`](https://github.com/heart-IT/p2p-from-scratch-labs/tree/main/verify), which installs whatever Holepunch publishes today and fails if the stack has moved.

## The NAT Problem: Why Your Computer Isn't Reachable

Here's something that should bother you: your laptop is connected to the Internet right now, but nobody can reach it. This is why NAT hole punching exists — and why it's the first problem any P2P system must solve.

Try it. Find your IP address. It's probably something like `192.168.1.47`. Now ask a friend on a different Wi-Fi network to send a packet to `192.168.1.47`. Nothing happens. That address means nothing outside your home.

The IP address the rest of the world sees — the one your ISP gave your router — belongs to your *router*, not your laptop. And your router has no idea which of the dozens of devices behind it you're trying to reach. Worse, in many countries your ISP doesn't even give your router a real public IP. They put your router behind *their own* router, so you're behind two layers of address translation.

This is <a href="https://en.wikipedia.org/wiki/Network_address_translation" target="_blank">Network Address Translation</a> — NAT — and it's the reason peer-to-peer connectivity is hard.

> **Terminology:** **NAT** (Network Address Translation) is a technique where a router rewrites the source IP address of outbound packets and maintains a mapping table so it can route responses back to the correct internal device. It was designed to conserve IPv4 addresses, not to enable direct communication.

Every time you visit a website, your router creates a temporary mapping: "outgoing traffic from `192.168.1.47:52301` should appear as `203.0.113.5:41928` to the outside world." When the website responds to `203.0.113.5:41928`, the router checks its table, finds the mapping, and forwards the response to your laptop.

This works perfectly for client-server communication. You always initiate the connection. The server always has a fixed public address. The router's mapping table always has the right entry.

But what if there's no server? What if two laptops, both behind NATs, want to talk to each other?

Neither one has a public address. Neither router has a mapping entry for the other. Any packet sent to either router from an unknown source gets silently dropped.

This is the fundamental problem of peer-to-peer networking. It's not a software bug — it's a consequence of address translation and stateful firewalling.

---

## The Mental Model: Two People in Soundproof Rooms

Imagine two people, Alice and Bob, each in a soundproof room with a locked door. The door only opens from the inside, and only for a few seconds. Neither person can hear the other through the walls.

They want to have a conversation.

If Alice opens her door and shouts, but Bob's door is still closed — he hears nothing. If Bob opens his door a minute later and shouts, Alice's door has already closed — she hears nothing. They could each open their doors a thousand times and never connect.

But if someone *outside* both rooms — a coordinator — passes each of them a note saying "open your door in exactly 10 seconds," and they both do it at the same moment, their voices travel through both open doors and they connect.

That coordinator is the role a <a href="https://github.com/holepunchto/hyperdht" target="_blank">DHT</a> (distributed hash table) plays in peer-to-peer networking. The soundproof room is your NAT. The door opening is your router creating a mapping entry. The simultaneous timing is the critical requirement.

> **Feynman Moment:** Here's where the analogy breaks — and where the real engineering begins. In the real world, "opening the door" doesn't just mean creating a NAT mapping. Different routers create mappings with wildly different rules. Some routers assign the same external port no matter who you're talking to. Others assign a different external port for every destination. Some allow any outside address to send traffic through the mapping. Others only allow the specific address you originally contacted. These differences aren't edge cases — they're the entire battlefield.

---

## How NATs Actually Work (The Four Behavioral Classes)

Not all NATs are created equal. The way your router creates and filters its mapping table determines whether holepunching can work at all.

> **Terminology:** **NAT Mapping** is the entry your router creates in its translation table when an internal device sends a packet. It links your internal IP:port to an external IP:port and governs what traffic can flow back through.

| NAT Type | Mapping Behavior | Inbound Filtering | Holepunch Friendly? |
|---|---|---|---|
| **Full Cone** | Same external port for all destinations | Any source allowed through | Yes — easiest |
| **Restricted Cone** | Same external port for all destinations | Only IPs you've contacted | Yes — with coordination |
| **Port Restricted** | Same external port for all destinations | Only IP:port pairs you've contacted | Yes — with precise timing |
| **Symmetric** | Different external port per destination IP:port | Only the specific destination | No — the port can't be read off one sample |

The key question for holepunching is whether the external port is predictable:

```mermaid
graph LR
    subgraph "Predictable Port (Holepunchable)"
        FC["Full Cone<br/>Any source allowed"]:::green
        RC["Restricted Cone<br/>IP must match"]:::green
        PR["Port Restricted<br/>IP:port must match"]:::green
    end

    subgraph "Unpredictable Port (Punchable only against a predictable peer)"
        SYM["Symmetric<br/>Different port per destination"]:::red
    end

    FC --- RC --- PR

    classDef green fill:#22272e,stroke:#57ab5a,color:#e6edf3
    classDef red fill:#22272e,stroke:#e5534b,color:#e6edf3
```

*Figure 1: The NAT classification from a holepunching perspective. The first three types share a critical property — predictable external ports — that makes them holepunchable. Symmetric NAT assigns unpredictable ports: one symmetric side can still be brute-forced, but two symmetric sides leave nothing to aim at, and only a relay can join them.*

HyperDHT doesn't classify by RFC name at all — it measures. **OPEN** means your listening port answered a cold probe from DHT nodes (a public IP or a port-forward — no coordination needed). **CONSISTENT** means the samples converged on an address worth aiming at — three sightings of one external `ip:port`, or two sightings each of two different ones (predictable — coordination required). **RANDOM** means they didn't: no address repeated often enough to be worth a punch (symmetric — punchable only if the other side is consistent).

> **Note on terminology:** The four names above (Full Cone, Restricted Cone, Port Restricted, Symmetric) come from <a href="https://www.rfc-editor.org/rfc/rfc3489" target="_blank">RFC 3489</a> (2003). The later <a href="https://www.rfc-editor.org/rfc/rfc4787" target="_blank">RFC 4787</a> (2007) replaces this with a two-axis model — *mapping behavior* (Endpoint-Independent / Address-Dependent / Address-and-Port-Dependent) × *filtering behavior* — which better captures real-world NATs that don't fit neatly into one of four boxes. Internally, HyperDHT uses a measured classification — **OPEN**, **CONSISTENT** (predictable port mapping), and **RANDOM** (unpredictable), plus **UNKNOWN** until a handful of DHT nodes have reported what they saw — which maps to what matters for holepunching: can you predict the port or not?

The first three types share a critical property: the external port stays the same regardless of destination. If your laptop sends a packet to server A and gets mapped to external port `41928`, it also uses port `41928` when talking to server B. This consistency is what makes holepunching possible — a coordinator can observe the port from one connection and tell a peer to aim at that same port.

Symmetric NAT breaks this entirely. Every new destination gets a fresh external port, and symmetric NATs typically combine this with address-and-port-dependent filtering — so neither the mapping nor the filter can be worked out from a single observation. A coordinator can observe the port your router assigned when talking to the DHT, but that port is useless for connecting to another peer — the router will assign a completely different one.

> **Key Insight:** Holepunching is fundamentally about *port prediction*. If the coordinator can predict what external port your router will use, peers can aim their packets at it. Symmetric NAT takes that single observation away — the port the DHT saw tells you nothing about the port your peer will get — and HyperDHT doesn't try to extrapolate it, so it stops predicting and starts guessing: the predictable side sprays packets at random ports (about 1,750 of them, 20 ms apart) while the symmetric side opens 256 sockets, and the birthday paradox makes a collision near-certain inside ~35 seconds.

---

## How UDP Hole Punching Works Step by Step

<!-- vg:hyperswarm/nat-hole-punching -->

Let's walk through what <a href="https://github.com/holepunchto/hyperswarm" target="_blank">Hyperswarm</a> does when two peers want to connect. This isn't abstract protocol theory — this is what happens on your network right now.

### Step 1: Both Peers Join the DHT

Both Alice and Bob connect to <a href="https://github.com/holepunchto/hyperdht" target="_blank">HyperDHT</a> — a Kademlia-based distributed hash table. This establishes their presence in the network and — critically — creates NAT mappings. The DHT nodes can now observe each peer's external IP and port.

### Step 2: Signaling via DHT Nodes

Alice wants to connect to Bob. She finds Bob's announcement in the DHT and sends a connection request. But she doesn't send it directly to Bob — she can't, because Bob's NAT would drop it. Instead, she sends it to DHT nodes that are closest to Bob's announcement.

This is a key design choice: Hyperswarm doesn't rely on external STUN/TURN servers like WebRTC does. Instead, the DHT nodes handle signaling — NAT type detection (STUN's role) and holepunch coordination. If holepunching fails and you've told the swarm which peer to fall back to, a separate mechanism kicks in: **blind relays** (any willing peer, not DHT nodes specifically) relay the data (TURN's role). The protocol is different, but the jobs are the same. No single company controls the infrastructure.

### Step 3: The Simultaneous Send

The relay delivers Alice's intent to Bob. Now both peers know about each other's external address (IP + port, as observed by the DHT). Both peers simultaneously send UDP packets toward each other's external address.

Here's the critical moment: when Alice sends a packet to Bob's external address, *Alice's* router creates a mapping entry that says "I'm expecting a response from Bob's IP." When Bob's packet arrives at Alice's router — from Bob's IP — the router matches it against the fresh mapping and lets it through.

The same thing happens on Bob's side. Both doors open at the same moment. The hole is punched.

```mermaid
sequenceDiagram
    participant A as Alice (behind NAT)
    participant AR as Alice's Router
    participant DHT as DHT Signaling Node
    participant BR as Bob's Router
    participant B as Bob (behind NAT)

    A->>DHT: 1. "I want to connect to Bob"
    DHT->>B: 2. "Alice wants to connect" (relayed)
    Note over DHT: DHT shares external addresses

    A->>BR: 3. UDP packet → Bob's external addr
    Note over AR: Alice's NAT creates mapping
    B->>AR: 3. UDP packet → Alice's external addr
    Note over BR: Bob's NAT creates mapping

    Note over AR,BR: Both NATs now have mappings for each other

    B-->>AR: 4. Packet arrives, matches mapping ✓
    AR-->>A: 4. Forwarded to Alice
    A-->>BR: 4. Packet arrives, matches mapping ✓
    BR-->>B: 4. Forwarded to Bob

    Note over A,B: Direct P2P connection established
```
*Figure 2: The holepunching dance. Both peers must send before either receives.*

> **Implementation detail:** The diagram above shows the logical flow. In practice, HyperDHT sends multiple probe rounds with retries — the first packets sent to an unopened NAT mapping are expected to be dropped. The holepunch succeeds when at least one packet from each side arrives *after* the other side's outbound packet has created the necessary mapping. This is why timing coordination matters more than single-packet delivery.

> **Note:** All of this refers to **UDP holepunching**. Hyperswarm uses UDP for the holepunch dance because UDP NAT mappings are simpler and more predictable. TCP holepunching is harder — it needs a simultaneous open, and a SYN that arrives before the other side has sent its own can be dropped or answered with a RST, killing the attempt (RFC 5128 §3.4). This is why Hyperswarm establishes the UDP path first and then upgrades it to a reliable, encrypted stream.

### Step 4: Encrypted Stream

The keys were agreed before the first punch packet flew — the Noise IK handshake rode inside the DHT signaling messages. So the moment the UDP path opens, Hyperswarm runs a reliable, ordered stream over it with <a href="https://github.com/holepunchto/libudx" target="_blank">libudx</a> and encrypts it with Secret Stream, which uses <a href="https://doc.libsodium.org/secret-key_cryptography/secretstream" target="_blank">libsodium's secretstream</a> underneath. We'll cover this in detail in <a href="part-2-encrypted-pipes.md">Part 2</a>.

> **Gotcha:** The timing requirement isn't just "roughly at the same time." HyperDHT gives each punch a short budget — about ten probes a second apart, and before that a 10-second deadline for the relayed handshake to get both sides punching at all — far shorter than a NAT mapping's lifetime (at least two minutes per RFC 4787). If the DHT node relaying the signal is slow, Bob's packets arrive after Alice's probes have stopped, and the attempt is abandoned. Connection failures that look like "peer unreachable" are often timing desynchronization in disguise.

---

## When the Dance Fails: Symmetric NAT and Relay Fallback

Holepunching works when at least one side has a predictable port mapping. If Alice is behind a symmetric NAT but Bob is behind a cone or restricted NAT, Bob's external port is still predictable — so Alice can open mappings toward it. Bob can't know which port Alice's NAT picked, so HyperDHT brute-forces it: Alice opens 256 sockets, each punching a fresh mapping toward Bob, and Bob sprays packets at random ports on Alice's address until one lands in a mapping — the birthday paradox makes that near-certain within about 35 seconds. One predictable side is enough.

Relay is unavoidable when **both** peers are behind randomized (symmetric) NATs. Neither side can predict the other's port, so there's no target to aim at: HyperDHT re-samples its own NAT up to three times hoping for a consistent reading, then aborts without ever sending a punch packet. A relay also rescues the rarer failures — a punch that times out, or a peer that declines to punch.

Hyperswarm handles this with **blind relays**. If a connection cannot be established for whatever reason, it supports passing the traffic through another peer as a relay. Any peer can be a blind relay if they want, allowing powerful topologies to be built.

| Scenario | NAT A | NAT B | Method | Result |
|---|---|---|---|---|
| Best case | Full Cone | Full Cone | Direct holepunch | Low latency, direct path |
| Common case | Restricted | Port Restricted | Coordinated holepunch | Slightly higher latency |
| One-sided | Symmetric | Restricted | Direct holepunch | Works — B's port is predictable |
| Worst case | Symmetric | Symmetric | Relay (if you configured one) | Neither side has a port the other can aim at — no relay, no connection |

Direct punching needs only one predictable side, so the pairs that fail are the ones where both sides are randomized. How often that happens is a property of the networks your users sit on, not a fixed rate: symmetric NATs cluster in places like corporate LANs, so two peers inside one of those are far likelier to need a relay than two peers on home broadband. The application should handle both paths transparently.

> **Key Insight:** The fallback isn't a failure — it's a design requirement. A P2P system that doesn't account for symmetric NAT simply never connects those user pairs, and nothing in the failure says why. Hyperswarm makes the fallback automatic once you give it a relay: pass a blind-relay peer's public key as `relayThrough` when you create the swarm and failed punches are re-routed through it with no further code. Without one, a double-symmetric pair simply never connects.

---

## Beyond NAT: What Makes Hyperswarm's DHT Different

<!-- vg:hyperswarm/dht-peer-discovery -->

The DHT isn't just a signaling helper — it's the peer discovery layer, and it has its own engineering challenges.

### Sybil Resistance via Node ID Derivation

In a standard Kademlia DHT, nodes choose their own IDs. An attacker could generate thousands of IDs strategically positioned near a target, surrounding it with malicious nodes. This is a <a href="https://en.wikipedia.org/wiki/Sybil_attack" target="_blank">Sybil attack</a>.

<a href="https://github.com/holepunchto/dht-rpc" target="_blank">dht-rpc</a> prevents this by *deriving* node IDs from the node's network identity: `nodeID = hash(publicIP + publicPort)`. You can't choose your ID — the network determines it from your address. An attacker would need control of specific IP addresses to position themselves near a target in the keyspace.

This is one defense layer. Round-trip tokens prove IP ownership (preventing spoofing), and the ephemeral-to-persistent transition (described below) prevents rapid routing table pollution.

### The Ephemeral-to-Persistent Transition

New nodes don't immediately become permanent members of the DHT's routing tables. They start in **ephemeral mode** — participating in queries but not stored in other nodes' routing tables.

After 20 minutes of stable uptime (240 ticks × 5 seconds), the node checks itself: DHT nodes must agree on its external `ip:port`, and a cold probe to its listening port must get through. If that passes, it derives its node ID from that address and switches to **persistent mode**, taking a permanent position in the routing table. If it fails — the node is firewalled — it doesn't keep hammering: it caches the address it just tested and re-checks only once that external IP changes. A sleep/wake cycle clears the cache and restarts the clock at ~60 minutes.

This protects the DHT from short-lived nodes churning the routing tables and from attackers spinning up thousands of nodes to flood the network. If you're running a server on an open NAT, you can bypass this with `ephemeral: false`, but for consumer devices behind NATs, the transition period is a feature, not a limitation.

---

## The Tradeoffs: Nothing Is Free

Holepunching and DHT-based discovery solve the fundamental connectivity problem, but they come with costs.

| What You Gain | What You Pay |
|---|---|
| No central server dependency | Connection setup is slower (DHT lookup + holepunch negotiation) |
| No monthly infrastructure bill | Some connections need a relay peer you provide (mostly when both sides are on randomized NATs) |
| Resistant to single-point-of-failure | First connection takes seconds, not milliseconds |
| Works across ISPs and countries | Both-sides-symmetric connections get relay latency |
| DHT nodes are the infrastructure | ~20 minute warmup for new DHT nodes (~60 min after wake) |

The connection setup cost is a one-time tax. Once the hole is punched, the direct UDP path is as fast as any other Internet connection. But that initial negotiation — DHT lookup, signaling, simultaneous send, handshake — takes real time. Your UX needs to account for this (we'll cover P2P UX design in <a href="part-8-ux-production.md">Part 8</a>).

---

## In Practice: Watching It Happen

You can observe Hyperswarm's holepunching in action with a minimal script. Start with the bare essentials — join a topic:

```js title="holepunch-demo.js"
const Hyperswarm = require('hyperswarm')

// Both peers must join the same topic — a 32-byte buffer.
// Use a fixed value so both machines connect to the same swarm.
const topic = Buffer.from(
  'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  'hex'
)

const swarm = new Hyperswarm()
const discovery = swarm.join(topic, { server: true, client: true })
await discovery.flushed()
console.log('Announced on topic, waiting for peers...')
```

That's enough to join the DHT and announce yourself. Now add connection handling — when a peer is found, exchange a message:

```js title="holepunch-demo.js (complete)" {1-5}
swarm.on('connection', (conn, info) => {
  console.log('Connected to peer!', info.publicKey.toString('hex').slice(0, 8))
  conn.on('data', data => console.log('Received:', data.toString()))
  conn.write('Hello from ' + (process.argv[2] || 'anonymous'))
})
```

The complete script combines both pieces. Run it on two different machines — e.g., `node holepunch-demo.js Alice` on one and `node holepunch-demo.js Bob` on the other.

> **Note:** Most code examples in this series use `require()` with top-level `await` for clarity. To run them, either wrap the body in `(async () => { ... })()` or save with an `.mjs` extension and use `import` instead of `require`. The <a href="https://docs.pears.com/" target="_blank">Pear Runtime</a> is no different — its Bare runtime rejects `require()` and top-level `await` in the same file too, so pick one of the two forms above.

Because the topic is hardcoded, both peers discover each other automatically. You'll see the connection event and the data exchange. If only one side is symmetric, holepunching still works directly. If both peers are behind randomized (symmetric) NATs, this script never connects — Hyperswarm keeps retrying with backoff, but without a `relayThrough` peer there is no fallback and no `connection` event.

> **Gotcha:** If you run both peers on the same machine or the same LAN, you're not testing holepunching at all — you're testing local discovery. Real holepunching only happens across NAT boundaries. To test properly, use two different networks or a cloud VM as the second peer.

---

## Key Takeaways

- **NAT is the fundamental obstacle to P2P connectivity.** Your device doesn't have a reachable address. Your router drops unsolicited inbound packets. This isn't a bug — it's how the Internet was designed.

- **Holepunching is a timing dance.** Both peers must create outbound NAT mappings simultaneously so that each peer's inbound packet matches the other's fresh mapping. The DHT coordinates this timing.

- **Both-sides-symmetric always needs a relay.** If only one peer is behind a symmetric NAT, holepunching still works — the other side's port is predictable and the symmetric side is brute-forced. When both peers have randomized port mappings there is nothing to aim at, and only a relay you've configured can join them.

- **Hyperswarm's DHT is more than a phone book.** Node IDs derived from `hash(IP + port)` resist Sybil attacks. Ephemeral-to-persistent transitions resist routing table pollution. When direct connections fail, any willing peer can serve as a blind relay — the relay infrastructure is decentralized, not tied to DHT nodes.

- **Budget for relayed connections — and bring your own relay.** Direct punching needs only one predictable side, so the pairs that fail are the ones where both are randomized — concentrated wherever symmetric NATs are, like corporate networks. Hyperswarm only relays through a peer you name in `relayThrough`, so your architecture and UX must handle relayed connections as a first-class path, not an error state.

---

## Frequently Asked Questions

### What is NAT hole punching?
NAT hole punching is a technique for establishing direct connections between two devices that are both behind NAT routers. It works by having both peers simultaneously send UDP packets toward each other's external addresses, causing their routers to create mapping entries that allow the other peer's packets through.

### Why does UDP hole punching fail with symmetric NAT?
Symmetric NATs assign a different external port for every destination, so the port a coordinator saw is not the port your peer will need. A coordinator can observe the port your router assigned when talking to the DHT, but that port is useless for connecting to another peer because the router will assign a completely different one.

### Can you do peer-to-peer without a server?
You need at least a minimal coordination point (like DHT bootstrap nodes) to help peers discover each other and coordinate the holepunching dance. However, these bootstrap nodes are lightweight, replaceable, and don't control your data or connections. Once peers are connected, none of the traffic between them touches a bootstrap node — they only ever help you find your way back into the DHT.

### What is the difference between STUN and TURN?
STUN tells you the public address the outside world sees for your socket, which is what makes direct holepunching possible. (Classic STUN also tried to label your NAT type; RFC 5389 dropped that, because real NATs don't sort cleanly into the four boxes.) TURN relays data through an intermediary when direct connection fails. Hyperswarm's DHT nodes serve a similar role to STUN, while blind relays serve a similar role to TURN.

---

## What's Next

We've established that two peers can find each other and create a connection path — even through hostile network conditions. But a UDP path protects nothing on its own — left raw, anyone on the wire could read those packets, modify them, or inject fake ones. Hyperswarm never leaves it raw, and Part 1 skipped over how.

In <a href="part-2-encrypted-pipes.md">Part 2</a>, we'll look at how Hyperswarm turns that UDP path into an encrypted, multiplexed communication channel using the Noise protocol, Secret Stream, and Protomux. We'll see how a single encrypted connection carries multiple independent protocol channels — and why that matters when you start replicating data structures in Part 3.

[heartit_lab title="p2p-hello" cmd="npx @heart-it/p2p-hello swordfish" desc="Two terminals, one passphrase — watch the DHT introduce two strangers. Everything this series explains, you are about to watch happen." repo="https://github.com/heart-IT/p2p-from-scratch-labs" note="needs Node.js 18+ · every reader using this phrase meets the others"]

[heartit_lab title="p2p-path" cmd="npx @heart-it/p2p-path swordfish" desc="What the DHT knows about you — external address, firewall state, NAT class — then a timestamped timeline of the connection and an honest verdict on the path it took." repo="https://github.com/heart-IT/p2p-from-scratch-labs" note="needs Node.js 18+ · same phrase in two terminals"]

---

## References & Further Reading

1. <a href="https://github.com/holepunchto/hyperswarm" target="_blank">holepunchto/hyperswarm — High-level peer discovery and connection management</a>
2. <a href="https://github.com/holepunchto/hyperdht" target="_blank">holepunchto/hyperdht — DHT layer with keypair connections and NAT traversal</a>
3. <a href="https://github.com/holepunchto/dht-rpc" target="_blank">holepunchto/dht-rpc — Low-level Kademlia DHT with Sybil-resistant node IDs</a>
4. <a href="https://github.com/holepunchto/hyperswarm-secret-stream" target="_blank">holepunchto/hyperswarm-secret-stream — Noise handshake (IK inside Hyperswarm, XX standalone) + libsodium transport encryption</a>
5. <a href="https://en.wikipedia.org/wiki/Network_address_translation" target="_blank">Wikipedia — Network Address Translation</a>
6. <a href="https://www.rfc-editor.org/rfc/rfc4787" target="_blank">RFC 4787 — NAT Behavioral Requirements for Unicast UDP</a>
7. <a href="https://en.wikipedia.org/wiki/Hole_punching_(networking)" target="_blank">Wikipedia — Hole Punching (Networking)</a>
8. <a href="https://en.wikipedia.org/wiki/Sybil_attack" target="_blank">Wikipedia — Sybil Attack</a>
9. <a href="https://docs.pears.com/" target="_blank">Pear Runtime Documentation</a>

---

> **Series: P2P from Scratch — Building on the Holepunch Stack**
> **Part 1: NAT Hole Punching Explained (You are here)** | [Part 2: P2P Encryption with the Noise Protocol](part-2-encrypted-pipes.md) | [Part 3: Merkle Trees and Append-Only Logs](part-3-hypercore-merkle.md) | [Part 4: Building P2P Databases with Hyperbee and Hyperdrive](part-4-hyperbee-hyperdrive.md) | [Part 5: Peer Discovery with Kademlia DHT](part-5-dht-discovery.md) | [Part 6: Multi-Writer Consensus with Autobase](part-6-autobase-consensus.md) | [Part 7: P2P Security — Threats, Defenses, and Trust](part-7-security-trust.md) | [Part 8: Offline-First UX for P2P Applications](part-8-ux-production.md)
