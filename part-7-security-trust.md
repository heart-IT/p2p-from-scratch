# P2P from Scratch — Part 7: Trust No One, Verify Everything

> "Cryptography is typically bypassed, not penetrated."
> — Adi Shamir

**Excerpt:** The Holepunch stack is built on strong cryptography — Ed25519 signatures, BLAKE2b hashes, Noise XX handshakes. But cryptography alone doesn't make a system secure. Attackers don't break your ciphers — they poison your DHT, surround your node, or steal your keys. This post maps the full security model of the Holepunch stack: what's enforced in code, what's assumed by convention, and where the real attack surface lies.

<!-- Series Navigation -->
> **Series: P2P from Scratch — Building on the Holepunch Stack**
> [Part 1: The Internet is Hostile](part-1-nat-holepunching.md) | [Part 2: Encrypted Pipes](part-2-encrypted-pipes.md) | [Part 3: Append-Only Truth](part-3-hypercore-merkle.md) | [Part 4: From Logs to Databases](part-4-hyperbee-hyperdrive.md) | [Part 5: Finding Peers](part-5-dht-discovery.md) | [Part 6: Many Writers, One Truth](part-6-autobase-consensus.md) | **Part 7: Trust No One (You are here)** | [Part 8: Building for Humans](part-8-ux-production.md)

---

## Quick Recap

Over Parts <a href="part-1-nat-holepunching.md">1</a>–<a href="part-6-autobase-consensus.md">6</a>, we built the full collaboration stack: NAT traversal, encrypted transport, verified data structures, peer discovery, and multi-writer consensus. Now we need to examine what happens when a peer is malicious.

---

## The Problem: No Gatekeeper, No Safety Net

In a client-server world, security has a natural chokepoint. The server validates inputs, authenticates users, and controls access. If someone misbehaves, the server revokes their account. Problem solved.

P2P has no server. No bouncer at the door. Every peer is simultaneously a client and a server — and any of them might be malicious. An attacker doesn't need to find a vulnerability in your code. They just need to join the network and start lying.

The attack surface for a P2P system is fundamentally different from a centralized one:

- **DHT Sybil attacks** — flood the routing table with fake nodes to control discovery
- **Eclipse attacks** — surround a target node so every peer it talks to is attacker-controlled
- **DHT poisoning** — announce fake records for a topic so lookups return attacker-controlled addresses
- **Data poisoning** — serve corrupted blocks to peers requesting Hypercore data
- **Identity theft** — steal a keypair and impersonate a legitimate user
- **Key loss** — no "reset password" in P2P; lose your key, lose your identity forever

The Holepunch stack addresses each of these — some with hard cryptographic guarantees, others with probabilistic defenses, and a few with conventions that application developers must uphold themselves.

> **Key Insight:** P2P security is layered, not binary. The cryptographic layer (signatures, handshakes, Merkle proofs) provides mathematical guarantees. The network layer (Sybil resistance, peer diversity) provides probabilistic protection. The application layer (key backup, access control) provides operational safety. A secure P2P application needs all three.

---

## The Mental Model: A City of Strangers

Imagine a city with no police, no ID cards, and no central records office. Anyone can walk in, claim any name, and start talking to residents. How do you build trust?

You don't trust identities — you trust *cryptographic proof*. Instead of asking "who are you?" you ask "prove you know this secret." Instead of checking a database, you verify a mathematical relationship. And instead of trusting one gatekeeper, you insist on hearing from multiple independent sources before believing anything.

> **Feynman Moment:** The analogy suggests that individual interactions are untrustworthy — but that's not quite right. Each *individual* cryptographic verification is absolute. The Ed25519 signature either matches or it doesn't. The Merkle proof either checks out or it doesn't. What's probabilistic is the *network-level* protection: no single mechanism prevents a well-resourced attacker from controlling your view of the network. The defense is redundancy, diversity, and layering — making the cost of attack prohibitively high rather than mathematically impossible.

---

