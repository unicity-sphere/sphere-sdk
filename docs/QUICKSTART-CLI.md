# Sphere CLI Quick Start

> **Note:** The CLI is now a standalone package at [`@unicity-sphere/cli`](https://github.com/unicity-sphere/sphere-cli).
> Install it with `npm install -g @unicity-sphere/cli` and run `sphere --help`.
> The `npm run cli` script in sphere-sdk no longer works.

The Sphere CLI covers wallet management, payments, messaging, and invoicing — no code required. All data is stored locally in `~/.config/sphere/` (or `.sphere-cli/` in the working directory for legacy compatibility).

**Node.js version:** 18.0.0 or higher required.

```bash
# Full help
sphere --help
```

> **Asset amount convention:** All CLI commands that reference assets use the format `<amount> <symbol>`.
> Examples: `10 UCT`, `0.5 BTC`, `1000000 USDU`. This format is used consistently:
>
> ```
> send @alice 10 UCT
> topup 10 UCT
> swap-propose --to @bob --offer "1000000 UCT" --want "500000 USDU"
> invoice-create --target @alice --asset "1000000 UCT"
> invoice-return <id> --recipient <addr> --asset "500 UCT"
> ```

---

## Shell Auto-Completion (Optional)

Enable tab-completion for all CLI commands and flags.

### Step 1: Install the CLI globally

```bash
npm install -g @unicity-sphere/cli
```

This makes `sphere` available as a global command.

### Step 2: Generate and install completions

**Bash:**
```bash
sphere completions bash >> ~/.bashrc
source ~/.bashrc
```

**Zsh:**
```bash
mkdir -p ~/.zsh/completions
sphere completions zsh > ~/.zsh/completions/_sphere
# Add to ~/.zshrc if not already there:
# fpath=(~/.zsh/completions $fpath)
# autoload -Uz compinit && compinit
source ~/.zshrc
```

**Fish:**
```bash
sphere completions fish > ~/.config/fish/completions/sphere.fish
```

### What it provides

After setup, press Tab to auto-complete:
```
sphere <TAB>                    # all commands
sphere swap-<TAB>               # swap-propose swap-list swap-accept ...
sphere swap-propose --<TAB>     # --to --offer --want --escrow --timeout --message
sphere invoice-<TAB>            # invoice-create invoice-list ...
sphere wallet <TAB>             # list create use current delete
```

---

## Command Quick Reference

| Command | Description |
|---------|-------------|
| `init` | Create or import wallet |
| `status` | Show wallet identity |
| `config` | Show or set CLI configuration |
| `clear` | Delete all wallet data (requires confirmation or `--yes`) |
| `wallet list` | List wallet profiles |
| `wallet create <name>` | Create a new wallet profile |
| `wallet use <name>` | Switch to a wallet profile |
| `wallet delete <name>` | Delete a wallet profile |
| `wallet current` | Show active profile |
| `balance` | Show L3 token balance |
| `tokens` | List individual tokens |
| `assets` | List registered assets (coins & NFTs) |
| `asset-info <id>` | Show asset details |
| `verify-balance` | Detect spent tokens via aggregator |
| `sync` | Sync tokens with IPFS |
| `send <to> <amount> <symbol>` | Send L3 tokens |
| `receive` | Check for incoming transfers |
| `history [limit]` | Transaction history |
| `topup [<amount> <symbol>]` | Top up by self-minting test tokens (v2 engine — no faucet) |
| `addresses` | List tracked addresses |
| `switch <index>` | Switch to HD address |
| `hide <index>` | Hide address |
| `unhide <index>` | Unhide address |
| `nametag <name>` | Register a nametag |
| `nametag-info <name>` | Look up nametag info |
| `my-nametag` | Show current nametag |
| `nametag-sync` | Re-publish nametag binding |
| `dm <to> <msg>` | Send direct message |
| `dm-inbox` | List conversations |
| `dm-history <peer>` | Show conversation history |
| `group-create <name>` | Create NIP-29 group |
| `group-list` | List groups on relay |
| `group-my` | List your groups |
| `group-join <id>` | Join a group |
| `group-leave <id>` | Leave a group |
| `group-send <id> <msg>` | Send group message |
| `group-messages <id>` | Show group messages |
| `group-members <id>` | List group members |
| `group-info <id>` | Show group details |
| `market-post <desc>` | Post a market intent |
| `market-search <query>` | Search market intents |
| `market-my` | Your posted intents |
| `market-close <id>` | Close a market intent |
| `market-feed` | Watch live market feed |
| `invoice-create` | Create invoice |
| `invoice-import <file>` | Import invoice from token file |
| `invoice-list` | List invoices |
| `invoice-status <id>` | Show invoice status |
| `invoice-pay <id>` | Pay an invoice |
| `invoice-close <id>` | Close an invoice |
| `invoice-cancel <id>` | Cancel an invoice |
| `invoice-return <id>` | Return payment to sender |
| `invoice-receipts <id>` | Send receipts |
| `invoice-notices <id>` | Send cancellation notices |
| `invoice-auto-return` | Show/set auto-return settings |
| `invoice-transfers <id>` | List related transfers |
| `invoice-export <id>` | Export invoice to JSON file |
| `invoice-parse-memo <memo>` | Parse an invoice memo string |
| `swap-propose` | Propose a swap deal (`--offer`, `--want`) |
| `swap-list` | List swap deals |
| `swap-accept <id>` | Accept a swap deal |
| `swap-reject <id> [reason]` | Reject a swap proposal |
| `swap-status <id>` | Show detailed swap status |
| `swap-deposit <id>` | Deposit into an announced swap |
| `swap-cancel <id>` | Cancel a swap |
| `daemon start` | Start persistent event listener |
| `daemon stop` | Stop running daemon |
| `daemon status` | Check daemon status |
| `encrypt <data> <pass>` | Encrypt data with password |
| `decrypt <json> <pass>` | Decrypt encrypted data |
| `parse-wallet <file>` | Parse wallet backup file |
| `wallet-info <file>` | Show wallet file metadata |
| `generate-key` | Generate random key pair (private key hidden; use `--unsafe-print` to show) |
| `validate-key <hex>` | Validate secp256k1 key |
| `hex-to-wif <hex>` | Convert hex to WIF |
| `derive-pubkey <hex>` | Derive public key |
| `derive-address <hex>` | Derive address at index |
| `to-smallest <amount>` | Convert to smallest unit |
| `to-human <amount>` | Convert from smallest unit |
| `format <amount>` | Format amount with decimals |
| `base58-encode <hex>` | Encode hex to base58 |
| `base58-decode <str>` | Decode base58 to hex |

---

## 1. Installation and Setup

### Prerequisites

- Node.js 18.0.0 or higher
- Install the CLI globally:

```bash
npm install -g @unicity-sphere/cli
```

### First-Time Wallet Initialization

The `init` command creates a new wallet or imports an existing one. It is the single entry point for both paths.

```bash
# Create a new wallet on testnet (default)
sphere init

# Specify network: mainnet | testnet | testnet2 | dev
# ('testnet' IS testnet2 — the v2 gateway; mainnet/dev are still v1-era
#  aggregators and cannot serve the v2 engine yet)
sphere init --network testnet

# Create wallet and immediately register a nametag
# NOTE: --nametag publishes a Nostr identity binding (first-seen-wins)
sphere init --network testnet --nametag alice

# Import an existing wallet from a 12 or 24-word mnemonic
sphere init --mnemonic "word1 word2 word3 ... word24"

# Interactive mnemonic import (more secure — mnemonic never in process args)
sphere init --mnemonic
# Prompts: "Enter mnemonic phrase: "

# Import with a nametag registration in one step
sphere init --mnemonic "word1 ..." --nametag alice
```

> **Security:** Using `--mnemonic` without a value prompts interactively, keeping the mnemonic out of shell history and `/proc/<pid>/cmdline`. Prefer this mode for production wallets.

> **Important:** When a new wallet is created without `--mnemonic`, a 24-word mnemonic is generated and printed once to the terminal. Save it immediately — it cannot be recovered.

> **Important:** `--nametag` and the standalone `nametag` command register the name by publishing a Nostr identity binding (name ↔ chain pubkey, first-seen-wins). A self-issued v2 Unicity ID token is additionally minted and stored best-effort; runtime name resolution uses only the Nostr binding.

On first run, `init` prints the full wallet identity:

```
Wallet initialized successfully!

Identity:
{
  "directAddress": "DIRECT://0000be36...",
  "chainPubkey": "02abc123...",
  "nametag": "alice"
}

⚠️  BACKUP YOUR MNEMONIC (24 words):
──────────────────────────────────────────────────
abandon ability able about above absent ...
──────────────────────────────────────────────────
Store this safely! You will need it to recover your wallet.
```

### Where Data is Stored

All CLI data is stored in the current working directory under `.sphere-cli/`:

```
.sphere-cli/
  config.json          # Active network, dataDir, tokensDir
  profiles.json        # Named wallet profiles
  wallet.json          # Wallet keys (plaintext or encrypted mnemonic)
  tokens/              # Token storage (one JSON file per token)
  daemon.json          # Daemon config (if used)
  daemon.log           # Daemon log file
  daemon.pid           # Daemon PID file

.sphere-cli-alice/     # Per-profile directory (if using wallet profiles)
  wallet.json
  tokens/
```

### Show Wallet Status

```bash
sphere status
```

```
Wallet Status:
──────────────────────────────────────────────────
Profile:       alice
Network:       testnet
Direct Addr:   DIRECT://0000be36...
Chain Pubkey:  02abc123...
Nametag:       alice
──────────────────────────────────────────────────
```

### Configuration

```bash
# Show current configuration
sphere config

# Change the network
sphere config set network mainnet

# Change data directory
sphere config set dataDir ./my-wallet

# Change token storage directory
sphere config set tokensDir ./my-tokens
```

---

## 2. Wallet Profiles

Wallet profiles let you manage multiple independent wallets (e.g., for testing with different identities). Each profile gets its own directory under `.sphere-cli-<name>/`.

```bash
# Create a new profile (creates .sphere-cli-alice/ and switches to it)
sphere wallet create alice

# Create on a specific network
sphere wallet create bob --network mainnet

# Initialize the wallet inside the active profile
sphere init --nametag alice

# List all profiles (→ marks the active profile)
sphere wallet list

# Switch to a different profile
sphere wallet use bob

# Show the currently active profile
sphere wallet current

# Delete a profile (data directory is NOT deleted automatically)
sphere wallet delete bob
```

> **Note:** Deleting a profile removes the registry entry only. The data directory (e.g., `.sphere-cli-bob/`) is left on disk and must be removed manually if no longer needed.

### Example: Two-Wallet Test Setup

```bash
# Create alice wallet
sphere wallet create alice
sphere init --nametag alice

# Create bob wallet
sphere wallet create bob
sphere init --nametag bob

# Top up alice with test tokens (self-mint)
sphere wallet use alice
sphere topup 100 UCT

# Send from alice to bob
sphere send @bob 100 UCT

# Check bob's balance
sphere wallet use bob
sphere balance
```

---

## 3. Wallet Management

### Check Balance

```bash
# Show L3 token balance (fetches pending transfers first)
sphere balance

# Skip IPFS sync before showing balance
sphere balance --no-sync
```

> v2 transfers arrive as finished tokens — there is no receiver-side finalization step. The old `--finalize` flag is obsolete.

Example output:

```
L3 Balance:
──────────────────────────────────────────────────
UCT: 100.00000000 (3 tokens)
ETH: 0.04200000 (1 token) ≈ $131.24
──────────────────────────────────────────────────
Total: $131.24
```

When unconfirmed tokens are present:

```
UCT: 50.00000000 (+ 50.00000000 unconfirmed) [2+1 tokens]
```

### List Individual Tokens

```bash
# List all tokens with details
sphere tokens

# Skip IPFS sync
sphere tokens --no-sync
```

Example output:

```
Tokens:
──────────────────────────────────────────────────
ID: a1b2c3d4e5f67890...
  Coin: UCT (deadbeef...)
  Amount: 50.00000000 UCT
  Status: active

ID: 9876543210abcdef...
  Coin: ETH (cafe1234...)
  Amount: 0.04200000 ETH
  Status: active
──────────────────────────────────────────────────
```

### Registered Assets

Browse the token registry to see all known coins and NFTs on the network.

```bash
# List all registered assets
sphere assets

# Filter by type
sphere assets --type fungible
sphere assets --type nft

# Get detailed info for a specific asset (by symbol, name, or coin ID)
sphere asset-info UCT
sphere asset-info bitcoin
sphere asset-info 0a1b2c3d4e5f...
```

### Verify Tokens Against Aggregator

Detects tokens that have already been spent (transferred out) but are still in local storage due to missed sync or relay redelivery.

```bash
# Check for spent tokens without removing them
sphere verify-balance

# Also remove any spent tokens from storage (moves to archive + creates tombstone)
sphere verify-balance --remove

# Show all tokens, not just spent ones
sphere verify-balance --verbose
sphere verify-balance -v
```

Example output:

```
Verifying 3 token(s) against aggregator...
────────────────────────────────────────────────────────────
✓ Valid: 50.00000000 UCT (a1b2c3d4e5f6...)
✗ SPENT: 100.00000000 UCT (deadbeef0123...)
────────────────────────────────────────────────────────────

Summary:
  Valid tokens: 2
  Spent tokens: 1

To move spent tokens to Sent folder, run: sphere verify-balance --remove
```

### Sync with IPFS

```bash
sphere sync
```

Merges local tokens with tokens stored on IPFS/IPNS. Useful for recovering tokens after local data loss (re-initialize with the same mnemonic, then sync).

### Transaction History

```bash
# Show last 10 transactions
sphere history

# Show last N transactions
sphere history 25
```

Example output:

```
Transaction History (last 10):
────────────────────────────────────────────────────────────
3/9/2026, 2:15:00 PM → 100.00000000 UCT
  To: bob

3/9/2026, 1:30:00 PM ← 200.00000000 UCT
  From: 02abc123def456...
────────────────────────────────────────────────────────────
```

### Delete Wallet Data

```bash
# Delete all wallet data for the active profile (keys + tokens)
sphere clear
```

> **Warning:** This permanently deletes the wallet keys and all tokens from local storage. Only tokens synced to IPFS can be recovered afterward.

---

## 4. Nametags

Nametags (e.g., `@alice`) are human-readable aliases for wallet addresses. Registration publishes a Nostr identity binding (name ↔ chain pubkey, first-seen-wins); a self-issued v2 Unicity ID token is additionally minted and stored best-effort. Runtime name resolution uses only the Nostr binding.

```bash
# Register a nametag for the current address
sphere nametag alice
sphere nametag @alice   # @ prefix is stripped automatically

# Show your current nametag
sphere my-nametag

# Look up another user's nametag
sphere nametag-info alice
sphere nametag-info @alice

# Re-publish nametag with chainPubkey (fixes legacy nametags registered
# before the direct-address binding was introduced)
sphere nametag-sync
```

> **Note:** Each derived HD address can have its own nametag. Use `switch` to move to a different address before registering a new nametag.

---

## 5. Address Management

The wallet uses BIP-32 HD derivation. You can generate and track multiple independent addresses from the same mnemonic.

```bash
# List all tracked addresses
# → marks the currently active address
sphere addresses
```

Example output:

```
Tracked Addresses:
──────────────────────────────────────────────────────────────────────
→ #0: DIRECT://0000be36... @alice
  #1: DIRECT://0001cafe... @alice-work
  #2: DIRECT://0002dead... [hidden]
──────────────────────────────────────────────────────────────────────
```

```bash
# Switch to a different HD address index
sphere switch 1

# Hide an address from the active list (does not delete data)
sphere hide 2

# Unhide an address
sphere unhide 2
```

---

## 6. Payments (L3)

### Send Tokens

```bash
# Basic send to a nametag
sphere send @bob 100 UCT

# Send to a DIRECT:// address
sphere send DIRECT://0000be36... 50 UCT

# Send to a raw chain pubkey (02... or 03...)
sphere send 02abc123def456... 1000000 UCT
```

**Available coin symbols:** UCT, BTC, ETH, SOL, USDT, USDC, USDU, EURU

**Amounts** are specified as human-readable decimals (e.g., `0.5`, `100`, `1000000`). The CLI converts to the smallest unit automatically.

#### Transfer Flow

v2 transfers are **sender-driven**: the sender certifies the transfer on-chain (collects the inclusion proof) and delivers a finished token via Nostr; the receiver stores it as confirmed immediately. The old `--instant`/`--conservative` transfer modes and the `--proxy` address mode (PROXY:// addressing) no longer exist — all transfers go to the recipient's key-based DIRECT address resolved from their published identity binding.

```bash
# Skip IPFS sync after sending
sphere send @bob 100 UCT --no-sync
```

### Receive Tokens

The `receive` command shows your receive addresses and fetches any pending incoming transfers from the Nostr relay.

```bash
# Show addresses and fetch pending transfers
sphere receive

# Skip IPFS sync after receiving
sphere receive --no-sync
```

> v2 transfers arrive as finished tokens and are stored confirmed — there is no `--finalize` step.

Example output:

```
Receive Address:
──────────────────────────────────────────────────
L3 (Direct): DIRECT://0000be36...
Nametag:     @alice
──────────────────────────────────────────────────

Checking for incoming transfers...

Received 2 new transfer(s):
  100.00000000 UCT
  0.04200000 ETH
```

### Top Up With Test Tokens (Testnet Self-Mint)

There is no faucet — `topup` **self-mints** tokens to your own wallet via the v2 token engine (`payments.mintFungibleToken`):

```bash
# Mint a specific amount and coin
sphere topup 10 UCT
sphere topup 13 ETH
sphere topup 200 BTC
```

> **Note:** Self-mint is intended for test networks (testnet/testnet2).

---

## 7. Communications

### Direct Messages

DMs are end-to-end encrypted via NIP-17 (gift-wrapped messages) over the Nostr relay.

```bash
# Send a direct message to a nametag
sphere dm @alice "Hello, how are you?"

# Send to a raw chain pubkey
sphere dm 02abc123def456... "Hello!"
```

```
# List all conversations and unread counts
sphere dm-inbox
```

Example output:

```
Inbox (2 conversations, 3 unread):
────────────────────────────────────────────────────────────
@bob [2 unread]
  Last: Hey, did you get my tokens?
  Time: 3/9/2026, 2:15:00 PM

@carol
  Last: Thanks for the payment!
  Time: 3/9/2026, 1:00:00 PM
────────────────────────────────────────────────────────────
```

```bash
# Show conversation history with a peer
sphere dm-history @alice

# Limit to last N messages (default: 50)
sphere dm-history @alice --limit 20
sphere dm-history 02abc123def456... --limit 5
```

### Group Chat (NIP-29)

Group chat uses the NIP-29 relay protocol for managed groups with roles (ADMIN, MODERATOR, MEMBER).

```bash
# Create a new public group
sphere group-create "Trading Chat"

# Create with description
sphere group-create "Trading Chat" --description "Discuss token trades"

# Create a private group (invite-only)
sphere group-create "Private Team" --private
```

```
✓ Group created!
  ID: trading-chat-abc123
  Name: Trading Chat
  Visibility: PUBLIC
```

```bash
# List all groups available on the relay
sphere group-list

# List groups you have joined
sphere group-my

# Join a group
sphere group-join trading-chat-abc123

# Join a private group with invite code
sphere group-join private-group-id --invite code123

# Send a message to a group
sphere group-send trading-chat-abc123 "Hello everyone!"

# Reply to a specific message (by event ID)
sphere group-send trading-chat-abc123 "Agreed!" --reply <eventId>

# Read group messages (fetches from relay and marks as read)
sphere group-messages trading-chat-abc123
sphere group-messages trading-chat-abc123 --limit 20

# List group members (with roles)
sphere group-members trading-chat-abc123

# Show group details
sphere group-info trading-chat-abc123

# Leave a group
sphere group-leave trading-chat-abc123
```

---

## 8. Market (Intent Bulletin Board)

The market module lets you post buy/sell/service intents and search for matching offers using semantic search.

### Posting Intents

```bash
# Post a buy intent
sphere market-post "Buying 100 UCT tokens" --type buy

# Post a sell intent with price
sphere market-post "Selling ETH" --type sell --price 2500 --currency USD

# Post a service offer
sphere market-post "Web development services" --type service

# Post an announcement
sphere market-post "New feature released" --type announcement

# Full options
sphere market-post "Buying UCT" \
  --type buy \
  --category tokens \
  --price 100 \
  --currency UCT \
  --location "Berlin, DE" \
  --contact @myhandle \
  --expires 14
```

**Intent types:** `buy`, `sell`, `service`, `announcement`, `other`

**`--expires <days>`** sets the expiration in days (default: 30).

### Searching Intents

```bash
# Semantic search
sphere market-search "UCT tokens"

# Filter by type
sphere market-search "tokens" --type sell

# Filter by price range
sphere market-search "ETH" --min-price 2000 --max-price 3000

# Set minimum similarity score (0.0 to 1.0)
sphere market-search "tokens" --min-score 0.7

# Filter by location and category
sphere market-search "services" --category dev --location Berlin

# Limit results (default: 10)
sphere market-search "tokens" --limit 5
```

### Managing Your Intents

```bash
# List your posted intents
sphere market-my

# Close (delete) an intent by ID
sphere market-close <intentId>
```

### Live Market Feed

```bash
# Watch the live listing feed via WebSocket (Ctrl+C to stop)
sphere market-feed

# Use REST fallback to fetch recent listings once (no persistent connection)
sphere market-feed --rest
```

---

## 9. Invoicing (Accounting Module)

Invoices are on-chain tokens that encode payment terms: target address, coin, amount, due date, and memo. Both issuer and payer can track payment state in real time.

**Invoice states:** `OPEN` → `PARTIAL` → `COVERED` → `CLOSED` (or `CANCELLED`, `EXPIRED`)

> **Note:** The accounting module requires the Aggregator (Oracle) provider, which is included by default.

### Create an Invoice

```bash
# Create invoice requesting 1 UCT (amount in smallest units)
sphere invoice-create --target @alice --asset "1000000 UCT"

# Create targeting a DIRECT address
sphere invoice-create --target DIRECT://0000be36... --asset "1000000 UCT"

# With optional metadata
sphere invoice-create \
  --target @alice \
  --asset "1000000 UCT" \
  --due 2026-12-31 \
  --memo "Order #1234"

# Request an NFT token
sphere invoice-create --target @alice --nft <tokenId>

# Load full invoice terms from a JSON file
sphere invoice-create --terms invoice-terms.json
```

The `--asset` flag takes a quoted `"<amount> <symbol>"` string. The amount must be a positive integer in the smallest unit (no decimals, no leading zeros). For UCT with 8 decimals: `1000000` = 0.01 UCT.

The `--due` flag accepts ISO-8601 date strings, e.g. `2026-12-31` or `2026-12-31T23:59:59Z`.

Example output:

```json
{
  "success": true,
  "invoiceId": "a1b2c3d4e5f678901234567890abcdef...",
  "terms": { ... }
}
```

### Import an Invoice

```bash
# Import an invoice from a token JSON file (shared by the issuer)
sphere invoice-import invoice-a1b2c3d4.json
```

### List Invoices

```bash
# List all invoices
sphere invoice-list

# Filter by state (comma-separated)
sphere invoice-list --state OPEN
sphere invoice-list --state OPEN,PARTIAL

# Filter by role
sphere invoice-list --role creator    # Invoices you created
sphere invoice-list --role payer      # Invoices targeting you

# Limit results
sphere invoice-list --limit 10

# Output as JSON array
sphere invoice-list --json
```

**Valid states:** `OPEN`, `PARTIAL`, `COVERED`, `CLOSED`, `CANCELLED`, `EXPIRED`

### Check Invoice Status

```bash
# Full ID or a unique prefix (as few characters as needed to be unambiguous)
sphere invoice-status a1b2c3d4

# Output as JSON
sphere invoice-status a1b2c3d4 --json
```

Example output:

```json
{
  "state": "PARTIAL",
  "allConfirmed": false,
  "targets": [
    {
      "address": "DIRECT://0000be36...",
      "assets": [
        {
          "coinId": "UCT",
          "requested": "1000000",
          "totalForward": "500000",
          "surplus": "0"
        }
      ]
    }
  ]
}
```

### Pay an Invoice

```bash
# Pay the full remaining amount on the first target
sphere invoice-pay a1b2c3d4

# Pay a specific amount (in smallest units)
sphere invoice-pay a1b2c3d4 --amount 500000

# Pay a specific target in a multi-target invoice (0-indexed)
sphere invoice-pay a1b2c3d4 --target-index 1
```

### Close an Invoice

```bash
# Close the invoice (no further payments accepted after this)
sphere invoice-close a1b2c3d4

# Close and trigger auto-return for any overpayments
sphere invoice-close a1b2c3d4 --auto-return
```

### Cancel an Invoice

```bash
# Cancel an invoice as the target (payer-side cancellation)
sphere invoice-cancel a1b2c3d4
```

### Return a Payment

```bash
# Return a specific amount to the original sender
sphere invoice-return a1b2c3d4 \
  --recipient @bob \
  --asset "500000 UCT"
```

Both `--recipient` and `--asset` flags are required.

### Send Receipts and Notices

```bash
# Send payment receipts for a terminated invoice (CLOSED or COVERED)
sphere invoice-receipts a1b2c3d4

# Send cancellation notices to all parties
sphere invoice-notices a1b2c3d4
```

### Auto-Return Settings

Auto-return automatically returns overpayments when an invoice is closed.

```bash
# Show current auto-return settings
sphere invoice-auto-return

# Enable globally (applies to all future close operations)
sphere invoice-auto-return --enable

# Disable globally
sphere invoice-auto-return --disable

# Enable for a specific invoice
sphere invoice-auto-return --enable --invoice a1b2c3d4

# Disable for a specific invoice
sphere invoice-auto-return --disable --invoice a1b2c3d4
```

### List Related Transfers

```bash
# List all transfers related to an invoice in chronological order
sphere invoice-transfers a1b2c3d4

# Output as JSON array
sphere invoice-transfers a1b2c3d4 --json
```

### Export an Invoice

```bash
# Export invoice data to a JSON file (e.g., invoice-a1b2c3d4.json)
sphere invoice-export a1b2c3d4
```

### Parse an Invoice Memo

Invoice memos embed a compact reference string that can be decoded back to the invoice ID and state.

```bash
sphere invoice-parse-memo "INV:a1b2c3d4...:F"
```

---

## 10. Token Swaps

The swap module enables trustless two-party token swaps via an escrow service. Both parties agree on terms, deposit their tokens into the escrow, and the escrow executes the exchange atomically -- either both parties receive their tokens, or both deposits are returned.

**Prerequisites:**
- Two wallet profiles set up (or two terminals with different data directories)
- Both wallets initialized with nametags
- Tokens available for the swap
- An escrow service address (e.g., `@escrow-testnet` on testnet)

> **Note:** The swap module requires the Accounting module (for invoice-based deposits) and the Communications module (for DM negotiation). Both are included by default.

### Complete Walkthrough: Two-Party Token Swap

This example shows Alice proposing a swap and Bob accepting it, using two terminals.

**Terminal 1: Alice (@alice) -- the proposer**

```bash
# 1. Check Alice's balance
sphere balance
# Output: UCT: 10,000,000 (10 UCT)

# 2. Propose a swap: Alice offers 1,000,000 UCT for 500,000 USDU
sphere swap-propose \
  --to @bob \
  --offer "1000000 UCT" \
  --want "500000 USDU" \
  --escrow @escrow-testnet \
  --timeout 3600 \
  --message "Trading 1 UCT for 0.5 USDU"

# Output:
# Swap proposed:
# {
#   "swap_id": "a1b2c3d4e5f6...",
#   "counterparty": "@bob",
#   "offer": "1000000 UCT",
#   "want": "500000 USDU",
#   "escrow": "@escrow-testnet",
#   "timeout": 3600,
#   "status": "proposed"
# }

# 3. Check swap list
sphere swap-list
# SWAP ID   ROLE        PROGRESS            OFFER             WANT              COUNTERPARTY    CREATED
# a1b2c3d4  proposer    proposed            1000000 UCT       500000 USDU       @bob            just now

# 4. Wait for Bob to accept...
sphere swap-status a1b2c3d4e5f6...full64hex...
```

**Terminal 2: Bob (@bob) -- the acceptor**

```bash
# 1. Check Bob's balance
sphere balance
# Output: USDU: 5,000,000 (5 USDU)

# 2. Check incoming swap proposals
sphere swap-list
# SWAP ID   ROLE        PROGRESS            OFFER             WANT              COUNTERPARTY    CREATED
# a1b2c3d4  acceptor    proposed            500000 USDU       1000000 UCT       @alice          30 sec ago
#
# Note: from Bob's perspective, "OFFER" is what HE would send (USDU),
# and "WANT" is what he receives (UCT).

# 3. Accept the swap AND deposit in one command
sphere swap-accept a1b2c3d4e5f6...full64hex... --deposit
# Output:
# Swap accepted. Announced to escrow. Waiting for deposit invoice...
# Deposit sent: transfer_xyz789
# [swap] Deposit confirmed by escrow.
# [swap] Awaiting counterparty deposit...
```

**Terminal 1: Alice deposits**

```bash
# 5. Alice sees the swap is now 'announced' (escrow ready)
sphere swap-list
# SWAP ID   ROLE        PROGRESS            OFFER             WANT              COUNTERPARTY    CREATED
# a1b2c3d4  proposer    announced           1000000 UCT       500000 USDU       @bob            2 min ago

# 6. Alice deposits her side
sphere swap-deposit a1b2c3d4e5f6...full64hex...
# Output:
# Deposit result:
# {
#   "id": "transfer_abc123",
#   "status": "delivered"
# }

# 7. Check progress -- both deposits made
sphere swap-status a1b2c3d4e5f6...full64hex...
# progress: "concluding"
# escrowState: "CONCLUDING"
```

**Both terminals: Swap completes**

After the escrow processes payouts, both parties receive their tokens.

```bash
# Alice checks:
sphere swap-list --all
# a1b2c3d4  proposer    completed           1000000 UCT       500000 USDU       @bob            5 min ago

sphere balance
# UCT: 9,000,000 (was 10M, sent 1M)
# USDU: 500,000 (received from swap!)

# Bob checks:
sphere swap-list --all
# a1b2c3d4  acceptor    completed           500000 USDU       1000000 UCT       @alice          5 min ago

sphere balance
# USDU: 4,500,000 (was 5M, sent 0.5M)
# UCT: 1,000,000 (received from swap!)
```

### Checking Progress and Troubleshooting

```bash
# Detailed status with escrow query (asks the escrow for its view)
sphere swap-status a1b2c3d4...full64hex... --query-escrow

# Filter swaps by progress state
sphere swap-list --progress depositing
sphere swap-list --progress announced

# Filter by role
sphere swap-list --role proposer
sphere swap-list --role acceptor

# Show all swaps including completed/cancelled/failed (default hides terminal)
sphere swap-list --all
```

### Cancellation and Timeouts

Swaps that are not fully deposited within the timeout period are automatically cancelled by the escrow. Any deposits already made are returned.

```bash
# If you proposed a swap and want to check if it timed out:
sphere swap-status a1b2c3d4...full64hex...
# progress: "cancelled"
# escrowState: "CANCELLED"

# Deposits are returned automatically by the escrow.
# Check your balance to confirm tokens were returned:
sphere balance
```

You can also explicitly reject or cancel swaps:

```bash
# Reject a proposal
sphere-cli swap-reject 3611a464... "Price too high"

# Cancel your own swap
sphere-cli swap-cancel 3611a464...
```

> **Note:** After the escrow is announced but before deposits, you can explicitly cancel with `swap-cancel`. Once both deposits are confirmed, cancellation is no longer possible — the escrow will execute the payout. Before acceptance, the proposal can be rejected with `swap-reject` or simply expires after 5 minutes (client-side timeout).

### All Swap CLI Commands Reference

| Command | Description | Key Flags |
|---------|-------------|-----------|
| `swap-propose` | Propose a swap deal | `--to`, `--offer "<amount> <symbol>"`, `--want "<amount> <symbol>"`, `--escrow`, `--timeout`, `--message` |
| `swap-list` | List swaps | `--all`, `--role <proposer\|acceptor>`, `--progress <state>` |
| `swap-accept <id>` | Accept a swap | `--deposit` (also deposit immediately), `--no-wait` (do not wait for completion) |
| `swap-reject <id> [reason]` | Reject a swap proposal | (optional reason as second positional argument) |
| `swap-status <id>` | Detailed status | `--query-escrow` (query the escrow for its state) |
| `swap-deposit <id>` | Deposit into swap | (no additional flags) |
| `swap-cancel <id>` | Cancel a swap | (no additional flags) |

**Swap IDs** are 64-character hex strings (content-addressed from the manifest). The `swap-list` output shows an 8-character prefix for readability. All commands that accept a swap ID require the full 64-character ID.

### Swap Progress States

| State | Meaning |
|-------|---------|
| `proposed` | Proposal sent or received, waiting for counterparty |
| `accepted` | Counterparty accepted, announcing to escrow |
| `announced` | Escrow acknowledged, deposit invoice available |
| `depositing` | Local deposit sent, awaiting confirmation |
| `awaiting_counter` | Local deposit confirmed, waiting for counterparty |
| `concluding` | Both deposited, escrow processing payouts |
| `completed` | Swap done -- tokens exchanged (terminal) |
| `cancelled` | Swap cancelled -- timeout or escrow failure (terminal) |
| `failed` | Unrecoverable error (terminal) |

### Swap Propose Flags

| Flag | Required | Description |
|------|----------|-------------|
| `--to <recipient>` | Yes | Counterparty: `@nametag`, `DIRECT://...`, or chain pubkey |
| `--offer "<amount> <symbol>"` | Yes | What you are offering (e.g., `"1000000 UCT"`) |
| `--want "<amount> <symbol>"` | Yes | What you want in return (e.g., `"500000 USDU"`) |
| `--escrow <address>` | No | Escrow service address (defaults to module config) |
| `--timeout <seconds>` | No | Swap timeout in seconds, 60-86400 (default: 3600) |
| `--message <text>` | No | Human-readable message included in proposal DM |

---

## 11. Event Daemon

The daemon runs in the background and reacts to wallet events — incoming transfers, DMs, payment requests — by triggering actions such as auto-receive, webhook calls, bash scripts, or log writes.

### Quick Start

```bash
# Listen for incoming transfers and auto-receive them
sphere daemon start --event transfer:incoming --action auto-receive

# Start in background (detaches, writes PID and log files)
sphere daemon start --event transfer:incoming --action auto-receive --detach

# Check if daemon is running
sphere daemon status

# Stop daemon
sphere daemon stop
```

### Start Options

```bash
sphere daemon start [options]

  --config <path>      Config file path (default: .sphere-cli/daemon.json)
  --detach             Fork to background; redirect output to log file
  --log <path>         Override log file path
  --pid <path>         Override PID file path
  --event <type>       Subscribe to event type (repeatable for multiple)
  --action <spec>      Action to run on matching events (see below)
  --market-feed        Also subscribe to market WebSocket feed
  --verbose            Print full event JSON in log output
```

### Action Specs

| Spec | Description |
|------|-------------|
| `auto-receive` | Automatically call `sphere.payments.receive()` on each incoming transfer |
| `log:<path>` | Append event JSON as newline-delimited JSON to a file |
| `webhook:<url>` | POST event JSON to the given URL |
| `bash:<command>` | Run a shell command; event fields available as environment variables |

```bash
# Auto-receive all incoming transfers
sphere daemon start --event transfer:incoming --action auto-receive

# Webhook: POST to URL on any transfer event
sphere daemon start \
  --event "transfer:*" \
  --action "webhook:https://example.com/hook" \
  --detach

# Log all events to a file
sphere daemon start --event "*" --action "log:./events.jsonl" --verbose

# Bash: run a shell command on DM receipt
# Environment variables: SPHERE_SENDER, SPHERE_EVENT, SPHERE_DATA, etc.
sphere daemon start \
  --event message:dm \
  --action "bash:echo DM from \$SPHERE_SENDER"

# Multiple events and actions via config file
sphere daemon start --config ./my-daemon.json --detach
```

### Config File Format

For complex setups, write a JSON config file at `.sphere-cli/daemon.json`:

```json
{
  "logFile": ".sphere-cli/daemon.log",
  "pidFile": ".sphere-cli/daemon.pid",
  "marketFeed": false,
  "actionTimeout": 30000,
  "rules": [
    {
      "name": "auto-receive on transfer",
      "events": ["transfer:incoming"],
      "actions": [
        { "type": "builtin", "action": "auto-receive" }
      ]
    },
    {
      "name": "webhook on DM",
      "events": ["message:dm"],
      "actions": [
        {
          "type": "webhook",
          "url": "https://example.com/hook",
          "headers": { "X-Api-Key": "secret" }
        }
      ]
    },
    {
      "name": "log everything",
      "events": ["*"],
      "actions": [
        { "type": "builtin", "action": "log-to-file", "path": "./all-events.jsonl" }
      ]
    }
  ]
}
```

---

## 12. Utility Commands

### Encryption

```bash
# Encrypt a string with a password (AES-256-GCM output as JSON)
sphere encrypt "my secret data" mypassword

# Decrypt encrypted JSON
sphere decrypt '{"ciphertext":"...","iv":"...","tag":"..."}' mypassword
```

### Wallet File Parsing

```bash
# Parse a wallet backup file (.txt, .dat, .json)
sphere parse-wallet wallet.txt
sphere parse-wallet wallet.dat
sphere parse-wallet wallet.json

# Parse encrypted wallet (provide password)
sphere parse-wallet wallet.txt mypassword

# Show metadata only (format, encrypted?, SQLite?)
sphere wallet-info wallet.txt
sphere wallet-info wallet.dat
```

### Key Operations

These commands work without a wallet and are useful for low-level key management and testing.

```bash
# Generate a fresh secp256k1 key pair (private key hidden by default)
sphere generate-key
# Output: Public Key: 02abc... / Direct Address: DIRECT://0000be36...

# Show private key and WIF (use with caution — never in scripts/CI)
sphere generate-key --unsafe-print
# Output: { privateKey, publicKey, wif, directAddress }

# Validate a private key
sphere validate-key 64-char-hex-string

# Convert private key hex to WIF format
sphere hex-to-wif 64-char-hex-string

# Derive the compressed public key from a private key
sphere derive-pubkey 64-char-hex-string

# Derive the DIRECT:// address at a given HD index (default: 0)
sphere derive-address 64-char-hex-string
sphere derive-address 64-char-hex-string 3
```

### Currency Conversion

```bash
# Convert human-readable amount to smallest unit (default: 8 decimals)
sphere to-smallest 1.5
# Output: 150000000

# Convert smallest unit to human-readable
sphere to-human 150000000
# Output: 1.5

# Format with explicit decimal places
sphere format 150000000 8
# Output: 1.50000000
```

### Base58 Encoding

```bash
# Encode a hex string to base58
sphere base58-encode deadbeef01234567

# Decode a base58 string back to hex
sphere base58-decode Xm4A9...
```

---

## 13. Global Flags

These flags are accepted by all commands:

| Flag | Description |
|------|-------------|
| `--no-nostr` | Disable Nostr transport (uses a no-op stub). Useful for testing IPFS-only recovery. |

```bash
sphere balance --no-nostr
sphere init --network testnet --no-nostr
```

---

## 14. Common Workflows

### Create Wallet, Register Nametag, Send Tokens

```bash
# 1. Initialize wallet with nametag on testnet
sphere init --network testnet --nametag alice

# 2. Top up with test tokens (self-mint via the v2 engine)
sphere topup 10 UCT

# 3. Check your balance
sphere balance

# 4. Send 50 UCT to bob
sphere send @bob 50 UCT

# 5. Confirm the transfer is reflected in history
sphere history 5
```

### Import Wallet from Mnemonic

```bash
# Import and optionally register a nametag in one step
sphere init \
  --mnemonic "abandon ability able about above absent absorb abstract absurd abuse access accident" \
  --nametag alice \
  --network testnet

# Sync with IPFS to restore any previously stored tokens
sphere sync
sphere balance
```

### Create Invoice, Share, Pay, Close

```bash
# Alice creates an invoice requesting 1 UCT from Bob
sphere wallet use alice
sphere invoice-create --target @alice --asset "100000000 UCT" --memo "Order #1234"
# Note the invoice ID prefix, e.g., a1b2c3d4

# Alice exports the invoice token to share with Bob
sphere invoice-export a1b2c3d4
# Creates: invoice-a1b2c3d4.json

# Bob imports the invoice
sphere wallet use bob
sphere invoice-import invoice-a1b2c3d4.json

# Bob pays it
sphere invoice-pay a1b2c3d4

# Alice checks status
sphere wallet use alice
sphere invoice-status a1b2c3d4

# Alice closes the invoice and sends receipts
sphere invoice-close a1b2c3d4
sphere invoice-receipts a1b2c3d4
```

### Set Up Daemon for Automated Receiving

```bash
# Start daemon that auto-receives incoming tokens
sphere daemon start \
  --event transfer:incoming \
  --action auto-receive \
  --detach

# Verify it is running
sphere daemon status

# Stop when no longer needed
sphere daemon stop
```

---

## Troubleshooting

### "No wallet found. Run: sphere init"

The active profile directory contains no wallet data. Either:
- Run `sphere init` to create a new wallet, or
- Run `sphere wallet use <name>` to switch to a profile that has one.

### Incoming transfer not showing up

v2 transfers arrive as finished tokens (no finalization phase). If a transfer is missing, fetch pending Nostr events explicitly:

```bash
sphere receive
sphere balance
```

### Balance shows old tokens that have already been sent

```bash
# Detect and remove spent tokens
sphere verify-balance --remove
```

### Nametag not found after registration

```bash
# Re-publish the nametag binding with chainPubkey
sphere nametag-sync
```

### Recovering tokens after data loss

```bash
# Re-import from mnemonic, then sync with IPFS
sphere init --mnemonic "your mnemonic here ..."
sphere sync
sphere balance
```

### Daemon does not start

Check for an existing PID file:
```bash
sphere daemon status
# If stale: rm .sphere-cli/daemon.pid
sphere daemon start --event transfer:incoming --action auto-receive
```

---

## Next Steps

- [Node.js Quick Start](./QUICKSTART-NODEJS.md) — SDK integration guide for Node.js applications
- [Browser Quick Start](./QUICKSTART-BROWSER.md) — SDK integration guide for web applications
- [API Reference](./API.md) — Full API documentation
- [Connect Protocol](./CONNECT.md) — dApp-to-wallet RPC integration