## Layer 1: Sybil Resistance in the DHT

A **Sybil attack** is when an adversary creates many fake identities to gain disproportionate influence. In a DHT, this means generating thousands of nodes to dominate the routing table — so that when a victim looks up any topic, the query routes through attacker-controlled nodes.

HyperDHT defends against Sybil attacks with three interlocking mechanisms.

### Mechanism 1: Node IDs Are Tied to Network Address

As we covered in <a href="part-5-dht-discovery.md">Part 5</a>, every DHT node's ID is derived from its observed IP and port:

```js title="dht-rpc/lib/peer.js"
function id (host, port, out = b4a.allocUnsafeSlow(32)) {
  const addr = out.subarray(0, 6)
  ipv4.encode({ start: 0, end: 6, buffer: addr }, { host, port })
  sodium.crypto_generichash(out, addr)  // BLAKE2b
  return out
}
```

You can't choose your position in the keyspace. To place a node near a specific target key, you'd need to find an IP:port combination whose BLAKE2b hash is close to that key — essentially brute-forcing a hash function. And the ID is derived from the *observed* address (what the network sees), not what the node claims, so NAT doesn't help the attacker.

### Mechanism 2: Round-Trip Tokens Prove Address Ownership

Before a node can write to the DHT (announce a topic, store a record), it must present a **token** received from the target node in a previous request. The token is a keyed BLAKE2b hash of the requester's IP address:

```js title="dht-rpc/lib/io.js"
token (addr, i) {
  const token = b4a.allocUnsafe(32)
  sodium.crypto_generichash(token, b4a.from(addr.host), this._secrets[i])
  return token
}
```

Two secrets are maintained, rotating periodically. Tokens are checked against both the current and previous secret, giving them an effective lifetime of about 15 seconds. This prevents IP spoofing — an attacker can't write to the DHT from a forged address because they'd never receive the token.

### Mechanism 3: The 20-Minute Proving Period

New nodes start in **ephemeral** mode — they can query the DHT but don't store routing information for others. After roughly 20 minutes of stable uptime (240 ticks × 5 seconds), the node undergoes a reachability test: it asks 5 peers to ping it back, requiring at least 3 responses from distinct hosts. Only then does it transition to **persistent** mode.

This 20-minute cold start means a Sybil attacker can't rapidly spin up and tear down thousands of nodes — each one needs to survive for 20 minutes before it participates in routing. After a sleep/wake cycle, the node resets to ephemeral and must re-prove stability (taking roughly 60 minutes in that case).

> **Key Insight:** None of these mechanisms makes Sybil attacks impossible — a well-funded attacker with thousands of distinct IP addresses and patience could still position nodes near a target. The defense is *economic*: it makes the attack expensive enough that the vast majority of adversaries can't afford it. This is the fundamental security model of open DHTs.

---

## Layer 2: Eclipse Prevention

An **Eclipse attack** is more targeted than a Sybil attack. Instead of dominating the whole DHT, the attacker surrounds a specific victim — controlling every peer the victim communicates with. If successful, the attacker controls the victim's entire view of the network.

HyperDHT's routing table design provides structural resistance:

- **K-bucket eviction favors incumbents.** When a bucket is full and a new node appears, the DHT pings the oldest existing node. Only if it's dead does the new node get in. This means long-running honest nodes are hard to displace.
- **Down hints are rate-limited.** Attackers can't rapidly claim that honest nodes are offline to trigger eviction. The default limit is 50 down-hint events before throttling kicks in.
- **Multiple independent lookup paths.** A Kademlia lookup queries up to 10 nodes in parallel from different parts of the routing table. An attacker would need to control nodes across multiple buckets to intercept all paths.

But the most important Eclipse defense is **peer diversity at the application level**. If your application relies on a single DHT path for critical data, one compromised route can blind you. Maintaining connections to peers discovered through different topics, at different times, from different network paths makes Eclipse attacks exponentially harder.

> **Gotcha:** Eclipse resistance is a shared responsibility. The DHT provides structural resistance, but the application must maintain peer diversity. If your application connects to only 2-3 peers for important data, you're vulnerable regardless of the DHT's defenses.

---

## Layer 3: DHT Poisoning and the Noise Handshake

**DHT poisoning** is when an attacker announces fake records on a topic — so that when you look up "who has this data?", the DHT returns attacker-controlled addresses instead of real peers.

The defense is elegant: **the DHT provides candidates, not trusted peers.** Every connection goes through a Noise XX handshake (from <a href="part-2-encrypted-pipes.md">Part 2</a>) that cryptographically proves the remote peer holds the private key matching the announced public key.

```
Lookup result:  { publicKey: 0xABCD..., relayAddresses: [...] }
                          ↓
               HyperDHT connect(publicKey)
                          ↓
               Noise XX handshake (3 messages)
                          ↓
     Handshake proves:  remote holds private key for 0xABCD...
                          ↓
               Connection established — or rejected
```

The handshake is non-negotiable. If the remote party can't prove key ownership, the connection fails. An attacker who poisons the DHT with fake addresses will successfully intercept lookup results — but the victim's connection attempt will fail at the Noise handshake because the attacker doesn't hold the legitimate private key.

The HyperDHT server firewall adds another layer. It runs *after* the remote identity is cryptographically verified but *before* the connection is fully established:

```js title="hyperdht-firewall.js"
const server = dht.createServer({
  async firewall (remotePublicKey, remotePayload, clientAddress) {
    // remotePublicKey is already verified by Noise handshake
    // Return true to reject, false to accept
    return !allowedKeys.has(remotePublicKey.toString('hex'))
  }
})
```

The firewall receives three arguments: the verified public key, handshake payload data, and the client's network address. Because it runs post-authentication, you can implement access control based on cryptographic identity — not just IP addresses.

> **Terminology:** The HyperDHT server firewall (`async firewall(remotePublicKey, remotePayload, clientAddress)` — 3 args, can be async) is distinct from the Hyperswarm firewall (`firewall(remotePublicKey, payload)` — 2 args, synchronous). The HyperDHT firewall runs at the connection level; the Hyperswarm firewall runs at the swarm orchestration level.

---

## Layer 4: The Merkle Verification Chain

Even after you've connected to a legitimate peer, you don't trust their data. Every block received from a remote Hypercore is verified through a **complete cryptographic chain** before your application sees it.

Here's the full chain, from raw bytes to trusted data:

```
┌─────────────────────────────────────────────────────────────┐
│                 The Verification Chain                        │
│                                                              │
│  1. Raw block data arrives from peer                        │
│     ↓                                                        │
│  2. BLAKE2b(0x00 ‖ uint64(data.length) ‖ data) → leaf hash │
│     ↓                                                        │
│  3. Merkle uncle path: leaf + siblings → root peaks          │
│     ↓                                                        │
│  4. BLAKE2b(0x02 ‖ for each root: hash ‖ index ‖ size)     │
│     → bagged tree hash                                       │
│     ↓                                                        │
│  5. 112-byte signable:                                       │
│     [TREE namespace (32)] [manifest hash (32)]               │
│     [tree hash (32)] [length (8)] [fork (8)]                 │
│     ↓                                                        │
│  6. Ed25519 signature verification against core's public key │
│     ↓                                                        │
│  7. Data is trusted ✓                                        │
└─────────────────────────────────────────────────────────────┘
```

Each step has a specific security property:

| Step | What It Prevents |
|------|------------------|
| Leaf hash with `0x00` type prefix | Second-preimage attacks (leaf hashes can't collide with parent hashes) |
| Parent hash with `0x01` type prefix | Domain separation between tree levels |
| Root bagging with `0x02` type prefix | Prevents root hash collisions across different tree structures |
| Manifest hash in signable | Prevents cross-core signature reuse (each core has a unique manifest) |
| Length in signable | Prevents truncation attacks (signature commits to exact tree size) |
| Fork counter in signable | Detects unauthorized tree rewrites (fork increments on truncate) |
| Ed25519 signature | Proves the core owner authorized this exact tree state |

Hypercore performs this verification automatically on every block received during replication. You can't skip it, bypass it, or weaken it through configuration. It's not a "security option" — it's the data layer itself.

> **Feynman Moment:** The three type prefixes (0x00 for leaves, 0x01 for parents, 0x02 for roots) seem like a minor detail, but they solve a subtle attack called a **second-preimage attack**. Without domain separation, an attacker could craft data whose leaf hash happens to equal a valid parent hash — potentially making a corrupted tree look valid. The type prefix makes this impossible: no matter what data you feed in, a leaf hash always starts with a different internal state than a parent hash. It's one byte that closes an entire class of attacks.

---

## Layer 5: Sovereign Identity and Key Management

In a centralized system, your identity lives on a server. Lose your password? Reset it via email. Account compromised? The admin revokes it. P2P has no admin. Your identity *is* your keypair, and the rules are simple and unforgiving:

- **Lose your private key → lose your identity forever.** No recovery, no appeal, no reset.
- **Compromise your primary key → compromise everything.** All Hypercore keypairs derive deterministically from the Corestore primary key (as we covered in <a href="part-4-hyperbee-hyperdrive.md">Part 4</a>). One key rules them all.

The derivation chain from <a href="part-4-hyperbee-hyperdrive.md">Part 4</a>:

```
Primary Key (32 bytes — the root of trust)
    ↓ keyed BLAKE2b with namespace + name
Deterministic Seed (32 bytes)
    ↓ crypto_sign_seed_keypair
Ed25519 Keypair (for a specific Hypercore)
```

The primary key is the BLAKE2b key parameter in `crypto_generichash_batch` — it's a proper keyed hash, not a simple concatenation. Same primary key plus same namespace plus same name always produces the same Hypercore keypair.

This determinism is both a strength and a vulnerability. It means you can regenerate all your cores from a single backup of the primary key. But it also means a single compromise exposes every core in the store.

### Key Backup Strategies

Since there's no "forgot password" flow, applications *must* provide key backup:

| Strategy | How It Works | Tradeoff |
|----------|-------------|----------|
| **Mnemonic seed** | Encode the 32-byte primary key as 24 words (BIP39-style) | Simple but requires secure physical storage |
| **Social recovery** | Split the key into N shares, require M to reconstruct (Shamir's Secret Sharing) | Resilient to individual loss, but requires trusted social graph |
| **Multi-device sync** | Replicate the primary key across user's devices | Convenient, but each device is an attack surface |
| **Hardware key** | Store the primary key in a hardware security module | Strongest protection, but adds cost and complexity |

> **Gotcha:** Corestore does not encrypt the primary key at rest. It's stored as raw bytes in whatever storage backend is configured — typically a file on disk. Protection depends entirely on the OS-level file permissions and disk encryption. If your application handles sensitive data, encrypting the primary key before storage is your responsibility, not Corestore's.

---

## Layer 6: Blind Pairing — Safe Introductions

How do you invite someone to a private group without a central server? You can't just share a Hypercore key on a public channel — anyone who intercepts it gets access. You need a protocol that lets two strangers establish a trusted connection through an out-of-band invitation.

<a href="https://github.com/holepunchto/blind-pairing-core" target="_blank">blind-pairing-core</a> implements a 5-step cryptographic handshake:

**Step 1 — Create the invite.** The member generates a random 32-byte seed, derives an Ed25519 keypair from it, and packages the seed with a discovery key into an invite token. This token is shared out-of-band (QR code, secure message, in person).

**Step 2 — Candidate requests access.** The candidate decodes the invite, re-derives the same keypair from the seed, and encrypts a request using XChaCha20-Poly1305. The encryption key is derived from the invitation's public key, so only someone with the invite can produce a valid request.

**Step 3 — Member validates.** The member decrypts the candidate's request using the same derived key and verifies the cryptographic receipt signature.

**Step 4 — Member responds.** If accepted, the member encrypts a response containing the group's core key and encryption key under a session-derived key, and sends it back.

**Step 5 — Candidate verifies and joins.** The candidate decrypts the response, verifies that the discovery key matches the original invite, and joins the group.

```
Member                              Candidate
  │                                      │
  │──── Invite (seed + discoveryKey) ───▶│  (out-of-band)
  │                                      │
  │◀─── Encrypted request ──────────────│  (via DHT)
  │     (XChaCha20-Poly1305)            │
  │                                      │
  │──── Encrypted response ─────────────▶│  (via DHT)
  │     (key + encryptionKey)            │
  │                                      │
  │         ✓ Paired                     │
```

The security of the scheme rests on the **confidentiality of the invite**. The 32-byte seed is essentially a bearer credential — anyone who possesses it can impersonate a legitimate candidate. This is why the invite must be shared through a trusted channel.

> **Key Insight:** Blind pairing separates *discovery* from *authorization*. The DHT is used for rendezvous (finding each other), but the invite seed provides the cryptographic basis for trust. An attacker who monitors the DHT sees encrypted blobs at ephemeral keypair locations — without the invite seed, they can't decrypt, forge, or replay anything.

---

## The Trust Boundary Map

Not all security properties are enforced the same way. Here's an honest accounting of what the Holepunch stack guarantees in code versus what it assumes by convention:

| Property | Enforced in Code | Assumed by Convention |
|----------|:---:|:---:|
| Node IDs tied to IP:port (Sybil resistance) | Yes | — |
| Round-trip tokens for DHT writes | Yes | — |
| 20-min ephemeral proving period | Yes | — |
| Noise XX mutual authentication | Yes | — |
| Merkle proof + Ed25519 signature verification | Yes | — |
| Discovery key hides public key | Yes | — |
| Type-prefix domain separation (0x00/0x01/0x02) | Yes | — |
| Primary key encryption at rest | — | Application must implement |
| Peer diversity for Eclipse resistance | — | Application must maintain |
| Invite confidentiality (Blind Pairing) | — | Out-of-band channel must be secure |
| Apply function purity (Autobase) | — | Developer must uphold |
| Post-handshake key ratcheting | — | Not provided (single key for connection lifetime) |

The left column is math. The right column is discipline. A secure application needs both.

> **Gotcha:** The Noise XX handshake provides forward secrecy against later compromise of static keys — past sessions can't be decrypted even if the long-term key leaks. But there's no post-handshake key ratcheting (unlike Signal's Double Ratchet). A single Hypercore connection uses the same symmetric keys for its entire lifetime. For most P2P applications this is fine — connections are relatively short-lived and data is already authenticated by Merkle proofs. But it's worth understanding the boundary.

---

## The Tradeoffs

| What You Gain | What You Pay |
|---|---|
| No central authority to compromise | No central authority to revoke access or reset passwords |
| Cryptographic identity (unforgeable) | Key loss is permanent — no recovery without backup |
| Automatic Merkle verification on every block | Can't skip verification for performance — it's always on |
| Sybil resistance via hash-based node IDs | Determined attacker with many IPs can still position nodes |
| Noise XX proves identity before connection | 3-message handshake adds latency to every connection |
| DHT poisoning defeated by handshake verification | Poisoning still wastes time (failed connections before finding real peers) |
| Blind pairing enables serverless invitations | Invite security depends on out-of-band channel |
| Deterministic key derivation from one master key | Single point of failure — master key compromise exposes all cores |

---

## Key Takeaways

- **The Holepunch stack has six security layers: Sybil resistance, Eclipse prevention, DHT poisoning defense, Merkle verification, sovereign identity, and Blind Pairing.** Each addresses a different attack vector. No single layer is sufficient alone.

- **Sybil resistance is economic, not absolute.** Hash-based node IDs, round-trip tokens, and the 20-minute proving period make Sybil attacks expensive but not impossible. The defense works because the cost exceeds the reward for most adversaries.

- **DHT lookups return candidates, not trusted peers.** The Noise XX handshake is the real authentication boundary. An attacker who poisons the DHT can redirect your lookups, but can't pass the handshake without the legitimate private key.

- **Every block is verified through a complete cryptographic chain.** Leaf hash → Merkle path → root peaks → bagged tree hash → 112-byte signable → Ed25519 signature. This is enforced in code, not optional. Data poisoning is cryptographically impossible.

- **Your master key is your entire identity.** All Hypercore keypairs derive from the Corestore primary key. Protect it like a root CA certificate — encrypted storage, no transmission, backup strategy in place. There is no password reset in P2P.

- **Know what's enforced and what's assumed.** Cryptographic verification is mathematical. Peer diversity, key protection, and invite confidentiality are operational. Build your application assuming both layers are necessary.

---

## What's Next

We've mapped every layer of the stack — from punching through NATs to securing against sophisticated attacks. The technology is sound. But technology alone doesn't make a product. Users don't care about Merkle proofs or Sybil resistance. They care about whether the app works when they're on the subway, whether their data appears instantly, and whether they can recover when things go wrong.

In <a href="part-8-ux-production.md">Part 8</a>, we'll tackle the hardest challenge of all: making P2P feel reliable to real humans. We'll cover offline-first design, optimistic UX for eventually-consistent data, availability strategies (seeded mesh, personal relay nodes, hybrid architectures), mobile deployment with suspend/resume, and the observability tools that keep a serverless system debuggable.

---

## References & Further Reading

1. <a href="https://github.com/holepunchto/dht-rpc" target="_blank">holepunchto/dht-rpc — Kademlia DHT with Sybil-resistant node IDs and round-trip tokens</a>
2. <a href="https://github.com/holepunchto/hyperdht" target="_blank">holepunchto/hyperdht — DHT with keypair-authenticated Noise XX connections</a>
3. <a href="https://github.com/holepunchto/hypercore" target="_blank">holepunchto/hypercore — Append-only log with Merkle proof verification</a>
4. <a href="https://github.com/holepunchto/hypercore-crypto" target="_blank">holepunchto/hypercore-crypto — BLAKE2b hashing, Ed25519 signatures, type-prefixed domain separation</a>
5. <a href="https://github.com/holepunchto/blind-pairing-core" target="_blank">holepunchto/blind-pairing-core — Cryptographic invitation protocol for serverless group access</a>
6. <a href="https://github.com/holepunchto/hyperswarm-secret-stream" target="_blank">holepunchto/hyperswarm-secret-stream — Noise XX handshake + XChaCha20-Poly1305 post-handshake encryption</a>
7. <a href="https://github.com/holepunchto/corestore" target="_blank">holepunchto/corestore — Deterministic key derivation from a single primary key</a>
8. <a href="https://noiseprotocol.org/noise.html" target="_blank">Noise Protocol Framework — Specification for the XX handshake pattern</a>
9. <a href="https://en.wikipedia.org/wiki/Sybil_attack" target="_blank">Wikipedia — Sybil attack</a>
10. <a href="https://docs.pears.com/" target="_blank">Pear Runtime Documentation</a>

---

> **Series: P2P from Scratch — Building on the Holepunch Stack**
> [Part 1: The Internet is Hostile](part-1-nat-holepunching.md) | [Part 2: Encrypted Pipes](part-2-encrypted-pipes.md) | [Part 3: Append-Only Truth](part-3-hypercore-merkle.md) | [Part 4: From Logs to Databases](part-4-hyperbee-hyperdrive.md) | [Part 5: Finding Peers](part-5-dht-discovery.md) | [Part 6: Many Writers, One Truth](part-6-autobase-consensus.md) | **Part 7: Trust No One (You are here)** | [Part 8: Building for Humans](part-8-ux-production.md)
